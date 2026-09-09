import { parsePresetActionProtocol, parseRequirementProtocol, modelCatalogText } from './protocols.js';

/**
 * Built-in goals for the requirement loop. Each goal is a plain object
 * consumed by `createGoalEngine`.
 *
 * `env` contains:
 *   - featureIntents: createFeatureIntentStore() result
 *   - modelCatalog: user-editable model catalog
 *   - taskModes: simple/complex default model ids
 *   - presetActionSkills: [{ id, name, description, model, reasoningEffort, content }]
 */
export function createBuiltinGoals() {
  return [
    {
      id: 'preset-action-match',
      phase: 'PRESET_ACTION',
      prompt: [
        '[目标] 探测 preset action',
        '先调用 list_preset_actions 查看可用 preset actions 的 id、说明和匹配条件。',
        '然后判断用户需求是否与某个 preset action 匹配：',
        '- 匹配：调用 submit_preset_action 并填写 skill_id。',
        '- 不匹配：调用 submit_preset_action 并填写 no_match: true，将直接进入普通需求分解阶段。',
        '探测失败不需要重试，直接提交 no_match 即可。',
      ].join('\n'),
      allowedTools: ['list_preset_actions', 'submit_preset_action'],
      allowedBash: [],
      requiredCalls: [{ tool: 'list_preset_actions', min: 1 }],
      submitTool: {
        name: 'submit_preset_action',
        async parse(args, env) {
          const decision = parsePresetActionProtocol(args);
          if (decision.kind === 'match') {
            const skills = Array.isArray(env.presetActionSkills) ? env.presetActionSkills : [];
            const skill = skills.find((entry) => entry && entry.id === decision.skillId);
            if (!skill) {
              throw new Error(`未找到 preset action "${decision.skillId}"。可用：${skills.map((s) => s.id).join(', ') || '（无）'}`);
            }
            return { ...decision, skill };
          }
          return decision;
        },
      },
      async onSubmit(parsed, env) {
        if (parsed.kind === 'no-match') {
          return {
            nextPhase: 'REQUIREMENT_RECOGNITION',
            nextGoal: 'feature-intent-read',
            prompt: '未命中 preset action，进入普通需求分解阶段。',
            statePatch: { chosenPresetAction: null },
          };
        }
        const skill = parsed.skill;
        const model = {
          provider: skill.provider || 'deepseek-official',
          model: skill.model || 'deepseek-v4-pro',
          ...(skill.reasoningEffort ? { reasoningEffort: skill.reasoningEffort } : {}),
        };
        return {
          nextPhase: 'IMPLEMENT',
          nextGoal: null,
          prompt: [
            `已命中 preset action "${skill.id}"，跳过需求分解阶段，进入实现阶段。`,
            '',
            '请按照下面注入的 preset action 内容执行，不要自行扩大任务范围。',
            '',
            '--- preset action skill ---',
            skill.content,
          ].join('\n'),
          statePatch: {
            chosenPresetAction: skill.id,
            selectedModel: model,
          },
        };
      },
    },

    {
      id: 'feature-intent-read',
      phase: 'REQUIREMENT_RECOGNITION',
      prompt: [
        '[目标] 至少阅读一个 feature intent',
        '当前阶段只解锁 feature intent 阅读工具。系统会尝试自动读取一个 feature intent 作为起点；',
        '你也可以用 list_feature_intents 查看全部，再用 get_feature_intent 阅读与你需求最相关的一个。',
        '阅读完成后，系统会自动进入下一目标（追加 feature intent 记录 + 提交需求识别协议）。',
      ].join('\n'),
      allowedTools: ['list_feature_intents', 'get_feature_intent'],
      allowedBash: [],
      requiredCalls: [{ tool: 'get_feature_intent', min: 1 }],
      async onActivate(env) {
        const intents = await env.featureIntents.list();
        if (intents.length === 0) {
          return {
            prompt: [
              '[目标] 至少阅读一个 feature intent',
              '当前 feature intent 目录为空。请询问用户是否已有需求文档需要迁移，或让用户提供项目背景。',
              `目录：${env.featureIntents.dir}`,
            ].join('\n'),
            statePatch: { featureIntentFile: null },
          };
        }
        const preferred = intents.find((entry) => entry.name === 'mode-gate') || intents[0];
        let content = '';
        try {
          content = env.featureIntents.get(preferred.name).content;
        } catch (err) {
          content = `（自动读取失败：${(err && err.message) || err}）`;
        }
        return {
          prompt: [
            '[目标] 至少阅读一个 feature intent',
            `已自动读取 feature intent "${preferred.name}"，内容如下。请确认它是否匹配当前需求；若不匹配，用 list_feature_intents + get_feature_intent 读取更相关的文档。`,
            '',
            '--- feature intent 内容开始 ---',
            content,
            '--- feature intent 内容结束 ---',
          ].join('\n'),
          statePatch: { featureIntentFile: preferred.name },
        };
      },
      async onComplete(env, state) {
        const file = state.featureIntentFile || (state.goal && state.goal.featureIntentFile) || '';
        return {
          nextPhase: 'REQUIREMENT_RECOGNITION',
          nextGoal: 'feature-intent-update',
          prompt: `已阅读 feature intent${file ? ` "${file}"` : ''}。现在进入本阶段第二步：追加 feature intent 记录并提交需求识别协议。`,
          statePatch: { featureIntentFile: file || null },
        };
      },
    },

    {
      id: 'feature-intent-update',
      phase: 'REQUIREMENT_RECOGNITION',
      prompt: (env) => buildFeatureIntentUpdatePrompt(env.modelCatalog, env.taskModes),
      allowedTools: [
        'list_feature_intents',
        'get_feature_intent',
        'update_feature_intent',
        'submit_requirement_protocol',
      ],
      allowedBash: [],
      requiredCalls: [{ tool: 'update_feature_intent', min: 1 }],
      submitTool: {
        name: 'submit_requirement_protocol',
        async parse(args, env) {
          const parsed = parseRequirementProtocol(args, env.modelCatalog, env.taskModes);
          const intents = await env.featureIntents.list();
          const found = intents.find((entry) => entry.name === parsed.featureIntentFile);
          if (!found) {
            throw new Error(`feature_intent_file "${parsed.featureIntentFile}" 不存在。可用：${intents.map((e) => e.name).join(', ') || '（无）'}`);
          }
          return { ...parsed, featureIntent: found };
        },
      },
      async onSubmit(parsed, env) {
        return {
          nextPhase: 'IMPLEMENT',
          nextGoal: null,
          prompt: [
            '需求识别协议已通过，进入实现阶段。',
            `任务模式：${parsed.taskMode}`,
            `选用模型：${parsed.model.provider}/${parsed.model.model}${parsed.model.reasoningEffort ? `（reasoning_effort=${parsed.model.reasoningEffort}）` : ''}`,
            `feature intent：${parsed.featureIntentFile}`,
            '',
            '请开始实现该任务。',
          ].join('\n'),
          statePatch: {
            selectedModel: parsed.model,
            featureIntentFile: parsed.featureIntentFile,
            taskMode: parsed.taskMode,
            requirementSummary: parsed.summary,
          },
        };
      },
    },
  ];
}

/** Generate the feature-intent-update prompt with the live model catalog. */
export function buildFeatureIntentUpdatePrompt(modelCatalog, taskModes) {
  const base = [
    '[目标] 追加 feature intent 记录并提交需求识别协议',
    '1. 调用 update_feature_intent 至少一次，把当前需求的原始记录与简单分析追加到 feature intent 文件末尾（不要直接编辑文件）。',
    '2. 确认本次任务的任务模式与模型：',
    modelCatalogText(modelCatalog, taskModes),
    '3. 调用 submit_requirement_protocol 提交需求识别协议。',
    '协议通过后会自动切换到实现阶段；协议校验失败会作为工具错误返回，请根据错误修正后重新提交。',
  ].join('\n');
  return base;
}
