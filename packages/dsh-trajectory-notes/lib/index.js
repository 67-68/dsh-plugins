// dsh-trajectory-notes · host 入口
//
// 目标：让模型能读会话轨迹（一条轨迹 = 一个 turn）并逐条生成摘要。
//
// 关键设计约束（两条都是踩过的坑，别改）：
//   1) 会话日志 append-only，只读。读取走 ctx.sessionQuery，绝不写 sessions。
//   2) 插件工具「全局注册」模型是看不见的：宿主/门禁会把 global 层用 allow
//      限制压到 built-ins，而 restriction 只能收窄、不能放大。因此可见性
//      只能靠 agent scope 注册（restriction 不影响 scoped registration），
//      也就是在 agent/created 时往 agent.ctx.tools 里再注册一份。
//
// 本阶段（checklist-1）只做读取层 + 摘要引擎 + 模型可见工具；持久化字段与
// 伴生页面分别由后续 checklist 接上。
// checklist-2：摘要落专属存储 trajectory_notes（per-record domain），
// summarize_trajectory 默认落盘，另有 list/delete 工具；UI 层见 checklist-3。

import { defineTool } from '@deepseek-ai/dsh-tools'

import { listSessions, readTrajectory, renderTurnText, turnPreview, PLUGIN_ID } from './trajectory-reader.js'
import { DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS } from './summarizer.js'
import { openNoteStore, listNotes, deleteNote } from './note-store.js'
import { summarizeEntries } from './summarize-entries.js'
import { TrajectoryNotesGateway } from './remote.js'

export const name = PLUGIN_ID
export const inject = ['tools', 'sessionQuery', 'llm', 'storageDomain']

const LOG_PREFIX = `[${PLUGIN_ID}]`

const DEFAULTS = {
  /** 摘要调用显式路由；留空则用会话最近一次实际路由。 */
  provider: '',
  model: '',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxTokens: DEFAULT_MAX_TOKENS,
  /** 单次工具调用最多处理多少个 turn（防止模型一把梭把整个会话灌进 LLM）。 */
  maxTurnsPerCall: 20,
  /** 单条轨迹送进摘要模型的最大字符数。 */
  maxCharsPerTurn: 24000,
}

function log(message) {
  try {
    console.log(`${LOG_PREFIX} ${message}`)
  } catch (_err) {
    /* 日志失败不影响功能 */
  }
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/** 取当前 agent 的会话 id（工具调用时优先用 exec.agent，其次参数）。 */
function sessionIdOf(exec, args) {
  const fromArgs = args && typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
  if (fromArgs) return fromArgs
  const agent = exec && exec.agent
  const id = agent && agent.session && agent.session.id
  return typeof id === 'string' && id ? id : ''
}

function formatTime(ms) {
  if (!ms) return ''
  try {
    return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
  } catch (_err) {
    return String(ms)
  }
}

// ── 工具实现 ────────────────────────────────────────────────────────────────

function makeListTrajectories(ctx) {
  return {
    name: 'list_trajectories',
    description:
      '列出 DSH 会话轨迹。不给 sessionId 时列出所有会话；给 sessionId 时列出该会话的轨迹条目' +
      '（一条轨迹 = 一个 turn，含用户输入预览、step 数、工具调用数、失败数与结束原因）。' +
      '只读会话数据，不修改任何会话内容。当用户问「有哪些会话/这个会话有哪些轨迹/轨迹列表」时使用。',
    parameters: {
      sessionId: { type: 'string', description: '会话 id；省略时列出所有会话。' },
      limit: { type: 'number', description: '列出的轨迹条目上限（默认 50，从最新的往回取）。' },
    },
    isConcurrencySafe: () => true,
    timeoutMs: 60000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          sessions: { type: 'array', items: { type: 'object', additionalProperties: true } },
          sessionId: { type: 'string' },
          title: { type: 'string' },
          turnCount: { type: 'number' },
          turns: { type: 'array', items: { type: 'object', additionalProperties: true } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderListResult(value) }],
    },
    async execute(args, exec) {
      try {
        const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
        if (!sessionId) {
          const sessions = await listSessions(ctx.sessionQuery)
          return { sessions }
        }
        const limit = clampInt(args && args.limit, 50, 1, 1000)
        const trajectory = await readTrajectory(ctx.sessionQuery, sessionId, { limit })
        return {
          sessionId: trajectory.sessionId,
          title: trajectory.title,
          turnCount: trajectory.turnCount,
          turns: trajectory.turns.map(turnPreview),
        }
      } catch (err) {
        return { error: `列出轨迹失败: ${(err && err.message) || err}` }
      }
    },
  }
}

