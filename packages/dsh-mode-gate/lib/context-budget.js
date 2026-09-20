/**
 * 上下文预算表（硬编码）。
 *
 * CREATE 循环默认**不再经过 ACCUMULATION**：只有当前上下文估算 tokens 超过本表
 * 的预算时，阶段转移才把下一阶段切换为 ACCUMULATE（压缩沉淀）。
 *
 * 预算表按 workflow / stage 给出，未命中时回落到 DEFAULT_CONTEXT_BUDGET_TOKENS。
 * 数值故意写成硬编码常量，便于单测与后续按模型能力调整；tokens 使用 CJK 感知
 * 的保守估算（见 architecture-store.estimateTokens）。
 *
 * 模型压缩点（见 model-compression.js）优先参与决策：当能解析出当前阶段
 * 具体模型时，用其有效压缩点（用户填写优先，否则自带默认）代替本表预算；
 * 无模型信息时回落到本表。
 */

import { estimateTokens } from './architecture-store.js';
import { effectiveCompressionPoint } from './model-compression.js';

export const DEFAULT_CONTEXT_BUDGET_TOKENS = 64000;

export const CONTEXT_BUDGET_TABLE = {
  create: {
    BASE_READ: 64000,
    REQUIREMENT_RECOGNITION: 64000,
    FEATURE_UPDATE: 64000,
    RESEARCH: 64000,
    EXECUTE: 64000,
    DEBUG: 64000,
    ACCUMULATION: 64000,
    INIT: 64000,
  },
  rough: {
    BASE_READ: 64000,
    REQUIREMENT_RECOGNITION: 64000,
    RESEARCH: 64000,
    IMPLEMENT: 64000,
  },
};

/** 取某个 workflow/stage 的硬编码预算 tokens。 */
export function budgetFor(workflowId, stateId) {
  const table = CONTEXT_BUDGET_TABLE[String(workflowId || '')];
  if (table) {
    if (Number.isFinite(table[stateId])) return table[stateId];
    if (Number.isFinite(table.default)) return table.default;
  }
  return DEFAULT_CONTEXT_BUDGET_TOKENS;
}

/** 尽量把一条 message 的文本抽出来（兼容 string / content[] / text）。 */
export function messageText(message) {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;
        try {
          return JSON.stringify(part);
        } catch (_err) {
          return '';
        }
      })
      .join('\n');
  }
  if (typeof message.text === 'string') return message.text;
  return '';
}

/** 估算一轮请求 messages 的上下文 tokens（偏保守，宁可提前压缩）。 */
export function estimateMessagesTokens(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let total = 0;
  for (const message of list) {
    total += estimateTokens(messageText(message));
    total += 4; // 每条消息的 role / 结构开销
  }
  return total;
}

/** 按硬编码预算表判定当前上下文是否超预算。 */
export function contextStatus({ workflowId, stateId, contextTokens } = {}) {
  const raw = Number(contextTokens);
  const tokens = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  const budget = budgetFor(workflowId, stateId);
  return {
    tokens,
    budget,
    overBudget: tokens > budget,
    ratio: budget > 0 ? Number((tokens / budget).toFixed(3)) : 0,
  };
}

/**
 * 压缩边界（硬编码）：只有这些**离开状态**的阶段转移允许因超预算进入 ACCUMULATE。
 *
 * CREATE 的一个迭代是 RESEARCH → EXECUTE → DEBUG：
 *   - DEBUG 结束 = 一个迭代结束 → 到下一轮 RESEARCH/结束前允许压缩；
 *   - RESEARCH→EXECUTE、EXECUTE→DEBUG 属于迭代内部 → 绝不触发压缩。
 * ROUGH 没有 ACCUMULATION，故为空表。
 */
export const COMPRESSION_BOUNDARY_STATES = {
  create: ['DEBUG'],
  rough: [],
};

export function isCompressionBoundary(workflowId, stateId) {
  const list = COMPRESSION_BOUNDARY_STATES[String(workflowId || '')];
  return Array.isArray(list) && list.includes(stateId);
}

/**
 * 按模型压缩点解析预算。返回：
 * - null：无模型信息（调用方回落到硬编码预算表）；
 * - { supported: true, budget, ... }：用有效压缩点（用户填写优先，否则自带默认）作为压缩阈值。
 */
export function modelBudgetFor(modelId, contextWindow, overrides) {
  const ref = typeof modelId === 'string' ? modelId.trim() : '';
  if (!ref) return null;
  const effective = effectiveCompressionPoint(ref, contextWindow, overrides);
  if (!effective || !Number.isFinite(effective.point)) return null;
  return { supported: true, budget: effective.point, modelId: ref, label: effective.label, origin: effective.origin };
}

