/**
 * Reusable goal engine for mode-gate.
 *
 * A "goal" is a forced, phase-bound piece of work:
 *   - prompt: injected when the goal is active
 *   - onActivate: run once when the goal becomes active; may return extra
 *     prompt text, messages, and state patches (for example auto-reading a
 *     feature intent so the agent does not have to search for one)
 *   - allowedTools / allowedBash: the ONLY tools and bash verbs callable while
 *     the goal is active (plus control tools)
 *   - requiredCalls: tool calls that must be observed before the goal can be
 *     submitted / auto-completed
 *   - submitTool: optional tool whose successful submission completes the goal
 *   - onSubmit / onComplete: transition to the next phase/goal
 */

const CONTROL_TOOLS = [
  'declare_target',
  'dev_tool_search',
  'request_extra',
  'skill_search',
  'switch_mode',
];

export function defineGoal(def) {
  if (!def || typeof def !== 'object') throw new TypeError('goal 定义必须是对象');
  if (typeof def.id !== 'string' || def.id.length === 0) throw new TypeError('goal.id 必须是非空字符串');
  if (typeof def.phase !== 'string' || def.phase.length === 0) throw new TypeError(`goal "${def.id}" 缺少 phase`);
  if (typeof def.prompt !== 'string' && typeof def.prompt !== 'function') {
    throw new TypeError(`goal "${def.id}" 缺少 prompt`);
  }
  if (typeof def.prompt === 'string' && def.prompt.length === 0) throw new TypeError(`goal "${def.id}" prompt 不能为空`);
  if (!Array.isArray(def.allowedTools)) throw new TypeError(`goal "${def.id}" 缺少 allowedTools`);
  if (!Array.isArray(def.allowedBash)) throw new TypeError(`goal "${def.id}" 缺少 allowedBash`);
  return def;
}

export function createGoalEngine({ goals, log }) {
  const definitions = new Map();
  for (const raw of goals || []) {
    const def = defineGoal(raw);
    definitions.set(def.id, def);
  }

  const logger = typeof log === 'function' ? log : () => {};

  function get(id) {
    return definitions.get(id);
  }

  function defFor(state) {
    const goal = state && state.goal;
    if (!goal || typeof goal.id !== 'string') return void 0;
    return definitions.get(goal.id);
  }

  function allowedToolSet(def) {
    const set = new Set(CONTROL_TOOLS);
    for (const tool of def.allowedTools) set.add(tool);
    return set;
  }

  function isSubmitTool(def, toolName) {
    return def && def.submitTool && def.submitTool.name === toolName;
  }

  function requiredCallsSatisfied(state, def) {
    const calls = (state && state.goal && state.goal.calls) || {};
    for (const req of def.requiredCalls || []) {
      if ((calls[req.tool] || 0) < (req.min || 1)) return false;
    }
    return true;
  }

  /**
   * Activate a goal. Returns { prompt, messages, statePatch } where statePatch
   * already contains the new goal record (id/status/startedAt) plus any
   * patches produced by `onActivate`.
   */
  async function activate(goalId, env) {
    const def = definitions.get(goalId);
    if (!def) throw new Error(`未知目标 "${goalId}"`);
    const baseGoal = {
      id: def.id,
      status: 'active',
      startedAt: Date.now(),
      calls: {},
    };
    let action = {};
    if (typeof def.onActivate === 'function') {
      try {
        action = (await def.onActivate(env)) || {};
      } catch (err) {
        logger(`goal ${goalId} onActivate failed: ${(err && err.message) || err}`);
        action = { prompt: `（目标自动激活动作失败：${(err && err.message) || err}）` };
      }
    }
    const prompt = typeof action.prompt === 'string'
      ? action.prompt
      : (typeof def.prompt === 'function' ? def.prompt(env) : def.prompt);
    return {
      prompt,
      messages: Array.isArray(action.messages) ? action.messages : [],
      statePatch: {
        goal: {
          ...baseGoal,
          prompt,
          ...(action.goalPatch || {}),
        },
        ...(action.statePatch || {}),
      },
    };
  }

  /** Record a successful call of `toolName` against the current goal. */
  function recordCall(state, toolName) {
    if (!state || !state.goal) return state;
    const def = definitions.get(state.goal.id);
    if (!def) return state;
    const isRequired = (def.requiredCalls || []).some((req) => req.tool === toolName);
    if (!isRequired) return state;
    const calls = { ...(state.goal.calls || {}) };
    calls[toolName] = (calls[toolName] || 0) + 1;
    return {
      ...state,
      goal: { ...state.goal, calls },
    };
  }

  /** True when a no-submit goal has satisfied its required calls. */
  function isAutoCompleted(state, def) {
    return def && !def.submitTool && requiredCallsSatisfied(state, def);
  }

  /**
   * Validate and complete a submit-tool call.
   * Returns { ok:false, reason } or { ok:true, transition }.
   */
  async function submit(toolName, args, state, env) {
    const def = defFor(state);
    if (!def) return { ok: false, reason: '当前没有激活的目标' };
    if (!isSubmitTool(def, toolName)) {
      return { ok: false, reason: `当前目标 "${def.id}" 不通过 ${toolName} 提交` };
    }
    if (!requiredCallsSatisfied(state, def)) {
      const missing = (def.requiredCalls || [])
        .filter((req) => ((state.goal.calls || {})[req.tool] || 0) < (req.min || 1))
        .map((req) => `${req.tool}（至少 ${req.min || 1} 次）`)
        .join('、');
      return { ok: false, reason: `提交协议前必须先完成：${missing}` };
    }
    let parsed;
    try {
      parsed = await def.submitTool.parse(args, env);
    } catch (err) {
      return { ok: false, reason: `协议校验失败：${(err && err.message) || err}` };
    }
    if (!parsed) return { ok: false, reason: '协议解析结果为空' };

    if (typeof def.onSubmit !== 'function') {
      return { ok: false, reason: `目标 "${def.id}" 缺少 onSubmit 转换定义` };
    }
    const transition = await def.onSubmit(parsed, env);
    if (!transition || typeof transition !== 'object') {
      return { ok: false, reason: `目标 "${def.id}" onSubmit 未返回转换` };
    }
    return { ok: true, transition };
  }

  /** Build the transition for a no-submit goal whose required calls are met. */
  async function autoComplete(state, env) {
    const def = defFor(state);
    if (!def || !isAutoCompleted(state, def)) return void 0;
    if (typeof def.onComplete !== 'function') {
      return { nextPhase: state.phase, nextGoal: null, statePatch: {} };
    }
    return def.onComplete(env, state);
  }

  return {
    definitions,
    get,
    defFor,
    allowedToolSet,
    isSubmitTool,
    requiredCallsSatisfied,
    activate,
    recordCall,
    isAutoCompleted,
    submit,
    autoComplete,
  };
}
