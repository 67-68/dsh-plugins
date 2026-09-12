import { parsePresetActionProtocol, parseRequirementProtocol, modelCatalogText } from './protocols.js';
import {
  extractEntryFields,
  createStaticPlan,
  advanceStaticPlan,
  beginCurrentStaticItem,
  staticPlanCurrent,
} from './plans.js';

/**
 * Built-in goal registry for mode-gate workflows.
 *
 * A goal never hardcodes the next state. On completion it returns
 *   { signal?, statePatch?, prompt? }
 * and index.js resolves the state's declarative `transitions` against that
 * signal plus the current static/dynamic plans.
 */

function latestEntry(content) {
  const text = String(content || '');
  const parts = text.split(/\n---\n/);
  return parts.length ? parts[parts.length - 1] : text;
}

function currentItemText(state) {
  const item = staticPlanCurrent(state.staticPlan);
  return item ? `当前 checklist goal：${item.text}（id: ${item.id}）` : '当前没有待完成的 checklist goal。';
}

function appendLoopMemory(state, item) {
  const memory = state.loopMemory && typeof state.loopMemory === 'object'
    ? state.loopMemory
    : { iteration: 0, blocks: [], updatedAt: 0 };
  const blocks = Array.isArray(memory.blocks) ? memory.blocks.slice(-7) : [];
  if (item) {
    blocks.push({
      key: item.id,
      text: item.text,
      iteration: (state.goal && state.goal.iteration) || memory.iteration || 0,
      stampedAt: Date.now(),
    });
  }
  return { ...memory, blocks, updatedAt: Date.now() };
}

