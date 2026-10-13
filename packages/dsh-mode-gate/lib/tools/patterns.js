// patterns tools — extracted from lib/index.js apply() (behavior unchanged).
// Registered via registerPatternTools(deps); deps carry apply-scope bindings (see index.js toolDeps).
import { assertNotProgress, assertReasonValid, assertSelfCheckFresh } from '../services/pattern-gate.js';
import { textOutput } from '../shared/tool-output.js';
import { readState, writeState } from '../engine/state.js';
import { join } from 'node:path';

export function registerPatternTools({ ctx, workspaceOf, collectUserWords, intentWriteKey, grantBypass, activateStateGoal, defaultWorkspace, registerTool, registryFor, submitGoalTool, presetActionSkills, storesFor, latestEntry }) {

    // ── behavior-pattern self-check（专用自查 skill）──────────────────────
    // 写入行为模式前必须先提交 reason 完成「这是否是用户强调/纠正过的模式」自查。
    // reason 只存在 state 里用于审计，绝不写入 patterns 目标文件。
    const MAX_PATTERNS_PER_ROUND = 3;
    registerTool({
      name: 'pattern_reason',
      description: '行为模式写入前的专用自查。必填 reason，说明本轮要写的模式为何是用户强调或纠正过的模式。reason 只用于审计，不写入任何行为模式文件。',
      parameters: {
        project: { type: 'string', description: '项目名；省略时使用当前 feature intent 文件名。' },
        reason: { type: 'string', required: true, description: '自查结论：为什么这是用户强调/纠正过的模式（4-200 字）。' },
      },
      output: textOutput(),
      async execute(args, exec) {
        const agent = exec.agent;
        const state = readState(agent);
        const project = (typeof args.project === 'string' && args.project.trim()) || state.featureIntentFile || '';
        const reason = assertReasonValid(args.reason);
        const goal = state.goal && typeof state.goal === 'object' ? state.goal : null;
        writeState(agent, {
          patternSelfCheck: {
            reason,
            project,
            goalId: goal ? goal.id : null,
            goalStartedAt: goal ? goal.startedAt : null,
            at: Date.now(),
          },
        });
        return JSON.stringify(
          {
            ok: true,
            project,
            message: '自查已记录（reason 不会写入行为模式文件）。现在可以调用 pattern_write；没有值得复用的模式时传 skip=true。',
          },
          null,
          2,
        );
      },
    });

    // ── journal（冷层）：进展流水的落点 ───────────────────────────────────
    registerTool({
      name: 'journal_append',
      description: '把进展流水写入 journal 冷层（不进入 hot 上下文）。行为模式拒绝进展流水时会指向这里。',
      parameters: {
        project: { type: 'string', description: '项目名；省略时使用当前 feature intent 文件名。' },
        text: { type: 'string', required: true, description: '进展内容。' },
      },
      output: textOutput(),
      async execute(args, exec) {
      // 项目内的长期记忆 store：按 exec.agent 的 workspace 解析。
      const { journal } = storesFor(exec.agent);
        const state = readState(exec.agent);
        const project = (typeof args.project === 'string' && args.project.trim()) || state.featureIntentFile || '';
        if (!project) throw new Error('无法确定 project：请传 project 参数，或先完成 feature intent 记录。');
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text) throw new Error('journal 内容不能为空。');
        const result = journal.append(project, text);
        return JSON.stringify({ ok: true, ...result }, null, 2);
      },
    });

    registerTool({
      name: 'pattern_write',
      description: '两步写入行为模式。第一步 step=facts 必填 trigger/wrong/right，返回 pattern_id；第二步 step=rationale 必填 pattern_id/why/evidence，自动附加到同一条规则明细。skip=true 表示本轮没有值得写入的模式。',
      parameters: {
        project: { type: 'string', description: '项目名；省略时使用当前 feature intent 文件名。' },
        skip: { type: 'boolean', description: '本轮没有值得写入的模式时传 true。' },
        step: { type: 'string', enum: ['facts', 'rationale'], description: '第一步 facts，第二步 rationale；默认 facts。' },
        pattern_id: { type: 'string', description: '第一步返回的 pattern id；第二步必填。' },
        body: { type: 'string', description: '热文件行摘要，≤20 字；省略时用「trigger → right」，超长会被拒绝。' },
        trigger: { type: 'string', description: '触发条件。' },
        wrong: { type: 'string', description: '错误做法。' },
        right: { type: 'string', description: '正确做法。' },
        why: { type: 'string', description: '为什么。' },
        evidence: { type: 'string', description: '证据。' },
      },
      output: textOutput(),
      async execute(args, exec) {
      // 项目内的长期记忆 store：按 exec.agent 的 workspace 解析。
      const { patternStore } = storesFor(exec.agent);
        const agent = exec.agent;
        const state = readState(agent);
        const project = (typeof args.project === 'string' && args.project.trim()) || state.featureIntentFile;
        if (!project) throw new Error('无法确定 project：请传 project 参数，或先完成 feature intent 记录。');
        const step = args.step === 'rationale' ? 'rationale' : 'facts';
        // 写入前自查门禁：必须是本 goal 激活期内提交过 pattern_reason。
        const goal = state.goal && typeof state.goal === 'object' ? state.goal : null;
        assertSelfCheckFresh(state.patternSelfCheck, goal);
        if (args.skip === true) {
          return JSON.stringify({ ok: true, project, skipped: true, written: 0 }, null, 2);
        }
        if (step === 'rationale') {
          const patternId = typeof args.pattern_id === 'string' ? args.pattern_id.trim() : '';
          if (!patternId) throw new Error('第二步必须提供 pattern_id（第一步返回的 id）。');
          const result = patternStore.addRationale(project, patternId, { why: args.why, evidence: args.evidence });
          return JSON.stringify({ ok: true, project, ...result }, null, 2);
        }
        // 进展流水不得进入行为模式热层：命中 marker 即拒绝并指向 journal。
        assertNotProgress({ body: args.body, trigger: args.trigger, wrong: args.wrong, right: args.right }, journal.filePath(project));
        // 热文件预算：单次（本轮 ACCUMULATE）最多写入 3 行。
        const startedAt = goal ? goal.startedAt : null;
        const round = state.patternRound && state.patternRound.goalStartedAt === startedAt
          ? state.patternRound
          : { goalStartedAt: startedAt, ids: [] };
        if (round.ids.length >= MAX_PATTERNS_PER_ROUND) {
          throw new Error(
            `单次最多写入 ${MAX_PATTERNS_PER_ROUND} 行行为模式（本轮已写入 ${round.ids.length} 条）。` +
              '请只保留最值得复用的，其余改写入 journal 或留到下一轮。',
          );
        }
        const result = patternStore.addRule(project, {
          trigger: args.trigger,
          wrong: args.wrong,
          right: args.right,
          body: args.body,
        });
        writeState(agent, { patternRound: { goalStartedAt: startedAt, ids: [...round.ids, result.id] } });
        return JSON.stringify({ ok: true, project, ...result, roundWritten: round.ids.length + 1 }, null, 2);
      },
    });

    registerTool({
      name: 'pattern_overwrite',
      description: '覆盖行为模式：清除过期规则行。mode=retire（默认）只把过期行移出热文件，明细保留并标记 retired；mode=replace 同时写入一条完整的新规则并互相留引用。必填 reason 作为可审计的变更说明；所有变更写入 audit 冷文件。',
      parameters: {
        project: { type: 'string', description: '项目名；省略时使用当前 feature intent 文件名。' },
        pattern_id: { type: 'string', required: true, description: '要覆盖的规则 id，例如 P001。' },
        reason: { type: 'string', required: true, description: '为什么覆盖/清除这条规则（可审计的变更说明）。' },
        mode: { type: 'string', enum: ['retire', 'replace'], description: 'retire 只清除；replace 清除并写入新规则（需同时提供完整五字段）。' },
        body: { type: 'string', description: 'replace 时新规则的热文件行摘要，≤20 字。' },
        trigger: { type: 'string', description: 'replace 时新规则的触发条件。' },
        wrong: { type: 'string', description: 'replace 时新规则的错误做法。' },
        right: { type: 'string', description: 'replace 时新规则的正确做法。' },
        why: { type: 'string', description: 'replace 时新规则的 why。' },
        evidence: { type: 'string', description: 'replace 时新规则的 evidence。' },
      },
      output: textOutput(),
      async execute(args, exec) {
      // 项目内的长期记忆 store：按 exec.agent 的 workspace 解析。
      const { patternStore } = storesFor(exec.agent);
        const state = readState(exec.agent);
        const project = (typeof args.project === 'string' && args.project.trim()) || state.featureIntentFile;
        if (!project) throw new Error('无法确定 project：请传 project 参数，或先完成 feature intent 记录。');
        const patternId = typeof args.pattern_id === 'string' ? args.pattern_id.trim() : '';
        if (!patternId) throw new Error('覆盖必须提供 pattern_id。');
        const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
        if (!reason) throw new Error('覆盖必须提供 reason，作为可审计的变更说明。');
        if (args.mode === 'replace') {
          assertNotProgress({ body: args.body, trigger: args.trigger, wrong: args.wrong, right: args.right }, journal.filePath(project));
          const result = patternStore.replace(project, patternId, {
            trigger: args.trigger,
            wrong: args.wrong,
            right: args.right,
            body: args.body,
            why: args.why,
            evidence: args.evidence,
            reason,
          });
          return JSON.stringify({ ok: true, project, mode: 'replace', ...result }, null, 2);
        }
        const result = patternStore.retire(project, patternId, { reason });
        return JSON.stringify({ ok: true, project, mode: 'retire', ...result }, null, 2);
      },
    });

    registerTool({
      name: 'pattern_list',
      description: '只读当前项目行为模式热文件（一行一条规则摘要）：ACCUMULATE 检查已有规则是否过期时使用，不读明细、不读短期对话。',
      parameters: {
        project: { type: 'string', description: '项目名；省略时使用当前 feature intent 文件名。' },
      },
      output: textOutput(),
      async execute(args, exec) {
      // 项目内的长期记忆 store：按 exec.agent 的 workspace 解析。
      const { patternStore } = storesFor(exec.agent);
        const state = readState(exec.agent);
        const project = (typeof args.project === 'string' && args.project.trim()) || state.featureIntentFile;
        if (!project) throw new Error('无法确定 project：请传 project 参数，或先完成 feature intent 记录。');
        const rows = patternStore.list(project);
        if (!rows.length) return `（${project} 热文件暂无规则）`;
        return rows.map((row) => `- [${row.id}] ${row.body}`).join('\n');
      },
    });
    registerTool({
      name: 'pattern_audit',
      description: '查看行为模式的变更记录（audit 冷文件）：create / rationale / retire / replace 的完整流水。',
      parameters: {
        project: { type: 'string', description: '项目名；省略时使用当前 feature intent 文件名。' },
      },
      output: textOutput(),
      async execute(args, exec) {
      // 项目内的长期记忆 store：按 exec.agent 的 workspace 解析。
      const { patternStore } = storesFor(exec.agent);
        const state = readState(exec.agent);
        const project = (typeof args.project === 'string' && args.project.trim()) || state.featureIntentFile;
        if (!project) throw new Error('无法确定 project：请传 project 参数，或先完成 feature intent 记录。');
        const text = patternStore.readAudit(project);
        return text || `（${project} 暂无变更记录）`;
      },
    });
}
