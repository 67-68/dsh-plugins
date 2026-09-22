// dsh-trajectory-notes · 总结核心（工具与 Remote 共用）
//
// summarize_trajectory 工具与伴生页"总结"按钮走同一份逻辑，区别只有
// source 标记（tool / ui）与错误形态：
//   - 工具要 { error } 结果对象（渲染成 Error 文本给模型看）；
//   - Remote 要抛错（Typert 把异常传回 client，由 UI 展示）。
// 成功时返回 { sessionId, title, route, notes }，notes 逐条含 saved 标记。

import { readTrajectory, renderTurnText } from './trajectory-reader.js'
import { resolveRoute, summarizeText } from './summarizer.js'
import { openNoteStore, saveNote } from './note-store.js'

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function log(message) {
  try {
    console.log(`[dsh-trajectory-notes] ${message}`)
  } catch (_err) {
    /* 日志失败不影响功能 */
  }
}

/**
 * 读轨迹 → 逐条总结 →（默认）落盘。
 * @param ctx - 插件上下文（需 sessionQuery / llm / storageDomain）。
 * @param cfg - 插件配置（provider/model/timeoutMs/maxTokens/maxTurnsPerCall/maxCharsPerTurn）。
 * @param options.sessionId - 目标会话（必填）。
 * @param options.turns - 指定 turn 列表；空则用 limit 取最近。
 * @param options.limit - turns 为空时取最近多少条。
 * @param options.routeOverride - { provider, model } 覆盖。
 * @param options.save - 是否落盘（默认 true）。
 * @param options.source - 'tool' | 'ui'，写入记录的来源标记。
 * @param options.throwOnError - true 时抛错（Remote 用），false 时返回 { error }（工具用）。
 */
export async function summarizeEntries(ctx, cfg, options) {
  const fail = (message) => {
    if (options.throwOnError) throw new Error(message)
    return { error: message }
  }

  const sessionId = options.sessionId
  if (!sessionId) return fail('缺少 sessionId。')

  const maxTurns = cfg.maxTurnsPerCall || 20
  let trajectory
  try {
    trajectory = await readTrajectory(ctx.sessionQuery, sessionId, { limit: 100000 })
  } catch (err) {
    return fail(`读取轨迹失败: ${(err && err.message) || err}`)
  }
  if (!trajectory.turns.length) return fail(`会话 ${sessionId} 里没有轨迹条目。`)

  const requested = Array.isArray(options.turns)
    ? options.turns.map((n) => Number(n)).filter((n) => Number.isFinite(n))
    : []
  const limit = clampInt(options.limit, 3, 1, maxTurns)

  let selected
  if (requested.length) {
    const wanted = new Set(requested)
    selected = trajectory.turns.filter((entry) => wanted.has(entry.turn))
  } else {
    selected = trajectory.turns.slice(-limit)
  }
  if (!selected.length) {
    return fail(`没匹配到要总结的轨迹条目（该会话共 ${trajectory.turnCount} 条）。`)
  }

  let route
  try {
    route = resolveRoute(options.routeOverride || {}, trajectory.route)
  } catch (err) {
    return fail((err && err.message) || String(err))
  }

  const shouldSave = options.save === undefined ? true : options.save === true
  const source = options.source === 'ui' ? 'ui' : 'tool'
  let store = null
  let storeError = ''
  if (shouldSave) {
    try {
      store = await openNoteStore(ctx)
    } catch (err) {
      storeError = (err && err.message) || String(err)
      log(`存储打开失败，本次只返回不落盘：${storeError}`)
    }
  }

  const notes = []
  for (const entry of selected) {
    const text = renderTurnText(entry).slice(0, cfg.maxCharsPerTurn || 24000)
    let result
    try {
      result = await summarizeText(ctx, {
        text,
        route,
        sessionId: trajectory.sessionId,
        timeoutMs: cfg.timeoutMs,
        maxTokens: cfg.maxTokens,
      })
    } catch (err) {
      const message = `turn ${entry.turn} 摘要失败: ${(err && err.message) || err}`
      if (options.throwOnError) throw new Error(message)
      notes.push({ turn: entry.turn, startSeq: entry.startSeq, endSeq: entry.endSeq, summary: '', chars: 0, saved: false, saveError: message })
      continue
    }
    const note = {
      turn: entry.turn,
      startSeq: entry.startSeq,
      endSeq: entry.endSeq,
      summary: result.summary,
      chars: result.chars,
    }
    // 落盘失败不丢摘要：fail-soft，逐条标记 saved/saveError。
    if (store) {
      try {
        await saveNote(store, {
          sessionId: trajectory.sessionId,
          turn: entry.turn,
          startSeq: entry.startSeq,
          endSeq: entry.endSeq == null ? null : entry.endSeq,
          title: trajectory.title || '',
          summary: result.summary,
          model: route,
          stepCount: entry.stepCount,
          toolCallCount: entry.toolCalls.length,
          errorCount: entry.errorCount,
          source,
        })
        note.saved = true
      } catch (err) {
        note.saved = false
        note.saveError = (err && err.message) || String(err)
      }
    } else {
      note.saved = false
      if (storeError) note.saveError = storeError
    }
    notes.push(note)
  }

  return {
    sessionId: trajectory.sessionId,
    title: trajectory.title,
    route,
    notes,
  }
}
