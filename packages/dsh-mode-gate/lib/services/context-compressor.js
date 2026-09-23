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

import { estimateTokens } from '../stores/architecture-store.js';

export const KEEP_LOOP_BLOCKS = 3;
/**
 * 最近尾部至少保留的 tokens。压缩只吃掉比这更老的安全区间，
 * 避免把刚发生的工作（当前 checklist 的上下文）一起压掉。
 */
export const KEEP_RECENT_SURFACE_TOKENS = 8000;
/** 没有 token 计量时的兜底：按节点数保留最近 N 个。 */
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

/** 一条 surface 事件对「未闭合 tool-call 数」的影响。 */
function surfaceEventDelta(event) {
  if (!event || typeof event !== 'object') return 0;
  if (event.type === 'tool/result') return -1;
  if (event.type !== 'assistant/message') return 0;
  const content = event.data && event.data.message && Array.isArray(event.data.message.content)
    ? event.data.message.content
    : [];
  let calls = 0;
  for (const block of content) {
    if (block && block.type === 'tool-call') calls += 1;
  }
  return calls;
}

/**
 * 折叠出每个切点的配对平衡性：`cutBalanced[k]` 表示「第 k 个节点之前的切点」
 * 是否没有未闭合的 tool-call。压缩区间两端都必须落在平衡切点上，否则会把
 * assistant 的 tool-call 和它的 tool/result 拆开，compactRegion 会直接拒绝。
 */
function foldToolPairing(session, seqs) {
  const cutBalanced = [true];
  let open = 0;
  for (const seq of seqs) {
    const event = session && typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
    if (event === undefined) throw new Error(`surface seq ${seq} 没有对应的会话事件`);
    open += surfaceEventDelta(event);
    if (open < 0) throw new Error(`surface seq ${seq} 的 tool/result 没有对应的 tool-call`);
    cutBalanced.push(open === 0);
  }
  return cutBalanced;
}

/** surface 头节点是否是 system/message（该节点永不进入压缩区间）。 */
function isSystemHead(session, seq) {
  try {
    const event = session && typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
    // 读不到就保守地当成 system head：宁可少压一个节点，也不冒丢掉系统提示的风险。
    return event === undefined || event.type === 'system/message';
  } catch (_err) {
    return true;
  }
}

/**
 * 选出一段可安全压缩的旧 surface 区间；无法确定时返回 null（宁可不压）。
 *
 * 与 harness 自己的 selectCompactableRange 同构：
 *   1. token 计量与当前 surface 必须对齐，否则退化为按节点数保留；
 *   2. 保留最近一段（优先按 tokens 预算，无计量时按节点数）不动；
 *   3. 起点从第一个非 system 节点开始，终点向前退到配对平衡的切点。
 *
 * @param {object} session - 提供 surface.nodes 与 eventAt 的会话。
 * @param {object|null} measurement - ctx.tokenMeter.measure(session) 的结果，可为 null。
 * @param {number} retainTokens - 最近尾部至少保留的 tokens。
 */
export function pickCompactRange(session, measurement, retainTokens = KEEP_RECENT_SURFACE_TOKENS) {
  const surfaceNodes = session && session.surface && Array.isArray(session.surface.nodes)
    ? session.surface.nodes
    : [];
  if (surfaceNodes.length === 0) return null;
  const firstIdx = isSystemHead(session, surfaceNodes[0]) ? 1 : 0;
  if (surfaceNodes.length <= firstIdx + 1) return null;

  const priced = measurement && Array.isArray(measurement.nodes) ? measurement.nodes : [];
  const aligned = priced.length === surfaceNodes.length
    && surfaceNodes.every((seq, index) => seq === priced[index].seq);

  let cutBalanced;
  try {
    cutBalanced = foldToolPairing(session, surfaceNodes);
  } catch (_err) {
    // surface 本身不自洽（例如 tool/result 找不到配对）时不冒险压缩。
    return null;
  }

  let keepFromIdx;
  if (aligned && Number(retainTokens) > 0) {
    let accumulated = 0;
    keepFromIdx = surfaceNodes.length;
    for (let index = surfaceNodes.length - 1; index >= 0; index -= 1) {
      accumulated += Number(priced[index].tokens) || 0;
      keepFromIdx = index;
      if (accumulated >= retainTokens) break;
    }
  } else {
    keepFromIdx = Math.max(0, surfaceNodes.length - KEEP_RECENT_SURFACE_NODES);
  }
  while (keepFromIdx > firstIdx && !cutBalanced[keepFromIdx]) keepFromIdx -= 1;
  if (keepFromIdx <= firstIdx) return null;
  return { start: surfaceNodes[firstIdx], end: surfaceNodes[keepFromIdx - 1] };
}

/** 取 harness 的压缩服务；不可用返回 null（含未 inject 时属性读取抛错的情况）。 */
function compactionEngine(ctx) {
  try {
    const engine = ctx && (ctx.compaction
      || (typeof ctx.get === 'function' ? ctx.get('compaction') : null));
    if (!engine || typeof engine.compactRegion !== 'function') return null;
    return engine;
  } catch (_err) {
    return null;
  }
}

/** 取当前 surface 的计量（含逐节点 tokens）；不可用返回 null。 */
function measureSurface(ctx, session) {
  try {
    const meter = ctx && (ctx.tokenMeter
      || (typeof ctx.get === 'function' ? ctx.get('tokenMeter') : null));
    if (!meter || typeof meter.measure !== 'function') return null;
    return meter.measure(session);
  } catch (_err) {
    return null;
  }
}

/**
 * 真正压缩 harness 会话：把最老的、安全的一段 surface 换成一个 summary。
 *
 * 失败一律降级为 { compacted:false, reason }，绝不阻塞工作流；但结果里会带上
 * 判定依据（range / 失败原因），让「压缩到底有没有发生」可审计——历史上这里
 * 因为插件没有 inject compaction，永远只返回 compaction-unavailable。
 */
export async function compressSession(agent, ctx) {
  const engine = compactionEngine(ctx);
  if (!engine) return { compacted: false, reason: 'compaction-unavailable' };
  const session = agent && agent.session;
  if (!session) return { compacted: false, reason: 'no-session' };
  const measurement = measureSurface(ctx, session);
  const range = pickCompactRange(session, measurement);
  if (!range) return { compacted: false, reason: 'no-safe-range' };
  try {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const result = await engine.compactRegion(range.start, range.end, agent, controller ? controller.signal : undefined);
    return {
      compacted: true,
      range: { start: range.start, end: range.end },
      shadowedSeqs: Array.isArray(result && result.shadowedSeqs) ? result.shadowedSeqs.length : 0,
      shadowedTokens: Number.isFinite(result && result.shadowedTokenCount) ? result.shadowedTokenCount : 0,
    };
  } catch (err) {
    return {
      compacted: false,
      reason: (err && err.message) || 'compact-failed',
      range: { start: range.start, end: range.end },
    };
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
      // 明确的压缩结果态：harness 历史到底有没有真的被压掉，一眼可判。
      compacted: Boolean(session && session.compacted),
      reason: session && session.compacted ? null : ((session && session.reason) || 'unknown'),
      session,
      loopMemory: { from, to: Array.isArray(loopMemory.blocks) ? loopMemory.blocks.length : 0 },
      contextTokens: contextUsage && Number.isFinite(contextUsage.tokens) ? contextUsage.tokens : 0,
      hotTokens,
    },
  };
}
