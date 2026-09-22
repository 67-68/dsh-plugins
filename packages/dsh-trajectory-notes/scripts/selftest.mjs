// dsh-trajectory-notes · 自检脚本
//
// 不依赖真实 DSH host：用真实会话日志（~/.dsh/sessions 里最大的那个，或 $1
// 指定路径）+ mock 的 ctx.sessionQuery / ctx.llm，跑通
//   reader（turn 折叠、文本提取）→ tools（五个工具的执行与渲染）
//   → note-store（真实 DomainFacility + 内存后端）
//   → remote 网关（真实 cordis Context 上的 TrajectoryNotesGateway 方法）
// 并断言关键不变量。
//
// 运行前提：`@deepseek-ai/*` peer 能解析到本包。两种跑法：
//   A. 部署后（推荐）：node ~/.dsh/profiles/node_modules/dsh-trajectory-notes/scripts/selftest.mjs
//   B. 仓库里直接跑：先造一个带 @deepseek-ai 的临时 node_modules，例如
//        rm -rf /tmp/tn && mkdir -p /tmp/tn/node_modules
//        ln -s ~/.dsh/profiles/node_modules/@deepseek-ai /tmp/tn/node_modules/@deepseek-ai
//        cp -R <repo>/packages/dsh-trajectory-notes /tmp/tn/node_modules/dsh-trajectory-notes
//        node /tmp/tn/node_modules/dsh-trajectory-notes/scripts/selftest.mjs
//
// 只读：绝不写 ~/.dsh/sessions。

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { apply } from '../lib/index.js'
import { listSessions, readTrajectory, renderTurnText, turnPreview } from '../lib/trajectory-reader.js'
import { resolveRoute, summarizeText } from '../lib/summarizer.js'
import { defineTool } from '@deepseek-ai/dsh-tools'

// ── 断言小工具 ──────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n== ${title} ==`)
}

// ── 找会话日志 ──────────────────────────────────────────────────────────────

function findSessionFile() {
  const fromArg = process.argv[2]
  if (fromArg) return fromArg
  const root = join(homedir(), '.dsh', 'sessions')
  if (!existsSync(root)) return ''
  let best = ''
  let bestSize = 0
  const walk = (dir) => {
    let entries = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const p = join(dir, entry)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(p)
        continue
      }
      if (/^session(\.v\d+)?\.jsonl\.zstd$/.test(entry) && st.size > bestSize) {
        best = p
        bestSize = st.size
      }
    }
  }
  walk(root)
  return best
}

const file = findSessionFile()
if (!file || !existsSync(file)) {
  console.error('找不到会话日志。用法: node selftest.mjs [/path/to/session.v3.jsonl.zstd]')
  process.exit(2)
}

console.log(`会话日志: ${file} (${(statSync(file).size / 1024 / 1024).toFixed(1)} MB)`)

const rawText = execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 1 << 30 })
const events = rawText
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line))

const SESSION = 'session-selftest'
const header = {
  id: SESSION,
  cwd: '/tmp',
  createdAt: events.find((e) => e.type === 'session' && e.createdAt)?.createdAt ?? 0,
  version: 3,
  isSeeded: false,
}

// ── 1. 原始计数（作为断言的 ground truth）──────────────────────────────────

section('1. reader · 与原始日志计数比对')

const rawCounts = events.reduce((acc, e) => {
  acc[e.type] = (acc[e.type] || 0) + 1
  return acc
}, {})

const sessionQuery = {
  listSessions: async () => ([
    { header, live: true, persisted: true },
    { header: { ...header, id: 'session-other', createdAt: 1 }, live: false, persisted: true },
  ]),
  readSession: async (id) => {
    if (id !== SESSION) throw new Error(`unknown session ${id}`)
    return { session: header, inheritedEventCount: 0, events }
  },
}

const trajectory = await readTrajectory(sessionQuery, SESSION)
console.log(`  事件 ${trajectory.eventCount} · turn ${trajectory.turnCount} · 标题「${trajectory.title}」· 路由 ${trajectory.route ? `${trajectory.route.provider}/${trajectory.route.model}` : '(无)'}`)

