/**
 * Protocol parsers for the mode-gate requirement loop.
 *
 * Each parser receives the already-JSON-decoded tool arguments and returns a
 * normalized decision object. Parsers throw with a Chinese reason string on
 * invalid input; the submit tool turns that into a tool error, which is how
 * the agent is "打回" without advancing the phase.
 */

export const PROTOCOL_PRESET_ACTION = 'preset-action';
export const PROTOCOL_REQUIREMENT_RECOGNITION = 'requirement-recognition';

/** Validate and normalize `submit_preset_action` arguments. */
export function parsePresetActionProtocol(args) {
  if (args === null || typeof args !== 'object') {
    throw new Error('preset-action 协议必须是 JSON 对象');
  }
  const skillId = typeof args.skill_id === 'string' ? args.skill_id.trim() : '';
  const noMatch = args.no_match === true;
  if (skillId.length > 0) {
    if (noMatch) throw new Error('skill_id 与 no_match 不能同时填写');
    return { kind: 'match', skillId };
  }
  if (noMatch) return { kind: 'no-match' };
  throw new Error('preset-action 协议无效：命中时填写 skill_id，未命中时填写 no_match: true');
}

/**
 * Validate and normalize `submit_requirement_protocol` arguments against the
 * user-editable model catalog and task-mode defaults.
 */
export function parseRequirementProtocol(args) {
  if (args === null || typeof args !== 'object') {
    throw new Error('requirement-recognition 协议必须是 JSON 对象');
  }
  if (args.protocol !== PROTOCOL_REQUIREMENT_RECOGNITION) {
    throw new Error(`protocol 必须为 "${PROTOCOL_REQUIREMENT_RECOGNITION}"`);
  }
  if (args.version !== 1) throw new Error('version 当前只支持 1');

  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  if (summary.length === 0) throw new Error('summary 不能为空');

  const featureIntentFile = typeof args.feature_intent_file === 'string'
    ? args.feature_intent_file.trim().replace(/\.md$/i, '')
    : '';
  if (featureIntentFile.length === 0) throw new Error('feature_intent_file 不能为空');

  return {
    protocol: PROTOCOL_REQUIREMENT_RECOGNITION,
    version: 1,
    featureIntentFile,
    summary,
  };
}

