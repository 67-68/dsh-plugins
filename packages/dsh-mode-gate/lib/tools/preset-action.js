// preset-action tools — extracted from lib/index.js apply() (behavior unchanged).
// Registered via registerPresetActionTools(deps); deps carry apply-scope bindings (see index.js toolDeps).
import { readState } from '../engine/state.js';
import { textOutput } from '../shared/tool-output.js';

export function registerPresetActionTools({ ctx, workspaceOf, collectUserWords, intentWriteKey, grantBypass, activateStateGoal, defaultWorkspace, registerTool, registryFor, submitGoalTool, presetActionSkills, storesFor, latestEntry }) {
    registerTool({
      name: 'list_preset_actions',
      description: '列出所有 preset-action 候选 skill 的 id、说明与匹配条件。',
      parameters: {},
      output: textOutput(),
      async execute() {
        return JSON.stringify({
          ok: true,
          actions: presetActionSkills.map((skill) => ({
            id: skill.id, name: skill.name, title: skill.title, description: skill.description,
            match: skill.match, model: skill.model, reasoning_effort: skill.reasoningEffort, content: skill.content,
          })),
        }, null, 2);
      },
    });

    registerTool({
      name: 'submit_preset_action',
      description: '提交 preset-action 探测协议。命中时填写 skill_id；未命中时填写 no_match: true。',
      parameters: {
        skill_id: { type: 'string', description: '命中的 preset action id。' },
        no_match: { type: 'boolean', description: '未命中时填写 true。' },
      },
      output: textOutput(),
      async execute(args, exec) {
        const agent = exec.agent;
        if (agent === void 0) throw new Error('submit_preset_action 需要 agent 上下文');
        const result = await submitGoalTool(agent, 'submit_preset_action', args || {});
        const state = readState(agent);
        return JSON.stringify({ ok: true, phase: state.phase, workflowId: state.workflowId, ...(result.prompt ? { prompt: result.prompt } : {}) }, null, 2);
      },
    });
}
