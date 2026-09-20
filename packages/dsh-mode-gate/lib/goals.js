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
        '1. 不读任何文档，直接基于用户需求分解；',
        '2. checklist 按模块粒度拆分：一个模块一项，不同模块各占一项，同一模块的多个改动合并为一项；不要拆到按钮或字段级，每一项必须是可验收的节点；',
        '3. 用 update_feature_intent 写入 feature intent：用户原话字段由系统自动收集（无需你写），你需要提供 understanding（你的理解）、user_visible_behavior（用户在新工作流下如何工作/感知本次改动）和 feature_intent（本次功能修改意图），以及 checklist（可验收节点数组）；这些 field 会在同一次写入中落到对应小标题下；',
        '4. checklist 示例（模块级）：「模型压缩上下文设置页」「压缩决策引擎」「阶段权限门禁」；反例（太细）：「按钮在 xx 处出现」；',
        '5. 如需记录需求分解期间的调研任务，可调用 todo_write；',
        '6. 调用 submit_requirement_protocol 提交协议，通过后 checklist 会成为本工作流的 staticPlan 并自动同步到 DSH task 系统。',
        '本状态禁用 bash 与文件查看工具，只允许 feature intent 相关工具，禁止写文件；专心分解需求。',
      ].join('\n'),
      allowedTools: [
        'list_feature_intents', 'update_feature_intent',
        'submit_requirement_protocol',
        'list_agents', 'get_goal', 'job_list', 'job_output',
        'ask_user_question', 'todo_write',
      ],
      // 本阶段不读文件、不解锁新工具，专心分解需求。
      lockUnlockTools: true,
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
          if (!fields.userVisibleBehavior) throw new Error('feature intent 缺少 user_visible_behavior 展示字段；请用 update_feature_intent 补充后再提交协议。');
          if (!fields.featureIntent) throw new Error('feature intent 缺少 feature_intent 展示字段；请用 update_feature_intent 补充后再提交协议。');
          return { ...parsed, featureIntent: found, fields };
        },
      },
      async onSubmit(parsed, env) {
        const file = await env.featureIntents.get(parsed.featureIntentFile);
        const fields = parsed.fields || extractEntryFields(latestEntry(file.content));
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
      id: 'create.feature-update',
      prompt: (env, state) => [
        '[目标] 更新功能列表总体条目',
        '1. 先用 read 查看当前功能列表索引 features.md 与详情 features/<feature-intent-file>.md（feature id 默认使用当前 feature intent 文件名）；',
        '2. 用 update_feature_list 写入总体 user_visible_behavior（不超过 500 字）与总体 feature_intent（不超过 50 字），并将 status 置为 in_progress；',
        '3. 调用 submit_state 结束本状态。',
      ].join('\n'),
      allowedTools: ['update_feature_list', 'read', 'grep', 'glob', 'str_replace_editor:view'],
      requiredCalls: [{ tool: 'update_feature_list', min: 1 }],
      submitTool: {
        name: 'submit_state',
        async parse(args) {
          return { summary: typeof args?.summary === 'string' ? args.summary : '' };
        },
      },
      async onSubmit() {
        return { signal: { goalCompleted: true }, prompt: '功能列表已更新，进入 INIT 初始化本轮上下文。' };
      },
    },



    {
      id: 'create.research',
      prompt: (env, state) => [
        '[目标] 研究当前 checklist goal',
        currentItemText(state),
        '1. 用 read / grep / glob / web_search / read_url / bash（只读）充分调研当前 goal 的实现思路、涉及文件和风险；',
        '2. 调研清楚后，调用 todo_write 写出本 goal 的完整 dynamic plan（第一项 in_progress，只放本 goal 的任务，不要放其他 goal 的任务）；',
        '3. 遇到需要快速定位模块依赖时，可调用 dependency_map 按需生成轻量依赖图（单次 ≤1024 tokens，非必调）。',
        '4. 调用 submit_state 结束研究。',
      ].join('\n'),
      allowedTools: [
        'read', 'grep', 'glob', 'web_search',
        'read_url', 'read_url_batch', 'read_url_links', 'read_url_site',
        'read_image', 'list_agents', 'get_goal', 'job_list', 'job_output',
        'ask_user_question', 'todo_write', 'bash', 'str_replace_editor', 'dependency_map',
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
        '不要直接执行 git 修改命令（会被拒绝）；本轮文件改动会在 DEBUG 验证通过后由 git_commit 统一提交。',
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
        '验证通过后，先调用 git_commit 工具（由 mode-gate-git-commit skill 提供）完成本轮 commit + push（直接执行 git 修改命令会被拒绝），再调用 submit_state 结束本状态。',
        '用户显式要求压缩时可用工具 goto_accumulation（进入沉淀流程逐步整理）或 accumulation_and_init（已整理完长期文档时一键沉淀并进入 INIT），聊天框里对应 /goto-accumulation、/accumulation-and-init；自动压缩只在超预算且本阶段结束时触发，不要主动调用。',
      ].join('\n'),
      allowedTools: [
        'bash', 'str_replace_editor', 'write', 'edit', 'apply_patch', 'todo_write',
        'ask_user_question', 'read', 'grep', 'glob', 'web_search', 'read_url',
        'read_url_batch', 'read_url_links', 'read_url_site', 'read_image',
        'list_agents', 'get_goal', 'job_list', 'job_output', 'git_commit',
      ],
      requiredCalls: [{ tool: 'git_commit', min: 1 }],
      submitTool: {
        name: 'submit_state',
        async parse(args) {
          return { summary: typeof args?.summary === 'string' ? args.summary : '' };
        },
      },
      async onSubmit(parsed, env, state) {
        // checklist-11: 计划推进与 loopMemory 追加移到 create.debug，
        // 这样 DEBUG 可直接进入下一轮 RESEARCH，不再默认绕 ACCUMULATE。
        const item = staticPlanCurrent(state.staticPlan);
        const advanced = advanceStaticPlan(state.staticPlan);
        const memory = appendLoopMemory(state, item);
        return {
          signal: { goalCompleted: true },
          statePatch: { staticPlan: advanced, loopMemory: memory },
          prompt: item ? `已完成 checklist goal「${item.text}」。` : '调试完成。',
        };
      },
    },

    {
      id: 'create.accumulate',
      prompt: (env, state) => [
        '[目标] 整理长期文档并压缩上下文（仅在超预算时进入）',
        '本轮 checklist goal 已在 DEBUG 结束时完成并推进，这里不再重复推进计划。',
        '1. 先主动检查本轮是否有用户强调或纠正过的模式；默认鼓励不写，只有确实值得跨轮复用才写。',
        '2. 写入前必须先调用 pattern_reason 提交 reason，说明这是哪一条用户强调/纠正过的模式；reason 只用于审计，不会写入任何行为模式文件；缺少 reason 时写入会被拒绝。',
        '3. 如需写入：第一步调用 pattern_write step=facts 传 trigger / wrong / right，得到 pattern_id；第二步调用 pattern_write step=rationale 传 pattern_id / why / evidence，自动附加到同一条规则明细。',
        '热文件每个 pattern 只占一行摘要；「trigger → right」超过 20 字时，第一步额外传 body 参数（≤20 字的短摘要），详细内容仍留在 trigger / wrong / right。',
        '没有值得写的模式时，完成 pattern_reason 后调用一次 pattern_write skip=true。',
        '注意：只要第一步 facts 写入了规则，就必须在 submit_state 前用第二步 rationale 补全 why / evidence；存在缺项规则时提交会被拒绝。',
        '内容属于进展流水（例如「本轮完成了什么」「进度到哪」）会被拒绝，请改用 journal_append 写入 journal 冷层。不做相似度判断，重复与否由你自己判断后再写。',
        '如果发现已有规则过期（被新的用户强调推翻），用 pattern_overwrite 覆盖：mode=retire 只清除过期行，mode=replace 清除并写入新规则；必填 reason 作为审计说明。覆盖只把行移出热文件，明细与审计记录都保留。先用 pattern_list 只读现行热文件行（不读明细、不读短期对话），再判断哪条过期；可用 pattern_audit 查看变更记录。',
        '4. 同时检查本轮是否产生了稳定结构事实（模块职责 / 依赖方向与禁止边 / 关键 invariant / entrypoint / 不要碰的目录等）。默认不写；确需沉淀时先调用 architecture_reason 提交 reason（说明为何值得长期留存），再用 architecture_write 写入：mode=section 只更新一个结构 section（推荐），mode=replace 整篇替换。reason 只写 audit，不写入 architecture.md。',
        '5. architecture.md 只放稳定结构事实，不得混入功能状态或进展流水；超过 120 行或约 1000 tokens 的写入会被拒绝。没有结构变化时无需调用 architecture_write。',
        '6. 如需代码结构感知，可调用 dependency_map 按需生成轻量依赖图（正则抽取 import/require，不常驻注入；单次 ≤1024 tokens，超预算自动截断并提示用 focus 收窄）。只用于导航，不读业务代码细节。',
        '7. 长期文档整理完成后，调用 compress_context 压缩上下文（顺序强制：必须先完成 pattern_reason + pattern_write）。压缩会精简 hot loopMemory，并尽力压缩 harness 旧会话；harness 压缩不可用时静默降级，不会报错阻塞。',
        '8. 最后调用 submit_state 结束本状态；引擎会进入 INIT 阶段。',
      ].join('\n'),
      allowedTools: ['pattern_reason', 'pattern_write', 'pattern_overwrite', 'pattern_list', 'pattern_audit', 'journal_append', 'architecture_reason', 'architecture_write', 'architecture_audit', 'dependency_map', 'compress_context'],
      requiredCalls: [
        { tool: 'pattern_reason', min: 1 },
        { tool: 'pattern_write', min: 1 },
        { tool: 'compress_context', min: 1 },
      ],
      submitTool: {
        name: 'submit_state',
        async parse(args, env, state) {
          const project = state && state.featureIntentFile;
          const incomplete = env.patternStore.listIncomplete(project);
          if (incomplete.length) {
            const detail = incomplete
              .map((row) => `${row.project}/${row.id}（缺 ${row.missing.join('、')}）`)
              .join('、');
            throw new Error(
              `以下行为模式规则五字段不完整：${detail}。请对每条规则调用 pattern_write step=rationale 传 pattern_id / why / evidence 补全后再提交。`,
            );
          }
          if (!state.compression || !state.compression.at) {
            throw new Error('提交前必须先调用 compress_context 完成上下文压缩（先整理长期文档，再压缩，然后进入 INIT）。');
          }
          return { summary: typeof args?.summary === 'string' ? args.summary : '' };
        },
      },
      async onSubmit() {
        // checklist-11: ACCUMULATE 只负责沉淀/压缩，不再推进 staticPlan 或追加 loopMemory。
        return { signal: { goalCompleted: true }, prompt: '沉淀与压缩完成，进入 INIT。' };
      },
    },

    {
      id: 'create.init',
      prompt: (env, state) => [
        '[目标] 初始化本轮上下文（工作流首阶段）',
        currentItemText(state),
        '1. 只读取长期文档热文件与最近一次 feature intent，不读任何实际代码，不解锁新工具（本阶段引用 no-code-read 限制）。',
        '2. 用 list_feature_intents / get_feature_intent 读取最近一次 feature intent。',
        '3. journal / changelog / history 属于短期冷数据，默认不进入 hot 上下文。',
        '4. 不要读取完整短期对话；可用 dependency_map 做代码导航（按需生成、单次 ≤1024 tokens）。',
        '5. 调用 submit_state：首轮无需求进入需求识别，有待办进入下一轮 RESEARCH，全部完成则结束。',
      ].join('\n'),
      allowedTools: [
        'list_feature_intents', 'get_feature_intent',
        'dependency_map', 'todo_write',
      ],
      // 首阶段不读代码、不解锁新工具。
      lockUnlockTools: true,
      requiredCalls: [],
      submitTool: {
        name: 'submit_state',
        async parse(args) {
          return { summary: typeof args?.summary === 'string' ? args.summary : '' };
        },
      },
      async onSubmit() {
        return { signal: { goalCompleted: true }, prompt: '上下文初始化完成。' };
      },
    },

    {
      id: 'rough.requirement-recognition',
      prompt: (env) => [
        '[目标] 读取 feature intent 并拆解为 1 个 goal',
        '1. 不读任何文档，直接基于用户需求分解；',
        '2. 不读任何文档、不读实际文件、不解锁新工具，直接确认这 1 个 goal 的可验收边界；',
        '3. 用 update_feature_intent 写入 feature intent：用户原话字段由系统自动收集（无需你写），你需要提供 understanding、user_visible_behavior、feature_intent 和 checklist；',
        '4. checklist 只能有且仅有 1 项；同模块的多个需求（例如修改 UI 的某几个地方）必须合并成这 1 项可验收描述，不要拆成多个 goal；',
        '5. 如需记录调研任务，可调用 todo_write；',
        '6. 调用 submit_requirement_protocol 提交协议，通过后这 1 个 goal 会成为本工作流的 staticPlan 并同步到 DSH task 系统。',
        '本状态禁用 bash 与文件查看工具，只允许 feature intent 相关工具，禁止写文件；专心分解需求。',
      ].join('\n'),
      allowedTools: [
        'list_feature_intents', 'update_feature_intent',
        'submit_requirement_protocol',
        'list_agents', 'get_goal', 'job_list', 'job_output',
        'ask_user_question', 'todo_write',
      ],
      // 本阶段不读文件、不解锁新工具，专心分解需求。
      lockUnlockTools: true,
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
          if (!fields.userVisibleBehavior) throw new Error('feature intent 缺少 user_visible_behavior 展示字段；请用 update_feature_intent 补充后再提交协议。');
          if (!fields.featureIntent) throw new Error('feature intent 缺少 feature_intent 展示字段；请用 update_feature_intent 补充后再提交协议。');
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
        '3. 遇到需要快速定位模块依赖时，可调用 dependency_map 按需生成轻量依赖图（单次 ≤1024 tokens，非必调）。',
        '4. 调用 submit_state 结束研究。',
      ].join('\n'),
      allowedTools: [
        'read', 'grep', 'glob', 'web_search',
        'read_url', 'read_url_batch', 'read_url_links', 'read_url_site',
        'read_image', 'list_agents', 'get_goal', 'job_list', 'job_output',
        'ask_user_question', 'todo_write', 'bash', 'str_replace_editor', 'dependency_map',
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
        '实现完成后，先调用 git_commit 工具（由 mode-gate-git-commit skill 提供）完成 commit + push（直接执行 git 修改命令会被拒绝），再向用户清晰呈现改动内容与使用方式，然后调用 submit_state 结束本工作流。不要运行测试，不要写长期记忆。',
      ].join('\n'),
      allowedTools: [
        'bash', 'str_replace_editor', 'write', 'edit', 'apply_patch', 'todo_write',
        'read', 'grep', 'glob', 'web_search', 'read_url', 'read_url_batch',
        'read_url_links', 'read_url_site', 'read_image', 'list_agents',
        'get_goal', 'job_list', 'job_output', 'git_commit',
      ],
      requiredCalls: [{ tool: 'git_commit', min: 1 }],
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