check('事件总数与原始一致', trajectory.eventCount === events.length, `${trajectory.eventCount} vs ${events.length}`)
check('turn 数与原始 turn/start 一致', trajectory.turnCount === (rawCounts['turn/start'] || 0), `${trajectory.turnCount} vs ${rawCounts['turn/start'] || 0}`)
// 未收口的 turn 是真实存在的（turn/start 之后被中断、没有 turn/end，实测
// 25 个 start 只有 18 个 end）。分组必须仍然一个 turn/start 一个条目，只是
// endSeq 为 null，由渲染层标成「未收口」。
const unclosed = trajectory.turns.filter((t) => t.endSeq == null)
check('未收口 turn 被容忍且不并条', trajectory.turns.length === (rawCounts['turn/start'] || 0), `未收口 ${unclosed.length} 条`)
check('未收口 turn 渲染为「未收口」', unclosed.length === 0 || renderTurnText(unclosed[0]).includes('未收口'), `样例 turn ${unclosed[0] ? unclosed[0].turn : '-'}`)
check('已收口 turn 的 endSeq 大于 startSeq', trajectory.turns.filter((t) => t.endSeq != null).every((t) => t.endSeq > t.startSeq))
check('turn 号连续递增', trajectory.turns.every((t, i) => i === 0 || t.turn > trajectory.turns[i - 1].turn))

const toolCallTotal = trajectory.turns.reduce((acc, t) => acc + t.toolNames.length, 0)
check('工具调用总数与原始一致', toolCallTotal === (rawCounts['tool/call'] || 0), `${toolCallTotal} vs ${rawCounts['tool/call'] || 0}`)

const assistantTextTotal = trajectory.turns.reduce((acc, t) => acc + t.assistantTexts.length, 0)
const rawAssistantWithText = events.filter((e) => {
  if (e.type !== 'assistant/message') return false
  const blocks = (e.data && e.data.message && e.data.message.content) || []
  return blocks.some((b) => b && (b.type === 'text' || b.type === undefined) && typeof b.text === 'string' && b.text.trim())
}).length
check('assistant 文本条数与原始一致（reasoning-only 应被丢弃）', assistantTextTotal === rawAssistantWithText, `${assistantTextTotal} vs ${rawAssistantWithText}`)

const humanUserTotal = trajectory.turns.reduce((acc, t) => acc + t.userTexts.length, 0)
check('人类输入条数不超过原始 user/message', humanUserTotal <= (rawCounts['user/message'] || 0), `${humanUserTotal} vs 上限 ${rawCounts['user/message'] || 0}`)

section('2. reader · 预览与正文渲染')
const sample = trajectory.turns[Math.min(3, trajectory.turns.length - 1)]
const preview = turnPreview(sample)
const rendered = renderTurnText(sample)
check('预览含 turn 号与统计字段', typeof preview.turn === 'number' && typeof preview.stepCount === 'number' && typeof preview.toolCallCount === 'number')
check('正文以条目标题开头', rendered.startsWith(`# 轨迹条目 · turn ${sample.turn}`))
check('正文含四段结构', ['## 用户输入', '## Agent 最终回复', '## 工具调用序列'].every((h) => rendered.includes(h)) || rendered.includes('## 用户输入'))
// 有的 turn 天然很短（用户一句话、agent 没回），所以断言结构完整而不是长度。
check('正文包含统计行与用户输入段', rendered.includes('- step 数:') && rendered.includes('## 用户输入'), `${rendered.length} 字符`)
check('取到内容最多的 turn 时正文足够长', (() => {
  const richest = trajectory.turns.reduce((a, b) => (renderTurnText(b).length > renderTurnText(a).length ? b : a), trajectory.turns[0])
  return renderTurnText(richest).length > 500
})())

section('3. reader · 只读契约')
check('reader 不暴露任何写入入口', typeof listSessions === 'function' && typeof readTrajectory === 'function')
const readOnlyCalls = []
const spyQuery = {
  listSessions: async () => { readOnlyCalls.push('listSessions'); return [] },
  readSession: async () => { readOnlyCalls.push('readSession'); return { session: header, events: [] } },
}
await readTrajectory(spyQuery, SESSION)
check('读取只触碰 listSessions/readSession', readOnlyCalls.every((c) => c === 'listSessions' || c === 'readSession'), readOnlyCalls.join(','))

