/**
 * Tool policy for mode-gate states.
 *
 * A state declares `permissions: { write, bash, tools }`.
 * - `write: false` denies known write tools.
 * - `bash`: none | read-only | read-only-strict | declared | unrestricted (resolved in index.js).
 *   (`declared` no longer gates on declared verbs since the declare_target
 *   mechanism was removed: non-dangerous commands are allowed, dangerous ones ask.)
 * - `tools`: "*" means no extra restriction; otherwise a whitelist. Entries may
 *   be exact tool names or `<name>:view` (only str_replace_editor view).
 */

/** Tools that are always allowed regardless of state. */
export const ALWAYS_ALLOWED = new Set([
  'switch_mode', 'skill_search', 'request_extra', 'dev_tool_search',
  'submit_state', 'list_workflows', 'get_workflow_state', 'select_workflow',
  'goto_accumulation', 'accumulation_and_init',
]);

/** Tools considered safe in read-only states. */
export const READ_ONLY_TOOLS = new Set([
  'read', 'grep', 'glob', 'skill', 'skill_search', 'skill_load', 'read_image',
  'web_search', 'list_agents', 'get_goal', 'job_list', 'job_output', 'ask_user_question',
  'read_url', 'read_url_batch', 'read_url_links', 'read_url_site', 'dev_tool_search',
  'list_feature_intents', 'get_feature_intent', 'get_workflow_state',
  'list_workflows',
]);

export const READ_ONLY_TOOL_GLOBS = ['cordis_inspect_*'];

/** Tools considered planning-safe on top of READ_ONLY. */
export const PLAN_TOOLS = new Set(['todo_write', 'exit_plan_mode']);

/**
 * 重量级的「压缩 / 累积」工具：它们会改写长期记忆（patterns / architecture /
 * journal）或压缩会话历史，因此只允许在**显式授予**它们的阶段执行。
 *
 * `tools: '*'`（或省略 tools）的语义是「无额外工具限制」，对这批工具**不算授予**——
 * 否则 create 的 EXECUTE / DEBUG（tools:'*'）也能在迭代内部压缩、沉淀，绕过
 * 「只在 ACCUMULATION 压缩沉淀」的阶段边界。人工通道不受影响：
 * goto_accumulation / accumulation_and_init 在 ALWAYS_ALLOWED 中，始终可用。
 */
export const STAGE_GRANTED_TOOLS = new Set([
  'compress_context',
  'pattern_write',
  'pattern_overwrite',
  'architecture_write',
  'journal_append',
]);

/** 阶段是否把某个工具显式写进了 tools 白名单（'*' 与省略都不算）。 */
export function stageExplicitlyGrants(tools, name) {
  if (!Array.isArray(tools)) return false;
  return tools.some((entry) => String(entry) === String(name));
}

/** Tool names that are always classified as writes. */
export const KNOWN_WRITE_TOOLS = new Set([
  'write', 'edit', 'create', 'apply_patch', 'patch', 'str_replace_editor',
]);

export function matchesReadOnlyToolGlob(name) {
  return READ_ONLY_TOOL_GLOBS.some((pattern) => {
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return re.test(name);
  });
}

/**
 * Resolve a tool call against a state permission block.
 * @param {string} name - tool name.
 * @param {object} permissions - state `permissions` block.
 * @param {string} [stage] - current `workflow/state` label, used in denial text.
 * @returns {{kind: 'allow'|'deny', reason?: string}}
 */
export function toolDisposition(name, permissions, stage) {
  if (ALWAYS_ALLOWED.has(name)) return { kind: 'allow' };
  const perms = permissions || {};
  const write = perms.write !== false;
  const tools = perms.tools;

  // 压缩 / 累积类工具必须被本阶段显式授予：'*' 不足以放行。
  if (STAGE_GRANTED_TOOLS.has(name) && !stageExplicitlyGrants(tools, name)) {
    const where = stage ? `（当前 ${stage}）` : '';
    return {
      kind: 'deny',
      reason: `工具 ${name} 属于「压缩/累积」动作，只在显式授予它的阶段可用${where}，本阶段未授予。`
        + '需要沉淀或压缩时，请先调用 goto_accumulation 进入 ACCUMULATION（用户可直接用 /goto-accumulation）。',
    };
  }

  if (tools !== undefined && tools !== '*' && Array.isArray(tools)) {
    const exact = tools.filter((entry) => !String(entry).includes(':'));
    const viewOnly = tools.filter((entry) => String(entry).endsWith(':view')).map((entry) => String(entry).slice(0, -5));
    if (name === 'str_replace_editor') {
      if (viewOnly.includes('str_replace_editor')) return { kind: 'allow' };
      // view-only means the caller checks command === 'view' before allowing.
      if (exact.includes('str_replace_editor')) return { kind: 'allow' };
      return { kind: 'deny', reason: `当前状态不允许 str_replace_editor 工具。` };
    }
    if (!exact.includes(name) && !viewOnly.includes(name)) {
      return { kind: 'deny', reason: `当前状态不允许工具 ${name}。` };
    }
  }

  if (!write && (KNOWN_WRITE_TOOLS.has(name) || name === 'str_replace_editor')) {
    return { kind: 'deny', reason: `当前状态禁止写工具 ${name}。` };
  }
  return { kind: 'allow' };
}

/** Whether a state's tool whitelist is read-only for `name`. */
export function isReadOnlyPermission(name, permissions) {
  const perms = permissions || {};
  if (perms.write !== false) return false;
  if (READ_ONLY_TOOLS.has(name) || matchesReadOnlyToolGlob(name)) return true;
  if (name === 'str_replace_editor') return true;
  const tools = perms.tools;
  if (tools === '*' || tools === undefined) return false;
  if (!Array.isArray(tools)) return false;
  if (tools.includes(`${name}:view`)) return true;
  return false;
}
