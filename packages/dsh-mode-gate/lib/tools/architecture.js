// architecture tools — extracted from lib/index.js apply() (behavior unchanged).
// Registered via registerArchitectureTools(deps); deps carry apply-scope bindings (see index.js toolDeps).
import { MAX_DEPENDENCY_TOKENS, generateDependencyMap } from '../engine/dependency-map.js';
import { textOutput } from '../shared/tool-output.js';
import { assertArchitectureReason, assertArchitectureSelfCheckFresh } from '../stores/architecture-store.js';
import { readState, writeState } from '../engine/state.js';
import { resolve } from 'node:path';

export function registerArchitectureTools({ ctx, workspaceOf, collectUserWords, intentWriteKey, grantBypass, activateStateGoal, defaultWorkspace, registerTool, registryFor, submitGoalTool, presetActionSkills, storesFor, latestEntry }) {
    registerTool({
      name: 'architecture_reason',
      description: '写入 architecture.md 前的专用必要性自查。必填 reason，说明本轮为何要沉淀/修改某条稳定结构事实。reason 只用于门禁与审计，不写入 architecture.md。',
      parameters: {
        reason: { type: 'string', required: true, description: '自查结论：为什么这是值得长期沉淀的稳定结构事实（4-200 字，不能是进展流水）。' },
      },
      output: textOutput(),
      async execute(args, exec) {
        const agent = exec.agent;
        const state = readState(agent);
        const reason = assertArchitectureReason(args.reason);
        const goal = state.goal && typeof state.goal === 'object' ? state.goal : null;
        writeState(agent, {
          architectureSelfCheck: {
            reason,
            goalId: goal ? goal.id : null,
            goalStartedAt: goal ? goal.startedAt : null,
            at: Date.now(),
          },
        });
        return JSON.stringify(
          {
            ok: true,
            message: '必要性自查已记录（reason 不会写入 architecture.md）。确认确有稳定结构事实后再调用 architecture_write；没有结构变化时无需调用写入。',
          },
          null,
          2,
        );
      },
    });

    registerTool({
      name: 'architecture_write',
      description: '写入 architecture.md。必须先在本 goal 激活期调用 architecture_reason 提交 reason，否则拒绝。mode=section 只更新一个结构 section（推荐），mode=replace 整篇替换。写入前校验 ≤120 行/约 1000 tokens 且不混入进展流水；reason 只写 audit，不写文档。',
      parameters: {
        mode: { type: 'string', enum: ['section', 'replace'], description: 'section（默认）更新单节；replace 整篇替换。' },
        section: { type: 'string', description: 'mode=section 时要 upsert 的 section（id 或中文标题，如 modules / 模块职责）。' },
        content: { type: 'string', required: true, description: 'mode=section 时为该节正文；mode=replace 时为整篇 architecture.md 内容。' },
      },
      output: textOutput(),
      async execute(args, exec) {
      // 项目内的长期记忆 store：按 exec.agent 的 workspace 解析。
      const { architecture } = storesFor(exec.agent);
        const agent = exec.agent;
        const state = readState(agent);
        const goal = state.goal && typeof state.goal === 'object' ? state.goal : null;
        assertArchitectureSelfCheckFresh(state.architectureSelfCheck, goal);
        const reason = state.architectureSelfCheck.reason;
        if (args.mode === 'replace') {
          const result = architecture.write(args.content, { reason, action: 'replace' });
          return JSON.stringify({ ok: true, mode: 'replace', ...result, note: 'reason 已写入 audit，未写入 architecture.md。' }, null, 2);
        }
        const result = architecture.writeSection(args.section, args.content, { reason });
        return JSON.stringify({ ok: true, mode: 'section', section: args.section, ...result, note: 'reason 已写入 audit，未写入 architecture.md。' }, null, 2);
      },
    });

    registerTool({
      name: 'architecture_audit',
      description: '查看 architecture.md 的变更记录（audit 冷文件）：每次写入的时间、行数/tokens 与 reason。',
      parameters: {},
      output: textOutput(),
      async execute(_args, exec) {
      // 项目内的长期记忆 store：按 exec.agent 的 workspace 解析。
      const { architecture } = storesFor(exec.agent);
        const text = architecture.readAudit();
        return text || '（architecture.md 暂无变更记录）';
      },
    });

    // ── 按需轻量依赖图（代码导航）────────────────────────────────────────
    // 不常驻注入；只在调用时生成，单次输出硬上限 1024 tokens。
    registerTool({
      name: 'dependency_map',
      description: `按需生成轻量代码依赖图（源码相对 import/require 关系），用于代码导航；单次输出硬上限 ${MAX_DEPENDENCY_TOKENS} tokens，超预算自动截断并提示用 focus 收窄。`,
      parameters: {
        root: { type: 'string', description: '相对 workspace 的扫描根目录；省略时扫描整个 workspace。' },
        focus: { type: 'string', description: '只看与某个路径/模块相关的子图（命中文件及其 1 跳邻居）。' },
      },
      output: textOutput(),
      async execute(args, exec) {
        const workspace = workspaceOf(exec.agent, defaultWorkspace);
        const requested = typeof args.root === 'string' && args.root.trim() ? args.root.trim() : '.';
        const root = resolve(workspace, requested);
        const result = generateDependencyMap(root, {
          focus: args.focus,
          maxTokens: MAX_DEPENDENCY_TOKENS,
        });
        return result.text;
      },
    });
}
