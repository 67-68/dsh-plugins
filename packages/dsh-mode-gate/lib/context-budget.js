/**
 * 上下文预算表（硬编码）。
 *
 * CREATE 循环默认**不再经过 ACCUMULATION**：只有当前上下文估算 tokens 超过本表
 * 的预算时，阶段转移才把下一阶段切换为 ACCUMULATE（压缩沉淀）。
 *
 * 预算表按 workflow / stage 给出，未命中时回落到 DEFAULT_CONTEXT_BUDGET_TOKENS。
 * 数值故意写成硬编码常量，便于单测与后续按模型能力调整；tokens 使用 CJK 感知
 * 的保守估算（见 architecture-store.estimateTokens）。
 */

import { estimateTokens } from './architecture-store.js';

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
 * 阶段转移时的完整预算判定：
 *   - overBudget：原始判定（按硬编码预算表）；
 *   - compressionBoundary：当前阶段是否是允许压缩的迭代边界；
 *   - compressionAllowed：只有「超预算 且 在边界」才允许切到 ACCUMULATE。
 * index.js 只把 compressionAllowed 注入 transitions 的 context.overBudget，
 * 这样即便配置写错，迭代内部也不会压缩。
 */
export function budgetDecision({ workflowId, stateId, contextTokens } = {}) {
  const status = contextStatus({ workflowId, stateId, contextTokens });
  const compressionBoundary = isCompressionBoundary(workflowId, stateId);
  return {
    ...status,
    compressionBoundary,
    compressionAllowed: status.overBudget && compressionBoundary,
  };
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