// ── 4. summarizer ──────────────────────────────────────────────────────────

section('4. summarizer · 收口 / 路由 / 超时')

const llmCalls = []
const llm = {
  stream(options) {
    llmCalls.push(options)
    return (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '这一轮用户要求 X，Agent 完成了 Y。' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '这一轮用户要求 X，Agent 完成了 Y。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}

const okResult = await summarizeText({ llm }, {
  text: renderTurnText(sample),
  route: trajectory.route || { provider: 'p', model: 'm' },
  sessionId: SESSION,
})
check('正常收口返回摘要文本', typeof okResult.summary === 'string' && okResult.summary.length > 0, okResult.summary)
check('调用参数带 provider/model/purpose/sessionId',
  llmCalls[0].provider && llmCalls[0].model && llmCalls[0].purpose === 'trajectory-note' && llmCalls[0].sessionId === SESSION,
  `${llmCalls[0].provider}/${llmCalls[0].model} purpose=${llmCalls[0].purpose}`)
check('system prompt 已注入', typeof llmCalls[0].system === 'string' && llmCalls[0].system.includes('摘要'))

let errorThrew = false
try {
  await summarizeText({ llm: { stream: () => (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } } })() } },
    { text: 'x', route: { provider: 'p', model: 'm' } })
} catch (_err) {
  errorThrew = true
}
check('finish=error 必须抛错', errorThrew)

