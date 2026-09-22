// dsh-trajectory-notes · 摘要引擎
//
// 直接调 `ctx.llm.stream`（不经过任何 agent turn），范式抄官方
// `@deepseek-ai/dsh-session-title-llm`：
//   - createUserMessage 包输入，system 给固定指令
//   - BlockAssembler 收流、判定 finish 终态
//   - deadline() 给辅助调用兜底超时（辅助调用绝不能挂死主流程）
//
// 路由解析顺序：显式配置 provider/model > 会话最近一次实际路由 > 抛错。
// 显式传 route 可以让「总结」用一个便宜的模型，而不用主对话模型。

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { deadline } from '@deepseek-ai/dsh-timeout'

export const TIMEOUT_CODE = 'TRAJECTORY_NOTES_TIMEOUT'
export const DEFAULT_TIMEOUT_MS = 120000
export const DEFAULT_MAX_TOKENS = 700

const SYSTEM_PROMPT = [
  '你是一个 DSH 会话轨迹的摘要器。用户会给你一条轨迹条目（一次 turn）的完整内容：用户输入、Agent 最终回复、工具调用序列。',
  '请用中文写一条简洁的摘要，说明：这轮用户想要什么、Agent 实际做了什么、结论或产出是什么、有没有失败或未完成的事项。',
  '要求：',
  '- 只描述这条条目里真实存在的内容，不要推测、不要补充外部知识。',
  '- 控制在 3 句话以内，不要 Markdown 标题，不要列表符号。',
  '- 如果这轮没有产出结论或中途被中断，直接说明这一点。',
].join('\n')

/** finish 终态 → 错误（stop 是唯一正常收口）。 */
function finishError(finish) {
  if (!finish || typeof finish !== 'object') return null
  switch (finish.kind) {
    case 'stop':
      return null
    case 'error':
    case 'aborted': {
      const failure = finish.failure || {}
      const error = new Error(failure.message || `摘要调用被中止（${finish.kind}）`)
      if (failure.code) error.code = failure.code
      return error
    }
    case 'max-tokens':
      return new Error('摘要输出达到 maxTokens 上限，请调大 maxTokens 或缩短输入')
    case 'tool-calls':
      return new Error('摘要模型意外发起了工具调用')
    default:
      return new Error(`摘要调用以不支持的终态结束：${String(finish.kind)}`)
  }
}

/** 解析本次调用要用的路由。 */
export function resolveRoute(config, sessionRoute) {
  const provider = config && typeof config.provider === 'string' ? config.provider.trim() : ''
  const model = config && typeof config.model === 'string' ? config.model.trim() : ''
  if (provider && model) return { provider, model }
  if (sessionRoute && sessionRoute.provider && sessionRoute.model) {
    return { provider: sessionRoute.provider, model: sessionRoute.model }
  }
  throw new Error(
    'dsh-trajectory-notes: 无法确定摘要模型路由——会话日志里没有可用的 provider/model，' +
    '请在插件配置里显式设置 provider 与 model',
  )
}

/**
 * 对一段轨迹文本生成摘要。
 * @param ctx - 插件上下文（需注入 llm）。
 * @param options.text - 输入文本（见 renderTurnText 的输出）。
 * @param options.route - { provider, model }。
 * @param options.sessionId - 归属会话（计费/日志归属，避免串到别的会话）。
 * @param options.signal - 上游取消信号。
 * @returns { summary, model, chars }
 */
export async function summarizeText(ctx, options) {
  const text = String(options.text || '')
  if (!text.trim()) throw new Error('dsh-trajectory-notes: 摘要输入为空')

  const route = options.route
  if (!route || !route.provider || !route.model) {
    throw new Error('dsh-trajectory-notes: summarizeText 需要显式 route')
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS
  const maxTokens = Number.isFinite(options.maxTokens) && options.maxTokens > 0
    ? options.maxTokens
    : DEFAULT_MAX_TOKENS

  const gate = deadline(options.signal, timeoutMs, TIMEOUT_CODE)
  try {
    const messages = [
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-trajectory-notes' },
      }),
    ]

    const assembler = new BlockAssembler()
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      system: SYSTEM_PROMPT,
      maxTokens,
      sessionId: options.sessionId,
      purpose: 'trajectory-note',
      signal: gate.signal,
    })

    // 每步都 throwIfAborted：provider 即便忽略 signal，超时/取消也必须在
    // 这里显形（辅助调用绝不能悄悄挂住调用方）。
    gate.signal.throwIfAborted()
    for await (const chunk of stream) {
      gate.signal.throwIfAborted()
      assembler.push(chunk)
    }
    gate.signal.throwIfAborted()

    const terminal = finishError(assembler.finish)
    if (terminal) throw terminal

    const blocks = assembler.blocks()
    if (blocks.some((block) => block.type === 'tool-call')) {
      throw new Error('dsh-trajectory-notes: 摘要输出必须只有文本')
    }
    const summary = blocks
      .filter((block) => block.type === 'text')
      .map((block) => String(block.text || '').trim())
      .filter(Boolean)
      .join(' ')
      .trim()

    if (!summary) throw new Error('dsh-trajectory-notes: 摘要模型没有产出文本')

    return { summary, model: route, chars: summary.length }
  } finally {
    try {
      gate[Symbol.dispose]()
    } catch (_err) {
      /* 定时器清理失败不影响结果 */
    }
  }
}
