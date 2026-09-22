// dsh-trajectory-notes · 摘要专属存储（checklist-2）
//
// 一条摘要 = domain `trajectory_notes` 表 `notes` 里的一条记录，key 是
// `${sessionId}--${turn}`（文件名安全：session id 只含字母数字与 `-`，
// turn 是数字；per-record 后端直接把 key 拼成 `<table>/<key>.json`）。
//
// 为什么是 storage-domain 而不是 settings：
//   - settings 是配置层（icon-marker 那种短符号可以），摘要是长文本派生
//     数据，量级和语义都不对；
//   - domain 自带 schema 校验（zod）、per-record 细粒度读写、
//     `domain/changed` 变更事件（checklist-3 的 UI 刷新就靠它）；
//   - 派生数据必须 `invalidRecords: 'backup-and-skip'`：坏记录只搬走备份，
//     绝不让一次格式漂移拖死整个插件启动（抄 session_projcache）。
//
// 只写自己的 domain，绝不碰会话日志与其它 domain。

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

export const DOMAIN_NAME = 'trajectory_notes'
export const TABLE_NAME = 'notes'
export const DOMAIN_VERSION = 1

/** 摘要记录在 durable 边界的 schema。字段只增不改；不兼容时升 version。 */
const noteRecordSchema = z.object({
  /** 归属会话 id。 */
  sessionId: z.string().min(1),
  /** turn 号（与轨迹条目一一对应）。 */
  turn: z.number().int().nonnegative(),
  /** 条目在日志里的 seq 区间（总结时刻的快照；会话继续推进后可据此判 stale）。 */
  startSeq: z.number().int().nonnegative(),
  endSeq: z.number().int().nonnegative().nullable(),
  /** 总结时刻的会话标题（展示用，不随标题改名而更新）。 */
  title: z.string(),
  /** 摘要正文。 */
  summary: z.string().min(1),
  /** 生成摘要的模型路由。 */
  model: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
  }),
  /** 条目快照统计（展示用）。 */
  stepCount: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  /** 谁生成的：tool（模型调工具）/ ui（伴生页按钮，checklist-3 接）。 */
  source: z.enum(['tool', 'ui']),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})

export const noteSpec = defineDomain({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  invalidRecords: 'backup-and-skip',
  layout: 'per-record',
  tables: { [TABLE_NAME]: domainTable(noteRecordSchema) },
})

/** key 编码：两端都不含 `--` 分隔歧义（turn 是纯数字后缀）。 */
export function noteKey(sessionId, turn) {
  const key = `${String(sessionId)}--${Number(turn)}`
  assertSafeKey(key)
  return key
}

/**
 * per-record 后端把 key 直接拼成 `<table>/<key>.json`，只接受
 * `[a-zA-Z0-9_-]+`（见 KvUnit.putRecord 契约），不安全直接拒绝，
 * 避免写到一半才被后端打回来。
 */
export const SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/

export function assertSafeKey(key) {
  if (!SAFE_KEY_RE.test(key)) {
    throw new Error(`dsh-trajectory-notes: 非法的存储 key（只允许字母数字 _ -）：${String(key).slice(0, 80)}`)
  }
}

/** key 解码：非法 key 返回 null（调用方跳过，不抛错）。 */
export function parseNoteKey(key) {
  if (typeof key !== 'string') return null
  const idx = key.lastIndexOf('--')
  if (idx <= 0) return null
  const sessionId = key.slice(0, idx)
  const turn = Number(key.slice(idx + 2))
  if (!sessionId || !Number.isInteger(turn) || turn < 0) return null
  return { sessionId, turn }
}

/**
 * 打开（或复用）domain。open 是 async 且单开的：
 *   - 首次调用真正 open，后续调用直接复用；
 *   - 并发 open 时输的那一方会吃到 already-open，回落到 get()；
 *   - 插件热重载时 domain 还开着，get() 直接复用，不重开。
 * 返回 { domain, table }，table 读同步、写走 write chain（先落盘后内存）。
 */
let openPromise = null

export function openNoteStore(ctx) {
  if (!openPromise) {
    openPromise = (async () => {
      const facility = ctx.storageDomain
      if (!facility || typeof facility.open !== 'function') {
        throw new Error('dsh-trajectory-notes: ctx.storageDomain 不可用（缺少 storage-domain 挂载）')
      }
      const existing = typeof facility.get === 'function' ? facility.get(DOMAIN_NAME) : undefined
      if (existing) return wrapStore(existing)
      try {
        return wrapStore(await facility.open(noteSpec))
      } catch (err) {
        const code = err && err.code
        if (code === 'already-open' && typeof facility.get === 'function') {
          const reopened = facility.get(DOMAIN_NAME)
          if (reopened) return wrapStore(reopened)
        }
        throw err
      }
    })()
    // open 失败不缓存，下次调用重试（否则一次启动抖动就永久残废）。
    openPromise.catch(() => {
      openPromise = null
    })
  }
  return openPromise
}

function wrapStore(domain) {
  const table = domain.table(TABLE_NAME)
  return { domain, table }
}

/** 测试/重载场景下丢弃缓存的 open 句柄（生产路径不需要调）。 */
export function resetNoteStoreForTests() {
  openPromise = null
}

// ── 读写 ────────────────────────────────────────────────────────────────────

/**
 * 保存一条摘要（同 key 覆盖即更新，updatedAt 自动刷新）。
 * @param store - openNoteStore 的返回值。
 * @param note - 除 createdAt/updatedAt 外的完整记录字段。
 */
export async function saveNote(store, note) {
  const now = Date.now()
  const key = noteKey(note.sessionId, note.turn)
  const current = store.table.get(key)
  const record = {
    ...note,
    createdAt: current ? current.createdAt : now,
    updatedAt: now,
  }
  // zod 在 durable 边界再验一次：open 时 loadAll 会验，这里先验早暴露 bug。
  noteRecordSchema.parse(record)
  await store.table.put(key, record)
  return record
}

/** 取一条。 */
export function getNote(store, sessionId, turn) {
  return store.table.get(noteKey(sessionId, turn))
}

/** 取一个会话的全部摘要，按 turn 升序。 */
export function listNotes(store, sessionId) {
  const sid = String(sessionId)
  assertSafeKey(sid)
  const prefix = `${sid}--`
  const out = []
  for (const [key, record] of store.table.entries()) {
    if (!key.startsWith(prefix)) continue
    const parsed = parseNoteKey(key)
    if (!parsed) continue
    out.push(record)
  }
  out.sort((a, b) => a.turn - b.turn)
  return out
}

/** 删一条；不存在返回 false（不写盘、不发事件）。 */
export async function deleteNote(store, sessionId, turn) {
  return store.table.delete(noteKey(sessionId, turn))
}

/** 全库条目数（调试/自检用）。 */
export function noteCount(store) {
  return store.table.size
}

/**
 * 订阅本 domain 的变更（checklist-3 的 UI 刷新用；checklist-2 的工具不需要）。
 * @returns disposer。
 */
export function onNotesChanged(ctx, listener) {
  return ctx.on('domain/changed', (change) => {
    if (!change || change.domain !== DOMAIN_NAME || change.table !== TABLE_NAME) return
    try {
      listener(change)
    } catch (_err) {
      /* 监听器异常不回滚写入（domain 层同样语义） */
    }
  })
}