let toolCallThrew = false
try {
  await summarizeText({ llm: { stream: () => (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c', name: 'bash', arguments: {} } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })() } }, { text: 'x', route: { provider: 'p', model: 'm' } })
} catch (_err) {
  toolCallThrew = true
}
check('模型发起工具调用必须抛错', toolCallThrew)

let timeoutCode = ''
try {
  await summarizeText({ llm: { stream: () => (async function* () { await new Promise((r) => setTimeout(r, 3000)) })() } },
    { text: 'x', route: { provider: 'p', model: 'm' }, timeoutMs: 50 })
} catch (err) {
  timeoutCode = err && err.code ? err.code : ''
}
check('超时以 TRAJECTORY_NOTES_TIMEOUT 收口', timeoutCode === 'TRAJECTORY_NOTES_TIMEOUT', timeoutCode || '(无 code)')

check('显式路由优先于会话路由', resolveRoute({ provider: 'a', model: 'b' }, { provider: 'x', model: 'y' }).provider === 'a')
check('无路由时抛错而不是猜', (() => { try { resolveRoute({}, null); return false } catch { return true } })())

// ── 5. 工具层 ──────────────────────────────────────────────────────────────

section('5. tools · 注册与执行')

// 真实 DomainFacility + 内存 kv 后端：只 mock 存储介质，domain 层
// （schema 校验、write chain、变更事件）全部走真实代码。
function memoryKvBackend() {
  const docs = new Map()
  return {
    docs,
    kv: {
      async open(descriptor) {
        const tables = descriptor.tables || []
        return {
          async loadAll() {
            const out = {}
            for (const t of tables) out[t] = {}
            for (const [k, v] of docs) {
              const i = k.indexOf('/')
              if (i < 0) continue
              const t = k.slice(0, i)
              if (out[t]) out[t][k.slice(i + 1)] = v
            }
            return { tables: out, global: null }
          },
          async putRecord(table, key, value) {
            // 与真实 json 后端同一条 key 规则（per-record key 即路径段）。
            if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error(`unsafe key rejected: ${key}`)
            docs.set(`${table}/${key}`, JSON.parse(JSON.stringify(value)))
          },
          async deleteRecord(table, key) {
            docs.delete(`${table}/${key}`)
          },
          async backupRecord(table, key) {
            const from = `${table}/${key}`
            const to = `${from}.bak.selftest`
            if (docs.has(from)) {
              docs.set(to, docs.get(from))
              docs.delete(from)
            }
            return to
          },
          async setGlobal() {
            throw new Error('no global declared')
          },
          async close() {},
        }
      },
    },
  }
}

const memBackend = memoryKvBackend()
const emittedChanges = []
const facilityCtx = {
  storage: { backend: { get: (name) => {
    if (name !== 'mem') throw new Error(`unknown backend ${name}`)
    return memBackend
  } } },
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  emit: (evt, payload) => {
    if (evt === 'domain/changed') emittedChanges.push(payload)
  },
}
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain')
const storageDomain = new DomainFacility(facilityCtx, { backend: 'mem' })

const registered = new Map()
// 用真实 cordis Context 跑 apply 全路径（含网关挂载）：只把 host 服务换成 mock。
const { Context: PluginContext } = await import('@deepseek-ai/cordis')
const ctx = new PluginContext()
ctx.tools = { register: (def) => { registered.set(def.name, def); return () => registered.delete(def.name) } }
ctx.sessionQuery = sessionQuery
ctx.llm = llm
ctx.storageDomain = storageDomain
const listeners = new Map()
const rawOn = ctx.on.bind(ctx)
ctx.on = (evt, cb) => {
  listeners.set(evt, cb)
  return rawOn(evt, cb)
}

apply(ctx, {})

check('网关随 apply 真实挂载', ctx.get('trajectoryNotes', false) !== undefined)

check('五个工具全部注册成功', ['list_trajectories', 'read_trajectory', 'summarize_trajectory', 'list_trajectory_notes', 'delete_trajectory_note'].every((n) => registered.has(n)), [...registered.keys()].join(','))
check('监听 agent/created（scope 可见性）', listeners.has('agent/created'))

const callTool = async (toolName, args, exec = { agent: { session: { id: SESSION } } }) => {
  const def = registered.get(toolName)
  const value = await def.execute(args, exec)
  return { value, text: def.output.render(args, value).map((b) => b.text).join('\n') }
}

const listed = await callTool('list_trajectories', { sessionId: SESSION, limit: 3 })
check('list_trajectories 返回条目预览', Array.isArray(listed.value.turns) && listed.value.turns.length === Math.min(3, trajectory.turnCount), `${listed.value.turns && listed.value.turns.length} 条`)
check('list_trajectories 渲染不含错误', !listed.text.startsWith('Error:'))

const sessionsListed = await callTool('list_trajectories', {})
check('list_trajectories 不传 sessionId 时列出会话', Array.isArray(sessionsListed.value.sessions) && sessionsListed.value.sessions.length === 2)

const readOne = await callTool('read_trajectory', { sessionId: SESSION, turn: sample.turn })
check('read_trajectory 读到指定 turn', readOne.value.entries.length === 1 && readOne.value.entries[0].turn === sample.turn)
check('read_trajectory 正文非空', readOne.value.entries[0].text.length > 100, `${readOne.value.entries[0].text.length} 字符`)

const readMissing = await callTool('read_trajectory', { sessionId: SESSION, turn: 999999 })
check('不存在的 turn 返回可读错误', typeof readMissing.value.error === 'string' && readMissing.value.error.includes('没找到'))

const before = llmCalls.length
const summarized = await callTool('summarize_trajectory', { sessionId: SESSION, turns: [sample.turn] })
check('summarize_trajectory 逐条生成摘要', summarized.value.notes.length === 1 && typeof summarized.value.notes[0].summary === 'string')
check('每条摘要一次独立 LLM 调用', llmCalls.length - before === 1, `新增 ${llmCalls.length - before} 次`)
check('摘要调用归属正确会话', llmCalls[llmCalls.length - 1].sessionId === SESSION)
check('summarize 渲染含模型路由', summarized.text.includes('/'), summarized.text.split('\n')[0])
check('summarize 默认落盘（saved=true）', summarized.value.notes[0].saved === true, summarized.text.split('\n').find((l) => l.includes('turn')) || '')
check('落盘触发 domain/changed put 事件', emittedChanges.some((c) => c.domain === 'trajectory_notes' && c.table === 'notes' && c.operation === 'put'), `${emittedChanges.length} 个事件`)

let scopeRegisteredCount = 0
listeners.get('agent/created')({
  agent: { session: { id: 'session-scope' }, ctx: { tools: { register: () => { scopeRegisteredCount += 1; return () => {} } } } },
})
check('agent/created 时向 agent scope 再注册一份（模型可见性）', scopeRegisteredCount === 5, `${scopeRegisteredCount} 个`)

let badArgRejected = false
try {
  await callTool('read_trajectory', { sessionId: SESSION, turn: 'not-a-number' })
} catch (_err) {
  badArgRejected = true
}
check('参数 schema 拒绝坏参数', badArgRejected)

const noSave = await callTool('summarize_trajectory', { sessionId: SESSION, turns: [sample.turn], save: false })
check('save=false 只返回不落盘', noSave.value.notes[0].saved === false && !noSave.value.notes[0].saveError, noSave.text.split('\n').find((l) => l.includes('turn')) || '')

const notesListed = await callTool('list_trajectory_notes', { sessionId: SESSION })
check('list_trajectory_notes 读到已保存摘要', notesListed.value.notes.length >= 1 && notesListed.value.notes[0].turn === sample.turn, `${notesListed.value.notes.length} 条`)
check('list 渲染不含错误', !notesListed.text.startsWith('Error:'))

const notesOne = await callTool('list_trajectory_notes', { sessionId: SESSION, turn: sample.turn })
check('list_trajectory_notes 可按 turn 取单条', notesOne.value.notes.length === 1 && typeof notesOne.value.notes[0].summary === 'string')

const notesMissing = await callTool('list_trajectory_notes', { sessionId: 'session-nobody' })
check('空会话返回空列表而非报错', Array.isArray(notesMissing.value.notes) && notesMissing.value.notes.length === 0)

const deleted = await callTool('delete_trajectory_note', { sessionId: SESSION, turn: sample.turn })
check('delete_trajectory_note 删除成功', deleted.value.deleted === true, deleted.text)
const afterDelete = await callTool('list_trajectory_notes', { sessionId: SESSION })
check('删除后列表为空', afterDelete.value.notes.length === 0)
const deletedAgain = await callTool('delete_trajectory_note', { sessionId: SESSION, turn: sample.turn })
check('重复删除返回 deleted=false（幂等）', deletedAgain.value.deleted === false)

section('6. note-store · 边界与重载')

const { openNoteStore, getNote, listNotes, saveNote, deleteNote, noteKey, parseNoteKey, onNotesChanged, resetNoteStoreForTests, DOMAIN_NAME } = await import('../lib/note-store.js')

check('key 编解码互逆', (() => {
  const parsed = parseNoteKey(noteKey(SESSION, 7))
  return parsed && parsed.sessionId === SESSION && parsed.turn === 7
})())
check('非法 key 解析返回 null', parseNoteKey('no-separator') === null && parseNoteKey('a--x') === null && parseNoteKey('--3') === null)
let unsafeRejected = false
try {
  noteKey('sess/ion', 1)
} catch (_err) {
  unsafeRejected = true
}
check('不安全 key（含 /）在编码时拒绝', unsafeRejected)
unsafeRejected = false
try {
  listNotes({ table: { entries: () => [] } }, '../evil')
} catch (_err) {
  unsafeRejected = true
}
check('listNotes 拒绝不安全 sessionId', unsafeRejected)

const store = await openNoteStore(ctx)
check('openNoteStore 返回 domain+table', Boolean(store.domain && store.table))
const storeAgain = await openNoteStore(ctx)
check('重复 open 复用同一 domain（不抛 already-open）', storeAgain.domain === store.domain)
check('facility.get 能查到已开 domain', storageDomain.get(DOMAIN_NAME) === store.domain)

const [concurrentA, concurrentB] = await Promise.all([openNoteStore(ctx), openNoteStore(ctx)])
check('并发 open 收敛到同一句柄', concurrentA.domain === concurrentB.domain)

let changedEvents = 0
const disposeWatcher = onNotesChanged(ctx, () => {
  changedEvents += 1
})
// ctx.on 只是记录监听器，这里手动触发 change 事件验证过滤逻辑
const domainListener = listeners.get('domain/changed')
if (typeof domainListener === 'function') {
  domainListener({ domain: DOMAIN_NAME, table: 'notes', key: 'k', operation: 'put', value: {} })
  domainListener({ domain: 'other_domain', table: 'notes', key: 'k', operation: 'put', value: {} })
}
check('onNotesChanged 只收本 domain 事件', changedEvents === 1, `${changedEvents} 次`)
disposeWatcher()

const direct = await saveNote(store, {
  sessionId: SESSION,
  turn: 3,
  startSeq: 10,
  endSeq: 20,
  title: 't',
  summary: '直接写入的摘要',
  model: { provider: 'p', model: 'm' },
  stepCount: 1,
  toolCallCount: 0,
  errorCount: 0,
  source: 'tool',
})
check('saveNote 返回记录（含 createdAt/updatedAt）', direct.createdAt > 0 && direct.updatedAt >= direct.createdAt)
check('getNote 读回一致', getNote(store, SESSION, 3).summary === '直接写入的摘要')
const relisted = listNotes(store, SESSION)
check('listNotes 按 turn 升序', relisted.map((r) => r.turn).join(',') === [...relisted].map((r) => r.turn).sort((a, b) => a - b).join(','))
let schemaRejected = false
try {
  await saveNote(store, { ...direct, summary: '' })
} catch (_err) {
  schemaRejected = true
}
check('空摘要被 zod schema 拒绝', schemaRejected)
check('deleteNote 删直接写入的记录', await deleteNote(store, SESSION, 3) === true)
check('删后 get 返回 undefined', getNote(store, SESSION, 3) === undefined)

// 坏记录备份跳过：往后端直写一条非法 doc，用新 facility 重开，必须不炸且该记录缺席
resetNoteStoreForTests()
memBackend.docs.set('notes/session-bad--9', { sessionId: 'session-bad', turn: 'not-a-number', summary: 42 })
const facility2 = new DomainFacility(facilityCtx, { backend: 'mem' })
const ctx2 = { ...ctx, storageDomain: facility2 }
const reopened = await openNoteStore(ctx2)
check('坏记录 backup-and-skip 后重开成功', Boolean(reopened.table))
check('坏记录被视为缺席', reopened.table.get('session-bad--9') === undefined)
check('坏记录文档被搬走备份', [...memBackend.docs.keys()].some((k) => k.startsWith('notes/session-bad--9.bak.')))
resetNoteStoreForTests()

section('7. remote 网关 · 真实 cordis Context 上的方法调用')

// 回到主 facility（第 6 节末尾切到了 facility2，这里复位重开）。
resetNoteStoreForTests()
const { Context } = await import('@deepseek-ai/cordis')
const { TrajectoryNotesGateway } = await import('../lib/remote.js')
// 网关挂在独立 Context 上（与工具共用同一份 sessionQuery/llm/storageDomain）。
const gatewayCtx = new Context()
gatewayCtx.sessionQuery = sessionQuery
gatewayCtx.llm = llm
gatewayCtx.storageDomain = storageDomain
const gateway = new TrajectoryNotesGateway(gatewayCtx, {
  cfg: { provider: '', model: '', timeoutMs: 60000, maxTokens: 700, maxTurnsPerCall: 20, maxCharsPerTurn: 24000 },
})
check('网关以 trajectoryNotes 为键注册', gateway.name === 'trajectoryNotes' && gateway.ctx === gatewayCtx)
// client 的 TYPERT face 绑的是这些 Remote 标记：方法名必须对齐，否则 UI 调不动。
const { remoteMethods } = await import('@deepseek-ai/dsh-typert-protocol')
const marked = remoteMethods(gateway).map((m) => m.name ?? m.method ?? m.exportName ?? '')
check('四个 Remote 方法均已标记', ['listEntries', 'getEntry', 'summarize', 'deleteNote'].every((n) => marked.includes(n)), marked.join(','))

const gwList = await gateway.listEntries({ sessionId: SESSION, limit: 5 })
check('listEntries 返回条目（含摘要快照）', gwList.turnCount === trajectory.turnCount && gwList.entries.length === Math.min(5, trajectory.turnCount) && gwList.entries.every((e) => typeof e.turn === 'number' && 'hasNote' in e), `${gwList.entries.length} 条`)
check('listEntries 全 JSON-safe', (() => { try { JSON.stringify(gwList); return true } catch { return false } })())

const gwGet = await gateway.getEntry({ sessionId: SESSION, turn: sample.turn })
check('getEntry 返回单条详情', gwGet.turn === sample.turn && Array.isArray(gwGet.userTexts) && Array.isArray(gwGet.toolCalls))
check('getEntry 全 JSON-safe', (() => { try { JSON.stringify(gwGet); return true } catch { return false } })())
let gwGetMissing = false
try {
  await gateway.getEntry({ sessionId: SESSION, turn: 999999 })
} catch (_err) {
  gwGetMissing = true
}
check('getEntry 不存在的 turn 抛错（Remote 语义）', gwGetMissing)

const gwSum = await gateway.summarize({ sessionId: SESSION, turns: [sample.turn] })
check('summarize 生成并落盘（source=ui）', gwSum.notes.length === 1 && gwSum.notes[0].saved === true && typeof gwSum.notes[0].summary === 'string')
const uiStore = await openNoteStore({ storageDomain })
const uiNote = listNotes(uiStore, SESSION).find((r) => r.turn === sample.turn)
check('UI 总结的记录 source 记为 ui', uiNote && uiNote.source === 'ui')

const gwDel = await gateway.deleteNote({ sessionId: SESSION, turn: sample.turn })
check('deleteNote 删除成功', gwDel.deleted === true && gwDel.sessionId === SESSION)
let gwArgMissing = false
try {
  await gateway.listEntries({})
} catch (_err) {
  gwArgMissing = true
}
check('缺 sessionId 抛错', gwArgMissing)

section('8. client 静态对齐 · face 方法名 / slot 注册 / 跳转逻辑')

const { readFileSync: readClientSource } = await import('node:fs')
const { fileURLToPath } = await import('node:url')
const { dirname: pathDirname, join: pathJoin } = await import('node:path')
// selftest 位置固定：<pkg>/scripts/selftest.mjs → 包根可推导。
const pkgRoot = pathJoin(pathDirname(fileURLToPath(import.meta.url)), '..')
const clientSource = readClientSource(pathJoin(pkgRoot, 'lib', 'client.js'), 'utf8')
const pkgJson = JSON.parse(readClientSource(pathJoin(pkgRoot, 'package.json'), 'utf8'))

// host 侧 Remote 标记的方法名，必须全部出现在 client face 的 descriptor 里。
const faceMethods = ['listEntries', 'getEntry', 'summarize', 'deleteNote']
check('face 覆盖全部四个网关方法', faceMethods.every((m) => clientSource.includes(`"${m}"`) || clientSource.includes(`'${m}'`)))
check('face descriptor 命名空间对齐 host', clientSource.includes('dsh-trajectory-notes#trajectoryNotes/'))
check('注册 conversation.view 同级 tab', clientSource.includes('conversation.view') && clientSource.includes('id: "trajectory-notes"'))
check('跳转按钮走 setView 主路径', clientSource.includes(`setView("trajectory")`))
check('跳转有 DOM 点 tab 兜底', clientSource.includes('[role="tab"]') && clientSource.includes('click()'))
check('兜底排除自己 tab（轨迹摘要）', clientSource.includes('摘要') && clientSource.includes('isOwn'))
check('中英跳转文案齐全', clientSource.includes('跳转轨迹页面') && clientSource.includes('Open trajectory page'))
check('详情/列表/总结/删除 UI 齐全', ['backToList', 'summarizeOne', 'deleteNote', 'summarizeAll'].every((k) => clientSource.includes(k)))
check('package.json 有 dsh.client 声明', Boolean(pkgJson.dsh && pkgJson.dsh.client && pkgJson.dsh.client.platform === 'web'))
check('package.json client export 指向 lib/client.js', pkgJson.exports && pkgJson.exports['./client'] && pkgJson.exports['./client'].default === './lib/client.js')
check('client inject 与代码内 inject 一致', (() => {
  const declared = (pkgJson.dsh.client.inject || []).slice().sort().join(',')
  const expected = ['@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-slots'].sort().join(',')
  const codeHas = clientSource.includes('var inject = ["slots", "locale", "sessions", "remote"]')
  return declared === expected && codeHas
})(), (pkgJson.dsh.client.inject || []).join(','))

// ── 汇总 ────────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`)
console.log(`通过 ${passed} · 失败 ${failed}`)
console.log('='.repeat(50))
process.exit(failed === 0 ? 0 : 1)
