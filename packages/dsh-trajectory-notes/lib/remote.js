// dsh-trajectory-notes · host Remote 网关（checklist-3）
//
// 给伴生页（browser 半）用的 RPC 面：读条目、读单条、触发总结、删摘要。
// 传输约束：Typert 要求返回值 JSON-safe，所以这里只返回纯数据（字符串、
// 数字、布尔、null、plain 对象/数组），绝不返回 Date、Map、undefined。
//
// 方法签名统一收一个 args 对象（client 侧用 args descriptor 对应）。
// 总结逻辑与 summarize_trajectory 工具共用 lib/index.js 导出的
// summarizeEntries，只是 source 记为 'ui'。

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import { readTrajectory, turnPreview } from './trajectory-reader.js'
import { openNoteStore, listNotes, deleteNote, getNote } from './note-store.js'
import { summarizeEntries } from './summarize-entries.js'

export const SERVICE_NAME = 'trajectoryNotes'

/** 无装饰器环境的 Remote 标记 shim（抄 mode-gate 同名实现）。 */
function markRemoteMethods(cls, methodNames) {
  const initializers = []
  for (const name of methodNames) {
    Remote(name)(undefined, {
      kind: 'method',
      name,
      static: false,
      private: false,
      access: { has: (o) => name in o, get: (o) => o[name] },
      addInitializer: (fn) => {
        initializers.push(fn)
      },
    })
  }
  const probe = Object.create(cls.prototype)
  for (const fn of initializers) fn.call(probe)
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function capText(text, max) {
  const value = String(text == null ? '' : text)
  if (value.length <= max) return { text: value, truncated: false }
  return { text: value.slice(0, max), truncated: true, total: value.length }
}

const MAX_TEXT_CHARS = 6000

class TrajectoryNotesGateway extends TypertRemoteService {
  static inject = []
  constructor(ctx, options) {
    super(ctx, SERVICE_NAME)
    this.options = options || {}
  }
  get cfg() {
    return this.options.cfg || {}
  }
  /** 条目列表（含每条的摘要快照）：伴生页列表屏的数据源。 */
  async listEntries(args) {
    const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
    if (!sessionId) throw new Error('listEntries 需要 sessionId')
    const limit = clampInt(args && args.limit, 200, 1, 2000)
    const trajectory = await readTrajectory(this.ctx.sessionQuery, sessionId, { limit })
    let noteByTurn = new Map()
    try {
      const store = await openNoteStore(this.ctx)
      for (const record of listNotes(store, sessionId)) {
        noteByTurn.set(record.turn, record)
      }
    } catch (_err) {
      // 存储打不开不影响列表：当作全部无摘要
    }
    return {
      sessionId: trajectory.sessionId,
      title: trajectory.title,
      turnCount: trajectory.turnCount,
      truncated: trajectory.truncated,
      entries: trajectory.turns.map((entry) => {
        const note = noteByTurn.get(entry.turn)
        return {
          ...turnPreview(entry),
          hasNote: Boolean(note),
          summary: note ? note.summary : '',
          savedAt: note ? note.updatedAt : 0,
        }
      }),
    }
  }
  /** 单条详情：正文（截断保护）+ 摘要。 */
  async getEntry(args) {
    const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
    const turn = args ? Number(args.turn) : NaN
    if (!sessionId) throw new Error('getEntry 需要 sessionId')
    if (!Number.isInteger(turn) || turn < 0) throw new Error('getEntry 需要合法的 turn 号')
    const trajectory = await readTrajectory(this.ctx.sessionQuery, sessionId, { limit: 100000 })
    const entry = trajectory.turns.find((e) => e.turn === turn)
    if (!entry) throw new Error(`没找到 turn ${turn}（该会话共 ${trajectory.turnCount} 条轨迹）`)
    let note = null
    try {
      const store = await openNoteStore(this.ctx)
      note = getNote(store, sessionId, turn) || null
    } catch (_err) {
      // 存储打不开不影响详情
    }
    const userCapped = entry.userTexts.map((t) => capText(t, MAX_TEXT_CHARS))
    const assistantCapped = entry.assistantTexts.map((t) => capText(t, MAX_TEXT_CHARS))
    return {
      sessionId: trajectory.sessionId,
      title: trajectory.title,
      turn: entry.turn,
      startSeq: entry.startSeq,
      endSeq: entry.endSeq,
      startTime: entry.startTime,
      endTime: entry.endTime,
      endReasonKind: entry.endReasonKind,
      stepCount: entry.stepCount,
      toolCalls: entry.toolCalls,
      errorCount: entry.errorCount,
      userTexts: userCapped,
      assistantTexts: assistantCapped,
      summary: note ? note.summary : '',
      savedAt: note ? note.updatedAt : 0,
    }
  }
  /** 触发总结（伴生页"总结"按钮）：生成并落盘，返回 notes。 */
  async summarize(args) {
    const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
    if (!sessionId) throw new Error('summarize 需要 sessionId')
    const turns = Array.isArray(args && args.turns)
      ? args.turns.map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : []
    const limit = clampInt(args && args.limit, 3, 1, this.cfg.maxTurnsPerCall || 20)
    return summarizeEntries(this.ctx, this.cfg, {
      sessionId,
      turns,
      limit,
      save: true,
      source: 'ui',
      throwOnError: true,
    })
  }
  /** 删一条摘要。 */
  async deleteNote(args) {
    const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
    const turn = args ? Number(args.turn) : NaN
    if (!sessionId) throw new Error('deleteNote 需要 sessionId')
    if (!Number.isInteger(turn) || turn < 0) throw new Error('deleteNote 需要合法的 turn 号')
    const store = await openNoteStore(this.ctx)
    const deleted = await deleteNote(store, sessionId, turn)
    return { sessionId, turn, deleted }
  }
}

markRemoteMethods(TrajectoryNotesGateway, ['listEntries', 'getEntry', 'summarize', 'deleteNote'])

export { TrajectoryNotesGateway }