function makeReadTrajectory(ctx, cfg) {
  return {
    name: 'read_trajectory',
    description:
      '读取 DSH 会话轨迹的正文（一条轨迹 = 一个 turn）。指定 turn 时只读该条；' +
      '省略时读取最近若干条。返回内容含用户输入、Agent 最终回复与工具调用序列，' +
      '供你理解这一轮到底发生了什么。只读，不修改会话。',
    parameters: {
      sessionId: { type: 'string', description: '会话 id；省略时用当前会话。' },
      turn: { type: 'number', description: '只读取该序号（turn 号）的轨迹条目；省略时读取最近若干条。' },
      limit: { type: 'number', description: '省略 turn 时读取的条目数上限（默认 5，从最新的往回取）。' },
      includeReasoning: { type: 'boolean', description: '是否附加模型思考信息（默认 false，只占位不展开正文）。' },
    },
    isConcurrencySafe: () => true,
    timeoutMs: 60000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string' },
          turnCount: { type: 'number' },
          entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderReadResult(value) }],
    },
    async execute(args, exec) {
      try {
        const sessionId = sessionIdOf(exec, args)
        if (!sessionId) return { error: '缺少 sessionId，且当前会话不可用。' }
        const includeReasoning = Boolean(args && args.includeReasoning)
        const turn = args && args.turn != null ? Number(args.turn) : null

        const trajectory = await readTrajectory(ctx.sessionQuery, sessionId, {
          limit: turn != null ? 100000 : clampInt(args && args.limit, 5, 1, cfg.maxTurnsPerCall),
        })

        const selected = turn != null
          ? trajectory.turns.filter((entry) => entry.turn === turn)
          : trajectory.turns

        if (!selected.length) {
          return {
            error: `没找到 turn ${turn}（该会话共 ${trajectory.turnCount} 条轨迹）。先用 list_trajectories 看可用条目。`,
          }
        }

        return {
          sessionId: trajectory.sessionId,
          title: trajectory.title,
          turnCount: trajectory.turnCount,
          entries: selected.map((entry) => ({
            turn: entry.turn,
            startSeq: entry.startSeq,
            endSeq: entry.endSeq,
            text: renderTurnText(entry, { includeReasoning }),
          })),
        }
      } catch (err) {
        return { error: `读取轨迹失败: ${(err && err.message) || err}` }
      }
    },
  }
}

function makeSummarizeTrajectory(ctx, cfg) {
  return {
    name: 'summarize_trajectory',
    description:
      '读取 DSH 会话的一条或多条轨迹，并让模型逐条生成摘要（每次调用独立总结一条轨迹）。' +
      '指定 turns 时只总结这些序号；省略时总结最近若干条。摘要默认存入专属存储' +
      '（trajectory_notes domain，可由伴生页面展示），也会返回给你。' +
      '只读会话数据，不修改会话内容。',
    parameters: {
      sessionId: { type: 'string', description: '会话 id；省略时用当前会话。' },
      turns: { type: 'array', items: { type: 'number' }, description: '要总结的 turn 序号列表；省略时用 limit 取最近若干条。' },
      limit: { type: 'number', description: 'turns 省略时，总结最近多少条（默认 3）。' },
      provider: { type: 'string', description: '摘要模型 provider 覆盖；省略时用插件配置或会话实际路由。' },
      model: { type: 'string', description: '摘要模型 model 覆盖；省略时用插件配置或会话实际路由。' },
      save: { type: 'boolean', description: '是否存入专属存储（默认 true；设为 false 则只返回、不落盘）。' },
    },
    isConcurrencySafe: () => false,
    timeoutMs: cfg.timeoutMs + 30000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string' },
          notes: { type: 'array', items: { type: 'object', additionalProperties: true } },
          route: { type: 'object', additionalProperties: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSummaryResult(value) }],
    },
    async execute(args, exec) {
      try {
        const sessionId = sessionIdOf(exec, args)
        if (!sessionId) return { error: '缺少 sessionId，且当前会话不可用。' }
        const turns = Array.isArray(args && args.turns)
          ? args.turns.map((n) => Number(n)).filter((n) => Number.isFinite(n))
          : []
        return await summarizeEntries(ctx, cfg, {
          sessionId,
          turns,
          limit: args && args.limit,
          routeOverride: {
            provider: (args && args.provider) || cfg.provider,
            model: (args && args.model) || cfg.model,
          },
          save: !args || args.save === undefined ? true : args.save === true,
          source: 'tool',
          throwOnError: false,
        })
      } catch (err) {
        return { error: `生成轨迹摘要失败: ${(err && err.message) || err}` }
      }
    },
  }
}

