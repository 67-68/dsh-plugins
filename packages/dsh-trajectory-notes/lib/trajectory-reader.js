// dsh-trajectory-notes · 轨迹读取层（只读）
//
// 「一条轨迹」= 会话日志里的一个 turn（`turn/start` … `turn/end`）。DSH 的
// 轨迹页就是 turn → step → event 的账本，所以这里按同一粒度折叠，保证伴生
// 页面与原生轨迹页条目一一对应。
//
// 只读契约：
//   - 会话日志是 append-only 的（事件 seq 连续、从不改写），本模块只读。
//   - 读取走官方服务 ctx.sessionQuery（listSessions / readSession），不自己
//     解压 session.jsonl.zstd，避免和格式演进脱钩。
//   - 事件文本提取复用官方 extractSessionEventText，只对未显式处理的类型兜底。

import { extractSessionEventText } from '@deepseek-ai/dsh-session-query'

export const PLUGIN_ID = 'dsh-trajectory-notes'

/** user/message 里真正的「人」说的消息；插件注入的 notice / skill 说明不算。 */
const HUMAN_SOURCE_KIND = 'user'

const PREVIEW_CHARS = 200
const MAX_ARGS_CHARS = 300
const MAX_TOOL_CALLS_PER_TURN = 40

/** 非主流程但带语义、值得进摘要输入的事件类型。 */
const OTHER_TEXT_TYPES = new Set([
  'compaction/summary',
  'compaction/start',
  'compaction/end',
  'system/message',
  'session/end-seed',
])

// ── 消息内容提取 ────────────────────────────────────────────────────────────

/** 取出 content 块数组里的可见文本（text 块；reasoning 不算）。 */
function textOfBlocks(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object' && typeof content.text === 'string') return content.text.trim()
    return ''
  }
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (typeof block.text !== 'string') continue
    if (block.type === 'text' || block.type === undefined) parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** reasoning 块单独取，默认不进摘要输入（token 太贵、且多是过程噪声）。 */
function reasoningOfBlocks(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 这条 user/message 是不是人发的（插件注入的 notice 会标 source.kind=plugin）。 */
export function isHumanUserMessage(event) {
  const source = event && event.data && event.data.source
  if (!source || typeof source !== 'object') return true
  if (typeof source.kind !== 'string') return true
  return source.kind === HUMAN_SOURCE_KIND
}

function clip(text, max) {
  const value = String(text == null ? '' : text)
  return value.length <= max ? value : `${value.slice(0, max)}…(+${value.length - max} 字符)`
}

// ── turn 折叠 ──────────────────────────────────────────────────────────────

/**
 * 把完整事件日志折叠成 turn 列表。
 * `turn/start` 开一个条目，`turn/end` 收口；两侧之外的杂项事件（session 头、
 * 标题、权限预设等）收进 preamble，不参与摘要。
 */
export function groupTurns(events) {
  const turns = []
  const preamble = []
  let current = null

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'turn/start') {
      current = {
        turn: Number((event.data && event.data.turn) != null ? event.data.turn : turns.length + 1),
        startSeq: event.seq,
        startTime: event.time,
        endSeq: null,
        endTime: null,
        endReason: null,
        events: [],
      }
      turns.push(current)
      continue
    }
    if (event.type === 'turn/end') {
      if (current) {
        current.endSeq = event.seq
        current.endTime = event.time
        current.endReason = (event.data && event.data.reason) || null
        current = null
      }
      continue
    }
    if (current) current.events.push(event)
    else preamble.push(event)
  }

  return { turns, preamble }
}

/** 从 session/title 事件里取标题。 */
function foldTitle(events) {
  let title = ''
  for (const event of events) {
    if (!event || event.type !== 'session/title') continue
    const value = event.data && event.data.title
    if (typeof value === 'string' && value.trim()) title = value.trim()
  }
  return title
}

