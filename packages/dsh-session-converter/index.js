// dsh-session-converter — DeepSeek Harness 旧会话导入插件
//
// 目标：把旧版 DSH 会话记录（~/.dsh/sessions 下的 session.jsonl.zstd /
// session.vN.jsonl.zstd）中「用户 ↔ Agent 的最终回复」提取出来，作为
// 背景文本注入当前模型上下文。工具调用细节与模型思考（reasoning）
// 默认不保留，保持文本干净、token 可控。
//
// 实现要点：
//   - 只读会话文件，绝不写 ~/.dsh/sessions
//   - 用本机 zstd CLI 解压（DSH 会话是 zstd 多帧 JSONL）
//   - v0 / v3 事件结构不同，但 user/message 与 assistant/message 的
//     content 结构一致，因此用同一套提取逻辑
//   - 工具 import_session 的输出进入模型上下文，完成“背景注入”
//   - 斜杠命令 /import 只做用户侧展示（DSH 命令是 log-only，不进模型）

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-session-converter'
export const inject = ['tools', 'commands']

const DEFAULTS = {
  sessionsDir: join(homedir(), '.dsh', 'sessions'),
  maxChars: 200000,
  includeReasoning: false,
  zstd: '',
}

// ── 配置 ────────────────────────────────────────────────────────────────────

function clampInt(v, d, min, max) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d
}

function findZstd(configured) {
  if (configured) {
    const p = resolve(configured.replace(/^~(?=$|\/)/, homedir()))
    if (existsSync(p)) return p
  }
  const candidates = ['/opt/homebrew/bin/zstd', '/usr/local/bin/zstd', 'zstd']
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' })
      return c
    } catch {
      /* try next */
    }
  }
  throw new Error('zstd not found (expected /opt/homebrew/bin/zstd). Install zstd or set config.zstd.')
}

// ── 会话文件扫描 ────────────────────────────────────────────────────────────

function walkSessionFiles(sessionsDir) {
  const out = []
  function walk(dir) {
    let entries
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
      if (st.isDirectory()) walk(p)
      else if (entry === 'session.jsonl.zstd' || /^session\.v\d+\.jsonl\.zstd$/.test(entry)) {
        out.push({ file: p, dir: dirname(p), name: entry })
      }
    }
  }
  walk(sessionsDir)
  return out
}

/**
 * 按 session 目录去重。同一目录下同时存在 v0 与 v3 时，优先 v0
 * （那是旧版原始记录；v3 通常是迁移产物，内容等价）。
 */
function buildSessionIndex(sessionsDir) {
  const byDir = new Map()
  for (const item of walkSessionFiles(sessionsDir)) {
    const prev = byDir.get(item.dir)
    const priority = item.name === 'session.jsonl.zstd' ? 0 : 1
    if (!prev || priority < prev.priority) byDir.set(item.dir, { ...item, priority })
  }
  return [...byDir.values()]
}

// ── 读取与解析 ──────────────────────────────────────────────────────────────

function decompressJsonl(file, zstd) {
  const text = execFileSync(zstd, ['-dc', file], { encoding: 'utf8', maxBuffer: 1 << 30 })
  const rows = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch {
      // 跳过无法解析的行，尽力提取
    }
  }
  return rows
}

/** 从 content 块数组里提取文本；includeReasoning 为 true 时额外保留 reasoning。 */
function extractContentText(content, includeReasoning = false) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object' && typeof content.text === 'string') return content.text.trim()
    return ''
  }
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (typeof block.text !== 'string') continue
    if (block.type === 'text' || !block.type) parts.push(block.text)
    else if (includeReasoning && block.type === 'reasoning') parts.push(`[思考]\n${block.text}`)
  }
  return parts.join('\n').trim()
}

function parseSession(file, zstd, includeReasoning) {
  const rows = decompressJsonl(file, zstd)
  let header = null
  let title = ''
  const turns = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const type = row.type
    if (type === 'session' && !header) header = row
    if (type === 'session/title') {
      const t = row.data && typeof row.data.title === 'string' ? row.data.title.trim() : ''
      if (t) title = t
    }
    if (type === 'user/message') {
      const text = extractContentText(row.data && row.data.content, includeReasoning)
      if (text) turns.push({ role: 'user', text })
    } else if (type === 'assistant/message') {
      const content = row.data && row.data.message && row.data.message.content
      const text = extractContentText(content, includeReasoning)
      if (text) turns.push({ role: 'assistant', text })
    }
  }
  if (!title) {
    const firstUser = turns.find((t) => t.role === 'user')
    if (firstUser) title = firstUser.text.slice(0, 80)
  }
  const headerId = header && typeof header.id === 'string' ? header.id : basename(dirname(file))
  const headerCwd = header && typeof header.cwd === 'string' ? header.cwd : ''
  const headerCreatedAt = header && typeof header.createdAt === 'number' ? header.createdAt : 0
  return { header, headerId, headerCwd, headerCreatedAt, title, turns }
}