function makeListTrajectoryNotes(ctx) {
  return {
    name: 'list_trajectory_notes',
    description:
      '列出已保存的轨迹摘要（专属存储 trajectory_notes）。不给 sessionId 时列出' +
      '当前会话的；给 turn 时只返回该条。摘要按 turn 升序。只读存储，不碰会话。',
    parameters: {
      sessionId: { type: 'string', description: '会话 id；省略时用当前会话。' },
      turn: { type: 'number', description: '只返回该 turn 的摘要；省略时返回该会话全部。' },
    },
    isConcurrencySafe: () => true,
    timeoutMs: 30000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          sessionId: { type: 'string' },
          notes: { type: 'array', items: { type: 'object', additionalProperties: true } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderNotesResult(value) }],
    },
    async execute(args, exec) {
      try {
        const sessionId = sessionIdOf(exec, args)
        if (!sessionId) return { error: '缺少 sessionId，且当前会话不可用。' }
        const store = await openNoteStore(ctx)
        const turn = args && args.turn != null ? Number(args.turn) : null
        if (turn != null) {
          const record = store.table.get(`${sessionId}--${turn}`)
          if (!record) return { error: `会话 ${sessionId} 的 turn ${turn} 还没有保存摘要。` }
          return { sessionId, notes: [record] }
        }
        return { sessionId, notes: listNotes(store, sessionId) }
      } catch (err) {
        return { error: `列出轨迹摘要失败: ${(err && err.message) || err}` }
      }
    },
  }
}

function makeDeleteTrajectoryNote(ctx) {
  return {
    name: 'delete_trajectory_note',
    description:
      '删除一条已保存的轨迹摘要（专属存储 trajectory_notes）。只删摘要记录，' +
      '绝不改动会话轨迹本身。',
    parameters: {
      sessionId: { type: 'string', description: '会话 id；省略时用当前会话。' },
      turn: { type: 'number', required: true, description: '要删除的 turn 号。' },
    },
    isConcurrencySafe: () => false,
    timeoutMs: 30000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          sessionId: { type: 'string' },
          turn: { type: 'number' },
          deleted: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderDeleteResult(value) }],
    },
    async execute(args, exec) {
      try {
        const sessionId = sessionIdOf(exec, args)
        if (!sessionId) return { error: '缺少 sessionId，且当前会话不可用。' }
        const turn = Number(args && args.turn)
        if (!Number.isInteger(turn) || turn < 0) return { error: 'turn 必须是大于等于 0 的整数。' }
        const store = await openNoteStore(ctx)
        const deleted = await deleteNote(store, sessionId, turn)
        return { sessionId, turn, deleted }
      } catch (err) {
        return { error: `删除轨迹摘要失败: ${(err && err.message) || err}` }
      }
    },
  }
}

// ── 结果渲染 ────────────────────────────────────────────────────────────────