/** 最近一次实际使用的路由（provider/model），用于摘要调用默认走同一模型。 */
export function lastRoute(events) {
  let route = null
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const data = event.data || {}
    if (event.type === 'model/selection') {
      if (typeof data.provider === 'string' && typeof data.model === 'string') {
        route = { provider: data.provider, model: data.model }
      }
    } else if (event.type === 'request/header') {
      const config = (data.header && data.header.config) || data.config
      if (config && typeof config.provider === 'string' && typeof config.model === 'string') {
        route = { provider: config.provider, model: config.model }
      }
    }
  }
  return route
}

/** 一个 turn 里的工具调用结果索引：callId → isError。 */
function collectToolResults(events) {
  const results = new Map()
  for (const event of events) {
    if (!event || event.type !== 'tool/result') continue
    const message = (event.data && event.data.message) || {}
    const first = Array.isArray(message.content) ? message.content[0] : null
    const callId = first && first.toolCallId != null ? String(first.toolCallId) : null
    const isError = Boolean((first && first.isError) || (event.data && event.data.error))
    if (callId) results.set(callId, isError)
  }
  return results
}

/**
 * 把一个 turn 折叠成条目。文本型字段保留原文（供模型阅读），
 * 工具调用只留 name/成败/参数预览（避免摘要输入被工具输出淹没）。
 */
export function buildTurnEntry(turn) {
  const events = turn.events
  const results = collectToolResults(events)

  const userTexts = []
  const assistantTexts = []
  const otherTexts = []
  const reasoningChars = { total: 0 }
  const toolCalls = []
  const toolNames = []
  const eventTypes = new Map()
  let stepCount = 0
  let errorCount = 0

  for (const event of events) {
    const type = event.type
    eventTypes.set(type, (eventTypes.get(type) || 0) + 1)

    if (type === 'step/start') {
      stepCount += 1
      continue
    }
    if (type === 'user/message') {
      if (!isHumanUserMessage(event)) continue
      const text = textOfBlocks(event.data && event.data.content)
      if (text) userTexts.push(text)
      continue
    }
    if (type === 'assistant/message') {
      const blocks = event.data && event.data.message && event.data.message.content
      const text = textOfBlocks(blocks)
      if (text) assistantTexts.push(text)
      const reasoning = reasoningOfBlocks(blocks)
      if (reasoning) reasoningChars.total += reasoning.length
      continue
    }
    if (type === 'tool/call') {
      const data = event.data || {}
      const callId = data.callId != null ? String(data.callId) : ''
      const isError = results.get(callId) === true
      if (isError) errorCount += 1
      const name = String(data.name || '')
      if (toolCalls.length < MAX_TOOL_CALLS_PER_TURN) {
        toolCalls.push({
          name,
          isError,
          argsPreview: clip(data.arguments, MAX_ARGS_CHARS),
        })
      }
      toolNames.push(name)
      continue
    }
    // 其余类型：只有少数带语义（上文压缩、系统消息、注入的 seed）值得进摘要
    // 输入，走官方文本提取兜底，其余结构性事件（step/turn/approval 等）丢弃。
    if (OTHER_TEXT_TYPES.has(type)) {
      const text = extractSessionEventText(event)
      if (text) otherTexts.push(text)
    }
  }

  const endReasonKind = turn.endReason && typeof turn.endReason === 'object'
    ? String(turn.endReason.kind || '')
    : ''

  return {
    turn: turn.turn,
    startSeq: turn.startSeq,
    endSeq: turn.endSeq,
    startTime: turn.startTime,
    endTime: turn.endTime,
    endReasonKind,
    stepCount,
    userTexts,
    assistantTexts,
    otherTexts,
    toolCalls,
    toolNames,
    errorCount,
    reasoningChars: reasoningChars.total,
    eventCount: events.length,
    eventTypes: Object.fromEntries(eventTypes),
  }
}

/** 条目预览（列表页 / 工具列表用），不返回全文。 */
export function turnPreview(entry) {
  const firstUser = entry.userTexts[0] || ''
  const firstAssistant = entry.assistantTexts[0] || ''
  return {
    turn: entry.turn,
    startSeq: entry.startSeq,
    endSeq: entry.endSeq,
    stepCount: entry.stepCount,
    toolCallCount: entry.toolCalls.length,
    errorCount: entry.errorCount,
    userPreview: clip(firstUser, PREVIEW_CHARS),
    assistantPreview: clip(firstAssistant, PREVIEW_CHARS),
    endReasonKind: entry.endReasonKind,
  }
}

