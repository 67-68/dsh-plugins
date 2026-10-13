// feature-intent tools — extracted from lib/index.js apply() (behavior unchanged).
// Registered via registerFeatureIntentTools(deps); deps carry apply-scope bindings (see index.js toolDeps).
import { readHeadCommit } from '../services/git-commit.js';
import { textOutput } from '../shared/tool-output.js';
import { readState, writeState } from '../engine/state.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function registerFeatureIntentTools({ ctx, workspaceOf, collectUserWords, intentWriteKey, grantBypass, activateStateGoal, defaultWorkspace, registerTool, registryFor, submitGoalTool, presetActionSkills, storesFor, latestEntry }) {
    registerTool({
      name: 'list_feature_intents',
      description: '列出 feature intent 目录下的所有需求意图文件。',
      parameters: {},
      output: textOutput(),
      async execute(_args, exec) {
      // 项目内的长期记忆 store：按 exec.agent 的 workspace 解析。
      const { featureIntents } = storesFor(exec.agent);
        const intents = await featureIntents.list();
        return JSON.stringify({ ok: true, dir: featureIntents.dir, intents }, null, 2);
      },
    });
    registerTool({
      name: 'feature_tree',
      description: '查看 feature overview / feature intent 的树状层级。不带 path 时列出根层级；带 path 时列出该节点的全部上级（直至根）与全部直属下属。',
      parameters: {
        path: { type: 'string', description: '节点逻辑路径（如 ui 或 ui/nested/deep）；省略则列出根层级。' },
      },
      output: textOutput(),
      async execute(args, exec) {
      // 项目内的长期记忆 store：按 exec.agent 的 workspace 解析。
      const { featureTree } = storesFor(exec.agent);
        const path = typeof args.path === 'string' ? args.path.trim() : '';
        if (!path) {
          const roots = featureTree.tree().map((node) => ({
            type: node.type,
            path: node.path,
            name: node.name,
            title: node.title || '',
            hasChildren: Boolean(node.children && node.children.length > 0),
          }));
          return JSON.stringify({ ok: true, scope: 'root', nodes: roots }, null, 2);
        }
        const described = featureTree.describeNode(path);
        return JSON.stringify({ ok: true, scope: 'node', ...described }, null, 2);
      },
    });

    registerTool({
      name: 'get_feature_intent',
      description: '读取指定的 feature intent 文件内容。',
      parameters: { name: { type: 'string', required: true, description: 'feature intent 文件名（不带目录，可选 .md 后缀）。' } },
      output: textOutput(),
      async execute(args, exec) {
      // 项目内的长期记忆 store：按 exec.agent 的 workspace 解析。
      const { featureIntents } = storesFor(exec.agent);
        const resolved = featureIntents.get(args.name);
        return JSON.stringify({ ok: true, name: resolved.name, file: resolved.file, path: resolved.path, content: resolved.content }, null, 2);
      },
    });

    registerTool({
      name: 'update_feature_intent',
      description: '向 feature intent 追加一条记录。用户原话由系统自动收集，Agent 需提供 Agent 理解、用户可见行为、功能意图与可验收 checklist。',
      parameters: {
        name: { type: 'string', required: true, description: 'feature intent 文件名（不带目录，可选 .md 后缀）。' },
        user_words: { type: 'string', description: '已废弃：用户原话由系统自动收集，传入也会被自动收集值覆盖。' },
        understanding: { type: 'string', required: true, description: 'Agent 对需求的理解与拆解。' },
        user_visible_behavior: { type: 'string', required: true, description: '用户在新工作流下如何工作/如何感知本次改动（展示字段）。' },
        feature_intent: { type: 'string', required: true, description: '对本次功能修改意图的展示描述（展示字段）。' },
        checklist: { type: 'array', items: { type: 'string' }, required: true, description: '可验收节点，例如「按钮在 xx 处出现」。' },
        project_overview: { type: 'string', description: '仅当文件不存在时必填：项目概述，会写入 feature intent 文件的 Project Overview 段。' },
      },
      output: textOutput(),
      async execute(args, exec) {
      // 项目内的长期记忆 store：按 exec.agent 的 workspace 解析。
      const { featureIntents } = storesFor(exec.agent);
        const checklist = Array.isArray(args.checklist) ? args.checklist.filter((s) => typeof s === 'string' && s.trim()) : [];
        if (checklist.length === 0) throw new Error('checklist 不能为空，请提供至少一个可验收节点。');
        const agent = exec && exec.agent;
        const collected = agent ? collectUserWords(agent) : '';
        const userWords = collected || (typeof args.user_words === 'string' ? args.user_words.trim() : '');
        if (!userWords) {
          throw new Error('未能自动收集到用户原话；请确认会话中已存在本次工作流的用户输入。');
        }
        const userVisibleBehavior = typeof args.user_visible_behavior === 'string' ? args.user_visible_behavior.trim() : '';
        if (!userVisibleBehavior) throw new Error('user_visible_behavior 不能为空。');
        const featureIntent = typeof args.feature_intent === 'string' ? args.feature_intent.trim() : '';
        if (!featureIntent) throw new Error('feature_intent 不能为空。');
        const result = featureIntents.append(
          args.name,
          { userWords, understanding: args.understanding, userVisibleBehavior, featureIntent, checklist },
          args.project_overview,
        );
        // 记录本轮已写入的 feature intent（供 inject 路线协议校验「一个都不能少」）。
        if (agent) {
          const prev = readState(agent);
          const written = Array.isArray(prev.featureIntentWrites) ? prev.featureIntentWrites : [];
          const path = intentWriteKey(args.name);
          if (path && !written.includes(path)) {
            writeState(agent, { featureIntentWrites: [...written, path] });
          }
        }
        return JSON.stringify({ ok: true, ...result, message: `已追加到 ${result.file}${result.created ? '（新建文件）' : ''}` }, null, 2);
      },
    });
    registerTool({
      name: 'update_feature_list',
      description: '更新功能列表总体条目：写入 user_visible_behavior 与 feature_intent，并把 status 置为 in_progress（再次更新意味着该功能进入新一轮工作，已 done 的功能会被重新打开）。commit 由系统自动生成，done 只能由 finish_feature 设置。',
      parameters: {
        feature_id: { type: 'string', description: 'feature id；省略时使用当前 feature intent 文件名。' },
        title: { type: 'string', description: 'feature 标题。' },
        module: { type: 'string', description: 'feature 所属模块。' },
        user_visible_behavior: { type: 'string', required: true, description: '总体用户可见行为，不超过 500 字。' },
        feature_intent: { type: 'string', required: true, description: '总体功能意图，不超过 50 字。' },
        status: { type: 'string', enum: ['in_progress'], description: '功能状态；只能置为 in_progress，done 必须走 finish_feature。' },
      },
      output: textOutput(),
      async execute(args, exec) {
      // 项目内的长期记忆 store：按 exec.agent 的 workspace 解析。
      const { featureList } = storesFor(exec.agent);
        const agent = exec.agent;
        const state = readState(agent);
        const featureId = (typeof args.feature_id === 'string' && args.feature_id.trim()) || state.featureIntentFile;
        if (!featureId) throw new Error('无法确定 feature id：请传 feature_id，或先完成 feature intent 记录。');
        // 字段级校验统一由 feature-list-store 负责（任何写入路径都受同一约束）。
        const result = featureList.upsert({
          id: featureId,
          title: args.title,
          module: args.module,
          status: 'in_progress',
          userVisibleBehavior: args.user_visible_behavior,
          featureIntent: args.feature_intent,
        });
        return JSON.stringify({ ok: true, ...result }, null, 2);
      },
    });

    registerTool({
      name: 'finish_feature',
      description: '完成一个功能：必须提供真实证据（例如验证命令与结果）。系统会置 status=done、记录完成时间，并自动读取当前 HEAD 的 commit hash 写入功能列表。',
      parameters: {
        feature_id: { type: 'string', description: 'feature id；省略时使用当前 feature intent 文件名。' },
        evidence: { type: 'string', required: true, description: '真实证据，例如验证命令、测试输出或可核对的结论。' },
      },
      output: textOutput(),
      async execute(args, exec) {
      // 项目内的长期记忆 store：按 exec.agent 的 workspace 解析。
      const { featureList } = storesFor(exec.agent);
        const agent = exec.agent;
        const state = readState(agent);
        const featureId = (typeof args.feature_id === 'string' && args.feature_id.trim()) || state.featureIntentFile;
        if (!featureId) throw new Error('无法确定 feature id：请传 feature_id，或先完成 feature intent 记录。');
        const workspace = workspaceOf(agent, defaultWorkspace);
        const commit = readHeadCommit(workspace);
        const result = featureList.finish(featureId, { evidence: args.evidence, commit });
        return JSON.stringify(
          {
            ok: true,
            ...result,
            commitAutoFilled: Boolean(commit),
            note: commit
              ? 'commit hash 已自动读取当前 HEAD 写入功能列表。'
              : '当前工作区未取到 HEAD commit；checklist-15 的 git skill 完成 commit+push 后会用 setCommit 回填。',
          },
          null,
          2,
        );
      },
    });
    registerTool({
      name: 'get_feature',
      description: '独立查看入口：按 feature id 返回索引行与完整详情（user_visible_behavior / feature_intent / 完成证据等）。',
      parameters: {
        feature_id: { type: 'string', description: 'feature id；省略时使用当前 feature intent 文件名。' },
      },
      output: textOutput(),
      async execute(args, exec) {
      // 项目内的长期记忆 store：按 exec.agent 的 workspace 解析。
      const { featureList } = storesFor(exec.agent);
        const state = readState(exec.agent);
        const featureId = (typeof args.feature_id === 'string' && args.feature_id.trim()) || state.featureIntentFile;
        if (!featureId) throw new Error('无法确定 feature id：请传 feature_id，或先完成 feature intent 记录。');
        const detail = featureList.get(featureId);
        if (!detail) throw new Error(`feature "${featureId}" 不存在（可在 features.md 索引里查看已有 id）。`);
        const row = featureList.list().find((entry) => entry.id === detail.id);
        return [
          `# feature ${detail.id}`,
          '',
          '## 索引行',
          row ? `| ${row.id} | ${row.title} | ${row.module} | ${row.status} | ${row.commit} |` : '（索引中暂无此 id）',
          '',
          '## 详情',
          readFileSync(detail.path, 'utf8'),
        ].join('\n');
      },
    });

    registerTool({
      name: 'submit_requirement_protocol',
      description: '提交需求识别协议。提交后会在“工作流”界面等待用户确认：接受则进入功能列表更新，随后经 INIT 初始化本轮上下文再进入 RESEARCH；发送任意消息则视为拒绝并继续修改需求。',
      parameters: {
        protocol: { type: 'string', required: true, description: '固定为 requirement-recognition。' },
        version: { type: 'number', required: true, description: '固定为 1。' },
        feature_intent_file: { type: 'string', required: true, description: '本次查看/追加过的 feature intent 文件名。' },
        summary: { type: 'string', required: true, description: '一句话任务摘要。' },
      },
      output: textOutput(),
      async execute(args, exec) {
        const agent = exec.agent;
        if (agent === void 0) throw new Error('submit_requirement_protocol 需要 agent 上下文');
        // inject 路线：必须已修改全部被选 feature intent，缺一拒绝。
        const before = readState(agent);
        const selection = before.featureSelection;
        if (selection && selection.route === 'inject' && Array.isArray(selection.items)) {
          // 兼容历史 state 里已存的裸文件名：两侧都归一化成末段键后再比对。
          const written = new Set(
            (Array.isArray(before.featureIntentWrites) ? before.featureIntentWrites : []).map(intentWriteKey),
          );
          const missing = selection.items
            .filter((item) => item && item.type === 'intent')
            .map((item) => item.path)
            .filter((path) => !written.has(intentWriteKey(path)));
          if (missing.length > 0) {
            throw new Error(`以下被选 feature intent 尚未用 update_feature_intent 写入记录，一个都不能少：${missing.join('、')}。请逐个补写后再提交协议。`);
          }
        }
        const result = await submitGoalTool(agent, 'submit_requirement_protocol', args || {});
        const state = readState(agent);
        if (result && result.pendingApproval) {
          // 协议已提交待用户确认：直接终结本轮，不再让模型继续思考或输出。
          // 校验失败会走 throw 打回，不经过这里不断流。
          try {
            if (exec && typeof exec.concludeTurn === 'function') exec.concludeTurn();
          } catch (_err) {
            // 旧 harness 无 concludeTurn 时静默降级，仅靠 awaiting_user 提示约束模型。
          }
          return JSON.stringify({
            ok: true,
            pendingApproval: true,
            phase: state.phase,
            workflowId: state.workflowId,
            message: '协议已提交，等待用户在“工作流”界面确认。用户发送任意消息将视为拒绝，Agent 需继续修改需求。',
            display: result.display,
          }, null, 2);
        }
        return JSON.stringify({
          ok: true,
          phase: state.phase,
          workflowId: state.workflowId,
          staticPlan: state.staticPlan,
          ...(result.prompt ? { prompt: result.prompt } : {}),
        }, null, 2);
      },
    });
}