/**
 * 阶段转移时的完整预算判定：
 *   - budget：优先使用当前阶段模型的有效压缩点（用户填写优先，否则自带默认），
 *     无模型信息时回落到硬编码预算表；
 *   - overBudget：tokens 是否超过生效预算；
 *   - compressionBoundary：当前阶段是否是允许压缩的迭代边界；
 *   - compressionAllowed：只有「超预算 且 在边界」才允许切到 ACCUMULATE。
 * index.js 只把 compressionAllowed 注入 transitions 的 context.overBudget，
 * 这样即便配置写错，迭代内部也不会压缩。
 */
export function budgetDecision({ workflowId, stateId, contextTokens, modelId, contextWindow, overrides } = {}) {
  const raw = Number(contextTokens);
  const tokens = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  const modelBudget = modelBudgetFor(modelId, contextWindow, overrides);
  let budget;
  let budgetSource;
  if (modelBudget && modelBudget.supported) {
    budget = modelBudget.budget;
    budgetSource = { type: 'model-compression-point', modelId: modelBudget.modelId, label: modelBudget.label, origin: modelBudget.origin };
  } else {
    budget = budgetFor(workflowId, stateId);
    budgetSource = { type: 'legacy-table', reason: 'no-model-info' };
  }
  const overBudget = tokens > budget;
  const compressionBoundary = isCompressionBoundary(workflowId, stateId);
  return {
    tokens,
    budget,
    budgetSource,
    overBudget,
    ratio: budget > 0 ? Number((tokens / budget).toFixed(3)) : 0,
    compressionBoundary,
    compressionAllowed: overBudget && compressionBoundary,
  };
}

/**
 * 追踪上下文用量（单调峰值）：每次请求只带来当轮 messages 的估算值，
 * 而压缩判定发生在 submit 时刻（当轮请求很小），因此必须保留本轮迭代的
 * 峰值 peakTokens 并用它做预算判定；ACCUMULATE 压缩完成后由调用方重置。
 * sample: { tokens, modelId, contextWindow }。
 */
export function trackContextUsage(prev, sample) {
  const prevRec = prev && typeof prev === 'object' ? prev : {};
  const tokens = Number(sample && sample.tokens);
  const now = Number.isFinite(tokens) ? Math.max(0, Math.floor(tokens)) : 0;
  const prevPeak = Number(prevRec.peakTokens);
  const peakTokens = Math.max(Number.isFinite(prevPeak) ? prevPeak : 0, now);
  const modelId = typeof (sample && sample.modelId) === 'string' && sample.modelId.trim()
    ? sample.modelId.trim()
    : (typeof prevRec.modelId === 'string' ? prevRec.modelId : '');
  const windowRaw = sample && Number.isFinite(sample.contextWindow) ? sample.contextWindow : prevRec.contextWindow;
  return {
    tokens: now,
    peakTokens,
    modelId,
    contextWindow: Number.isFinite(windowRaw) ? windowRaw : null,
    at: Date.now(),
    workflowId: (sample && sample.workflowId) || prevRec.workflowId || null,
    stateId: (sample && sample.stateId) || prevRec.stateId || null,
  };
}

/** 重置峰值（压缩完成后调用，下一轮迭代重新累积）。 */
export function resetContextPeak(prev) {
  const prevRec = prev && typeof prev === 'object' ? prev : {};
  return { ...prevRec, tokens: 0, peakTokens: 0, at: Date.now() };
}

/** 按优先级选出预算判定用的模型 id：首个非空即中。 */
export function resolveBudgetModelId(candidates) {
  for (const cand of Array.isArray(candidates) ? candidates : []) {
    if (typeof cand === 'string' && cand.trim()) return cand.trim();
  }
  return '';
}

/**
 * 校验工作流配置是否只在压缩边界声明 context.overBudget。
 * 返回违规列表；空数组表示合规（可用于回归测试 / 启动自检）。
 */
export function validateCompressionBoundaries(workflowDef) {
  const workflowId = workflowDef && workflowDef.id;
  const states = Array.isArray(workflowDef && workflowDef.states) ? workflowDef.states : [];
  const violations = [];
  for (const state of states) {
    const id = state && state.id;
    const declares = Boolean(state && Array.isArray(state.transitions)
      && state.transitions.some((tr) => tr && tr.when && tr.when.type === 'context.overBudget'));
    const allowed = isCompressionBoundary(workflowId, id);
    if (declares && !allowed) violations.push({ state: id, reason: '在非压缩边界声明了 context.overBudget' });
    if (allowed && !declares) violations.push({ state: id, reason: '压缩边界未声明 context.overBudget' });
  }
  return violations;
}