/** 渲染一个条目供模型阅读的文本（摘要引擎的输入）。 */
export function renderTurnText(entry, options = {}) {
  const includeReasoning = options.includeReasoning === true
  const lines = [
    `# 轨迹条目 · turn ${entry.turn}`,
    '',
    `- seq: ${entry.startSeq} … ${entry.endSeq == null ? '(未收口)' : entry.endSeq}`,
    `- step 数: ${entry.stepCount}`,
    `- 工具调用: ${entry.toolCalls.length} 次${entry.errorCount ? `（失败 ${entry.errorCount} 次）` : ''}`,
    `- 结束原因: ${entry.endReasonKind || '(无)'}`,
    '',
    '## 用户输入',
    '',
    entry.userTexts.length ? entry.userTexts.join('\n\n') : '(本轮没有人类输入，可能是 agent 自驱或注入轮)',
    '',
    '## Agent 最终回复',
    '',
    entry.assistantTexts.length ? entry.assistantTexts.join('\n\n') : '(无文本回复)',
    '',
  ]

  if (includeReasoning && entry.reasoningChars > 0) {
    lines.push(`## 思考`, '', `（本轮含 ${entry.reasoningChars} 字符 reasoning，已按配置省略）`, '')
  }

  if (entry.otherTexts && entry.otherTexts.length) {
    lines.push('## 附带事件（压缩/系统消息）', '', entry.otherTexts.map((t) => clip(t, 2000)).join('\n\n'), '')
  }

  if (entry.toolCalls.length) {
    lines.push('## 工具调用序列', '')
    for (const call of entry.toolCalls) {
      lines.push(`- ${call.name}${call.isError ? ' [失败]' : ''} — ${clip(call.argsPreview, MAX_ARGS_CHARS)}`)
    }
    if (entry.toolCalls.length < entry.toolNames.length) {
      lines.push(`- …（其余 ${entry.toolNames.length - entry.toolCalls.length} 次已省略）`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ── 对外：列出 / 读取 ──────────────────────────────────────────────────────

function normalizeLimit(value, fallback, max) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

/**
 * 列出会话（只读 header，不解压任何日志，保证列表快）。
 * @param sessionQuery - ctx.sessionQuery 服务。
 * @param signal - 可选取消信号。
 */
export async function listSessions(sessionQuery, signal) {
  const records = await sessionQuery.listSessions(signal)
  return (Array.isArray(records) ? records : [])
    .map((record) => {
      const header = (record && record.header) || {}
      return {
        sessionId: header.id != null ? String(header.id) : '',
        cwd: typeof header.cwd === 'string' ? header.cwd : '',
        createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
        live: Boolean(record && record.live),
        persisted: Boolean(record && record.persisted),
        origin: header.origin || '',
        parentSession: header.parentSession != null ? String(header.parentSession) : '',
      }
    })
    .filter((item) => item.sessionId)
    .sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * 读一个会话的完整轨迹（turn 列表）。全程只读，不触碰会话日志的写入面。
 * @param sessionQuery - ctx.sessionQuery 服务。
 * @param sessionId - 目标会话 id。
 * @param options.limit - 最多返回多少个 turn（默认全部）。
 * @param options.tail - true 时从末尾取（默认 true，最近的在最后）。
 */
export async function readTrajectory(sessionQuery, sessionId, options = {}) {
  const snapshot = await sessionQuery.readSession(sessionId)
  const events = Array.isArray(snapshot && snapshot.events) ? snapshot.events : []
  const { turns } = groupTurns(events)

  const entries = turns.map(buildTurnEntry)
  const limit = normalizeLimit(options.limit, entries.length, 100000)
  const selected = limit >= entries.length ? entries : entries.slice(entries.length - limit)

  const header = (snapshot && snapshot.session) || {}
  return {
    sessionId: header.id != null ? String(header.id) : String(sessionId),
    title: foldTitle(events),
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
    route: lastRoute(events),
    eventCount: events.length,
    turnCount: entries.length,
    truncated: selected.length < entries.length,
    turns: selected,
  }
}
