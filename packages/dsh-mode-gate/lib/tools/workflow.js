// workflow tools — extracted from lib/index.js apply() (behavior unchanged).
// Registered via registerWorkflowTools(deps); deps carry apply-scope bindings (see index.js toolDeps).
import { formatCapabilities, readState, writeState } from '../engine/state.js';
import { textOutput } from '../shared/tool-output.js';

export function registerWorkflowTools({ ctx, workspaceOf, collectUserWords, intentWriteKey, grantBypass, activateStateGoal, defaultWorkspace, registerTool, registryFor, submitGoalTool, presetActionSkills, storesFor, latestEntry }) {
    registerTool({
      name: 'switch_mode',
      description: '请求切换工作流/状态。切换需要用户批准，批准后立即生效。',
      parameters: {
        workflow: { type: 'string', required: true, description: '目标工作流 id，例如 create / simple-action / IDLE。' },
        state: { type: 'string', description: '目标状态 id；省略时使用工作流 startState。' },
        reason: { type: 'string', description: '一句话说明为什么切换。' },
      },
      output: textOutput(),
      async execute(args, exec) {
        const agent = exec.agent;
        if (agent === void 0) throw new Error('switch_mode 需要 agent 上下文');
        const registry = registryFor(agent);
        const wf = registry.get(args.workflow);
        if (!wf) throw new Error(`未知工作流 ${String(args.workflow)}`);
        const stateId = args.state || wf.startState;
        await activateStateGoal(agent, args.workflow, stateId);
        return `已切换到 ${args.workflow} / ${stateId}`;
      },
    });

    registerTool({
      name: 'request_extra',
      description: '查看或申请额外的 skill 和 bash 命令访问。带 skills/bash 参数时作为问题向用户申报。',
      parameters: {
        skills: { type: 'array', items: { type: 'string' }, description: '要申请的 skill 名称列表。' },
        bash: { type: 'array', items: { type: 'string' }, description: '要申请的 bash 命令动词列表。' },
      },
      output: textOutput(),
      async execute(args, exec) {
        const agent = exec.agent;
        if (agent === void 0) throw new Error('request_extra 需要 agent 上下文');
        const state = readState(agent);
        const requestedSkills = Array.isArray(args.skills) ? args.skills.filter((s) => typeof s === 'string' && s.trim()) : [];
        const requestedBash = Array.isArray(args.bash) ? args.bash.filter((s) => typeof s === 'string' && s.trim()) : [];
        if (requestedSkills.length || requestedBash.length) {
          const nextSkills = [...new Set([...state.skills, ...requestedSkills])];
          const nextBash = [...new Set([...state.bash, ...requestedBash])];
          writeState(agent, { skills: nextSkills, bash: nextBash });
          return formatCapabilities({ ...state, skills: nextSkills, bash: nextBash });
        }
        return formatCapabilities(state);
      },
    });

    registerTool({
      name: 'list_workflows',
      description: '列出当前工作区所有可用工作流及其按钮信息。',
      parameters: {},
      output: textOutput(),
      async execute(_args, exec) {
        const registry = registryFor(exec.agent);
        return JSON.stringify({
          ok: true,
          workspace: workspaceOf(exec.agent, defaultWorkspace),
          workflows: registry.listForModal().map((wf) => ({
            id: wf.id, label: wf.label, description: wf.description, startState: wf.startState, ui: wf.ui || {},
          })),
        }, null, 2);
      },
    });

    registerTool({
      name: 'get_workflow_state',
      description: '读取当前会话的 mode-gate 工作流状态（workflow/state/target/checklist/dynamicPlan/loopMemory）。',
      parameters: {},
      output: textOutput(),
      async execute(_args, exec) {
        const state = readState(exec.agent);
        return JSON.stringify({
          ok: true,
          workflowId: state.workflowId,
          phase: state.phase,
          target: state.target,
          goal: state.goal,
          staticPlan: state.staticPlan,
          dynamicPlan: state.dynamicPlan,
          loopMemory: state.loopMemory,
          pendingProtocol: state.pendingProtocol,
        }, null, 2);
      },
    });

    registerTool({
      name: 'select_workflow',
      description: '从 IDLE 选择并进入一个工作流（等价于 /mode <workflowId>）。',
      parameters: {
        workflow_id: { type: 'string', required: true, description: '工作流 id，例如 create / simple-action。' },
        state: { type: 'string', description: '可选起始状态；省略时使用工作流 startState。' },
      },
      output: textOutput(),
      async execute(args, exec) {
        const agent = exec.agent;
        if (agent === void 0) throw new Error('select_workflow 需要 agent 上下文');
        const registry = registryFor(agent);
        const wf = registry.get(args.workflow_id);
        if (!wf) throw new Error(`未知工作流 ${String(args.workflow_id)}`);
        const stateId = args.state || wf.startState;
        const activated = await activateStateGoal(agent, args.workflow_id, stateId);
        return `已静默切换到 ${args.workflow_id} / ${stateId}。${activated && activated.prompt ? `\n当前阶段：${activated.prompt}` : ''}`;
      },
    });

    registerTool({
      name: 'submit_state',
      description: '结束当前状态/目标并交给引擎推进（用于研究、执行、调试、总结、preset action 执行）。',
      parameters: {
        summary: { type: 'string', description: '本状态完成了什么的一句话总结。' },
      },
      output: textOutput(),
      async execute(args, exec) {
        const agent = exec.agent;
        if (agent === void 0) throw new Error('submit_state 需要 agent 上下文');
        const result = await submitGoalTool(agent, 'submit_state', args || {});
        const state = readState(agent);
        return JSON.stringify({ ok: true, phase: state.phase, workflowId: state.workflowId, ...(result.prompt ? { prompt: result.prompt } : {}) }, null, 2);
      },
    });
}
