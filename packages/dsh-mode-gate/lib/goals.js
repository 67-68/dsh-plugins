import { parsePresetActionProtocol, parseRequirementProtocol } from './protocols.js';
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
      id: 'base-read.noop',
      prompt: [
        '[目标] 确认项目基准',
        '本阶段只做基准确认，不写任何文件。',
        '如需了解项目，可用 read / grep / glob 只读查看仓库、feature intent 与长期文档。',
        '确认后调用 submit_state 继续，不要在本状态写任何文件。',
      ].join('\n'),
      allowedTools: [
        'read', 'grep', 'glob', 'web_search', 'read_url', 'read_url_batch',
        'read_url_links', 'read_url_site', 'read_image', 'list_feature_intents',
        'get_feature_intent', 'skill_load', 'skill_search',
      ],
      requiredCalls: [],
      submitTool: {
        name: 'submit_state',
        async parse(args) {
          return { summary: typeof args?.summary === 'string' ? args.summary : '' };
        },
      },
      async onSubmit() {
        return { signal: { goalCompleted: true }, prompt: '项目基准确认完成，进入需求分解。' };
      },
    },

    {
      id: 'feature-intent.read-and-decompose',
      prompt: (env) => [
        '[目标] 读取 feature intent 并完成需求分解',
        '1. 用 list_feature_intents / get_feature_intent 找到并阅读本次任务的 feature intent 文档；',
        '2. 用 read / grep / glob / web_search / read_url 等只读调研工具调研代码库（本阶段完全禁用 bash），确保写出的 checklist 是可验收的节点；',
        '3. 用 update_feature_intent 写入 feature intent：用户原话字段由系统自动收集（无需你写），你只需要提供 understanding（你的理解）和 checklist（可验收节点数组）；这两个 field 会在同一次写入中落到对应小标题下；',
        '4. checklist 每一项必须是可验收的节点，例如「按钮在 xx 处出现」「点击按钮展示 xxxx 数据」；',
        '5. 如需记录需求分解期间的调研任务，可调用 todo_write；',
        '6. 调用 submit_requirement_protocol 提交协议，通过后 checklist 会成为本工作流的 staticPlan 并自动同步到 DSH task 系统。',
        '本状态完全禁用 bash，只允许只读调研工具和 feature intent 工具，禁止写文件。',
      ].join('\n'),
      allowedTools: [
        'list_feature_intents', 'get_feature_intent', 'update_feature_intent',
        'submit_requirement_protocol', 'read', 'grep', 'glob', 'web_search',
        'read_url', 'read_url_batch', 'read_url_links', 'read_url_site',
        'read_image', 'list_agents', 'get_goal', 'job_list', 'job_output',
        'ask_user_question', 'todo_write', 'str_replace_editor',
      ],
      requiredCalls: [{ tool: 'update_feature_intent', min: 1 }],
      submitTool: {
        name: 'submit_requirement_protocol',
        async parse(args, env) {
          const parsed = parseRequirementProtocol(args);
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
            featureIntentFile: parsed.featureIntentFile,
            requirementSummary: parsed.summary,
            staticPlan: plan,
            dynamicPlan: { scope: 'state', stateId: null, items: [], updatedAt: Date.now() },
          },
          prompt: [
            `需求识别协议已通过。`,
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
        '1. 用 read / grep / glob / web_search / read_url / bash（只读）充分调研当前 goal 的实现思路、涉及文件和风险；',
        '2. 调研清楚后，调用 todo_write 写出本 goal 的完整 dynamic plan（第一项 in_progress，只放本 goal 的任务，不要放其他 goal 的任务）；',
        '3. 调用 submit_state 结束研究。',
      ].join('\n'),
      allowedTools: [
        'read', 'grep', 'glob', 'web_search',
        'read_url', 'read_url_batch', 'read_url_links', 'read_url_site',
        'read_image', 'list_agents', 'get_goal', 'job_list', 'job_output',
        'ask_user_question', 'todo_write', 'bash', 'str_replace_editor',
      ],
      requiredCalls: [{ tool: 'todo_write', min: 1 }],
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
        '用 todo_write 维护本 goal 的 dynamic plan：开始一项标记 in_progress，完成一项立即标记 completed。',
        '完成后调用 submit_state 结束本状态，动态计划会被清空。',
      ].join('\n'),
      allowedTools: [
        'bash', 'str_replace_editor', 'write', 'edit', 'apply_patch', 'todo_write',
        'read', 'grep', 'glob', 'web_search', 'read_url', 'read_url_batch',
        'read_url_links', 'read_url_site', 'read_image', 'list_agents',
        'get_goal', 'job_list', 'job_output',
      ],
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
        '验证过程中用 todo_write 更新本 goal 的 dynamic plan（完成/新增/修改任务）。',
        '验证通过后调用 submit_state 结束本状态。',
      ].join('\n'),
      allowedTools: [
        'bash', 'str_replace_editor', 'write', 'edit', 'apply_patch', 'todo_write',
        'ask_user_question', 'read', 'grep', 'glob', 'web_search', 'read_url',
        'read_url_batch', 'read_url_links', 'read_url_site', 'read_image',
        'list_agents', 'get_goal', 'job_list', 'job_output',
      ],
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
        '[目标] 结束本轮 checklist goal',
        currentItemText(state),
        '本阶段不写长期记忆。',
        '直接调用 submit_state 结束本状态；引擎会自动推进到下一个 checklist goal。',
      ].join('\n'),
      allowedTools: [],
      requiredCalls: [],
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

    {
      id: 'rough.requirement-recognition',
      prompt: (env) => [
        '[目标] 读取 feature intent 并拆解为 1 个 goal',
        '1. 用 list_feature_intents / get_feature_intent 找到并阅读本次任务的 feature intent 文档；',
        '2. 用 read / grep / glob / web_search / read_url 等只读调研工具调研代码库（本阶段完全禁用 bash），确认这 1 个 goal 的可验收边界；',
        '3. 用 update_feature_intent 写入 feature intent：用户原话字段由系统自动收集（无需你写），你只需要提供 understanding 和 checklist；',
        '4. checklist 只能有且仅有 1 项；同模块的多个需求（例如修改 UI 的某几个地方）必须合并成这 1 项可验收描述，不要拆成多个 goal；',
        '5. 如需记录调研任务，可调用 todo_write；',
        '6. 调用 submit_requirement_protocol 提交协议，通过后这 1 个 goal 会成为本工作流的 staticPlan 并同步到 DSH task 系统。',
        '本状态完全禁用 bash，只允许只读调研工具和 feature intent 工具，禁止写文件。',
      ].join('\n'),
      allowedTools: [
        'list_feature_intents', 'get_feature_intent', 'update_feature_intent',
        'submit_requirement_protocol', 'read', 'grep', 'glob', 'web_search',
        'read_url', 'read_url_batch', 'read_url_links', 'read_url_site',
        'read_image', 'list_agents', 'get_goal', 'job_list', 'job_output',
        'ask_user_question', 'todo_write', 'str_replace_editor',
      ],
      requiredCalls: [{ tool: 'update_feature_intent', min: 1 }],
      submitTool: {
        name: 'submit_requirement_protocol',
        async parse(args, env) {
          const parsed = parseRequirementProtocol(args);
          const intents = await env.featureIntents.list();
          const found = intents.find((entry) => entry.name === parsed.featureIntentFile);
          if (!found) {
            throw new Error(`feature_intent_file "${parsed.featureIntentFile}" 不存在。可用：${intents.map((e) => e.name).join(', ') || '（无）'}`);
          }
          const file = await env.featureIntents.get(parsed.featureIntentFile);
          const fields = extractEntryFields(latestEntry(file.content));
          if (fields.checklist.length !== 1) {
            throw new Error(`ROUGH 工作流只允许识别 1 个 goal（checklist 必须且只能有 1 项），当前为 ${fields.checklist.length} 项。请把同模块的多个需求合并为 1 个可验收节点后重新写入 feature intent。`);
          }
          return { ...parsed, featureIntent: found, fields };
        },
      },
      async onSubmit(parsed) {
        const plan = createStaticPlan(parsed.fields.checklist, parsed.featureIntentFile);
        const item = plan.items[0];
        return {
          signal: { goalCompleted: true },
          statePatch: {
            featureIntentFile: parsed.featureIntentFile,
            requirementSummary: parsed.summary,
            staticPlan: plan,
            dynamicPlan: { scope: 'state', stateId: null, items: [], updatedAt: Date.now() },
          },
          prompt: [
            `ROUGH 需求识别协议已通过。`,
            item ? `已注册 1 个 static goal：${item.text}（id: ${item.id}）` : '（未解析到 checklist，请检查 update_feature_intent 的 checklist 字段）',
          ].join('\n'),
        };
      },
    },

    {
      id: 'rough.research',
      prompt: (env, state) => [
        '[目标] 研究当前 ROUGH goal',
        currentItemText(state),
        '1. 用 read / grep / glob / web_search / read_url / bash（只读）充分调研当前 goal 的实现思路、涉及文件和风险；',
        '2. 调研清楚后，调用 todo_write 写出本 goal 的完整 dynamic plan（第一项 in_progress，只放本 goal 的任务，不要列测试/沉淀任务）；',
        '3. 调用 submit_state 结束研究。',
      ].join('\n'),
      allowedTools: [
        'read', 'grep', 'glob', 'web_search',
        'read_url', 'read_url_batch', 'read_url_links', 'read_url_site',
        'read_image', 'list_agents', 'get_goal', 'job_list', 'job_output',
        'ask_user_question', 'todo_write', 'bash', 'str_replace_editor',
      ],
      requiredCalls: [{ tool: 'todo_write', min: 1 }],
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
        return { signal: { goalCompleted: true }, prompt: '研究完成，进入实现。' };
      },
    },

    {
      id: 'rough.implement',
      prompt: (env, state) => [
        '[目标] 实现当前 ROUGH goal 并呈现',
        currentItemText(state),
        '只做本 goal 范围内的事；完成标准以验收文本为准。',
        '用 todo_write 维护本 goal 的 dynamic plan：开始一项标记 in_progress，完成一项立即标记 completed。',
        '完成后直接向用户清晰呈现改动内容与使用方式；不要运行测试，不要写长期记忆，然后调用 submit_state 结束本工作流。',
      ].join('\n'),
      allowedTools: [
        'bash', 'str_replace_editor', 'write', 'edit', 'apply_patch', 'todo_write',
        'read', 'grep', 'glob', 'web_search', 'read_url', 'read_url_batch',
        'read_url_links', 'read_url_site', 'read_image', 'list_agents',
        'get_goal', 'job_list', 'job_output',
      ],
      requiredCalls: [],
      submitTool: {
        name: 'submit_state',
        async parse(args) {
          return { summary: typeof args?.summary === 'string' ? args.summary : '' };
        },
      },
      async onSubmit(parsed, env, state) {
        const item = staticPlanCurrent(state.staticPlan);
        const advanced = advanceStaticPlan(state.staticPlan);
        return {
          signal: { goalCompleted: true },
          statePatch: {
            staticPlan: advanced,
            dynamicPlan: { scope: 'state', stateId: null, items: [], updatedAt: Date.now() },
          },
          prompt: item ? `已完成 ROUGH goal「${item.text}」，结果已呈现。` : 'ROUGH 实现完成，结果已呈现。',
        };
      },
    },
  ];
}