function renderListResult(value) {
  if (!value || value.error) return `Error: ${(value && value.error) || '未知错误'}`
  if (Array.isArray(value.sessions)) {
    if (!value.sessions.length) return '没有找到任何会话。'
    const lines = [`共 ${value.sessions.length} 个会话：`, '']
    for (const s of value.sessions) {
      const flags = [s.live ? 'live' : 'persisted', s.origin || ''].filter(Boolean).join('/')
      lines.push(`- ${s.sessionId} — ${formatTime(s.createdAt)} [${flags}]`)
      if (s.cwd) lines.push(`  cwd: ${s.cwd}`)
    }
    lines.push('', '用 list_trajectories(sessionId) 看某个会话的轨迹条目。')
    return lines.join('\n')
  }
  const turns = Array.isArray(value.turns) ? value.turns : []
  const lines = [
    `会话 ${value.sessionId}（${value.title || '无标题'}）共 ${value.turnCount} 条轨迹，显示最近 ${turns.length} 条：`,
    '',
  ]
  for (const t of turns) {
    lines.push(`- turn ${t.turn}（seq ${t.startSeq}…${t.endSeq == null ? '?' : t.endSeq}）`)
    lines.push(`  step ${t.stepCount} · 工具 ${t.toolCallCount} 次${t.errorCount ? `（失败 ${t.errorCount}）` : ''}${t.endReasonKind ? ` · 结束原因 ${t.endReasonKind}` : ''}`)
    if (t.userPreview) lines.push(`  用户: ${t.userPreview}`)
    if (t.assistantPreview) lines.push(`  Agent: ${t.assistantPreview}`)
  }
  return lines.join('\n')
}

function renderReadResult(value) {
  if (!value || value.error) return `Error: ${(value && value.error) || '未知错误'}`
  const entries = Array.isArray(value.entries) ? value.entries : []
  const head = `会话 ${value.sessionId}（${value.title || '无标题'}）共 ${value.turnCount} 条轨迹，读取 ${entries.length} 条：`
  return [head, '', ...entries.map((e, i) => (i ? '\n---\n\n' : '') + e.text)].join('\n')
}

function renderSummaryResult(value) {
  if (!value || value.error) return `Error: ${(value && value.error) || '未知错误'}`
  const notes = Array.isArray(value.notes) ? value.notes : []
  if (!notes.length) return '没有生成任何摘要。'
  const route = value.route ? `${value.route.provider}/${value.route.model}` : ''
  const lines = [
    `会话 ${value.sessionId}（${value.title || '无标题'}）生成了 ${notes.length} 条摘要${route ? `（模型 ${route}）` : ''}：`,
    '',
  ]
  for (const note of notes) {
    const savedMark = note.saved === true ? '已保存' : (note.saveError ? `未保存：${note.saveError}` : '未保存（save=false）')
    lines.push(`- turn ${note.turn}（seq ${note.startSeq}…${note.endSeq == null ? '?' : note.endSeq}）[${savedMark}]`)
    lines.push(`  ${note.summary}`)
  }
  return lines.join('\n')
}

function renderNotesResult(value) {
  if (!value || value.error) return `Error: ${(value && value.error) || '未知错误'}`
  const notes = Array.isArray(value.notes) ? value.notes : []
  if (!notes.length) return `会话 ${value.sessionId} 还没有保存任何轨迹摘要。用 summarize_trajectory 生成。`
  const lines = [`会话 ${value.sessionId} 已保存 ${notes.length} 条轨迹摘要：`, '']
  for (const note of notes) {
    const route = note.model ? `${note.model.provider}/${note.model.model}` : ''
    lines.push(`- turn ${note.turn}（seq ${note.startSeq}…${note.endSeq == null ? '?' : note.endSeq}）${route ? `模型 ${route} · ` : ''}来源 ${note.source || 'tool'}`)
    lines.push(`  ${note.summary}`)
  }
  return lines.join('\n')
}

function renderDeleteResult(value) {
  if (!value || value.error) return `Error: ${(value && value.error) || '未知错误'}`
  return value.deleted
    ? `已删除会话 ${value.sessionId} 的 turn ${value.turn} 摘要。`
    : `会话 ${value.sessionId} 的 turn ${value.turn} 本来就没有摘要，无需删除。`
}

// ── 注册 ────────────────────────────────────────────────────────────────────

