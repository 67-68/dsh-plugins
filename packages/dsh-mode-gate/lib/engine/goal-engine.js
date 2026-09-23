/**
 * Goal engine for mode-gate workflows.
 *
 * A goal is a forced, state-bound piece of work:
 *   - prompt: string or (env, state) => string, injected while active
 *   - onActivate: run once when the goal becomes active; may return
 *     { prompt?, messages?, statePatch? }
 *   - allowedTools: additional tool restriction on top of the state permissions
 *   - requiredCalls: tool calls that must be observed before submit/auto-complete
 *   - submitTool: optional tool whose successful submission completes the goal
 *
 * Completion returns a RAW result `{ signal?, statePatch?, prompt? }`.
 * Resolving that result into the next workflow/state is the caller's job,
 * because only the caller has the workflow config and the transition table.
 */

const CONTROL_TOOLS = [
  'dev_tool_search',
  'request_extra',
  'skill_search',
  'skill_load',
  'switch_mode',
  'submit_state',
  'goto_accumulation',
  'accumulation_and_init',
];

export function defineGoal(def) {
  if (!def || typeof def !== 'object') throw new TypeError('goal 定义必须是对象');
  if (typeof def.id !== 'string' || def.id.length === 0) throw new TypeError('goal.id 必须是非空字符串');
  if (typeof def.prompt !== 'string' && typeof def.prompt !== 'function') {
    throw new TypeError(`goal "${def.id}" 缺少 prompt`);
  }
  if (!Array.isArray(def.allowedTools)) throw new TypeError(`goal "${def.id}" 缺少 allowedTools`);
  return def;
}

export function createGoalEngine({ goals, log }) {
  const definitions = new Map();
  for (const raw of goals || []) definitions.set(raw.id, defineGoal(raw));

  const logger = typeof log === 'function' ? log : () => {};

  function get(id) {
    return definitions.get(id);
  }

  function defFor(state) {
    const goal = state && state.goal;
    if (!goal || typeof goal.id !== 'string') return void 0;
    return definitions.get(goal.id);
  }

  // Tools that let the agent unlock new capabilities on its own.
  // Goals with `lockUnlockTools: true` (e.g. requirement recognition, where
  // the agent must focus on decomposing instead of reading files) deny them.
  // submit_state / switch_mode stay available so the agent can still advance.
  const UNLOCK_TOOLS = ['dev_tool_search', 'request_extra'];

  function allowedToolSet(def) {
    const set = new Set(CONTROL_TOOLS);
    for (const tool of def.allowedTools || []) set.add(tool);
    if (def && def.lockUnlockTools) {
      for (const tool of UNLOCK_TOOLS) set.delete(tool);
    }
    return set;
  }

  /** True when the active goal forbids self-unlocking new tools. */
  function unlockLocked(state) {
    const def = defFor(state);
    return Boolean(def && def.lockUnlockTools);
  }

  function isSubmitTool(def, toolName) {
    return Boolean(def && def.submitTool && def.submitTool.name === toolName);
  }

  function requiredCallsSatisfied(state, def) {
    const calls = (state && state.goal && state.goal.calls) || {};
    for (const req of def.requiredCalls || []) {
      if ((calls[req.tool] || 0) < (req.min || 1)) return false;
    }
    return true;
  }

  function promptFor(def, env, state) {
    return typeof def.prompt === 'function' ? def.prompt(env, state) : def.prompt;
  }

  /** Activate a goal and return { prompt, messages, statePatch }. */
  async function activate(goalId, env, state) {
    const def = definitions.get(goalId);
    if (!def) throw new Error(`未知目标 "${goalId}"`);
    let action = {};
    if (typeof def.onActivate === 'function') {
      try {
        action = (await def.onActivate(env, state)) || {};
      } catch (err) {
        logger(`goal ${goalId} onActivate failed: ${(err && err.message) || err}`);
        action = { prompt: `（目标自动激活动作失败：${(err && err.message) || err}）` };
      }
    }
    const patch = { ...(action.statePatch || {}) };
    const nextState = { ...state, ...patch };
    const prompt = typeof action.prompt === 'string' ? action.prompt : promptFor(def, env, nextState);
    const goal = {
      id: def.id,
      status: 'active',
      startedAt: Date.now(),
      calls: {},
      toolCount: 0,
      iteration: (state && ((state.goal && state.goal.iteration) || (state.loopMemory && state.loopMemory.iteration))) || 0,
      ...(action.goalPatch || {}),
    };
    return {
      prompt,
      messages: Array.isArray(action.messages) ? action.messages : [],
      statePatch: { ...patch, goal: { ...goal, prompt } },
    };
  }

  /** Record a successful call of `toolName` against the current goal. */
  function recordCall(state, toolName) {
    if (!state || !state.goal) return state;
    const def = definitions.get(state.goal.id);
    if (!def) return state;
    const isRequired = (def.requiredCalls || []).some((req) => req.tool === toolName);
    const calls = { ...(state.goal.calls || {}) };
    if (isRequired) calls[toolName] = (calls[toolName] || 0) + 1;
    return {
      ...state,
      goal: {
        ...state.goal,
        calls,
        toolCount: (state.goal.toolCount || 0) + 1,
      },
    };
  }

  /** True when a no-submit goal has satisfied its required calls. */
  function isAutoCompleted(state, def) {
    return Boolean(def && !def.submitTool && requiredCallsSatisfied(state, def) && (def.requiredCalls || []).length > 0);
  }

  /**
   * Validate and complete a submit-tool call.
   * Returns { ok:false, reason } or { ok:true, result }.
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
      return { ok: false, reason: `提交前必须先完成：${missing}` };
    }
    let parsed;
    try {
      parsed = await def.submitTool.parse(args, env, state);
    } catch (err) {
      return { ok: false, reason: `协议校验失败：${(err && err.message) || err}` };
    }
    if (!parsed) return { ok: false, reason: '协议解析结果为空' };
    if (typeof def.onSubmit !== 'function') {
      return { ok: false, reason: `目标 "${def.id}" 缺少 onSubmit 转换定义` };
    }
    const result = await def.onSubmit(parsed, env, state);
    if (!result || typeof result !== 'object') {
      return { ok: false, reason: `目标 "${def.id}" onSubmit 未返回结果` };
    }
    return { ok: true, result, parsed };
  }

  /** Build the raw result for a no-submit goal whose required calls are met. */
  async function autoComplete(state, env) {
    const def = defFor(state);
    if (!def || !isAutoCompleted(state, def)) return void 0;
    if (typeof def.onComplete !== 'function') return { signal: { goalCompleted: true } };
    return def.onComplete(env, state);
  }

  return {
    definitions,
    get,
    defFor,
    allowedToolSet,
    unlockLocked,
    isSubmitTool,
    requiredCallsSatisfied,
    activate,
    recordCall,
    isAutoCompleted,
    submit,
    autoComplete,
  };
}
