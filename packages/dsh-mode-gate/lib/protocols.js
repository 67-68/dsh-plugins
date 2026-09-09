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

export const TASK_MODES = ['simple', 'complex'];

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
export function parseRequirementProtocol(args, modelCatalog, taskModes) {
  if (args === null || typeof args !== 'object') {
    throw new Error('requirement-recognition 协议必须是 JSON 对象');
  }
  if (args.protocol !== PROTOCOL_REQUIREMENT_RECOGNITION) {
    throw new Error(`protocol 必须为 "${PROTOCOL_REQUIREMENT_RECOGNITION}"`);
  }
  if (args.version !== 1) throw new Error('version 当前只支持 1');

  const taskMode = args.task_mode;
  if (!TASK_MODES.includes(taskMode)) {
    throw new Error(`task_mode 必须是 ${TASK_MODES.join(' / ')}`);
  }

  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  if (summary.length === 0) throw new Error('summary 不能为空');

  const featureIntentFile = typeof args.feature_intent_file === 'string'
    ? args.feature_intent_file.trim().replace(/\.md$/i, '')
    : '';
  if (featureIntentFile.length === 0) throw new Error('feature_intent_file 不能为空');

  const catalog = Array.isArray(modelCatalog) ? modelCatalog : [];
  const findModel = (modelId) => {
    if (typeof modelId !== 'string' || modelId.length === 0) return void 0;
    return catalog.find((entry) => entry && entry.id === modelId);
  };

  const modes = taskModes && typeof taskModes === 'object' ? taskModes : {};
  const defaultModelId = modes[taskMode] && modes[taskMode].model;
  const defaultModel = findModel(defaultModelId);

  let model;
  if (args.model_override !== undefined && args.model_override !== null) {
    const override = args.model_override;
    if (typeof override !== 'object') throw new Error('model_override 必须是对象');
    const modelId = typeof override.model === 'string' ? override.model.trim() : '';
    const entry = findModel(modelId);
    if (!entry) {
      throw new Error(`model_override.model "${modelId}" 不在模型目录中。可用模型：${catalog.map((m) => m.id).join(', ')}`);
    }
    const provider = typeof override.provider === 'string' && override.provider.trim().length > 0
      ? override.provider.trim()
      : entry.provider || 'deepseek-official';
    const reasoningEffort = typeof override.reasoning_effort === 'string' && override.reasoning_effort.trim().length > 0
      ? override.reasoning_effort.trim()
      : void 0;
    model = { provider, model: modelId, ...(reasoningEffort === void 0 ? {} : { reasoningEffort }) };
  } else {
    if (!defaultModel) {
      throw new Error(`task_mode "${taskMode}" 没有配置默认模型，且未填写 model_override。`);
    }
    model = {
      provider: defaultModel.provider || 'deepseek-official',
      model: defaultModel.id,
      ...(defaultModel.reasoningEffort === void 0 ? {} : { reasoningEffort: defaultModel.reasoningEffort }),
    };
  }

  return {
    protocol: PROTOCOL_REQUIREMENT_RECOGNITION,
    version: 1,
    taskMode,
    model,
    featureIntentFile,
    summary,
  };
}

/** Build the model-catalog text injected into the phase prompt. */
export function modelCatalogText(modelCatalog, taskModes) {
  const catalog = Array.isArray(modelCatalog) ? modelCatalog : [];
  const lines = catalog.map((entry) => {
    const name = entry && entry.name ? `${entry.id}（${entry.name}）` : entry && entry.id;
    const desc = entry && entry.description ? ` — ${entry.description}` : '';
    return `- ${name}${desc}`;
  });
  const modes = taskModes && typeof taskModes === 'object' ? taskModes : {};
  const modeLines = TASK_MODES.map((mode) => {
    const modelId = modes[mode] && modes[mode].model ? modes[mode].model : '（未配置）';
    return `- ${mode}: ${modelId}`;
  });
  return [
    '可用模型目录：',
    ...(lines.length ? lines : ['- （空）']),
    '任务模式默认模型：',
    ...modeLines,
  ].join('\n');
}
