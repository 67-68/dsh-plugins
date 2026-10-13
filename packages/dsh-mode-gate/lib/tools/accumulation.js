// accumulation tools — extracted from lib/index.js apply() (behavior unchanged).
// Registered via registerAccumulationTools(deps); deps carry apply-scope bindings (see index.js toolDeps).
import { assertLongTermDocsFirst, compressContext } from '../services/context-compressor.js';
import { textOutput } from '../shared/tool-output.js';
import { buildDependencyGraph } from '../engine/dependency-map.js';
import { extractEntryFields } from '../engine/plans.js';
import { readState, writeState } from '../engine/state.js';
import { resetContextPeak } from '../services/context-budget.js';
import { stageExplicitlyGrants, toolDisposition } from '../engine/permissions.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function registerAccumulationTools({ ctx, workspaceOf, collectUserWords, intentWriteKey, grantBypass, activateStateGoal, defaultWorkspace, registerTool, registryFor, submitGoalTool, presetActionSkills, storesFor, latestEntry }) {
    registerTool({
      name: 'compress_context',
      description: 'ACCUMULATE 的上下文压缩（专用）。必须先完成长期文档整理（pattern_reason + pattern_write）才能调用。压缩后引擎会进入 INIT。',
      parameters: {},
      output: textOutput(),
      async execute(_args, exec) {
      // 项目内的长期记忆 store：按 exec.agent 的 workspace 解析。
      const { architecture, featureIntents, featureList } = storesFor(exec.agent);
        const agent = exec.agent;
        const state = readState(agent);
        // 阶段门禁（与 permissions.toolDisposition 同口径的防御性自检）：
        // 压缩只在显式授予 compress_context 的阶段执行，'*' 不算授予。
        const stateDef = registryFor(agent).stateOf(state.workflowId, state.phase);
        const grantedTools = stateDef && stateDef.permissions ? stateDef.permissions.tools : undefined;
        // 与 pre-execute 同一份判断：/grant 过的 compress_context 不受阶段显式授予约束。
        if (!stageExplicitlyGrants(grantedTools, 'compress_context') && !grantBypass(state, 'compress_context')) {
          throw new Error(
            `compress_context 只在显式授予它的阶段可用（当前 ${state.workflowId}/${state.phase}）。`
            + '需要压缩时请先调用 goto_accumulation 进入 ACCUMULATION，或由用户使用 /accumulation-and-init。',
          );
        }
        assertLongTermDocsFirst((state.goal && state.goal.calls) || {});
        const result = await compressContext(agent, ctx, state);
        writeState(agent, {
          loopMemory: result.loopMemory,
          compression: result.compression,
          contextUsage: resetContextPeak(readState(agent).contextUsage),
        });
        return JSON.stringify({ ok: true, ...result.compression, message: '上下文压缩完成，可以 submit_state 进入 INIT。' }, null, 2);
      },
    });

    // ── 手动沉淀/压缩的共用实现（tool 与 / 命令共用同一份）──────────────
    async function doGotoAccumulation(agent) {
      const state = readState(agent);
      if (state.workflowId !== 'create') throw new Error(`当前工作流是 ${state.workflowId || 'IDLE'}，手动沉淀仅 CREATE 工作流可用。`);
      if (state.phase === 'ACCUMULATION') return { ok: true, message: '已在 ACCUMULATION，按正常沉淀流程继续即可。' };
      const activated = await activateStateGoal(agent, 'create', 'ACCUMULATION');
      return { ok: true, message: '已进入 ACCUMULATION，请按沉淀流程整理长期文档并压缩。', prompt: activated && activated.prompt ? String(activated.prompt).slice(0, 500) : '' };
    }
    async function doAccumulationAndInit(agent) {
      const state = readState(agent);
      if (state.workflowId !== 'create') throw new Error(`当前工作流是 ${state.workflowId || 'IDLE'}，手动沉淀仅 CREATE 工作流可用。`);
      assertLongTermDocsFirst((state.goal && state.goal.calls) || {});
      const result = await compressContext(agent, ctx, state);
      writeState(agent, {
        loopMemory: result.loopMemory,
        compression: { ...result.compression, manual: true },
        contextUsage: resetContextPeak(readState(agent).contextUsage),
      });
      await activateStateGoal(agent, 'create', 'INIT');
      return { ok: true, ...result.compression, manual: true, message: '沉淀与压缩完成，已进入 INIT。' };
    }

    // /init 的实现：inspect 全库并幂等填充长期记忆。只补空缺、不覆盖。
    async function initRepositoryMemory(agent) {
      const { architecture, featureIntents, featureList } = storesFor(agent);
      const root = workspaceOf(agent, defaultWorkspace);
      const lines = [`仓库：${root}`];
      const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.next', '.turbo', 'coverage', 'vendor', '.cache', 'out']);
      const readPkg = (dir) => {
        try {
          const file = join(dir, 'package.json');
          if (!existsSync(file)) return null;
          return JSON.parse(readFileSync(file, 'utf8'));
        } catch (_e) {
          return null;
        }
      };
      // 依赖图（内部相对 import 边）。
      let graph = null;
      try {
        graph = buildDependencyGraph(root, {});
      } catch (err) {
        lines.push(`依赖图生成失败（跳过依赖分析）：${(err && err.message) || err}`);
      }
      // package.json 扫：root + 一层子目录。
      const pkgDirs = [];
      const rootPkg = readPkg(root);
      if (rootPkg) pkgDirs.push({ dir: '.', pkg: rootPkg });
      try {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
          const pkg = readPkg(join(root, entry.name));
          if (pkg) pkgDirs.push({ dir: entry.name, pkg });
        }
      } catch (_e) { /* 读不到目录时只用 root */ }
      const modOf = (rel) => {
        let best = null;
        for (const { dir } of pkgDirs) {
          if (dir === '.') continue;
          if (rel === dir || rel.startsWith(`${dir}/`)) {
            if (!best || dir.length > best.length) best = dir;
          }
        }
        if (best) return best;
        const seg = String(rel || '').split('/')[0];
        return seg || '.';
      };
      const modules = pkgDirs.map(({ dir, pkg }) => {
        const name = (pkg && (pkg.name || pkg.displayName)) || (dir === '.' ? 'root' : dir);
        const desc = (pkg && pkg.description) || '（职责待补充）';
        const entries = [];
        if (pkg) {
          if (typeof pkg.main === 'string' && pkg.main) entries.push(pkg.main);
          if (typeof pkg.bin === 'string' && pkg.bin) entries.push(pkg.bin);
          else if (pkg.bin && typeof pkg.bin === 'object') {
            for (const value of Object.values(pkg.bin)) {
              if (typeof value === 'string' && value) entries.push(value);
            }
          }
        }
        return { name: String(name), dir, desc: String(desc), entries };
      });
      const depEdges = new Map();
      if (graph && graph.edges) {
        for (const [from, targets] of graph.edges) {
          const m1 = modOf(from);
          for (const target of targets || []) {
            const m2 = modOf(target);
            if (!m2 || m2 === m1) continue;
            if (!depEdges.has(m1)) depEdges.set(m1, new Set());
            depEdges.get(m1).add(m2);
          }
        }
      }
      // architecture 三节：只补空缺。
      const current = architecture.read();
      const sectionBody = (text, label) => {
        const all = String(text || '').split(/\r?\n/);
        const idx = all.findIndex((l) => /^#{2,4}\s*/.test(l) && l.replace(/^#{2,4}\s*/, '').trim() === label);
        if (idx === -1) return '';
        const out = [];
        for (const l of all.slice(idx + 1)) {
          if (/^#{1,6}\s+/.test(l)) break;
          out.push(l);
        }
        return out.join('\n').trim();
      };
      const INIT_REASON = '/init 全库 inspect 自动填充长期记忆';
      const filled = [];
      const skipped = [];
      const ensureSection = (id, label, bodyLines) => {
        if (!bodyLines.length) {
          skipped.push(`${label}（无可填充内容）`);
          return;
        }
        if (sectionBody(current, label)) {
          skipped.push(`${label}（已有内容，不覆盖）`);
          return;
        }
        architecture.writeSection(id, bodyLines.join('\n'), { reason: INIT_REASON });
        filled.push(`${label}（${bodyLines.length} 行）`);
      };
      ensureSection('modules', '模块职责', modules.map((m) => `- ${m.name}（${m.dir}）：${m.desc}`));
      const depLines = [...depEdges.entries()].map(([from, set]) => `- ${from} → ${[...set].sort().join('、')}`);
      if (graph && graph.truncated) depLines.push('（依赖图被截断：文件数超上限，仅供参考）');
      ensureSection('dependencies', '依赖方向与禁止边', depLines);
      ensureSection('entrypoints', 'entrypoint', modules.flatMap((m) => m.entries.map((e) => `- ${m.name}：${e}`)));
      if (filled.length) lines.push(`architecture.md 已填充：${filled.join('；')}`);
      if (skipped.length) lines.push(`architecture.md 跳过：${skipped.join('；')}`);
      // features：每个 intent 一条，仅补缺失。
      let featCreated = 0;
      const featSkipped = [];
      try {
        const intents = await featureIntents.list();
        for (const intent of intents) {
          const id = intent.name;
          try {
            if (featureList.get(id)) {
              featSkipped.push(id);
              continue;
            }
            const file = featureIntents.get(id);
            const fields = extractEntryFields(latestEntry(file.content));
            featureList.upsert({
              id,
              title: intent.title || id,
              module: id,
              status: 'in_progress',
              userVisibleBehavior: fields.userVisibleBehavior || '（/init 自动填充：intent 缺少用户可见行为）',
              featureIntent: fields.featureIntent || '（/init 自动填充）',
            });
            featCreated += 1;
          } catch (err) {
            featSkipped.push(`${id}（${(err && err.message) || err}）`);
          }
        }
        lines.push(`features：新建 ${featCreated} 条${featSkipped.length ? `，跳过 ${featSkipped.length} 条（${featSkipped.join('、')}）` : ''}`);
      } catch (err) {
        lines.push(`feature 填充失败：${(err && err.message) || err}`);
      }
      return lines.join('\n');
    }

    // ── 手动压缩触发（用户显式要求时调用，常控工具，各阶段可用）────────
    // goto_accumulation：跳入 ACCUMULATION，走正常沉淀流程（长期文档整理 +
    // compress_context + submit_state → INIT）。
    registerTool({
      name: 'goto_accumulation',
      description: '手动触发压缩：跳入 ACCUMULATION 阶段，走正常沉淀流程（先整理长期文档，再 compress_context，最后 submit_state 进入 INIT）。仅 CREATE 工作流可用。',
      parameters: {},
      output: textOutput(),
      async execute(_args, exec) {
        return JSON.stringify(await doGotoAccumulation(exec.agent), null, 2);
      },
    });

    // accumulation_and_init：先沉淀后初始化（用户显式要求时使用；
    // 压缩后峰值重置，下一轮重新累积）。
    // 顺序与 ACCUMULATE 一致：必须先完成长期文档整理（pattern_reason +
    // pattern_write），再压缩，最后进入 INIT。还没整理时报错提示先整理，
    // 可先调 goto_accumulation 逐步沉淀，或补完文档整理后重试本工具。
    registerTool({
      name: 'accumulation_and_init',
      description: '手动沉淀并初始化：先整理长期文档（pattern_reason + pattern_write），再压缩上下文，然后进入 INIT。用户显式要求压缩时使用。仅 CREATE 工作流可用。',
      parameters: {},
      output: textOutput(),
      async execute(_args, exec) {
        return JSON.stringify(await doAccumulationAndInit(exec.agent), null, 2);
      },
    });
}