function formatTime(ms) {
  if (!ms) return ''
  try {
    return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
  } catch {
    return String(ms)
  }
}

// ── 列表与转录渲染 ──────────────────────────────────────────────────────────

function summarizeSession(item, zstd, includeReasoning) {
  const s = parseSession(item.file, zstd, includeReasoning)
  return {
    id: s.headerId,
    title: s.title,
    cwd: s.headerCwd,
    createdAt: formatTime(s.headerCreatedAt),
    userMessages: s.turns.filter((t) => t.role === 'user').length,
    assistantMessages: s.turns.filter((t) => t.role === 'assistant').length,
    fileName: item.name,
  }
}

function renderSessionList(list) {
  if (!list.length) return '没有找到可导入的会话。'
  const lines = [`找到 ${list.length} 个可导入会话：`, '']
  for (const s of list) {
    const meta = [s.createdAt, `${s.userMessages} 用户 / ${s.assistantMessages} agent 消息`, s.fileName].filter(Boolean).join(' · ')
    lines.push(`- ${s.id} — ${s.title || '(无标题)'}`)
    lines.push(`  ${meta}`)
    if (s.cwd) lines.push(`  cwd: ${s.cwd}`)
  }
  lines.push('', '请让 agent 调用 import_session(sessionId: "<id>") 导入指定会话作为背景。')
  return lines.join('\n')
}

function buildTranscript(session, maxChars) {
  const meta = [
    `session: ${session.headerId}`,
    `title: ${session.title || '(无标题)'}`,
  ]
  if (session.headerCwd) meta.push(`cwd: ${session.headerCwd}`)
  if (session.headerCreatedAt) meta.push(`createdAt: ${formatTime(session.headerCreatedAt)}`)
  meta.push(`消息数: ${session.turns.length}`)

  let body = ''
  for (const turn of session.turns) {
    const label = turn.role === 'user' ? '用户' : 'Agent'
    body += `\n## ${label}\n\n${turn.text}\n`
  }
  const full = `# 旧会话对话记录\n\n${meta.map((m) => `- ${m}`).join('\n')}\n\n${body.trim()}\n`
  if (full.length <= maxChars) return { text: full, truncated: false, charsTotal: full.length, charsReturned: full.length }

  const head = Math.floor(maxChars * 0.6)
  const tail = Math.max(0, maxChars - head)
  const omitted = full.length - maxChars
  const text = `${full.slice(0, head)}\n\n[…中间省略 ${omitted} 字符，可用 maxChars 调大或分批导入…]\n\n${full.slice(-tail)}`
  return { text, truncated: true, charsTotal: full.length, charsReturned: text.length }
}

function renderImportResult(value) {
  if (typeof value === 'string') return value
  const v = value || {}
  if (v.error) return `Error: ${v.error}`
  if (Array.isArray(v.sessions)) return renderSessionList(v.sessions)
  return v.transcript || '(空转录)'
}

// ── 查找目标会话 ────────────────────────────────────────────────────────────

