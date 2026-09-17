/**
 * Tool policy for mode-gate states.
 *
 * A state declares `permissions: { write, bash, tools }`.
 * - `write: false` denies known write tools.
 * - `bash`: none | read-only | declared | unrestricted (resolved in index.js).
 * - `tools`: "*" means no extra restriction; otherwise a whitelist. Entries may
 *   be exact tool names or `<name>:view` (only str_replace_editor view).
 */

/** Tools that are always allowed regardless of state / declared target. */
export const ALWAYS_ALLOWED = new Set([
  'declare_target', 'switch_mode', 'skill_search', 'request_extra', 'dev_tool_search',
  'submit_state', 'list_workflows', 'get_workflow_state', 'select_workflow',
]);

/** Tools allowed without a declared target (IDLE helper set). */
export const ALLOWED_WITHOUT_TARGET = new Set([
  'ask_user_question', 'get_goal', 'todo_write', 'skill_search', 'request_extra',
  'dev_tool_search', 'list_workflows', 'get_workflow_state', 'select_workflow',
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
 * @returns {{kind: 'allow'|'deny', reason?: string}}
 */
export function toolDisposition(name, permissions) {
  if (ALWAYS_ALLOWED.has(name)) return { kind: 'allow' };
  const perms = permissions || {};
  const write = perms.write !== false;
  const tools = perms.tools;

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