/** 工具 spec 表：全局层注册一份（供 dev_tool_search 发现），agent 层再注册一份（真正可见）。 */
function buildToolSpecs(ctx, cfg) {
  return [
    makeListTrajectories(ctx),
    makeReadTrajectory(ctx, cfg),
    makeSummarizeTrajectory(ctx, cfg),
    makeListTrajectoryNotes(ctx),
    makeDeleteTrajectoryNote(ctx),
  ]
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  cfg.timeoutMs = clampInt(cfg.timeoutMs, DEFAULTS.timeoutMs, 1000, 600000)
  cfg.maxTokens = clampInt(cfg.maxTokens, DEFAULTS.maxTokens, 64, 8000)
  cfg.maxTurnsPerCall = clampInt(cfg.maxTurnsPerCall, DEFAULTS.maxTurnsPerCall, 1, 200)
  cfg.maxCharsPerTurn = clampInt(cfg.maxCharsPerTurn, DEFAULTS.maxCharsPerTurn, 1000, 200000)
  cfg.provider = typeof cfg.provider === 'string' ? cfg.provider.trim() : ''
  cfg.model = typeof cfg.model === 'string' ? cfg.model.trim() : ''

  const specs = buildToolSpecs(ctx, cfg)

  // 全局层：让 dev_tool_search / 其它插件能发现这些工具。
  ctx.effect(() => {
    const disposers = []
    for (const spec of specs) {
      try {
        const dispose = ctx.tools.register(defineTool(spec))
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (err) {
        log(`全局注册工具 ${spec.name} 失败：${(err && err.message) || err}`)
      }
    }
    log(`全局注册完成：${specs.map((s) => s.name).join('、')}`)
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (_err) {
          /* 单个清理失败忽略 */
        }
      }
    }
  }, 'dsh-trajectory-notes: global tools')

  // agent 层：宿主会把 global 层压到 built-ins，只有 scope 注册才真正可见。
  const scopedDisposers = new Map()

  function clearScoped(sessionId) {
    const prev = scopedDisposers.get(sessionId)
    if (!prev) return
    for (const dispose of prev) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch (_err) {
        /* 单个清理失败忽略 */
      }
    }
    scopedDisposers.delete(sessionId)
  }

  function provisionScoped(agent) {
    const sessionId = agent && agent.session ? agent.session.id : undefined
    if (sessionId === undefined) return
    const agentTools = agent.ctx && agent.ctx.tools
    if (!agentTools || typeof agentTools.register !== 'function') {
      log('agent scope 工具不可用，退回全局注册（需 dev_tool_search 解锁）')
      return
    }
    clearScoped(sessionId)
    const disposers = []
    for (const spec of specs) {
      try {
        const dispose = agentTools.register(defineTool(spec))
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (err) {
        log(`agent scope 注册工具 ${spec.name} 失败：${(err && err.message) || err}`)
      }
    }
    if (disposers.length) scopedDisposers.set(sessionId, disposers)
    log(`agent scope 供给 ${disposers.length} 个工具：${sessionId}`)
  }

  ctx.on('agent/created', ({ agent }) => {
    try {
      provisionScoped(agent)
    } catch (err) {
      log(`agent scope 供给失败：${(err && err.message) || err}`)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    try {
      const sessionId = agent && agent.session ? agent.session.id : undefined
      if (sessionId !== undefined) clearScoped(sessionId)
    } catch (err) {
      log(`agent scope 清理失败：${(err && err.message) || err}`)
    }
  })

  ctx.effect(() => () => {
    for (const sessionId of [...scopedDisposers.keys()]) clearScoped(sessionId)
  }, 'dsh-trajectory-notes: scoped tools')

  // Remote 网关（checklist-3 伴生页的数据面）：与工具共用 summarizeEntries，
  // source 记 'ui'。TypertRemoteService 构造即在 ctx 上注册为服务，生命周期
  // 随插件 fiber（参考 mode-gate 的 ModeGateGateway，同款写法）。
  try {
    new TrajectoryNotesGateway(ctx, { cfg })
    log('remote 网关已挂载：trajectoryNotes')
  } catch (err) {
    log(`remote 网关挂载失败（伴生页不可用，工具不受影响）：${(err && err.message) || err}`)
  }

  log(`loaded; tools=${specs.map((s) => s.name).join('、')}`)
}