export function createBuiltinGoals() {
  return [
    {
      id: 'preset-action.match',
      prompt: [
        '[目标] 探测 preset action',
        '先调用 list_preset_actions 查看可用 preset actions 的 id、说明和匹配条件。',
        '然后判断用户需求是否与某个 preset action 匹配：',
        '- 匹配：调用 submit_preset_action 并填写 skill_id。',
        '- 不匹配：调用 submit_preset_action 并填写 no_match: true，将回到 IDLE。',
        '探测失败不需要重试，直接提交 no_match 即可。',
      ].join('\n'),
      allowedTools: ['list_preset_actions', 'submit_preset_action'],
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
      async onSubmit(parsed) {
        if (parsed.kind === 'no-match') {
          return {
            signal: { presetActionMatched: false },
            statePatch: { chosenPresetAction: null },
            prompt: '未命中 preset action，回到 IDLE。',
          };
        }
        const skill = parsed.skill;
        const model = {
          provider: skill.provider || 'deepseek-official',
          model: skill.model || 'deepseek-v4-pro',
          ...(skill.reasoningEffort ? { reasoningEffort: skill.reasoningEffort } : {}),
        };
        return {
          signal: { presetActionMatched: true },
          statePatch: {
            chosenPresetAction: skill.id,
            presetActionTitle: skill.title,
            presetActionContent: skill.content,
            selectedModel: model,
          },
          prompt: `已命中 preset action "${skill.id}"。`,
        };
      },
    },

    {
      id: 'preset-action.execute',
      prompt: (env, state) => [
        '[目标] 执行 preset action',
        '请严格按下面注入的 preset action 内容执行，不要自行扩大任务范围。',
        '',
        '--- preset action skill ---',
        (state && state.presetActionContent) || '（未找到 preset action 内容）',
      ].join('\n'),
      allowedTools: ['submit_state'],
      requiredCalls: [],
      submitTool: {
        name: 'submit_state',
        async parse(args) {
          return { summary: typeof args?.summary === 'string' ? args.summary : '' };
        },
      },
      async onSubmit() {
        return { signal: { goalCompleted: true }, prompt: 'preset action 执行完成。' };
      },
    },

    {
      id: 'project-experience.dump',
      prompt: [
        '[目标] 一次性读取项目基准',
        '调用 read_project_experience 工具（省略 project 时会自动选择唯一项目，或在多个时列出候选）。',
        '工具会一次性返回 intro / 系统拓扑 / 血泪法则 / 核心状态树四个文件的内容。',
        '读完即可，不要在本状态写任何文件。',
      ].join('\n'),
      allowedTools: ['read_project_experience'],
      requiredCalls: [{ tool: 'read_project_experience', min: 1 }],
      async onComplete() {
        return { signal: { goalCompleted: true }, prompt: '项目基准已读取，进入需求分解。' };
      },
    },

    {
      id: 'feature-intent.read-and-decompose',
      prompt: (env) => [
        '[目标] 读取 feature intent 并完成需求分解',
        '1. 用 list_feature_intents / get_feature_intent 找到并阅读最相关的文档；',
        '2. 用 update_feature_intent 一次写入三个 field：user_words（用户原话）、understanding（你的理解）、checklist（可验收节点数组）；',
        '3. checklist 每一项必须是可验收的节点，例如「按钮在 xx 处出现」「点击按钮展示 xxxx 数据」；',
        '4. 调用 submit_requirement_protocol 提交协议，通过后 checklist 会成为本工作流的 staticPlan。',
        '本状态允许 bash，但禁止写文件。',
        '',
        modelCatalogText(env.modelCatalog, env.taskModes),
      ].join('\n'),
      allowedTools: [
        'list_feature_intents', 'get_feature_intent', 'update_feature_intent',
        'submit_requirement_protocol', 'bash', 'str_replace_editor',
      ],
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
        const file = await env.featureIntents.get(parsed.featureIntentFile);
        const fields = extractEntryFields(latestEntry(file.content));
        const plan = createStaticPlan(fields.checklist, parsed.featureIntentFile);
        return {
          signal: { goalCompleted: true },
          statePatch: {
            selectedModel: parsed.model,
            featureIntentFile: parsed.featureIntentFile,
            taskMode: parsed.taskMode,
            requirementSummary: parsed.summary,
            staticPlan: plan,
            dynamicPlan: { scope: 'state', stateId: null, items: [], updatedAt: Date.now() },
          },
          prompt: [
            `需求识别协议已通过，任务模式：${parsed.taskMode}。`,
            `checklist 已注册为 ${plan.items.length} 个 static goal。`,
            plan.items.length ? plan.items.map((item) => `- ${item.id}: ${item.text}`).join('\n') : '（未解析到 checklist，请检查 update_feature_intent 的 checklist 字段）',
          ].join('\n'),
        };
      },
    },

    {
      id: 'create.research',
      prompt: (env, state) => [
        '[目标] 研究当前 checklist goal',
        currentItemText(state),
        '重新阅读 project-experience 三个文件（read_project_experience），围绕当前 goal 输出实现思路、涉及文件和风险。',
        '产出研究结论后调用 submit_state 结束本状态。',
      ].join('\n'),
      allowedTools: ['read_project_experience', 'bash', 'str_replace_editor:view'],
      requiredCalls: [],
      async onActivate(env, state) {
        return { statePatch: { staticPlan: beginCurrentStaticItem(state.staticPlan) } };
      },
      submitTool: {
        name: 'submit_state',
        async parse(args) {
          return { summary: typeof args?.summary === 'string' ? args.summary : '' };
        },
      },
      async onSubmit() {
        return { signal: { goalCompleted: true }, prompt: '研究完成，进入执行。' };
      },
    },

    {
      id: 'create.execute',
      prompt: (env, state) => [
        '[目标] 执行当前 checklist goal',
        currentItemText(state),
        '只做本 goal 范围内的事；完成标准以验收文本为准。',
        '完成后调用 submit_state 结束本状态，动态计划会被清空。',
      ].join('\n'),
      allowedTools: ['bash', 'str_replace_editor', 'write', 'edit', 'apply_patch', 'todo_write'],
      requiredCalls: [],
      submitTool: {
        name: 'submit_state',
        async parse(args) {
          return { summary: typeof args?.summary === 'string' ? args.summary : '' };
        },
      },
      async onSubmit() {
        return { signal: { goalCompleted: true }, prompt: '执行完成，进入调试。' };
      },
    },

    {
      id: 'create.debug',
      prompt: (env, state) => [
        '[目标] 验证当前 checklist goal',
        currentItemText(state),
        '先自行复现和修复。若无法解决，明确写出：复现步骤、期望结果、需要用户做什么，并请求用户协助。',
        '验证通过后调用 submit_state 结束本状态。',
      ].join('\n'),
      allowedTools: ['bash', 'str_replace_editor', 'write', 'edit', 'apply_patch', 'todo_write'],
      requiredCalls: [],
      submitTool: {
        name: 'submit_state',
        async parse(args) {
          return { summary: typeof args?.summary === 'string' ? args.summary : '' };
        },
      },
      async onSubmit() {
        return { signal: { goalCompleted: true }, prompt: '调试完成，进入总结沉淀。' };
      },
    },

    {
      id: 'create.accumulate',
      prompt: (env, state) => [
        '[目标] 总结并沉淀项目经验',
        currentItemText(state),
        '用 update_project_experience 把本轮变化追加到 project-experience（intro / 系统拓扑 / 血泪法则 / 核心状态树）。',
        'append 会直接写入；overwrite / diff 会作为问题提交给用户批准。',
        '写入后调用 submit_state 结束本状态；引擎会自动推进到下一个 checklist goal。',
      ].join('\n'),
      allowedTools: ['update_project_experience', 'read_project_experience', 'bash', 'str_replace_editor:view'],
      requiredCalls: [{ tool: 'update_project_experience', min: 1 }],
      submitTool: {
        name: 'submit_state',
        async parse(args) {
          return { summary: typeof args?.summary === 'string' ? args.summary : '' };
        },
      },
      async onSubmit(parsed, env, state) {
        const item = staticPlanCurrent(state.staticPlan);
        const advanced = advanceStaticPlan(state.staticPlan);
        const memory = appendLoopMemory(state, item);
        return {
          signal: { goalCompleted: true },
          statePatch: {
            staticPlan: advanced,
            dynamicPlan: { scope: 'state', stateId: null, items: [], updatedAt: Date.now() },
            loopMemory: memory,
          },
          prompt: item ? `已完成 checklist goal「${item.text}」。` : '本轮总结完成。',
        };
      },
    },
  ];
}
