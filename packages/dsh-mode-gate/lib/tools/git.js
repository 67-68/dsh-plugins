// git tools — extracted from lib/index.js apply() (behavior unchanged).
// Registered via registerGitTools(deps); deps carry apply-scope bindings (see index.js toolDeps).
import { assertTextLength } from '../services/text-limits.js';
import { textOutput } from '../shared/tool-output.js';
import { readState } from '../engine/state.js';
import { runGitUpdate } from '../services/git-update.js';
import { staticPlanCurrent } from '../engine/plans.js';
import { join } from 'node:path';

export function registerGitTools({ ctx, workspaceOf, collectUserWords, intentWriteKey, grantBypass, activateStateGoal, defaultWorkspace, registerTool, registryFor, submitGoalTool, presetActionSkills, storesFor, latestEntry }) {
    registerTool({
      name: 'git_commit',
      description: 'Git 更新（checklist-15）：每轮更新用本工具完成 git add -A + commit + push，输出可审计 update，并把 commit hash 自动写入功能列表。Agent 不要直接执行 git 修改命令。',
      parameters: {
        message: { type: 'string', description: 'commit message；省略时按当前 feature 与 checklist goal 自动生成。' },
        feature_id: { type: 'string', description: '要回填 commit 的 feature id；省略时使用当前 feature intent 文件名。' },
      },
      output: textOutput(),
      async execute(args, exec) {
      // 项目内的长期记忆 store：按 exec.agent 的 workspace 解析。
      const { featureList } = storesFor(exec.agent);
        const agent = exec.agent;
        const state = readState(agent);
        const workspace = workspaceOf(agent, defaultWorkspace);
        const featureId = (typeof args.feature_id === 'string' && args.feature_id.trim()) || state.featureIntentFile || '';
        let message = typeof args.message === 'string' ? args.message.trim() : '';
        if (message) assertTextLength(message, 200, 'commit message');
        if (!message) {
          const item = staticPlanCurrent(state.staticPlan);
          const feature = featureId || 'update';
          const goalText = item ? `${item.id} ${item.text}` : 'update';
          message = `mode-gate(${feature}): ${goalText}`.slice(0, 140);
        }
        const update = runGitUpdate(workspace, message);
        if (update.skipped) {
          return JSON.stringify(
            { ok: true, ...update, update: `[mode-gate git update] ${update.note || update.reason || '跳过 git update'}` },
            null,
            2,
          );
        }
        let featureNote = '';
        if (featureId) {
          try {
            const feature = featureList.setCommit(featureId, update.commit);
            featureNote = `commit hash 已自动写入功能列表 ${feature.id}（索引行与详情）。`;
          } catch (err) {
            featureNote = `commit hash 未写入功能列表：${(err && err.message) || err}`;
          }
        } else {
          featureNote = '无法确定 feature id，commit hash 未写入功能列表。';
        }
        const updateText = [
          '[mode-gate git update]',
          `commit: ${update.commit}`,
          `branch: ${update.branch}`,
          `message: ${update.message || '（无新提交，已推送现有提交）'}`,
          `pushed: ${update.pushed}`,
          featureNote,
        ].join('\n');
        return JSON.stringify({ ok: true, ...update, featureId, featureNote, update: updateText }, null, 2);
      },
    });
}
