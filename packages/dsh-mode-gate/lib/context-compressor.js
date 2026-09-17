/**
 * checklist-13：ACCUMULATE 的上下文压缩。
 *
 * 分两层：
 *   1. 插件 hot 层：loopMemory 只保留最近 KEEP_LOOP_BLOCKS 条（它是唯一会注入
 *      短期信息的插件上下文层）；
 *   2. harness 会话层：尽力调用 `ctx.compaction.compactRegion` 把最老的、安全的
 *      一段会话区间压成一条 summary，保留最近 KEEP_RECENT_SURFACE_NODES 个节点。
 *
 * 压缩是**有序的收尾动作**：调用方必须先完成长期文档整理。压缩失败/不可用一律
 * 静默降级（记录 reason），绝不阻塞工作流。
 */

import { estimateTokens } from './architecture-store.js';

export const KEEP_LOOP_BLOCKS = 3;
export const KEEP_RECENT_SURFACE_NODES = 12;

export const LONG_TERM_DOCS_FIRST_MESSAGE =
  '请先完成长期文档整理（pattern_reason + pattern_write）再调用 compress_context：ACCUMULATE 必须先整理长期文档，再压缩上下文。';

/** 顺序门禁：必须先完成长期文档整理，才允许压缩上下文。 */
export function assertLongTermDocsFirst(calls) {
  const value = calls && typeof calls === 'object' ? calls : {};
  if (!value.pattern_reason || !value.pattern_write) throw new Error(LONG_TERM_DOCS_FIRST_MESSAGE);
}

/** 压缩插件 hot 层：loopMemory 只保留最近 KEEP_LOOP_BLOCKS 条。 */
export function compressLoopMemory(memory) {
  const source = memory && typeof memory === 'object'
    ? memory
    : { iteration: 0, blocks: [], updatedAt: 0 };
  const blocks = Array.isArray(source.blocks) ? source.blocks : [];
  return {
    ...source,
    blocks: blocks.slice(-KEEP_LOOP_BLOCKS),
    compactedAt: Date.now(),
  };
}

/** 选出可尝试压缩的旧 surface 区间（保留最近 keepRecent 个节点）；无法确定返回 null。 */
export function pickCompactRange(session, keepRecent = KEEP_RECENT_SURFACE_NODES) {
  const nodes = session && session.surface && Array.isArray(session.surface.nodes)
    ? session.surface.nodes
    : [];
  if (nodes.length <= keepRecent + 1) return null;
  const endIndex = nodes.length - keepRecent - 1;
  if (endIndex < 0) return null;
  return { start: nodes[0], end: nodes[endIndex] };
}

/** 尽力压缩 harness 会话；任何失败都降级为 { compacted:false, reason }。 */
export async function compressSession(agent, ctx) {
  let engine = null;
  try {
    engine = ctx && ctx.compaction;
  } catch (_err) {
    engine = null;
  }
  if (!engine || typeof engine.compactRegion !== 'function') {
    return { compacted: false, reason: 'compaction-unavailable' };
  }
  const range = pickCompactRange(agent && agent.session);
  if (!range) return { compacted: false, reason: 'no-safe-range' };
  try {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const result = await engine.compactRegion(range.start, range.end, agent, controller ? controller.signal : undefined);
    return {
      compacted: true,
      shadowedSeqs: Array.isArray(result && result.shadowedSeqs) ? result.shadowedSeqs.length : 0,
      shadowedTokens: Number.isFinite(result && result.shadowedTokenCount) ? result.shadowedTokenCount : 0,
    };
  } catch (err) {
    return { compacted: false, reason: (err && err.message) || 'compact-failed' };
  }
}

/**
 * 一次完整压缩：先尽力压缩 harness 会话，再压缩 hot loopMemory。
 * @returns {{ loopMemory: object, compression: object }}
 */
export async function compressContext(agent, ctx, state) {
  const session = await compressSession(agent, ctx);
  const previous = state && state.loopMemory && typeof state.loopMemory === 'object' ? state.loopMemory : {};
  const from = Array.isArray(previous.blocks) ? previous.blocks.length : 0;
  const loopMemory = compressLoopMemory(previous);
  const contextUsage = state && state.contextUsage && typeof state.contextUsage === 'object'
    ? state.contextUsage
    : null;
  const hotTokens = estimateTokens(
    [loopMemory.summary || '', ...(loopMemory.blocks || []).map((block) => (block && block.text) || '')].join('\n'),
  );
  return {
    loopMemory,
    compression: {
      at: Date.now(),
      session,
      loopMemory: { from, to: Array.isArray(loopMemory.blocks) ? loopMemory.blocks.length : 0 },
      contextTokens: contextUsage && Number.isFinite(contextUsage.tokens) ? contextUsage.tokens : 0,
      hotTokens,
    },
  };
}