function findSession(index, zstd, includeReasoning, query) {
  if (!query) return null
  const q = String(query).trim().toLowerCase()
  if (!q) return null

  // 1) session 目录名精确匹配（如 session-xxxx）
  for (const item of index) {
    if (basename(item.dir).toLowerCase() === q) return { item, session: parseSession(item.file, zstd, includeReasoning) }
  }
  // 2) session id 前缀 / 子串匹配
  const sub = index.filter((item) => basename(item.dir).toLowerCase().includes(q))
  if (sub.length === 1) return { item: sub[0], session: parseSession(sub[0].file, zstd, includeReasoning) }
  // 3) 标题 / cwd 关键词匹配
  const fuzzy = index
    .map((item) => ({ item, summary: summarizeSession(item, zstd, includeReasoning) }))
    .filter((x) => x.summary.title.toLowerCase().includes(q) || x.summary.cwd.toLowerCase().includes(q))
  if (fuzzy.length === 1) return { item: fuzzy[0].item, session: parseSession(fuzzy[0].item.file, zstd, includeReasoning) }

  if (sub.length > 1 || fuzzy.length > 1) {
    const ids = [...new Set([...sub, ...fuzzy.map((x) => x.item)])].map((item) => basename(item.dir))
    return { ambiguous: ids }
  }
  return null
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  cfg.sessionsDir = resolve(String(cfg.sessionsDir || DEFAULTS.sessionsDir).replace(/^~(?=$|\/)/, homedir()))
  cfg.maxChars = clampInt(cfg.maxChars, DEFAULTS.maxChars, 5000, 1000000)
  cfg.includeReasoning = cfg.includeReasoning === true || cfg.includeReasoning === 'true'

  let zstd
  try {
    zstd = findZstd(cfg.zstd)
  } catch (e) {
    console.error(`[dsh-session-converter] ${e.message}`)
    return
  }

  const getIndex = () => buildSessionIndex(cfg.sessionsDir)

  ctx.effect(() => () => {
    // 无全局可变状态，无需清理；保留 dispose 槽位以便后续加缓存。
  })

  // 斜杠命令：用户命令平面（DSH 命令是 log-only，不进模型上下文）。
  // 不带参数时列出可导入会话；带 session id / 关键词时直接显示该会话转录。
  try {
    ctx.commands.register({
      name: 'import',
      description: '列出可导入的旧版 DSH 会话；带会话 ID 时直接显示该会话的对话转录（用户可复制）',
      input: { hint: '可选：会话 ID 或标题关键词' },
      handler: (invocation) => {
        try {
          const raw = invocation && typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
          const index = getIndex()
          if (raw) {
            const found = findSession(index, zstd, cfg.includeReasoning, raw)
            if (!found) return Promise.resolve({ kind: 'error', text: `没有找到匹配 "${raw}" 的会话。` })
            if (found.ambiguous) {
              return Promise.resolve({ kind: 'error', text: `关键词匹配到多个会话，请使用更完整的 session id：${found.ambiguous.join(', ')}` })
            }
            const { text } = buildTranscript(found.session, cfg.maxChars)
            return Promise.resolve({ kind: 'success', text })
          }
          const list = index.map((item) => summarizeSession(item, zstd, cfg.includeReasoning))
          list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
          return Promise.resolve({ kind: 'success', text: renderSessionList(list) })
        } catch (e) {
          return Promise.resolve({ kind: 'error', text: `列出会话失败: ${e && e.message ? e.message : e}` })
        }
      },
    })
  } catch (e) {
    console.error(`[dsh-session-converter] 注册 /import 命令失败: ${e && e.message ? e.message : e}`)
  }

  // 工具：真正把旧会话转录注入当前模型上下文。
  ctx.tools.register({
    name: 'import_session',
    description:
      '导入旧版 DeepSeek Harness 会话：列出 ~/.dsh/sessions 下的历史会话，或读取指定会话，' +
      '把「用户 ↔ Agent 的最终回复」整理成背景文本注入当前对话。' +
      '默认不包含模型思考与工具调用；只读原始会话文件，不修改任何数据。' +
      '当用户想延续旧会话、把旧对话作为背景、或说“导入会话/转换会话”时使用此工具。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: {
          type: 'string',
          description: '会话 ID（目录名 session-*）或标题/cwd 关键词；省略时列出所有可导入会话。',
        },
        maxChars: {
          type: 'number',
          description: '返回转录的最大字符数，默认 200000；超出时截头留尾并标注省略。',
        },
        includeReasoning: {
          type: 'boolean',
          description: '是否包含模型思考 reasoning；默认 false（只要最终回复）。',
        },
      },
    },
    // 本地 zstd 解压 + JSON 解析 + 转录构建：并发安全（无共享可变状态）。
    isConcurrencySafe: () => true,
    timeoutMs: 60000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          sessions: { type: 'array', items: { type: 'object' } },
          sessionId: { type: 'string' },
          title: { type: 'string' },
          cwd: { type: 'string' },
          createdAt: { type: 'string' },
          messageCount: { type: 'number' },
          truncated: { type: 'boolean' },
          charsTotal: { type: 'number' },
          charsReturned: { type: 'number' },
          transcript: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderImportResult(value) }],
    },
    async execute(args) {
      try {
        const maxChars = clampInt(args && args.maxChars, cfg.maxChars, 5000, 1000000)
        const includeReasoning = args && args.includeReasoning !== undefined ? args.includeReasoning === true : cfg.includeReasoning
        const index = getIndex()

        if (!args || !args.sessionId) {
          const list = index.map((item) => summarizeSession(item, zstd, includeReasoning))
          list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
          return { sessions: list }
        }

        const found = findSession(index, zstd, includeReasoning, args.sessionId)
        if (!found) return { error: `没有找到匹配 "${args.sessionId}" 的会话。可以先调用 import_session 不带参数查看列表。` }
        if (found.ambiguous) {
          return { error: `关键词匹配到多个会话，请使用更完整的 session id：${found.ambiguous.join(', ')}` }
        }
        const { session } = found
        const { text, truncated, charsTotal, charsReturned } = buildTranscript(session, maxChars)
        return {
          sessionId: session.headerId,
          title: session.title,
          cwd: session.headerCwd,
          createdAt: formatTime(session.headerCreatedAt),
          messageCount: session.turns.length,
          truncated,
          charsTotal,
          charsReturned,
          transcript: text,
        }
      } catch (e) {
        return { error: `导入会话失败: ${e && e.message ? e.message : e}` }
      }
    },
  })

  console.log('[dsh-session-converter] loaded; tool import_session + command /import registered')
}
