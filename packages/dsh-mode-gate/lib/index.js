import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

import { createFeatureIntentStore } from './stores/feature-intent-store.js';
import { createFeatureTreeStore, assertLogicalPath, discoverFeatureIntentDirs } from './stores/feature-tree-store.js';
import { createFeatureListStore, defaultFeatureListDir } from './stores/feature-list-store.js';
import { createPatternStore, defaultPatternDir } from './stores/pattern-store.js';
import { createJournalStore, defaultJournalDir } from './stores/journal-store.js';
import { createHistoryStore, defaultHistoryDir } from './stores/history-store.js';
import { createArchitectureStore, defaultArchitecturePath, limitedDigest } from './stores/architecture-store.js';
import { generateDependencyMap, MAX_DEPENDENCY_TOKENS } from './engine/dependency-map.js';
import { budgetDecision, trackContextUsage, resolveBudgetModelId } from './services/context-budget.js';
import { createGoalEngine } from './engine/goal-engine.js';
import { createModelWindowCache } from './services/model-window-cache.js';
import { createBuiltinGoals } from './engine/goals.js';
import { createRestrictionStore, getRestrictionOrBuiltin, isSkillDeniedByRestriction, isToolDeniedByRestriction, isToolWhitelistedByInjection, matchRestrictionDenyCommand, restrictionInjectedCommands, BUILTIN_STAGE_COMMAND_SETS, DEFAULT_UNIVERSAL_COMMANDS } from './stores/restrictions.js';
import { createWorkflowRegistry, expandHome, BUILTIN_WORKFLOW_DIR } from './engine/workflows.js';
import {
  createDynamicPlan,
  extractEntryFields,
  staticPlanCurrent,
  staticPlanPendingCount,
} from './engine/plans.js';
import { resolveTransition } from './engine/transitions.js';
import {
  IDLE_WORKFLOW_ID,
  loadStateStore,
  normalizeRequirements,
  normalizeStageCommandSets,
  normalizeUniversalCommands,
  readSessionEntry,
  readState,
  resolveModelAlias,
  saveStateStore,
  stageIdFor,
  writeState,
} from './engine/state.js';
import {
  KNOWN_WRITE_TOOLS,
  grantedToolsOutsideOf,
  isToolGranted,
  toolDisposition,
} from './engine/permissions.js';
import {
  classifyCommand,
  isAlwaysAllowedBash,
  isGitMutation,
  matchBashDeny,
  normalizeDenyList,
} from './engine/bash.js';
import { registerWorkflowTools } from './tools/workflow.js';
import { registerPresetActionTools } from './tools/preset-action.js';
import { registerFeatureIntentTools } from './tools/feature-intent.js';
import { registerPatternTools } from './tools/patterns.js';
import { registerArchitectureTools } from './tools/architecture.js';
import { registerAccumulationTools } from './tools/accumulation.js';
import { registerGitTools } from './tools/git.js';
import { ModeGateGateway } from './gateway/gateway.js';


// CONTROL_TOOLS 已随 declare_target 机制一并移除：不再有强制握手，
// pre-execute 只保留 switch_mode/request_extra 特判、阶段权限与 goal 门禁。

/** Best-effort extract the human text from a user/message event. */
function extractUserText(event) {
  const data = event && event.data && typeof event.data === 'object' ? event.data : {};
  if (typeof data.text === 'string' && data.text.trim()) return data.text.trim();
  if (typeof data.content === 'string' && data.content.trim()) return data.content.trim();
  if (Array.isArray(data.content)) {
    const text = data.content
      .map((block) => (typeof block === 'string' ? block : block && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) return text;
  }
  if (typeof data.message === 'string' && data.message.trim()) return data.message.trim();
  return '';
}

/**
 * INIT 闸门阶段的 target 文案：AI 在本阶段被完全禁言，这里只用于状态展示
 * （存量状态 / 非 AI 路径读取 state.target 时也有个可读说明）。
 */
const INIT_GATE_TARGET = '等待用户从 feature 树里提交选择（本阶段 AI 不运行）';

/** Collected user inputs for the current workflow run (auto user_words). */
function collectUserWords(agent) {
  const state = readState(agent);
  const inputs = Array.isArray(state.userInputs) ? state.userInputs : [];
  return inputs.join('\n\n');
}

function readBashDenyList() {
  return normalizeDenyList(loadStateStore().bashDenyList);
}

function pathLikeArgs(args) {
  if (!args || typeof args !== 'object') return [];
  const out = [];
  for (const key of ['path', 'file_path', 'filePath', 'file', 'target', 'name']) {
    if (typeof args[key] === 'string') out.push(args[key]);
  }
  return out;
}

function isFeatureIntentDirectWrite(name, args, dir) {
  if (name === 'bash' || name === 'pwsh') {
    const command = String((args && args.command) || '');
    if (!command.includes(dir)) return false;
    const kind = classifyCommand(command);
    return kind === 'mutating' || kind === 'dangerous';
  }
  if (!KNOWN_WRITE_TOOLS.has(name) && name !== 'str_replace_editor') return false;
  return pathLikeArgs(args).some((p) => p.includes(dir));
}

/**
 * mode-gate 的**单点授权豁免判断**：工具是否被用户通过 /grant 显式解锁。
 *
 * 这是「用户授权优先于一切 mode-gate 规则」的唯一落点。所有门禁分支（阶段
 * tools 白名单、goal allowedTools、STAGE_GRANTED_TOOLS、restriction denyTools、
 * 自行解锁锁定、bash 策略、写保护、feature_intent 直写保护）在拒绝之前都必须
 * 先问这里一次；命中即放行到 next()，不再由 mode-gate 施加任何限制。
 *
 * 之所以集中成一处，是因为以前每处各写一份判断，语义会漂移，也会漏掉某个
 * 分支（例如「当前阶段禁止自行解锁新工具」这类单独锁定最容易成为漏网之鱼）。
 *
 * @param {object} state - readState(agent) 的结果。
 * @param {string} name - 工具名。
 * @returns {boolean} 是否应跳过 mode-gate 的全部限制。
 */
function grantBypass(state, name) {
  try {
    return isToolGranted(state && state.grantedTools, name);
  } catch (_err) {
    return false;
  }
}

/** 当前授权的工具名列表（已归一化、去重）。 */
function grantedToolsOf(state) {
  try {
    return Array.isArray(state && state.grantedTools)
      ? [...new Set(state.grantedTools.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()))]
      : [];
  } catch (_err) {
    return [];
  }
}

function workspaceOf(agent, fallback) {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : fallback;
}

/**
 * 归一化 feature intent 写入比对键：树选择用 `overview/intent` 两层逻辑路径，
 * 而 update_feature_intent 只接受裸文件名。两侧统一取末段、去 `.md` 后缀，
 * 避免 `mode-gate-overview/x` 与 `x` 对不上导致协议校验误杀。
 */
function intentWriteKey(value) {
  return String(value == null ? '' : value).trim().replace(/\.md$/i, '').split('/').pop().trim();
}

export default {
  name: 'mode-gate',
  // tokenMeter 是 harness 唯一的上下文计量服务（compaction-basic 也用它判定压力），
  // compaction 是 harness 唯一的压缩服务（compactRegion/compactNow/compactIfNeeded）。
  // 两者都必须显式注入才能读取；缺 compaction 时压缩会退化成永远失败。
  inject: ['tools', 'systemPrompt', 'skills', 'tokenMeter', 'compaction'],

  apply(ctx, config) {
    const log = (msg) => console.log(`[dsh-mode-gate] ${msg}`);
    const cfg = config || {};

    // ── 每个项目自己的 feature intent 目录 ────────────────────────────────
    // feature intent 属于项目文件（类似 AGENT.md），不是全局数据：一个项目
    // 一份，固定放在项目根目录下的 `feature_intents/`（唯一规范位置，不再探测
    // 其它历史别名）。session 的 workspace 即项目根；workspace 若是多项目容器，
    // 则每个子项目根下的 `feature_intents/` 会被发现并挂载。其余长期记忆
    // （features / patterns / journal / history / architecture.md）沿用既有
    // dirname 派生规则，因此它们也一起落在项目根下的兄弟路径。
    // 唯一候选：项目根下的 feature_intents/。
    const INTENT_DIR_CANDIDATES = [
      'feature_intents',
    ];
    const presetActionDir = expandHome(
      typeof cfg.presetActionDir === 'string' && cfg.presetActionDir.trim()
        ? cfg.presetActionDir.trim()
        : join(homedir(), '.dsh', 'preset-actions'),
    );
    // agent 没带 cwd 时的兜底工作区（正常路径都会用 session 的 workspace）。
    const defaultWorkspace = expandHome(
      typeof cfg.workspace === 'string' && cfg.workspace.trim() ? cfg.workspace.trim() : process.cwd(),
    );

    /** 目录里是否有真实内容（空目录不算命中，避免空壳目录把真目录挡掉）。 */
    function dirHasContent(dir) {
      try {
        return readdirSync(dir).some((entry) => !entry.startsWith('.'));
      } catch (_err) {
        return false;
      }
    }

    /**
     * 目录的真实身份（用于去重）：软链别名可能让同一份 intent 目录以不同
     * 路径出现，光比字符串会把它挂两次。realpath 失败时退回原路径。
     */
    function canonicalDir(dir) {
      try {
        return realpathSync(dir);
      } catch (_err) {
        return String(dir || '');
      }
    }

    /** 某个 workspace 根层是否存在候选 intent 目录。 */
    function directIntentDir(workspaceRoot) {
      let firstExisting = '';
      for (const candidate of INTENT_DIR_CANDIDATES) {
        const dir = join(workspaceRoot, candidate);
        let isDir = false;
        try {
          isDir = existsSync(dir) && statSync(dir).isDirectory();
        } catch (_err) { /* 探测失败就继续下一个候选 */ }
        if (!isDir) continue;
        if (dirHasContent(dir)) return { dir, firstExisting };
        if (!firstExisting) firstExisting = dir;
      }
      return { dir: '', firstExisting };
    }

    /**
     * 解析某个工作区的 feature intent 布局。
     *
     * - `flat`：这个 workspace 自己就是一个项目（或已锁定项目目录）→ 树直接长在
     *   intent 目录上，路径都是短路径（`mode-gate`）。
     * - `mounts`：workspace 只是「多个项目的容器」（根层没有 intent 目录，或根层
     *   目录之外还发现了别的项目目录）→ 把每个发现到的 intent 目录挂成顶层
     *   overview 文件夹，路径是 workspace 相对路径（`documentation/feature_intents/mode-gate`）。
     *   overview 本身就是文件夹，因此挂载不引入新的节点类型。
     *
     * @param {string} workspace session 的 workspace
     * @param {string|null} pinned 用户提交选择时锁定的 intent 目录（绝对路径）
     */
    function resolveFeatureIntentLayout(workspace, pinned) {
      const root = resolve(String(workspace || '').trim() || defaultWorkspace);
      if (pinned) {
        const abs = isAbsolute(String(pinned)) ? String(pinned) : join(root, String(pinned));
        try {
          if (existsSync(abs) && statSync(abs).isDirectory()) {
            console.log(`[dsh-mode-gate] [feature-tree] 布局：pinned 命中 root=${root} dir=${abs}（flat）。`);
            return { workspace: root, root: abs, dirs: [abs], rels: [], flat: true, pinned: true };
          }
        } catch (_err) { /* 锁定目录失效就退回自动探测 */ }
        console.log(`[dsh-mode-gate] [feature-tree] 布局：pinned 失效 pinned=${pinned}，退回自动探测。`);
      }
      const direct = directIntentDir(root);
      const directKey = direct.dir ? canonicalDir(direct.dir) : '';
      const seenKeys = new Set(directKey ? [directKey] : []);
      const nested = [];
      for (const item of discoverFeatureIntentDirs(root, INTENT_DIR_CANDIDATES)) {
        const key = canonicalDir(item.abs);
        if (seenKeys.has(key)) continue; // 同一个物理目录（大小写/软链别名）只挂一次
        seenKeys.add(key);
        nested.push(item);
      }
      if (nested.length === 0) {
        const dir = direct.dir || direct.firstExisting || join(root, INTENT_DIR_CANDIDATES[0]);
        console.log(`[dsh-mode-gate] [feature-tree] 布局：root=${root} 根层直挂=${direct.dir || '(无)'} 嵌套发现=0 → flat，dir=${dir}。`);
        return { workspace: root, root: dir, dirs: [dir], rels: [], flat: true, autoCreate: !direct.dir };
      }
      const dirs = (direct.dir ? [direct.dir] : []).concat(nested.map((item) => item.abs));
      console.log(`[dsh-mode-gate] [feature-tree] 布局：root=${root} 根层直挂=${direct.dir || '(无)'} 嵌套发现=${nested.length} → mounts，rels=${JSON.stringify(dirs.map((dir) => relative(root, dir).split(sep).join('/')))}。`);
      return {
        workspace: root,
        root,
        dirs,
        rels: dirs.map((dir) => relative(root, dir).split(sep).join('/')),
        flat: false,
      };
    }

    // 目录扫描有成本（要在 workspace 里往下找），因此布局按 workspace+pinned 缓存；
    // 带短 TTL，这样用户在项目里新建 intent 目录后选择器能自愈。
    const LAYOUT_TTL_MS = 2000;
    const layoutCache = new Map();
    function layoutFor(workspace, pinned) {
      const wsRoot = resolve(String(workspace || '').trim() || defaultWorkspace);
      const key = `${wsRoot}|${pinned || ''}`;
      const hit = layoutCache.get(key);
      const now = Date.now();
      if (hit && now - hit.at < LAYOUT_TTL_MS) return hit.layout;
      const layout = resolveFeatureIntentLayout(wsRoot, pinned);
      layoutCache.set(key, { layout, at: now });
      return layout;
    }

    /** intent 目录 -> 该项目全部长期记忆 store（按项目缓存，避免重复建 store）。 */
    const storeBundles = new Map();
    function storesForWorkspace(workspace, pinned) {
      const layout = layoutFor(workspace, pinned);
      const dir = layout.dirs[0];
      const key = `${layout.flat ? 'flat' : 'mounts'}:${layout.root}`;
      const cached = storeBundles.get(key);
      if (cached) return cached;
      const featureTree = createFeatureTreeStore(dir);
      const bundle = {
        layout,
        dir,
        dirs: layout.dirs,
        rels: layout.rels,
        flat: layout.flat,
        workspace: layout.workspace,
        featureIntents: createFeatureIntentStore(dir),
        featureTree,
        // 选择器用的树：多项目 workspace 时按 workspace 相对路径挂载各项目目录。
        pickerTree: layout.flat
          ? featureTree
          : createFeatureTreeStore(layout.workspace, {
            mounts: layout.dirs.map((abs, index) => ({ rel: layout.rels[index], abs })),
          }),
        featureList: createFeatureListStore(defaultFeatureListDir(dir)),
        patternStore: createPatternStore(defaultPatternDir(dir)),
        journal: createJournalStore(defaultJournalDir(dir)),
        history: createHistoryStore(defaultHistoryDir(dir)),
        architecture: createArchitectureStore(defaultArchitecturePath(dir)),
      };
      storeBundles.set(key, bundle);
      return bundle;
    }
    /** 某个 agent 所属项目的 store 集合（已锁定项目目录时优先用它）。 */
    function storesFor(agent) {
      let pinned = null;
      try {
        pinned = readSessionEntry(agent?.session?.id).featureIntentDir;
      } catch (_err) { /* 读不到状态就按自动探测走 */ }
      return storesForWorkspace(workspaceOf(agent, defaultWorkspace), pinned);
    }
    const globalWorkflowDir = expandHome(
      typeof cfg.workflowsDir === 'string' && cfg.workflowsDir.trim()
        ? cfg.workflowsDir.trim()
        : join(homedir(), '.dsh', 'workflows'),
    );
    const restrictionsDir = expandHome(
      typeof cfg.restrictionsDir === 'string' && cfg.restrictionsDir.trim()
        ? cfg.restrictionsDir.trim()
        : join(homedir(), '.dsh', 'restrictions'),
    );

    const restrictions = createRestrictionStore(restrictionsDir);
    const workflowRegistry = createWorkflowRegistry({
      builtinDir: BUILTIN_WORKFLOW_DIR,
      globalDir: globalWorkflowDir,
      workspaceDir: (workspace) => (workspace ? join(workspace, 'workflows') : null),
      log,
    });
    const registryForWorkspace = (workspace) => workflowRegistry.forWorkspace(workspace || defaultWorkspace);
    /** sessionId -> live Agent, used by the Remote selectWorkflow to wake the agent. */
    const agents = new Map();
    // 观测到的真实模型上下文窗口（进程内）：自带表只覆盖少数模型，表外模型
    // 没有窗口就只能回落到 180k 默认值（对 128k 模型等于永不触发压缩）。
    const modelWindowCache = createModelWindowCache();

    function registryFor(agent) {
      return registryForWorkspace(workspaceOf(agent, defaultWorkspace));
    }

    // ── /grant：用户显式授权工具（mode-gate 的单点豁免入口） ────────────────
    //
    // 语义：用户点名 → mode-gate 全面让路。授权写进会话级 state.grantedTools，
    // 跨阶段保留；pre-execute 的每一处拒绝分支都先问 grantBypass，命中即
    // `next()`。这里只负责写状态与补 scope 供给，判断逻辑统一在 permissions.js。

    /** 列出当前会话可见的工具目录（含已解锁 / 未解锁标记），供 /grant 下拉与文本列表复用。 */
    function listGrantableTools(agent) {
      const out = [];
      const seen = new Set();
      try {
        const schemas = ctx.tools.schemas(agent) || [];
        for (const schema of schemas) {
          const name = schema && typeof schema.name === 'string' ? schema.name : '';
          if (!name || seen.has(name)) continue;
          seen.add(name);
          out.push({
            name,
            description: String((schema && schema.description) || '').split('\n')[0].slice(0, 160),
          });
        }
      } catch (err) {
        log(`读取工具目录失败：${(err && err.message) || err}`);
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    }

    /**
     * 授权一个（或多个）工具给指定会话。
     * @returns {{ ok: boolean, granted?: string[], error?: string }}
     */
    function grantTools(agent, names, options) {
      const opts = options && typeof options === 'object' ? options : {};
      const requested = (Array.isArray(names) ? names : [names])
        .map((n) => (typeof n === 'string' ? n.trim() : ''))
        .filter(Boolean);
      if (requested.length === 0) return { ok: false, error: '请提供要授权的工具名。' };
      const state = readState(agent);
      const catalog = new Map(listGrantableTools(agent).map((t) => [t.name, t]));
      const unknown = requested.filter((n) => !catalog.has(n) && !opts.allowUnknown);
      if (unknown.length > 0) {
        return { ok: false, error: `工具不存在：${unknown.join('、')}。可用 /grant 不带参数查看全部工具。` };
      }
      const next = [...new Set([...grantedToolsOf(state), ...requested])];
      writeState(agent, { grantedTools: next });
      // 立即重算 scope：授权工具必须当轮就可见，不能等下一次状态切换。
      try {
        const registry = registryFor(agent);
        const stateDef = registry.stateOf(state.workflowId, state.phase);
        const goalRef = stateDef && stateDef.goal && stateDef.goal.ref;
        provisionStageTools(agent, goalRef ? visibleToolsForGoal(goalRef) : []);
      } catch (err) {
        log(`授权后补供 scope 失败（授权已写入，仍会生效）：${(err && err.message) || err}`);
      }
      return { ok: true, granted: next };
    }

    /** 撤销授权。`name` 为空表示清空全部授权。 */
    function revokeTools(agent, names) {
      const state = readState(agent);
      const current = grantedToolsOf(state);
      const requested = (Array.isArray(names) ? names : [names])
        .map((n) => (typeof n === 'string' ? n.trim() : ''))
        .filter(Boolean);
      const next = requested.length === 0 ? [] : current.filter((n) => !requested.includes(n));
      writeState(agent, { grantedTools: next });
      try {
        const registry = registryFor(agent);
        const stateDef = registry.stateOf(state.workflowId, state.phase);
        const goalRef = stateDef && stateDef.goal && stateDef.goal.ref;
        provisionStageTools(agent, goalRef ? visibleToolsForGoal(goalRef) : []);
      } catch (err) {
        log(`撤销后重算 scope 失败：${(err && err.message) || err}`);
      }
      return { ok: true, granted: next };
    }

    /** `/grant` 的文本回显：无参数列目录，有参数走授权。 */
    function formatGrantResult(agent, rawInput) {
      const input = typeof rawInput === 'string' ? rawInput.trim() : '';
      const state = readState(agent);
      const granted = grantedToolsOf(state);
      if (!input) {
        const tools = listGrantableTools(agent);
        if (tools.length === 0) return '当前会话没有可授权的工具。';
        const lines = tools.map((t) => `${granted.includes(t.name) ? '●' : '○'} ${t.name}${t.description ? ` — ${t.description}` : ''}`);
        return [
          `可授权工具（共 ${tools.length} 个，● = 已授权）：`,
          ...lines,
          '',
          '授权：/grant <工具名>（可空格分隔多个）；撤销：/grant --revoke <工具名>；清空：/grant --revoke',
        ].join('\n');
      }
      const tokens = input.split(/\s+/).filter(Boolean);
      if (tokens[0] === '--revoke' || tokens[0] === '-r') {
        const result = revokeTools(agent, tokens.slice(1));
        return result.granted.length === 0
          ? '已清空全部工具授权。'
          : `已撤销。当前已授权工具：${result.granted.join('、')}。`;
      }
      const result = grantTools(agent, tokens);
      if (!result.ok) return `授权失败：${result.error}`;
      return `已授权：${tokens.join('、')}。此授权优先于 mode-gate 的一切限制（阶段工具白名单、目标可见集、限制套件、bash 策略等），并已立即对模型可见。\n当前已授权工具：${result.granted.join('、')}。`;
    }

    // ── preset actions ───────────────────────────────────────────────────
    function parsePresetActionMeta(content) {
      const meta = { description: '', match: '', model: 'deepseek-v4-pro', provider: 'deepseek-official', reasoningEffort: '' };
      if (typeof content !== 'string') return meta;
      const marker = /<!--\s*mode-gate(?:-json)?:\s*(\{[\s\S]*?\})\s*-->/.exec(content);
      if (marker) {
        try {
          const parsed = JSON.parse(marker[1]);
          if (parsed && typeof parsed === 'object') {
            if (typeof parsed.description === 'string') meta.description = parsed.description.trim();
            if (typeof parsed.match === 'string') meta.match = parsed.match.trim();
            if (typeof parsed.model === 'string') meta.model = parsed.model.trim();
            if (typeof parsed.provider === 'string') meta.provider = parsed.provider.trim();
            if (typeof parsed.reasoning_effort === 'string') meta.reasoningEffort = parsed.reasoning_effort.trim();
          }
        } catch (err) {
          log(`preset action 元数据 JSON 解析失败：${(err && err.message) || err}`);
        }
      }
      return meta;
    }

    function collectPresetActionSkills() {
      const out = [];
      let dirents = [];
      try {
        dirents = readdirSync(presetActionDir, { withFileTypes: true });
      } catch (_err) {
        log(`preset action 目录不可读：${presetActionDir}`);
        return out;
      }
      for (const dirent of dirents) {
        if (!dirent.isDirectory()) continue;
        const skillFile = join(presetActionDir, dirent.name, 'SKILL.md');
        let content;
        try {
          content = readFileSync(skillFile, 'utf8');
        } catch (_err) {
          continue;
        }
        const meta = parsePresetActionMeta(content);
        const firstHeading = content.split(/\r?\n/).find((line) => /^#\s+/.test(line.trim()));
        const title = firstHeading ? firstHeading.trim().replace(/^#\s+/, '') : dirent.name;
        out.push({
          id: dirent.name,
          name: `preset-action-${dirent.name}`,
          title,
          description: meta.description || `${title}（preset action）`,
          match: meta.match,
          provider: meta.provider,
          model: meta.model,
          reasoningEffort: meta.reasoningEffort,
          content,
        });
      }
      out.sort((a, b) => a.id.localeCompare(b.id));
      return out;
    }

    const presetActionSkills = collectPresetActionSkills();
    for (const skill of presetActionSkills) {
      try {
        ctx.skills.register({
          name: skill.name,
          description: skill.description,
          source: 'preset-action',
          invocation: { modelInvocable: false, userInvocable: false },
          content: skill.content,
        });
      } catch (err) {
        log(`注册 preset action skill "${skill.name}" 失败：${(err && err.message) || err}`);
      }
    }

    // ── git update skill（checklist-15）──────────────────────────────────
    // Agent 禁止直接执行 git 修改命令；每轮更新由本 skill 指导调用
    // git_commit 工具完成 add -A + commit + push，并输出可审计 update。
    try {
      ctx.skills.register({
        name: 'mode-gate-git-commit',
        description: 'Git 更新 skill：每轮改动通过 git_commit 工具完成 commit + push，输出可审计 update，commit hash 自动进入功能列表；Agent 禁止直接执行 git 修改命令。',
        source: 'mode-gate',
        invocation: { modelInvocable: true, userInvocable: false },
        content: [
          '# mode-gate-git-commit',
          '',
          '每轮更新结束时，用 git_commit 工具提交并推送本轮改动。',
          '',
          '规则：',
          '- 不要直接执行 git add / commit / push / rm / mv / reset / clean 等修改命令，模式门禁会拒绝。',
          '- 调用 git_commit 工具（可选 message，省略时由工具按当前 feature 与 checklist goal 自动生成）。',
          '- 工具会执行 git add -A、git commit、git push，并返回可审计 update（commit hash、分支、message、push 结果）。',
          '- commit hash 会自动写入功能列表 features/<feature-id>.md 与 features.md 索引行。',
          '- 把工具返回的 update 原样呈现给用户。',
        ].join('\n'),
      });
    } catch (err) {
      log(`注册 git skill 失败：${(err && err.message) || err}`);
    }


    // ── goal engine ──────────────────────────────────────────────────────
    const goalEngine = createGoalEngine({ goals: createBuiltinGoals(), log });

    function envFor(agent, state) {
      const stores = storesFor(agent);
      return {
        // 项目内长期记忆：feature intent / 功能列表 / 模式 / journal / history / architecture。
        ...stores,
        presetActionSkills,
        registry: registryFor(agent),
        workspace: workspaceOf(agent, defaultWorkspace),
        modelCatalog: state ? state.modelCatalog : loadStateStore().modelCatalog,
        agent,
        ctx,
        log,
      };
    }

    /** Effective per-stage override: stage-scoped wins, then legacy per-workflow/state. */
    function stateOverride(state, workflowId, stateId) {
      const stageId = stageIdFor(workflowId, stateId);
      const stageOverrides = state && state.stageOverrides && typeof state.stageOverrides === 'object'
        ? state.stageOverrides
        : {};
      const stage = stageOverrides[stageId];
      if (stage) return stage;
      const overrides = state && state.workflowOverrides && typeof state.workflowOverrides === 'object'
        ? state.workflowOverrides
        : {};
      const wf = overrides[workflowId];
      return wf && wf[stateId] ? wf[stateId] : null;
    }

    /**
     * 解析当前 state 生效的限制引用：stage override 的 restriction 优先，
     * 其次 state 定义自带的 restriction 字段。文件缺失时回退同名内置。
     * 无引用或解析失败返回 null（不限制）。
     */
    function resolveStateRestriction(state, workflowId, stateId, stateDef) {
      const override = stateOverride(state, workflowId, stateId);
      const ref = (override && typeof override.restriction === 'string' && override.restriction.trim())
        || (stateDef && typeof stateDef.restriction === 'string' && stateDef.restriction.trim())
        || '';
      if (!ref) return null;
      try {
        return getRestrictionOrBuiltin(restrictions, ref);
      } catch (err) {
        log(`限制引用解析失败（${workflowId}/${stateId} -> ${ref}）：${(err && err.message) || err}`);
        return null;
      }
    }

    function modelEntryForId(modelId) {
      if (!modelId) return null;
      const catalog = loadStateStore().modelCatalog || [];
      return catalog.find((entry) => entry && entry.id === modelId) || null;
    }

    /**
     * Resolve a stage model reference (codename or legacy catalog id) to a
     * concrete { provider, model }. Codename aliases win; unmapped references
     * fall back to the legacy model catalog lookup.
     */
    function resolveStageModel(modelRef) {
      const ref = typeof modelRef === 'string' ? modelRef.trim() : '';
      if (!ref) return null;
      const store = loadStateStore();
      const aliased = resolveModelAlias(store.modelAliases, ref);
      if (aliased) return aliased;
      const entry = modelEntryForId(ref);
      if (entry) return { provider: entry.provider || 'deepseek-official', model: entry.id };
      return null;
    }

    function stateModelOverride(state, workflowId, stateId) {
      const override = stateOverride(state, workflowId, stateId);
      if (!override) return null;
      const model = typeof override.model === 'string' && override.model.trim() ? override.model.trim() : '';
      const reasoningEffort = typeof override.reasoningEffort === 'string' ? override.reasoningEffort.trim() : '';
      if (!model && !reasoningEffort) return null;
      return { model, reasoningEffort };
    }

    function normalizeRequirementPath(path) {
      return String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    }

    function matchesRequirementPath(requiredPath, actualPath) {
      const required = normalizeRequirementPath(requiredPath);
      const actual = normalizeRequirementPath(actualPath);
      if (!required || !actual) return false;
      return actual === required || actual.endsWith(`/${required}`) || required.endsWith(`/${actual}`);
    }

    function builtinGoalRequirements(stateDef) {
      const goalRef = stateDef && stateDef.goal && stateDef.goal.ref;
      if (!goalRef) return [];
      const def = goalEngine.get(goalRef);
      if (!def || !Array.isArray(def.requiredCalls) || def.requiredCalls.length === 0) return [];
      return def.requiredCalls.map((req) => ({
        kind: 'skill',
        name: req.tool,
        requireTrueField: false,
        trueField: 'ok',
      }));
    }

    function effectiveStateRequirements(state, workflowId, stateId, stateDef) {
      const override = stateOverride(state, workflowId, stateId);
      if (override && Array.isArray(override.requirements)) return normalizeRequirements(override.requirements);
      if (stateDef && Array.isArray(stateDef.requirements)) return normalizeRequirements(stateDef.requirements);
      return builtinGoalRequirements(stateDef);
    }

    function parseToolResultValue(result) {
      const raw = result && result.value;
      if (raw === void 0 || raw === null) return null;
      if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch (_err) { return null; }
      }
      return typeof raw === 'object' ? raw : null;
    }

    function requirementLabel(requirement) {
      if (requirement.kind === 'file') return `查看过文件 ${requirement.path}`;
      const field = requirement.requireTrueField ? `（要求 ${requirement.trueField || 'ok'} = true）` : '';
      return `执行过 skill ${requirement.name}${field}`;
    }

    function unmetStateRequirements(state, stateDef) {
      const requirements = effectiveStateRequirements(state, state.workflowId, state.phase, stateDef);
      if (requirements.length === 0) return [];
      const progress = state.requirementProgress && typeof state.requirementProgress === 'object' ? state.requirementProgress : {};
      const files = Array.isArray(progress.files) ? progress.files : [];
      const skills = progress.skills && typeof progress.skills === 'object' ? progress.skills : {};
      const unmet = [];
      for (const requirement of requirements) {
        if (requirement.kind === 'file') {
          if (!files.some((path) => matchesRequirementPath(requirement.path, path))) unmet.push(requirement);
          continue;
        }
        if (requirement.kind === 'skill') {
          const entry = skills[requirement.name];
          if (!entry || (entry.count || 0) < 1) {
            unmet.push(requirement);
            continue;
          }
          if (requirement.requireTrueField) {
            const field = requirement.trueField || 'ok';
            const trueFields = entry.trueFields && typeof entry.trueFields === 'object' ? entry.trueFields : {};
            if (trueFields[field] !== true) unmet.push(requirement);
          }
        }
      }
      return unmet;
    }

    function recordStateRequirementProgress(agent, exec, result) {
      const state = readState(agent);
      const stateDef = registryFor(agent).stateOf(state.workflowId, state.phase);
      const requirements = effectiveStateRequirements(state, state.workflowId, state.phase, stateDef);
      if (requirements.length === 0) return;
      const name = exec && exec.name;
      const args = (exec && exec.arguments) || {};
      const resultValue = parseToolResultValue(result);
      const progress = state.requirementProgress && typeof state.requirementProgress === 'object' ? state.requirementProgress : {};
      const files = Array.isArray(progress.files) ? progress.files.slice() : [];
      const skills = progress.skills && typeof progress.skills === 'object' ? { ...progress.skills } : {};
      let changed = false;

      const readPath = name === 'read' && typeof args.path === 'string'
        ? args.path
        : (name === 'str_replace_editor' && args.command === 'view' && typeof args.path === 'string' ? args.path : '');
      if (readPath && requirements.some((requirement) => requirement.kind === 'file' && matchesRequirementPath(requirement.path, readPath))) {
        if (!files.some((path) => matchesRequirementPath(path, readPath))) {
          files.push(readPath);
          changed = true;
        }
      }

      const skillName = (name === 'skill' || name === 'skill_load') && typeof args.name === 'string' ? args.name : name;
      if (skillName && requirements.some((requirement) => requirement.kind === 'skill' && requirement.name === skillName)) {
        const entry = skills[skillName] && typeof skills[skillName] === 'object'
          ? { ...skills[skillName] }
          : { count: 0, trueFields: {} };
        entry.count = (entry.count || 0) + 1;
        const trueFields = entry.trueFields && typeof entry.trueFields === 'object' ? { ...entry.trueFields } : {};
        if (resultValue && typeof resultValue === 'object') {
          for (const requirement of requirements) {
            if (requirement.kind !== 'skill' || requirement.name !== skillName || !requirement.requireTrueField) continue;
            const field = requirement.trueField || 'ok';
            if (resultValue[field] === true) trueFields[field] = true;
            else if (trueFields[field] !== true) trueFields[field] = false;
          }
        }
        entry.trueFields = trueFields;
        skills[skillName] = entry;
        changed = true;
      }

      if (changed) writeState(agent, { requirementProgress: { files, skills } });
    }

    /** Persist a per-state model selection so the client model selector follows immediately. */
    function applyStateModelSelection(agent, workflowId, stateId) {
      if (!agent || !agent.session || typeof agent.session.append !== 'function') return;
      const state = readState(agent);
      const override = stateModelOverride(state, workflowId, stateId);
      if (!override || !override.model) return;
      const resolved = resolveStageModel(override.model);
      const resolvedThinking = resolved && resolved.thinking ? resolved.thinking : '';
      const payload = {
        provider: (resolved && resolved.provider) || 'deepseek-official',
        model: (resolved && resolved.model) || override.model,
        ...((override.reasoningEffort || resolvedThinking) ? { reasoningEffort: override.reasoningEffort || resolvedThinking } : {}),
      };
      try {
        agent.session.append('model/selection', payload);
      } catch (err) {
        log(`model/selection 注入失败：${(err && err.message) || err}`);
      }
    }

    function effectiveStatePrompt(state, workflowId, stateId, stateDef) {
      const override = stateOverride(state, workflowId, stateId);
      if (override && typeof override.prompt === 'string') {
        return override.prompt.trim();
      }
      return stateDef && typeof stateDef.prompt === 'string' ? stateDef.prompt.trim() : '';
    }

    function defaultAutoGuideEnabled(stateDef) {
      return Boolean(stateDef && (stateDef.goal || (Array.isArray(stateDef.transitions) && stateDef.transitions.length > 0)));
    }

    function autoGuideEnabled(state, workflowId, stateId, stateDef) {
      const override = stateOverride(state, workflowId, stateId);
      if (override && typeof override.autoGuide === 'boolean') return override.autoGuide;
      return defaultAutoGuideEnabled(stateDef);
    }

    /** 「忽略 prompt」：该阶段关闭用户/自动 prompt 注入（阶段 prompt、自动指引、feature 架构上下文）。 */
    function ignorePromptEnabled(state, workflowId, stateId) {
      const override = stateOverride(state, workflowId, stateId);
      return Boolean(override && override.ignorePrompt === true);
    }

    /** Dynamically generated command guide for a state, derived from its goal. */
    function buildAutoGuide(stateDef, goalDef) {
      if (!stateDef) return '';
      const lines = [];
      if (goalDef) {
        for (const req of goalDef.requiredCalls || []) {
          lines.push(`- 调用 ${req.tool}${req.min && req.min > 1 ? `（至少 ${req.min} 次）` : ''}`);
        }
        if (goalDef.submitTool) {
          lines.push(`- 最后调用 ${goalDef.submitTool.name} 提交并推进模式`);
        }
      } else {
        const tools = stateDef.permissions && Array.isArray(stateDef.permissions.tools)
          ? stateDef.permissions.tools
          : null;
        if (Array.isArray(tools) && tools.length > 0) lines.push(`- 本阶段可用工具：${tools.join('、')}`);
        else if (stateDef.permissions && stateDef.permissions.tools === '*') lines.push('- 本阶段可使用全部工具');
      }
      if (lines.length === 0) return '';
      return ['本阶段命令指引（自动生成）：', ...lines].join('\n');
    }

    function latestEntry(content) {
      const text = String(content || '');
      const parts = text.split(/\n---\n/);
      return parts.length ? parts[parts.length - 1] : text;
    }

    function agentFor(sessionId) {
      if (agents.has(sessionId)) return agents.get(sessionId);
      const entry = readSessionEntry(sessionId);
      return { session: { id: sessionId, header: { cwd: entry.workspace } } };
    }

    async function activateStateGoal(agent, workflowId, stateId, origin) {
      const state = readState(agent);
      const registry = registryFor(agent);
      const stateDef = registry.stateOf(workflowId, stateId);
      const goalRef = stateDef && stateDef.goal && stateDef.goal.ref;
      const previousWorkflow = state.workflowId || 'IDLE';
      const basePatch = {
        workflowId,
        phase: stateId,
        mode: stateId,
        workspace: workspaceOf(agent, defaultWorkspace),
        dynamicPlan: { scope: 'state', stateId, items: [], updatedAt: Date.now() },
        pendingProtocol: null,
        requirementProgress: {},
        userInputs: previousWorkflow === workflowId ? (state.userInputs || []) : [],
      };
      // ── INIT（create）是引擎阶段，必须在这里判去路 ──────────────────────
      // AI 在 INIT 被完全禁言（agent/pre-step 拦截），所以没人能替它 submit_state。
      // 注意：completeGoal 会先把 phase 写成目标状态再调本函数，因此来源状态必须
      // 由调用方用 origin 传进来（不能读 state.phase）。
      //   - 来源是需求分解 / 沉淀 → 本轮已有 feature intent：引擎直接推进；
      //   - 其余（切工作流、手动进 INIT 等）→「闸门」：停在 INIT，等用户提交选择。
      if (workflowId === 'create' && stateId === 'INIT') {
        const fromStateId = origin && typeof origin.stateId === 'string' ? origin.stateId : '';
        const continued = fromStateId === 'REQUIREMENT_RECOGNITION' || fromStateId === 'ACCUMULATION';
        if (continued) {
          // 上下文初始化：architecture.md / code-map 已由引擎按本轮选择注入，
          // 这里只负责推进，不在 INIT 停留。
          const pending = staticPlanPendingCount(state.staticPlan);
          const nextStateId = pending > 0 ? 'RESEARCH' : 'IDLE';
          return activateStateGoal(agent, nextStateId === 'IDLE' ? 'IDLE' : 'create', nextStateId);
        }
        // 闸门：清掉未完成的 goal，不供给任何工具，等用户提交选择。
        writeState(agent, {
          ...basePatch,
          goal: null,
          target: { target: INIT_GATE_TARGET, mode: stateId },
        });
        applyStateModelSelection(agent, workflowId, stateId);
        // 必须等阶段上下文排进 inbox 再返回：调用方（submitFeatureSelection 的
        // followup 唤醒）紧接着就会开新一轮，fire-and-forget 会让首轮看不到政策。
        await injectModeGateContext(agent, 'state');
        provisionStageTools(agent, []);
        return { prompt: INIT_GATE_TARGET, messages: [] };
      }
      if (!goalRef) {
        const isIdle = workflowId === 'IDLE' || stateId === 'IDLE';
        const prompt = effectiveStatePrompt(state, workflowId, stateId, stateDef) || `当前状态：${stateId}`;
        writeState(agent, {
          ...basePatch,
          goal: null,
          target: isIdle ? null : { target: prompt, mode: stateId },
        });
        applyStateModelSelection(agent, workflowId, stateId);
        await injectModeGateContext(agent, 'state');
        // 无 goal 的状态（含 IDLE）：只供给本阶段的初始 / Universal 命令（如有）。
        provisionStageTools(agent, isIdle ? [] : stageInjectedCommands(state, workflowId, stateId, stateDef));
        return { prompt, messages: [] };
      }
      const result = await goalEngine.activate(goalRef, envFor(agent, state), state);
      const targetText = result.prompt || effectiveStatePrompt(state, workflowId, stateId, stateDef) || stateId;
      writeState(agent, { ...basePatch, ...result.statePatch, target: { target: targetText, mode: stateId } });
      applyStateModelSelection(agent, workflowId, stateId);
      await injectModeGateContext(agent, 'state');
      // 按本状态 goal 可见集供给 scope 工具（与门禁同一份名单），并把本阶段
      // 「初始命令 / Universal 命令」并入可见集，确保注入的命令真的对模型可见。
      const injectedVisible = stageInjectedCommands(state, workflowId, stateId, stateDef);
      provisionStageTools(agent, [...new Set([...visibleToolsForGoal(goalRef), ...injectedVisible])]);
      return result;
    }

    /**
     * 量当前会话的上下文压力（tokens）。
     *
     * 唯一可信来源是 harness 的 `ctx.tokenMeter`：compaction-basic 判定自动压缩
     * 用的就是 `measure(session).totalTokens`。返回 null 表示计量不可用，调用方
     * 必须回落到既有估算值，绝不因为计量失败而阻塞工作流。
     */
    function measureAgentContextTokens(agent) {
      try {
        const session = agent && agent.session;
        if (!session) return null;
        const meter = ctx.tokenMeter
          || (typeof ctx.get === 'function' ? ctx.get('tokenMeter') : null);
        if (!meter || typeof meter.measure !== 'function') return null;
        const measurement = meter.measure(session);
        const total = Number(measurement && measurement.totalTokens);
        if (!Number.isFinite(total) || total < 0) return null;
        return Math.floor(total);
      } catch (err) {
        log(`上下文计量失败，回落估算值：${(err && err.message) || err}`);
        return null;
      }
    }

    /** Apply a raw goal result, resolve config transitions, activate the next state. */
    async function completeGoal(agent, rawResult) {
      const before = readState(agent);
      const patch = { ...(rawResult.statePatch || {}) };
      if (rawResult.prompt) {
        patch.goal = { ...(before.goal || {}), prompt: rawResult.prompt, status: 'active' };
      }
      writeState(agent, patch);
      const state = readState(agent);
      const registry = registryFor(agent);
      const stateDef = registry.stateOf(state.workflowId, state.phase);
      const wf = registry.get(state.workflowId);
      const signal = rawResult.signal || {};
      // 每次阶段转移都判定预算并计算压缩边界：优先使用当前阶段模型的
      // 压缩黄金点（model-compression.js），未知模型回落到硬编码预算表。
      // 只有「超预算 且 当前阶段是迭代边界 且 模型支持自动压缩」才把
      // overBudget=true 注入 transitions，因此 RESEARCH→EXECUTE /
      // EXECUTE→DEBUG 等迭代内部即使超预算也绝不会压缩；DEBUG→下一轮
      // RESEARCH（或结束）才允许压缩，由 transitions 的 context.overBudget 决定。
      const stageOverrideForBudget = stateModelOverride(state, state.workflowId, state.phase);
      const stageModelForBudget = stageOverrideForBudget && stageOverrideForBudget.model
        ? resolveStageModel(stageOverrideForBudget.model)
        : null;
      const phaseModelForBudget = stateDef && stateDef.model && stateDef.model.model ? stateDef.model.model : '';
      const usageForBudget = state.contextUsage && typeof state.contextUsage === 'object' ? state.contextUsage : {};
      // checklist-2：预算判定必须用真实计量。历史上这里依赖 agent/request 的
      // payload.messages 做估算，但该 payload 只有 { agent, turn, step, signal }，
      // 估算恒为空 → contextUsage 永远停在 0 → overBudget 永不成立 →
      // ACCUMULATION 从不自动进入。改用 harness 的 tokenMeter 实测，并保留
      // 「一个迭代内到过阈值就在迭代边界压缩」的峰值语义。
      const measuredTokens = measureAgentContextTokens(agent);
      const peakForBudget = Math.max(
        Number.isFinite(usageForBudget.peakTokens) && usageForBudget.peakTokens > 0
          ? usageForBudget.peakTokens
          : (Number.isFinite(usageForBudget.tokens) ? usageForBudget.tokens : 0),
        measuredTokens === null ? 0 : measuredTokens,
      );
      const budgetModelId = resolveBudgetModelId([
        stageModelForBudget && stageModelForBudget.model ? stageModelForBudget.model : '',
        state.selectedModel && state.selectedModel.model ? state.selectedModel.model : '',
        phaseModelForBudget,
        usageForBudget.modelId,
      ]);
      // 窗口优先用请求里带的；请求不带时用实测观测值兜底——否则表外模型会
      // 一律落到 180k 默认压缩点，128k 窗口的模型永远等不到触发。
      const budgetContextWindow = Number.isFinite(usageForBudget.contextWindow)
        ? usageForBudget.contextWindow
        : modelWindowCache.windowFor(budgetModelId);
      const contextBudget = budgetDecision({
        workflowId: state.workflowId,
        stateId: state.phase,
        contextTokens: peakForBudget,
        modelId: budgetModelId,
        contextWindow: budgetContextWindow,
        overrides: loadStateStore().compressionOverrides || {},
      });
      const { nextWorkflow, nextState, loopIncrement, complete } = resolveTransition({
        state,
        stateDef,
        workflowDef: wf,
        signal: { ...signal, overBudget: contextBudget.compressionAllowed },
      });
      if (loopIncrement) {
        const memory = state.loopMemory || { iteration: 0, blocks: [], updatedAt: 0 };
        const iteration = (memory.iteration || 0) + 1;
        writeState(agent, {
          loopMemory: { ...memory, iteration, updatedAt: Date.now() },
          goal: state.goal ? { ...state.goal, iteration } : null,
        });
      }
      writeState(agent, {
        workflowId: nextWorkflow,
        phase: nextState,
        mode: nextState,
        goal: null,
        pendingProtocol: null,
        dynamicPlan: { scope: 'state', stateId: null, items: [], updatedAt: Date.now() },
        // 实测值回写 contextUsage：既给下一轮判定保留峰值，也让排查能看到真实用量。
        contextUsage: trackContextUsage(usageForBudget, {
          tokens: measuredTokens === null ? peakForBudget : measuredTokens,
          modelId: budgetModelId,
          contextWindow: budgetContextWindow,
          workflowId: state.workflowId,
          stateId: state.phase,
        }),
        contextBudget: {
          ...contextBudget,
          // checklist-2：把计量来源与峰值一并落盘，压缩触发与否都可审计、可复现。
          measuredTokens,
          peakTokens: peakForBudget,
          measurementSource: measuredTokens === null ? 'fallback-estimate' : 'token-meter',
          from: `${state.workflowId}/${state.phase}`,
          to: `${nextWorkflow}/${nextState}`,
          decidedAt: Date.now(),
        },
      });
      return activateStateGoal(agent, nextWorkflow, nextState, {
        workflowId: state.workflowId,
        stateId: state.phase,
      });
    }

    async function buildPendingProtocolDisplay(agent, parsed) {
      const { featureIntents } = storesFor(agent);
      let fields = { userWords: '', understanding: '', userVisibleBehavior: '', featureIntent: '', checklist: [] };
      try {
        const file = await featureIntents.get(parsed.featureIntentFile);
        fields = extractEntryFields(latestEntry(file.content));
      } catch (err) {
        log(`读取 feature intent 以生成待确认协议失败：${(err && err.message) || err}`);
      }
      return {
        summary: parsed.summary,
        featureIntentFile: parsed.featureIntentFile,
        userWords: fields.userWords,
        understanding: fields.understanding,
        userVisibleBehavior: fields.userVisibleBehavior,
        featureIntent: fields.featureIntent,
        checklist: fields.checklist,
      };
    }

    async function submitGoalTool(agent, toolName, args) {
      const { history } = storesFor(agent);
      const before = readState(agent);
      const stateDefForSubmit = registryFor(agent).stateOf(before.workflowId, before.phase);
      const unmet = unmetStateRequirements(before, stateDefForSubmit);
      if (unmet.length > 0) {
        throw new Error(`阶段进展需求未完成：${unmet.map(requirementLabel).join('；')}`);
      }
      const submitted = await goalEngine.submit(toolName, args, before, envFor(agent, before));
      if (!submitted.ok) throw new Error(submitted.reason);
      const { result, parsed } = submitted;
      if (toolName === 'submit_requirement_protocol') {
        const display = await buildPendingProtocolDisplay(agent, parsed);
        // checklist-16：feature intent 提交时自动整理历史对话到冷库。
        // 失败只记日志，不阻塞协议提交。
        try {
          history.append(parsed.featureIntentFile, {
            summary: parsed.summary,
            userWords: display.userWords,
            understanding: display.understanding,
            userVisibleBehavior: display.userVisibleBehavior,
            featureIntent: display.featureIntent,
            checklist: display.checklist,
          });
        } catch (err) {
          log(`历史对话自动整理失败：${(err && err.message) || err}`);
        }
        writeState(agent, {
          goal: null,
          pendingProtocol: {
            status: 'awaiting_user',
            submittedAt: Date.now(),
            workflowId: before.workflowId,
            stateId: before.phase,
            result,
            display,
          },
          target: { target: '需求协议已提交，请在“工作流”界面确认；发送任意消息视为拒绝并继续修改需求。', mode: before.phase },
        });
        return { pendingApproval: true, phase: before.phase, workflowId: before.workflowId, display };
      }
      await completeGoal(agent, result);
      const after = readState(agent);
      if (toolName === 'submit_state' && (
        (before.workflowId === 'create' && (before.phase === 'DEBUG' || before.phase === 'ACCUMULATION'))
        || (before.workflowId === 'rough' && before.phase === 'IMPLEMENT')
      )) {
        syncStaticPlanToDshTodos(agent, after);
      }
      return result;
    }

    async function approvePendingProtocol(sessionId) {
      const entry = readSessionEntry(sessionId);
      if (!entry || !entry.pendingProtocol) {
        return { ok: false, error: '当前没有待确认的需求协议' };
      }
      const agent = agentFor(sessionId);
      writeState(agent, { pendingProtocol: null });
      const rawResult = entry.pendingProtocol.result;
      const activated = await completeGoal(agent, rawResult);
      const after = readState(agent);
      syncStaticPlanToDshTodos(agent, after);
      const live = agents.get(sessionId);
      if (live && typeof live.followup === 'function') {
        try {
          live.followup(createUserMessage({
            content: [{ type: 'text', text: '需求协议已通过，请现在开始执行当前阶段的工作，直接按阶段目标推进。' }],
            source: { kind: 'user' },
          }));
        } catch (err) {
          log(`协议确认后自动开工消息注入失败：${(err && err.message) || err}`);
        }
      }
      return { ok: true, workflowId: after.workflowId, phase: after.phase, ...(activated && activated.prompt ? { prompt: activated.prompt } : {}) };
    }

    async function rejectPendingProtocol(sessionId) {
      const entry = readSessionEntry(sessionId);
      if (!entry || !entry.pendingProtocol) {
        return { ok: false, error: '当前没有待确认的需求协议' };
      }
      const agent = agentFor(sessionId);
      writeState(agent, { pendingProtocol: null, goal: null, target: null });
      const activated = await activateStateGoal(agent, entry.workflowId, entry.phase);
      return { ok: true, workflowId: entry.workflowId, phase: entry.phase, ...(activated && activated.prompt ? { prompt: activated.prompt } : {}) };
    }

    /**
     * sessionId -> 该项目（按 workspace 解析）的 feature 树 store。
     * feature intent 是项目文件：活着的 agent 优先用它真实的 cwd，
     * 否则用状态里记录的 workspace 兜底。
     */
    function treeForSession(sessionId) {
      const entry = readSessionEntry(sessionId);
      const live = agents.get(sessionId);
      const workspace = (live && workspaceOf(live, '')) || entry.workspace || '';
      // 拿不到项目目录时返回 null：宁可让 UI 明确报错，也不要静默给一棵空树
      // （更不能在 server 的 cwd 下乱建 feature_intents 目录）。
      if (!workspace) return null;
      const bundle = storesForWorkspace(workspace, entry.featureIntentDir);
      // 多项目 workspace 用挂载树（顶层是各项目目录）；单项目用平铺树。
      return bundle.flat ? bundle.featureTree : bundle.pickerTree;
    }

    /** 选择器所需的布局信息（workspace / 是否多项目 / 发现的目录）。 */
    function layoutForSession(sessionId) {
      const entry = readSessionEntry(sessionId);
      const live = agents.get(sessionId);
      const liveCwd = live ? workspaceOf(live, '') : '';
      const entryWorkspace = entry.workspace || '';
      const workspace = liveCwd || entryWorkspace;
      if (!workspace) return null;
      const bundle = storesForWorkspace(workspace, entry.featureIntentDir);
      return {
        workspace: bundle.workspace,
        // 排查用：workspace 到底来自活 agent 的 cwd 还是状态记录（两者不一致会导致树为空）。
        source: liveCwd ? 'live' : 'entry',
        liveCwd: liveCwd || null,
        entryWorkspace: entryWorkspace || null,
        flat: bundle.flat,
        pinned: Boolean(entry.featureIntentDir),
        dirs: bundle.dirs,
        rels: bundle.rels,
      };
    }

    /**
     * 把最近一次 getFeatureTree 的解析结果写进 state.featureTreeProbe。
     * 只在结果发生变化时落盘（选择器 5 秒轮询，结果稳定时不产生写入），
     * 这样「树为什么是空的」可以直接从 state 文件里读出来。
     */
    function recordFeatureTreeProbe(summary) {
      try {
        const store = loadStateStore();
        const prev = store.featureTreeProbe && typeof store.featureTreeProbe === 'object' ? store.featureTreeProbe : null;
        const same = prev
          && prev.sessionId === summary.sessionId
          && prev.source === summary.source
          && prev.liveCwd === summary.liveCwd
          && prev.entryWorkspace === summary.entryWorkspace
          && prev.workspace === summary.workspace
          && prev.mode === summary.mode
          && prev.flat === summary.flat
          && prev.pinned === summary.pinned
          && prev.dir === summary.dir
          && prev.storeDirExists === summary.storeDirExists
          && prev.treeSize === summary.treeSize
          && prev.error === summary.error
          && JSON.stringify(prev.roots || []) === JSON.stringify(summary.roots || []);
        if (same) return;
        saveStateStore({ ...store, featureTreeProbe: { ...summary, at: new Date().toISOString() } });
      } catch (err) {
        log(`记录 feature 树探针失败：${(err && err.message) || err}`);
      }
    }

    /**
     * INIT 阶段用户从 feature 树里提交选择。
     *
     * 多项目 workspace 下，选择里带的路径是 workspace 相对路径
     * （`documentation/feature_intents/mode-gate`）。提交时按选中的项目目录
     * **锁定**本轮的 feature 根目录，并把路径归一化成相对该目录的短路径
     * （`mode-gate`），这样后续 feature intent / 功能列表 / pattern / journal /
     * architecture 全都落在该项目自己的文件里。
     *
     * 记入 state.featureSelection（供后续两条路线使用：选中 overview → AI 自动
     * 寻找；选中底层 intent → 冒泡注入），然后推进 INIT → REQUIREMENT_RECOGNITION。
     */
    async function submitFeatureSelection(sessionId, selection) {
      const agent = agentFor(sessionId);
      const bundle = storesFor(agent);
      const raw = [];
      const seenRaw = new Set();
      for (const item of selection || []) {
        if (!item || typeof item !== 'object') continue;
        const type = item.type === 'overview' ? 'overview' : (item.type === 'intent' ? 'intent' : null);
        if (!type) continue;
        const key = `${type}:${String(item.path || '')}`;
        if (seenRaw.has(key)) continue;
        seenRaw.add(key);
        raw.push({ type, path: typeof item.path === 'string' ? item.path : '', name: typeof item.name === 'string' ? item.name : '' });
      }
      if (raw.length === 0) {
        return { ok: false, error: '请选择至少一个 feature overview 或 feature intent' };
      }
      // 多项目 workspace：所有选择必须落在同一个项目目录下，并据此锁定根目录。
      let pinnedDir = '';
      let rel = '';
      if (!bundle.flat && bundle.rels.length > 0) {
        const owners = new Set();
        for (const item of raw) {
          const owner = bundle.rels.find((candidate) => item.path === candidate || item.path.startsWith(`${candidate}/`));
          if (!owner) {
            return { ok: false, error: `「${item.path || '(空路径)'}」不在任何已发现的 feature intent 目录下：请展开顶层项目文件夹，选择其中的 feature overview 或 feature intent。` };
          }
          owners.add(owner);
        }
        if (owners.size > 1) {
          return { ok: false, error: '不同项目目录下的 feature 不能混选：请只选择一个项目目录里的 feature。' };
        }
        rel = [...owners][0];
        pinnedDir = join(bundle.workspace, rel);
      }
      const clean = [];
      const seen = new Set();
      for (const item of raw) {
        let path = item.path.trim().replace(/^\/+|\/+$/g, '');
        if (rel) {
          if (path === rel) path = ''; // 选中的是项目目录本身 → 该项目根 overview
          else if (path.startsWith(`${rel}/`)) path = path.slice(rel.length + 1);
        }
        if (path === '') {
          // 根 overview 只对 overview 选择有意义（等价于「这个项目的根」）。
          if (item.type !== 'overview') continue;
        } else {
          try {
            path = assertLogicalPath(path);
          } catch (_err) {
            continue;
          }
        }
        const key = `${item.type}:${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        clean.push({ type: item.type, path, ...(item.name ? { name: item.name } : {}) });
      }
      if (clean.length === 0) {
        return { ok: false, error: '请选择至少一个 feature overview 或 feature intent' };
      }
      const types = new Set(clean.map((item) => item.type));
      if (types.size > 1) {
        return { ok: false, error: 'feature overview 与底层 feature intent 不能同时选择' };
      }
      const route = [...types][0] === 'overview' ? 'auto-discover' : 'inject';
      writeState(agent, {
        featureSelection: { types: [...types][0], items: clean, route, dir: pinnedDir || bundle.dir, submittedAt: new Date().toISOString() },
        featureIntentWrites: [],
        featureIntentDir: pinnedDir || null,
      });
      // 沿树上溯冒泡收集各层 architecture.md 及其父文件夹 code map，去重后注入。
      const context = collectFeatureArchitectureContext(agent, clean);
      writeState(agent, { featureArchitectureContext: context.state });
      // 顺序很关键：先激活 RR（内部已同步等待阶段上下文注入），再注入架构/
      // 选择上下文，最后 followup 唤醒。这样唤醒开出的首轮一定能看到 RR 政策
      // + 架构 + 选择（之前是先注入后激活，政策 inject 与唤醒赛跑，首轮经常缺席）。
      const activated = await activateStateGoal(agent, 'create', 'REQUIREMENT_RECOGNITION');
      if (!ignorePromptEnabled(readState(agent), 'create', 'REQUIREMENT_RECOGNITION')) {
        const archOk = injectFeatureArchitectureContext(agent, context.text);
        // auto-discover 路线：把所选 overview 的内容 + 路径也喂给 AI，供其自行寻找 intent。
        let routeOk = true;
        if (route === 'auto-discover') {
          routeOk = injectFeatureSelectionContext(agent, clean);
        } else if (route === 'inject') {
          // inject 路线：从所选 intent 向上冒泡收集 overview 链 + 底层被选 intent。
          routeOk = injectFeatureBubbleContext(agent, clean);
        }
        console.log(`[dsh-mode-gate] [feature-tree] 提交后注入：arch=${archOk} route=${route}:${routeOk}。`);
      }
      // INIT 闸门期间 AI 被禁言、用户消息也不会触发 AI：这里必须主动唤醒，
      // 否则需求分解阶段永远不跑（用户原话仍在会话历史里，AI 能看到）。
      const live = agents.get(sessionId);
      if (live && typeof live.followup === 'function') {
        try {
          live.followup(createUserMessage({
            content: [{ type: 'text', text: 'feature 选择已提交，请立即开始需求分解：按阶段目标写入对应 feature intent，并提交需求协议。' }],
            source: {
              kind: 'plugin',
              plugin: 'mode-gate',
              form: 'notice',
              summary: 'mode-gate feature 选择已提交',
            },
          }));
        } catch (err) {
          log(`feature 选择提交后唤醒 Agent 失败：${(err && err.message) || err}`);
        }
      } else {
        // 没有 live agent 就没有首轮：RR 状态已落盘，用户下一次输入才会开轮。
        // 记一笔，免得下次又以为是注入丢了。
        console.log(`[dsh-mode-gate] [feature-tree] 提交后无 live agent（session=${sessionId}），等待用户下一条消息开轮。`);
      }
      const after = readState(agent);
      return {
        ok: true,
        workflowId: after.workflowId,
        phase: after.phase,
        ...(activated && activated.prompt ? { prompt: activated.prompt } : {}),
      };
    }

    /**
     * 沿树上溯冒泡收集各层 architecture.md（去重），并为**最高层**（最外层）的那个
     * architecture.md 生成一次 code map（父文件夹依赖图）——依赖图只给一次。
     *
     * @returns {{ state: object, text: string }}
     */
    function collectFeatureArchitectureContext(agent, selection) {
      const { featureTree } = storesFor(agent);
      let architectures = [];
      try {
        architectures = featureTree.architecturesFor(selection);
      } catch (err) {
        log(`收集 feature architecture 失败：${(err && err.message) || err}`);
        architectures = [];
      }
      // 只对最外层（路径层级最浅）的 architecture.md 生成一次 code map。
      let codeMap = null;
      if (architectures.length > 0) {
        const outermost = architectures[0];
        try {
          const rootDir = dirname(outermost.path);
          const map = generateDependencyMap(rootDir, { maxTokens: MAX_DEPENDENCY_TOKENS });
          codeMap = {
            root: rootDir,
            rendered: map && map.text ? map.text : '',
            fileCount: map ? map.fileCount : 0,
            truncated: Boolean(map && map.truncated),
          };
        } catch (err) {
          log(`生成 code map 失败（${outermost.path}）：${(err && err.message) || err}`);
        }
      }
      const state = {
        architectures: architectures.map((entry) => ({ level: entry.level, path: entry.path })),
        codeMap: codeMap ? { root: codeMap.root, fileCount: codeMap.fileCount, truncated: codeMap.truncated } : null,
        collectedAt: new Date().toISOString(),
      };
      const lines = [];
      if (architectures.length > 0) {
        lines.push('## 相关 architecture.md（沿 feature 树上溯冒泡，已去重）');
        for (const entry of architectures) {
          lines.push('', `### ${entry.level}：${entry.path}`, '', limitedDigest(entry.content));
        }
      }
      if (codeMap && codeMap.rendered) {
        lines.push('', `## code map（最高层 architecture.md 所在目录：${codeMap.root}）`, '', codeMap.rendered);
      }
      return { state, text: lines.join('\n') };
    }

    /** 把 feature architecture / code map 作为插件上下文注入本轮。 */
    function injectFeatureArchitectureContext(agent, text) {
      if (!text || !agent || typeof agent.inject !== 'function') return false;
      try {
        agent.inject(createUserMessage({
          content: [{ type: 'text', text }],
          source: {
            kind: 'plugin',
            plugin: 'mode-gate',
            form: 'notice',
            summary: 'mode-gate feature architecture / code map',
          },
        }));
        return true;
      } catch (err) {
        log(`feature architecture 注入失败：${(err && err.message) || err}`);
        return false;
      }
    }

    /**
     * auto-discover 路线：把所选 feature overview 的内容 + 路径注入给 AI，
     * 供其在需求识别/feature update 阶段自行寻找（或新建）具体 feature intent。
     */
    function injectFeatureSelectionContext(agent, selection) {
      if (!agent || typeof agent.inject !== 'function') return false;
      const { featureTree } = storesFor(agent);
      const lines = ['## 已选择的 feature overview（请据此自行寻找 / 新建具体 feature intent）'];
      for (const item of selection || []) {
        if (!item || item.type !== 'overview') continue;
        lines.push('', `### ${item.path}`, '');
        try {
          const node = featureTree.contentOf('overview', item.path);
          lines.push(`路径：${item.path}（文档：${node.path}）`, '', limitedDigest(node.content));
        } catch (err) {
          lines.push(`路径：${item.path}（无法读取 overview.md：${(err && err.message) || err}）`);
        }
      }
      lines.push('', '提示：可用 feature 树工具查看该 overview 的上级与直属下属；如需新增 intent/overview，可直接创建并挂到任意 overview 下；完成后用 submit_state 推进阶段。');
      try {
        agent.inject(createUserMessage({
          content: [{ type: 'text', text: lines.join('\n') }],
          source: {
            kind: 'plugin',
            plugin: 'mode-gate',
            form: 'notice',
            summary: 'mode-gate feature overview 选择（auto-discover）',
          },
        }));
        return true;
      } catch (err) {
        log(`feature overview 选择注入失败：${(err && err.message) || err}`);
        return false;
      }
    }

    /**
     * inject 路线：从所选底层 feature intent 一路向上冒泡，收集 overview 链
     * （去重，父在前）与底层被选 intent，一并注入给 AI。
     */
    function injectFeatureBubbleContext(agent, selection) {
      if (!agent || typeof agent.inject !== 'function') return false;
      const { featureTree } = storesFor(agent);
      const intents = (selection || []).filter((item) => item && item.type === 'intent');
      // 冒泡：所有被选 intent 的祖先 overview（去重、父在前）。
      const overviewPaths = [];
      const seen = new Set();
      for (const item of intents) {
        let described;
        try {
          described = featureTree.describeNode(item.path);
        } catch (err) {
          log(`冒泡收集 "${item.path}" 上级失败：${(err && err.message) || err}`);
          continue;
        }
        for (const ancestor of described.ancestors) {
          if (ancestor.type !== 'overview') continue;
          if (seen.has(ancestor.path)) continue;
          seen.add(ancestor.path);
          overviewPaths.push(ancestor.path);
        }
      }
      const lines = ['## 注入 prompt 路线：所选 feature intent 与其 overview 链（一个都不能少）'];
      if (intents.length > 0) {
        lines.push('', '### 必须全部修改的被选 feature intent');
        for (const item of intents) {
          lines.push(`- ${item.path}`);
        }
      }
      if (overviewPaths.length > 0) {
        lines.push('', '### 冒泡收集的 feature overview（沿树上溯，去重）');
        for (const path of overviewPaths) {
          lines.push('', `#### ${path}`, '');
          try {
            const node = featureTree.contentOf('overview', path);
            lines.push(`路径：${path}（文档：${node.path}）`, '', limitedDigest(node.content));
          } catch (err) {
            lines.push(`路径：${path}（无法读取 overview.md：${(err && err.message) || err}）`);
          }
        }
      }
      lines.push('', '要求：submit_requirement_protocol 提交前，必须对上述每一个被选 feature intent 都调用 update_feature_intent 写入记录，缺一不可；协议会校验，未全部修改将被拒绝。update_feature_intent 的 name 只接受末段裸文件名（不带目录）：如所选路径为 `某-overview/某-intent`，传 `某-intent` 即可。');
      try {
        agent.inject(createUserMessage({
          content: [{ type: 'text', text: lines.join('\n') }],
          source: {
            kind: 'plugin',
            plugin: 'mode-gate',
            form: 'notice',
            summary: 'mode-gate feature intent 冒泡注入（inject）',
          },
        }));
        return true;
      } catch (err) {
        log(`feature intent 冒泡注入失败：${(err && err.message) || err}`);
        return false;
      }
    }

    function syncStaticPlanToDshTodos(agent, state) {
      const plan = state && state.staticPlan;
      if (!plan || !Array.isArray(plan.items) || plan.items.length === 0) return false;
      const session = agent && agent.session;
      if (!session || typeof session.append !== 'function') return false;
      const current = staticPlanCurrent(plan);
      const todos = plan.items.map((item) => ({
        content: item.text,
        status: item.status === 'completed'
          ? 'completed'
          : (current && item.id === current.id ? 'in_progress' : 'pending'),
      }));
      try {
        session.append('todo/write', { todos });
        return true;
      } catch (err) {
        log(`同步 DSH todo 失败：${(err && err.message) || err}`);
        return false;
      }
    }

    function bashDecision(command, stateDef, state) {
      const deny = matchBashDeny(command, readBashDenyList());
      if (deny) return { kind: 'deny', reason: deny.reason || `命令 ${deny.commands.join('/')} 已被禁止。` };
      // checklist-15：Agent 禁止直接执行 git 修改命令；每轮更新走 git_commit 工具。
      if (isGitMutation(command)) {
        return {
          kind: 'deny',
          reason: 'Agent 禁止直接执行 git 修改命令（如 add/commit/push/rm/mv/reset/clean/merge/rebase/checkout 等）。每轮更新请使用 git_commit 工具（由 mode-gate-git-commit skill 提供）完成 commit + push。',
        };
      }
      const policy = (stateDef && stateDef.permissions && stateDef.permissions.bash) || 'declared';
      if (policy === 'none') {
        const requirementRecognition = Boolean(stateDef && stateDef.id === 'REQUIREMENT_RECOGNITION');
        return {
          kind: 'deny',
          reason: requirementRecognition
            ? '需求分解阶段禁止使用任何 bash，请专心分解需求；请使用只读调研工具。'
            : '当前状态禁用 bash，请专心完成当前阶段目标。',
        };
      }
      const kind = classifyCommand(command);
      if (policy === 'unrestricted') {
        return kind === 'dangerous' ? { kind: 'ask', reason: `检测到危险命令，需要人工授权：${command}` } : { kind: 'allow' };
      }
      if (policy === 'read-only') {
        return kind === 'read-only'
          ? { kind: 'allow' }
          : { kind: 'deny', reason: `当前状态只允许只读 bash 命令：${command}` };
      }
      if (policy === 'read-only-strict') {
        return isAlwaysAllowedBash(command)
          ? { kind: 'allow' }
          : { kind: 'deny', reason: `当前状态只允许白名单只读命令（ls/cat/grep/sed/find 等），禁止 node/python3 等解释器：${command}` };
      }
      // declare_target 机制已移除：不再按声明动词拦截，非危险命令直接放行。
      return kind === 'dangerous'
        ? { kind: 'ask', reason: `检测到危险命令，需要人工授权：${command}` }
        : { kind: 'allow' };
    }

    // ── system prompt / runtime context ─────────────────────────────────
    function buildModeGatePolicyText(agent) {
      const state = readState(agent);
      const registry = registryFor(agent);
      const wf = registry.get(state.workflowId);
      const stateDef = registry.stateOf(state.workflowId, state.phase);
      const goalDef = goalEngine.defFor(state);
      const guideGoalDef = goalDef || (stateDef && stateDef.goal && stateDef.goal.ref ? goalEngine.get(stateDef.goal.ref) : null);
      const goalPrompt = state.goal && state.goal.prompt
        ? state.goal.prompt
        : (goalDef ? (typeof goalDef.prompt === 'function' ? goalDef.prompt(envFor(agent, state), state) : goalDef.prompt) : '');
      const stagePrompt = ignorePromptEnabled(state, state.workflowId, state.phase)
        ? ''
        : effectiveStatePrompt(state, state.workflowId, state.phase, stateDef);
      const awaitingUser = Boolean(state.pendingProtocol && state.pendingProtocol.status === 'awaiting_user');
      const autoGuide = !awaitingUser
        && !ignorePromptEnabled(state, state.workflowId, state.phase)
        && autoGuideEnabled(state, state.workflowId, state.phase, stateDef)
        ? buildAutoGuide(stateDef, guideGoalDef)
        : '';
      const denyList = readBashDenyList();
      const lines = [
        '[mode-gate]',
        `当前工作流：${state.workflowId}${wf ? `（${wf.label}）` : ''}`,
        `当前状态：${state.phase}${stateDef ? `（${stateDef.label}）` : ''}`,
        '规则：',
        '- 本工作流不再要求声明 Target，直接按阶段目标推进即可。',
        '- 始终可用：skill_search、switch_mode、dev_tool_search / request_extra、submit_state。',
        '当前禁止的 bash 命令：',
        ...(denyList.length ? denyList.map((entry) => `  - ${entry.commands.join(', ')}：${entry.reason || '已禁止'}`) : ['  （无）']),
        '  - git 修改命令（add/commit/push/rm/mv/reset/clean/merge/rebase/checkout 等）：Agent 禁止直接执行，请使用 git_commit 工具（mode-gate-git-commit skill）完成 commit + push。',
      ];
      if (awaitingUser) {
        lines.push('', '当前有需求协议正在等待用户确认。请停止工具调用，等待用户在“工作流”界面点击“接受”，或发送消息以修改需求。');
      }
      // 初始命令 / Universal 命令：阶段启动即声明，agent 无需自行搜索。
      const injectedText = buildInjectedCommandsText(state, stateDef);
      if (injectedText) lines.push('', injectedText);
      if (stagePrompt) lines.push('', '当前阶段说明：', stagePrompt);
      if (autoGuide) lines.push('', autoGuide);
      const requirementList = effectiveStateRequirements(state, state.workflowId, state.phase, stateDef);
      if (requirementList.length > 0) {
        const remainingLabels = new Set(unmetStateRequirements(state, stateDef).map((req) => requirementLabel(req)));
        lines.push('', '阶段进展需求：');
        lines.push(...requirementList.map((req) => `  - [${remainingLabels.has(requirementLabel(req)) ? ' ' : 'x'}] ${requirementLabel(req)}`));
      }
      if (state.goal && state.goal.status === 'active') lines.push('', '当前目标：', goalPrompt);
      if (state.goal && state.goal.status === 'active' && (state.goal.toolCount || 0) >= 10) {
        const submitName = guideGoalDef && guideGoalDef.submitTool ? guideGoalDef.submitTool.name : 'submit_state';
        lines.push('', '[目标提醒] 你当前的目标是：', goalPrompt, `完成当前 goal 后，调用 ${submitName} 推进到下一阶段。`);
      }
      const plan = state.staticPlan;
      if (plan && Array.isArray(plan.items) && plan.items.length > 0) {
        const pending = staticPlanPendingCount(plan);
        const current = staticPlanCurrent(plan);
        lines.push('', `Checklist 进度：${plan.items.length - pending}/${plan.items.length} 完成`);
        // 切换上下文只展示前一个、进行中、后一个，避免把整条 checklist 注入上下文。
        const currentIndex = current ? plan.items.findIndex((item) => item.id === current.id) : -1;
        const visibleItems = currentIndex >= 0
          ? plan.items.slice(Math.max(0, currentIndex - 1), currentIndex + 2)
          : plan.items.slice(0, 3);
        lines.push(...visibleItems.map((item) => `  - [${item.status === 'completed' ? 'x' : item.status === 'in_progress' ? '~' : ' '}] ${item.id}: ${item.text}`));
        if (current) lines.push(`当前 checklist goal：${current.id}`);
      }
      const dynamic = state.dynamicPlan;
      if (dynamic && Array.isArray(dynamic.items) && dynamic.items.length > 0) {
        const goalLabel = dynamic.goalId ? `（goal: ${dynamic.goalId}）` : '';
        lines.push('', `当前动态计划${goalLabel}（本状态内有效，状态切换时清空）：`);
        lines.push(...dynamic.items.map((item) => `  - [${item.status === 'completed' ? 'x' : item.status === 'in_progress' ? '~' : ' '}] ${item.content}`));
      }
      // Loop Memory no longer injected into switch context (iteration counting and compression kept).
      if (state.migrationNotice) lines.push('', `迁移提示：${state.migrationNotice}`);
      return lines.join('\n');
    }

    ctx.systemPrompt.context({
      name: 'mode-gate:policy',
      order: 95,
      text: (assembleCtx) => buildModeGatePolicyText(assembleCtx && assembleCtx.agent),
    });

    /**
     * architecture.md 作为**常驻 limited prompt** 独立注入：
     * 走 limitedDigest() 硬截断，内容超预算也不会影响上下文大小。
     */
    ctx.systemPrompt.context({
      name: 'mode-gate:architecture',
      order: 96,
      text: (assembleCtx) => {
        try {
          // architecture.md 属于项目文件：按当前 agent 的 workspace 取该项目的那一份。
          const { architecture } = storesFor(assembleCtx && assembleCtx.agent);
          return architecture.prompt();
        } catch (err) {
          log(`architecture limited prompt 读取失败：${(err && err.message) || err}`);
          return '';
        }
      },
    });

    async function modeGateContextDelivered(agent) {
      if (!agent || typeof agent.id === 'undefined') return false;
      try {
        const assembly = await ctx.systemPrompt.assemble({ scope: agent });
        return Array.isArray(assembly.contexts)
          && assembly.contexts.some((entry) => entry && entry.name === 'mode-gate:policy');
      } catch (err) {
        log(`mode-gate context assembly detection failed: ${(err && err.message) || err}`);
        return false;
      }
    }

    /**
     * 取该阶段的「命令 Set」：优先用户在本项目覆盖/自建的 stage command set，
     * 否则回退内置 BUILTIN_STAGE_COMMAND_SETS（按 `<workflowId>.<stateId>` 索引）。
     *
     * 这是 checklist-2 的抽象：每个阶段一套 initialCommands，来源于 Research
     * 产出的阶段×命令依赖表（goal.requiredCalls + submitTool 中阶段专属部分）。
     */
    function stageCommandSetFor(workflowId, stateId) {
      const key = `${workflowId}.${stateId}`;
      // 用户覆盖优先（设置-限制页「阶段命令 Set」表编辑，存 state store），缺省回退内置。
      try {
        const store = loadStateStore();
        const overrides = normalizeStageCommandSets(store && store.stageCommandSets);
        if (overrides[key]) {
          const base = BUILTIN_STAGE_COMMAND_SETS[key] || {};
          return {
            id: key,
            label: overrides[key].label || base.label || key,
            initialCommands: [...overrides[key].initialCommands],
            builtin: false,
          };
        }
      } catch (_e) {
        // 读不到覆盖则回退内置
      }
      const builtin = BUILTIN_STAGE_COMMAND_SETS[key] || null;
      return builtin ? { ...builtin, builtin: true } : null;
    }

    /**
     * 当前阶段生效的「初始命令 + Universal 命令」。
     *
     * 命令来源（合并去重，初始在前）：
     *  1. 阶段命令 Set（stageCommandSetFor）的 initialCommands —— checklist-2 抽象；
     *  2. 阶段引用限制套件的 initialCommands（兼容用户在 Set 里自定义）；
     *  3. Universal 命令：限制套件显式声明非空则覆盖，否则用全局默认值
     *     （设置-工作流页编辑，见 globalUniversalCommands）。
     */
    function stageInjectedCommands(state, workflowId, stateId, stateDef) {
      const set = resolveStateRestriction(state, workflowId, stateId, stateDef);
      const { initial } = restrictionInjectedCommands(set);
      const universal = universalCommandsForStage(state, workflowId, stateId, stateDef);
      const stageSet = stageCommandSetFor(workflowId, stateId);
      const stageInitial = stageSet && Array.isArray(stageSet.initialCommands) ? stageSet.initialCommands : [];
      const out = [];
      const seen = new Set();
      for (const name of [...stageInitial, ...initial, ...universal]) {
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push(name);
      }
      return out;
    }

    /**
     * 全局 Universal 默认值（设置-工作流页「Universal 注入命令」区编辑，
     * 对所有工作流所有 state 生效）。读不到时回退内置默认。
     */
    function globalUniversalCommands() {
      try {
        const store = loadStateStore();
        return normalizeUniversalCommands(store.universalCommands);
      } catch (_e) {
        return [...DEFAULT_UNIVERSAL_COMMANDS];
      }
    }

    /**
     * Universal 命令的「每阶段兜底」集合：限制套件显式声明了非空
     * universalCommands 则覆盖全局，否则继承全局默认值。
     */
    function universalCommandsForStage(state, workflowId, stateId, stateDef) {
      const set = resolveStateRestriction(state, workflowId, stateId, stateDef);
      if (set) {
        const scoped = restrictionInjectedCommands(set).universal;
        if (scoped.length > 0) return scoped;
      }
      return globalUniversalCommands();
    }

    /**
     * 把「本阶段初始命令 / Universal 命令」拼成政策文本片段。
     * 文本里同时声明 tool-search 白名单优先放行语义，让 agent 知道可以直接
     * 调用这些命令，也可以先用 tool-search 搜到再调用。
     */
    function buildInjectedCommandsText(state, stateDef) {
      const set = resolveStateRestriction(state, state.workflowId, state.phase, stateDef);
      const { initial } = restrictionInjectedCommands(set);
      const universal = universalCommandsForStage(state, state.workflowId, state.phase, stateDef);
      const commands = [...new Set([...initial, ...universal])];
      if (commands.length === 0) return '';
      return [
        '本阶段初始命令（已直接注入，无需自行搜索）：',
        ...commands.map((name) => `  - ${name}`),
        '这些命令在 tool-search 时被优先放行：先实际匹配目录，命中即允许真实搜索；未命中仍按本阶段限制处理。',
      ].join('\n');
    }

    /**
     * Some agent presets use a `complete: true` persona and suppress runtime
     * contexts (`includeRuntimeContext: false`).    /**
     * Some agent presets use a `complete: true` persona and suppress runtime
     * contexts (`includeRuntimeContext: false`). In that environment the
     * standard system prompt channels are intentionally unavailable, so
     * mode-gate delivers its phase/goal policy as a synthetic pre-step user
     * context instead. When the normal context channel is available this is a
     * no-op.
     */
    async function injectModeGateContext(agent, reason) {
      if (!agent || typeof agent.inject !== 'function') return false;
      try {
        if (await modeGateContextDelivered(agent)) return false;
        const text = buildModeGatePolicyText(agent);
        if (!text) return false;
        agent.inject(createUserMessage({
          content: [{ type: 'text', text }],
          source: {
            kind: 'plugin',
            plugin: 'mode-gate',
            form: 'notice',
            summary: `mode-gate 阶段上下文（${reason || 'state'}）`,
          },
        }));
        return true;
      } catch (err) {
        log(`mode-gate 阶段上下文注入失败：${(err && err.message) || err}`);
        return false;
      }
    }

    // ── tools ────────────────────────────────────────────────────────────
    // declare_target 机制已移除：不再要求声明 Target，直接按阶段目标推进。
    // 进入新状态时的 goal 激活由 activateStateGoal（切换/转移路径）承担。
    //
    // 可见层供给（M3）：宿主默认把 agent scope 压到 built-ins，插件工具只注册
    // 在全局层时模型根本看不见（dev_tool_search 手动解锁是唯一的口子）。
    // 因此每个工具的 spec 存一份，状态机按 goal 可见集逐 agent 写入 scope
    // （scope 注册不受全局限制影响，始终可见；见 provisionStageTools）。
    const TOOL_SPECS = new Map();
    function registerTool(spec) {
      const def = defineTool(spec);
      ctx.tools.register(def);
      if (spec && typeof spec.name === 'string' && spec.name) TOOL_SPECS.set(spec.name, spec);
      return def;
    }
    // 按可见集供给 agent scope 工具：先清上个状态的，再写入本状态的。
    // names 缺省时只清理（用于 IDLE）。内置工具（bash/read 等）宿主自管，
    // 这里只处理 TOOL_SPECS 有的插件工具；同名 scope 注册会 shadow 全局层，
    // 执行体是同一份闭包，行为一致。
    const scopedToolDisposers = new Map();
    function clearScopedTools(agent) {
      try {
        const key = agent && agent.session ? agent.session.id : undefined;
        const prev = key !== undefined ? scopedToolDisposers.get(key) : undefined;
        if (prev) {
          for (const dispose of prev) {
            try { if (typeof dispose === 'function') dispose(); } catch (_e) { /* 忽略单个清理失败 */ }
          }
          scopedToolDisposers.delete(key);
        }
      } catch (_e) { /* 清理绝不抛错 */ }
    }
    function provisionStageTools(agent, toolNames) {
      const sessionId = agent && agent.session ? agent.session.id : undefined;
      let phase = '';
      let goalId = '';
      try {
        const st = readState(agent);
        phase = st.phase || '';
        goalId = (st.goal && st.goal.id) || '';
      } catch (_e) { /* 读不到状态也继续供给，结果如实记录 */ }
      const probe = {
        sessionId: sessionId === undefined ? null : sessionId,
        phase,
        goalId,
        agentFound: Boolean(agent && agent.session),
        hasLiveAgent: sessionId !== undefined && agents.has(sessionId),
        hasCtxTools: false,
        usedFallbackCtx: false,
        visibleCount: Array.isArray(toolNames) ? toolNames.length : 0,
        supplied: [],
        verified: [],
        failed: [],
      };
      const finishProbe = (patch) => {
        try {
          const store = loadStateStore();
          const summary = { ...probe, ...patch, at: new Date().toISOString() };
          const prev = store.toolProvisionProbe;
          if (prev && JSON.stringify({ ...prev, at: undefined }) === JSON.stringify({ ...summary, at: undefined })) return;
          saveStateStore({ ...store, toolProvisionProbe: summary });
        } catch (err) {
          log(`记录工具供给探针失败：${(err && err.message) || err}`);
        }
      };
      clearScopedTools(agent);
      // 单点叠加：无论调用方给的是什么可见集，用户 /grant 解锁的工具一律并入
      // scope（grantedToolsOutsideOf 顺带剔除重复项）。这样每个状态——含 INIT /
      // IDLE / 无 goal 状态——都自动带上授权工具，不必逐个调用点去补。
      const base = Array.isArray(toolNames) ? toolNames : [];
      let stateGranted = [];
      try {
        stateGranted = grantedToolsOutsideOf(readState(agent)?.grantedTools, base);
      } catch (_e) { /* 读不到状态则视为无授权 */ }
      const list = [...base, ...stateGranted];
      if (!list.length) {
        finishProbe({});
        return true;
      }
      try {
        const agentCtx = agent && agent.ctx;
        let scopeTools = agentCtx && agentCtx.tools;
        if ((!scopeTools || typeof scopeTools.register !== 'function') && agent && agent.scope && agent.scope.ctx) {
          // 兜底：某些 agent 对象把 scope 挂在 .scope 上，ctx 链不同。
          const fallback = agent.scope.ctx && agent.scope.ctx.tools;
          if (fallback && typeof fallback.register === 'function') {
            scopeTools = fallback;
            probe.usedFallbackCtx = true;
          }
        }
        probe.hasCtxTools = Boolean(scopeTools && typeof scopeTools.register === 'function');
        if (!probe.hasCtxTools) {
          log('阶段工具供给跳过：agent.ctx.tools 不可用（沿用 dev_tool_search 手动解锁路径）。');
          finishProbe({ error: 'agent.ctx.tools 不可用' });
          return false;
        }
        const supplied = [];
        const failed = [];
        const disposers = [];
        for (const name of list) {
          const spec = TOOL_SPECS.get(name);
          if (!spec) continue; // 内置工具宿主自管
          try {
            const dispose = scopeTools.register(defineTool(spec));
            if (typeof dispose === 'function') disposers.push(dispose);
            supplied.push(name);
          } catch (err) {
            failed.push({ name, error: String((err && err.message) || err) });
            log(`scope 注册工具 ${name} 失败：${(err && err.message) || err}`);
          }
        }
        // 供给后自检：按 agent 视角回查关键工具是否真的可见（模型看到的即 view(scope).visible）。
        const verified = [];
        const verifyFailed = [];
        if (scopeTools && typeof scopeTools.get === 'function') {
          for (const name of supplied) {
            try {
              if (scopeTools.get(name, agent)) verified.push(name);
              else verifyFailed.push(name);
            } catch (err) {
              verifyFailed.push(`${name}(回查抛错:${(err && err.message) || err})`);
            }
          }
        }
        probe.supplied = supplied;
        probe.verified = verified;
        probe.failed = failed;
        if (verifyFailed.length > 0) probe.verifyFailed = verifyFailed;
        const key = agent && agent.session ? agent.session.id : undefined;
        if (key !== undefined) scopedToolDisposers.set(key, disposers);
        log(`阶段工具已供给 ${disposers.length} 个：${list.filter((n) => TOOL_SPECS.has(n)).join('、')}；回查可见 ${verified.length}/${supplied.length}。`);
        finishProbe({});
        return true;
      } catch (err) {
        log(`阶段工具供给失败：${(err && err.message) || err}`);
        finishProbe({ error: String((err && err.message) || err) });
        return false;
      }
    }
    /** 取某状态 goal 的可见集（与门禁同一份名单：看得见 = 调得动）。 */
    function visibleToolsForGoal(goalRef) {
      try {
        if (!goalRef) return [];
        const def = goalEngine.get(goalRef);
        if (!def) return [];
        return [...goalEngine.allowedToolSet(def)];
      } catch (_e) {
        return [];
      }
    }
    // 工具注册已按域下沉到 lib/tools/*（行为不变）；这里只做装配。
    // 注册顺序与下沉前一致（feature-intent 后段随首段提前注册，仅影响枚举顺序）。
    const toolDeps = { ctx, workspaceOf, collectUserWords, intentWriteKey, grantBypass, activateStateGoal, defaultWorkspace, registerTool, registryFor, submitGoalTool, presetActionSkills, storesFor, latestEntry };
    registerWorkflowTools(toolDeps);

    registerPresetActionTools(toolDeps);

    registerFeatureIntentTools(toolDeps);
    registerPatternTools(toolDeps);

    // ── architecture（结构层）写入：专用 reason 自查 + 有界写入 ────────────
    // 与行为模式同构：先 architecture_reason 完成必要性自查，再 architecture_write。
    // reason 只存 state 与 architecture.audit.md，绝不写入 architecture.md。
    registerArchitectureTools(toolDeps);

    // ── 上下文压缩（ACCUMULATE 收尾动作）────────────────────────────────
    // 顺序门禁：必须先完成长期文档整理（pattern_reason + pattern_write）才允许压缩。
    // 压缩 hot loopMemory，并尽力压缩 harness 旧会话；结果写入 state.compression。
    registerAccumulationTools(toolDeps);


    registerGitTools(toolDeps);


    // ── mode command ─────────────────────────────────────────────────────
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'mode',
        description: 'select a mode-gate workflow by id',
        input: { hint: '<workflow-id>' },
        recordInput: false,
        handler: async ({ agent, rawInput }) => {
          const workflowId = String(rawInput || '').trim();
          if (!workflowId) {
            const registry = registryFor(agent);
            const list = registry.listForModal().map((wf) => `- ${wf.id}: ${wf.label}`).join('\n');
            return { kind: 'success', text: `可用工作流：\n${list}` };
          }
          const registry = registryFor(agent);
          const wf = registry.get(workflowId);
          if (!wf) return { kind: 'error', text: `未知工作流 ${workflowId}` };
          const activated = await activateStateGoal(agent, workflowId, wf.startState);
          return {
            kind: 'success',
            text: `已静默进入 ${wf.label}（${workflowId} / ${wf.startState}）。${activated && activated.prompt ? `\n当前阶段：${activated.prompt}` : ''}`,
          };
        },
      });
      // 与同名 tool 共用实现（连字符名：DSH 命令名不支持下划线）。
      commandCtx.commands.register({
        name: 'goto-accumulation',
        description: '手动进入 ACCUMULATION 沉淀流程（仅 CREATE 工作流）',
        input: { hint: '无参数，直接执行' },
        recordInput: false,
        handler: async ({ agent }) => {
          try {
            const result = await doGotoAccumulation(agent);
            return { kind: 'success', text: result.message };
          } catch (err) {
            return { kind: 'error', text: (err && err.message) || String(err) };
          }
        },
      });
      commandCtx.commands.register({
        name: 'accumulation-and-init',
        description: '手动沉淀并初始化：先整理长期文档，再压缩，最后进入 INIT（仅 CREATE 工作流）',
        input: { hint: '无参数，直接执行' },
        recordInput: false,
        handler: async ({ agent }) => {
          try {
            const result = await doAccumulationAndInit(agent);
            return { kind: 'success', text: result.message };
          } catch (err) {
            return { kind: 'error', text: (err && err.message) || String(err) };
          }
        },
      });
      // /skip-mode：强制跳过当前阶段。不推进 staticPlan、不追加 loopMemory，
      // 直接以 goalCompleted 走正常转移表（绕过 submitTool 的 requiredCalls 校验）。
      commandCtx.commands.register({
        name: 'skip-mode',
        description: '强制跳过当前阶段：不做本阶段工作，直接进入转移表决定的下一状态（仅工作流内可用）',
        input: { hint: '无参数，直接执行' },
        recordInput: false,
        handler: async ({ agent }) => {
          try {
            const state = readState(agent);
            if (!state || state.workflowId === 'IDLE' || state.phase === 'IDLE') {
              return { kind: 'error', text: '当前不在工作流内，无阶段可跳过。' };
            }
            const from = `${state.workflowId}/${state.phase}`;
            await completeGoal(agent, { signal: { goalCompleted: true }, statePatch: {}, prompt: '（用户强制跳过当前阶段）' });
            const next = readState(agent);
            return { kind: 'success', text: `已从 ${from} 强制跳过，当前：${next.workflowId}/${next.phase}。` };
          } catch (err) {
            return { kind: 'error', text: (err && err.message) || String(err) };
          }
        },
      });
      // /init：初始化仓库长期记忆。不需要用户指令，完全依靠库本身：
      // inspect 全库（依赖图 + package.json），幂等填充 architecture.md 的
      // 模块职责/依赖方向/entrypoints 三节，以及 feature 概览（features.md）
      // 与各明细（features/<id>.md，来源为各 feature intent 最新条目）。
      // 只补空缺：已存在非空内容一律不覆盖，只报告。
      commandCtx.commands.register({
        name: 'init',
        description: '初始化仓库长期记忆：inspect 全库并填充 architecture.md 与 feature 概览+明细，只补空缺不覆盖',
        input: { hint: '无参数，直接执行' },
        recordInput: false,
        handler: async ({ agent }) => {
          try {
            const report = await initRepositoryMemory(agent);
            return { kind: 'success', text: report };
          } catch (err) {
            return { kind: 'error', text: (err && err.message) || String(err) };
          }
        },
      });
      // /grant：把工具授权给 agent。不带参数时列出全部可用工具（客户端会把这个
      // 命令挂成下拉选择列表，见 client.js 的 commandUi contribution）。
      // 这是 mode-gate 的**单点豁免入口**：被授权的工具在 pre-execute 的每一处
      // 拒绝分支上都会先命中 grantBypass 而直接放行。
      commandCtx.commands.register({
        name: 'grant',
        description: '把工具授权给 agent：不带参数列出所有可用工具，带工具名则解锁该工具（授权优先于 mode-gate 的一切限制）',
        input: { hint: '<工具名> [更多工具名…] | --revoke [工具名]' },
        recordInput: false,
        handler: async ({ agent, rawInput }) => {
          try {
            return { kind: 'success', text: formatGrantResult(agent, rawInput) };
          } catch (err) {
            return { kind: 'error', text: (err && err.message) || String(err) };
          }
        },
      });
      log('手动沉淀 / 命令已注册：/goto-accumulation、/accumulation-and-init、/skip-mode、/init、/grant');
    });


    // ── tool interception ────────────────────────────────────────────────
    ctx.on('tools/pre-execute', (exec, next) => {
      const name = exec.name;

      // tool-search 白名单优先：即使本阶段「禁止自行解锁新工具」，只要本次
      // tool-search 的查询 / toolNames 命中本阶段「初始命令 / Universal 命令」，
      // 就先实际匹配目录——命中则放行，让真实搜索机制执行；未命中仍禁止。
      // 优先级高于 unlockLocked（如：原本禁 tool-search + 允许 submit-state，
      // 则允许用 tool-search 搜 submit_state）。
      if (name === 'dev_tool_search' && exec.agent) {
        try {
          const searchState = readState(exec.agent);
          if (goalEngine.unlockLocked(searchState) && !grantBypass(searchState, name)) {
            const searchRegistry = registryFor(exec.agent);
            const searchStateDef = searchRegistry.stateOf(searchState.workflowId, searchState.phase);
            const searchSet = resolveStateRestriction(searchState, searchState.workflowId, searchState.phase, searchStateDef);
            const searchStageSet = stageCommandSetFor(searchState.workflowId, searchState.phase);
            const searchStageInitial = searchStageSet && Array.isArray(searchStageSet.initialCommands) ? searchStageSet.initialCommands : [];
            const allowed = [...new Set([
              ...searchStageInitial,
              ...restrictionInjectedCommands(searchSet).initial,
              ...universalCommandsForStage(searchState, searchState.workflowId, searchState.phase, searchStateDef),
            ])];
            const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
            const wanted = Array.isArray(args.toolNames)
              ? args.toolNames.filter((entry) => typeof entry === 'string')
              : [];
            const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
            // 「先实际匹配一下」：拿真实工具目录（agent scope）验证白名单命令确实存在。
            // 目录不可用（拿不到 schemas）时降级为仅按白名单名义匹配：白名单本身就是
            // 本阶段显式声明的命令，不会因此越界放行非白名单工具。
            let catalogNames = null;
            try {
              const schemas = ctx.tools && typeof ctx.tools.schemas === 'function'
                ? (ctx.tools.schemas(exec.agent) || [])
                : [];
              if (Array.isArray(schemas) && schemas.length > 0) {
                catalogNames = new Set(schemas.map((schema) => schema && schema.name).filter(Boolean));
              }
            } catch (_e) {
              catalogNames = null;
            }
            const existsInCatalog = (entry) => (catalogNames === null ? true : catalogNames.has(entry));
            // 命中方式一：toolNames 里直接点名了白名单命令（精确匹配），且该工具在目录中存在。
            const exactHit = wanted.filter((entry) => allowed.includes(entry) && existsInCatalog(entry));
            // 命中方式二：query 关键词实际匹配到目录里存在的白名单命令。
            const queryHit = query
              ? allowed.filter((entry) => existsInCatalog(entry)
                && (entry.toLowerCase().includes(query) || query.includes(entry.toLowerCase())))
              : [];
            const hits = [...new Set([...exactHit, ...queryHit])];
            if (hits.length > 0) return next();
            return Promise.resolve({
              kind: 'deny',
              reason: '当前阶段禁止自行解锁新工具，请专心分解需求；完成后调用 submit_state 推进。'
                + (allowed.length > 0 ? `（本阶段初始命令：${allowed.join('、')}，可先用 tool-search 搜它们）` : ''),
            });
          }
        } catch (_err) {
          // 读不到状态时走常规流程，不在这里拦截。
        }
      }

      // 需求识别等阶段会锁定自行解锁新工具的能力：dev_tool_search /
      // request_extra 直接拒绝（必须放在 request_extra 的 ask 分支之前）。
      // submit_state / switch_mode 不受影响，agent 仍可推进阶段。
      if (name === 'request_extra') {
        try {
          const unlockState = exec.agent ? readState(exec.agent) : null;
          // 单独锁定同样受 /grant 豁免：用户显式授权过的解禁工具不再被阶段锁定。
          if (unlockState && goalEngine.unlockLocked(unlockState) && !grantBypass(unlockState, name)) {
            return Promise.resolve({
              kind: 'deny',
              reason: '当前阶段禁止自行解锁新工具，请专心分解需求；完成后调用 submit_state 推进。',
            });
          }
        } catch (_err) {
          // 读不到状态时走常规流程，不在这里拦截。
        }
      }

      if (name === 'switch_mode') {
        const registry = registryFor(exec.agent);
        const workflow = exec.arguments && exec.arguments.workflow;
        const wf = registry.get(workflow);
        if (!wf) return Promise.resolve({ kind: 'deny', reason: `未知工作流 ${String(workflow)}` });
        return Promise.resolve({
          kind: 'ask',
          reason: `是否允许切换到 ${workflow}${exec.arguments && exec.arguments.state ? ` / ${exec.arguments.state}` : ''}？${exec.arguments && exec.arguments.reason ? `原因：${exec.arguments.reason}` : ''}`,
        });
      }

      if (name === 'request_extra') {
        const requestedSkills = Array.isArray(exec.arguments && exec.arguments.skills) ? exec.arguments.skills : [];
        const requestedBash = Array.isArray(exec.arguments && exec.arguments.bash) ? exec.arguments.bash : [];
        if (requestedSkills.length || requestedBash.length) {
          const items = [...requestedSkills.map((s) => `skill: ${s}`), ...requestedBash.map((b) => `bash: ${b}`)].join('、');
          return Promise.resolve({ kind: 'ask', reason: `是否授予以下额外访问？${items}` });
        }
        return next();
      }

      const agent = exec.agent;
      const state = readState(agent);
      const registry = registryFor(agent);
      const stateDef = registry.stateOf(state.workflowId, state.phase);

      if (isFeatureIntentDirectWrite(name, exec.arguments, storesFor(agent).dir) && !grantBypass(state, name)) {
        return Promise.resolve({
          kind: 'deny',
          reason: 'feature_intent 文件禁止直接修改。请使用 update_feature_intent 工具在文件末尾追加记录。',
        });
      }

      if (!stateDef || state.workflowId === IDLE_WORKFLOW_ID) {
        // IDLE is intentionally unrestricted; only the global guards above apply.
        return next();
      }

      // declare_target 机制已移除：不再要求先声明 Target，工具调用不再因此被拦截。
      // state 引用的限制套件：工具 / skill / 命令三层强制执行。
      const restrictionSet = resolveStateRestriction(state, state.workflowId, state.phase, stateDef);
      // 初始命令 / Universal 命令白名单优先：命中即放行（相当于该阶段显式授予），
      // 不受 denyTools / 阶段 tools 白名单 / goal allowedTools 拦截。
      // 白名单 = 阶段命令 Set 的 initialCommands ∪ 限制套件的 initial/universal。
      const stageCmdSet = stageCommandSetFor(state.workflowId, state.phase);
      const stageInitialHit = Boolean(stageCmdSet && Array.isArray(stageCmdSet.initialCommands)
        && stageCmdSet.initialCommands.includes(name));
      const injectedWhitelist = stageInitialHit
        || Boolean(restrictionSet && isToolWhitelistedByInjection(restrictionSet, name));
      if (injectedWhitelist && !grantBypass(state, name)) return next();
      if (restrictionSet && isToolDeniedByRestriction(restrictionSet, name) && !grantBypass(state, name)) {
        return Promise.resolve({ kind: 'deny', reason: `当前阶段引用的限制「${restrictionSet.label || restrictionSet.id}」禁止使用工具 ${name}。` });
      }
      if (restrictionSet && (name === 'skill_load' || name === 'skill')) {
        const requestedSkill = exec.arguments && typeof exec.arguments.name === 'string' ? exec.arguments.name : '';
        if (requestedSkill && isSkillDeniedByRestriction(restrictionSet, requestedSkill) && !grantBypass(state, name)) {
          return Promise.resolve({ kind: 'deny', reason: `当前阶段引用的限制「${restrictionSet.label || restrictionSet.id}」禁止使用 skill "${requestedSkill}"。` });
        }
      }
      const activeGoalDef = goalEngine.defFor(state);
      if (state.goal && state.goal.status === 'active' && activeGoalDef) {
        const allowed = goalEngine.allowedToolSet(activeGoalDef);
        if (!allowed.has(name) && !grantBypass(state, name)) {
          return Promise.resolve({
            kind: 'deny',
            reason: `当前目标 "${activeGoalDef.id}" 进行中，只允许：${[...allowed].join(', ')}。${name} 不在其中；请先完成当前目标或调用 submit_state。`,
          });
        }
      }

      if (name === 'bash' || name === 'pwsh') {
        // 用户 /grant bash 即视为对该工具整体放行：命令黑名单与阶段 bash 策略
        // 都不再由 mode-gate 施加（安全边界交回用户/宿主）。
        if (grantBypass(state, name)) return next();
        const command = String((exec.arguments && exec.arguments.command) || '');
        if (restrictionSet) {
          const hit = matchRestrictionDenyCommand(restrictionSet, command);
          if (hit) {
            return Promise.resolve({ kind: 'deny', reason: `当前阶段引用的限制「${restrictionSet.label || restrictionSet.id}」禁止命令：${command}。${hit.reason || ''}` });
          }
        }
        const decision = bashDecision(command, stateDef, state);
        return decision.kind === 'allow' ? next() : Promise.resolve(decision);
      }

      // declare_target 机制已移除：skill 不再受声明白名单限制。
      // 单点授权豁免：用户 /grant 过的工具直接放行，连 toolDisposition（阶段
      // tools 白名单 + STAGE_GRANTED_TOOLS 压缩/累积保护）也不再施加。
      if (grantBypass(state, name)) return next();
      const decision = toolDisposition(name, stateDef.permissions || {}, `${state.workflowId}/${state.phase}`);
      if (decision.kind === 'deny') return Promise.resolve(decision);

      if (name === 'str_replace_editor' && stateDef.permissions && stateDef.permissions.write === false) {
        if (exec.arguments && exec.arguments.command === 'view') return next();
        if (grantBypass(state, name)) return next();
        return Promise.resolve({ kind: 'deny', reason: `当前状态 ${state.phase} 禁止写工具 str_replace_editor。` });
      }

      return next();
    });

    // ── post-execute: auto complete + dynamic plan mirror ────────────────
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next();
      try {
        const agent = exec && exec.agent;
        const name = exec && exec.name;
        if (!agent || !name) return decision;
        const state = readState(agent);

        if (name === 'todo_write' && result && result.isError !== true && exec.arguments && Array.isArray(exec.arguments.todos)) {
          const currentGoal = state.staticPlan ? staticPlanCurrent(state.staticPlan) : null;
          const dynamicPlan = createDynamicPlan(exec.arguments.todos, state.phase, currentGoal);
          const patch = { dynamicPlan };
          if (state.staticPlan && Array.isArray(state.staticPlan.items)) {
            let changed = false;
            const items = state.staticPlan.items.map((item) => {
              if (item.status === 'completed') return item;
              const match = exec.arguments.todos.find((t) => t && t.content === item.text && t.status === 'completed');
              if (!match) return item;
              changed = true;
              return { ...item, status: 'completed', completedAt: Date.now() };
            });
            if (changed) {
              const next = staticPlanCurrent({ ...state.staticPlan, items });
              patch.staticPlan = { ...state.staticPlan, items, currentId: next ? next.id : null };
            }
          }
          writeState(agent, patch);
        }

        if (result && result.isError !== true) recordStateRequirementProgress(agent, exec, result);

        const def = goalEngine.defFor(state);
        if (!def) return decision;
        if (!(result && result.isError === true)) {
          const beforeCount = (state.goal && state.goal.toolCount) || 0;
          const recorded = goalEngine.recordCall(state, name);
          if (recorded !== state) {
            writeState(agent, { goal: recorded.goal });
            const afterCount = (recorded.goal.toolCount) || 0;
            if (beforeCount < 10 && afterCount >= 10) void injectModeGateContext(agent, 'toolCount');
          }
        }
        if (result && result.isError === true) return decision;
        const after = readState(agent);
        const afterStateDef = registryFor(agent).stateOf(after.workflowId, after.phase);
        if (unmetStateRequirements(after, afterStateDef).length === 0 && goalEngine.isAutoCompleted(after, def)) {
          const raw = await goalEngine.autoComplete(after, envFor(agent, after));
          if (raw) await completeGoal(agent, raw);
        }
      } catch (err) {
        log(`post-execute 目标推进失败：${(err && err.message) || err}`);
      }
      return decision;
    });

    // ── feature-intent approval: sending a user message rejects the pending protocol ──
    // ── user-input collection: non-IDLE user messages become the auto user_words ──
    // ── INIT 闸门：AI 完全禁言（create 工作流）────────────────────────────
    // INIT 是纯「引擎 + UI」驱动的闸门阶段：用户在“工作流”界面从 feature 树里挑选
    // overview / feature intent，引擎负责注入 architecture.md / code-map 并推进阶段。
    // 因此本阶段 AI 一律不运行：任何用户消息都在 pre-step 处被拦下、零输出；用户原话
    // 仍照常记入 state.userInputs，供走出闸门后的需求分解阶段使用。
    ctx.on('agent/pre-step', ({ agent }, next) => {
      try {
        const state = readState(agent);
        if (state.workflowId === 'create' && state.phase === 'INIT') {
          return { kind: 'reject' };
        }
        // 需求协议禁言闸门（对标 INIT 闸门）：协议提交待确认期间 agent 完全禁言。
        // 不限工作流：pendingProtocol.status === 'awaiting_user' 本身即是条件。
        // 接受走 UI（Remote approve，不经过 agent）；拒绝走发消息（见下方
        // agent/inbox/spliced 分支：禁言后 user/message 不再产生，在那里触发拒绝）。
        if (state.pendingProtocol && state.pendingProtocol.status === 'awaiting_user') {
          return { kind: 'reject' };
        }
      } catch (err) {
        log(`INIT 禁言判定失败：${(err && err.message) || err}`);
      }
      // 政策只在阶段激活时注入一次（activateStateGoal / agent 创建恢复），
      // 步里不再补投：全量政策塞进每一步 token 开销太大。
      return next();
    });

    // INIT 闸门期间 pre-step 直接 reject：消息会被从 inbox 里移除，不会产生
    // user/message 事件，所以用户原话只能在 agent/inbox/spliced 里捞。
    // 两个事件都可能带上同一条消息，用 rpcId 去重，保证 userInputs 不重复。
    const capturedUserMessages = new Set();
    function captureUserText(sessionId, text, source) {
      const clean = String(text || '').trim();
      if (!clean) return;
      const entry = readSessionEntry(sessionId);
      // 与既有行为一致：IDLE（没进任何工作流）不收集原话。
      if (!entry.workflowId || entry.workflowId === 'IDLE') return;
      const rpcId = source && typeof source.rpcId === 'string' ? source.rpcId : '';
      if (rpcId) {
        const key = `${sessionId}:${rpcId}`;
        if (capturedUserMessages.has(key)) return;
        capturedUserMessages.add(key);
      } else {
        const list = entry.userInputs || [];
        if (list[list.length - 1] === clean) return;
      }
      writeState(agentFor(sessionId), { userInputs: [...(entry.userInputs || []), clean] });
    }

    ctx.on('session/event', (session, event) => {
      try {
        if (!event) return;
        const sessionId = typeof session === 'string'
          ? session
          : (session && (session.id ?? session.sessionId));
        if (typeof sessionId !== 'string') return;
        if (event.type === 'user/message') {
          const source = event.data && event.data.source;
          if (!source || source.kind !== 'user') return;
          captureUserText(sessionId, extractUserText(event), source);
        } else if (event.type === 'agent/inbox/spliced') {
          // INIT / 协议禁言路径：用户消息被 pre-step reject 拦下、从 inbox 移除，不会产生
          // user/message 事件；不在这里捞，需求分解阶段就读不到「用户原话」。
          const data = event.data && typeof event.data === 'object' ? event.data : {};
          if (data.target !== 'next-turn' || !Array.isArray(data.inserted)) return;
          let sawUserMessage = false;
          for (const item of data.inserted) {
            const source = item && item.source;
            if (!source || source.kind !== 'user') continue;
            captureUserText(sessionId, extractUserText({ data: item }), source);
            sawUserMessage = true;
          }
          // 禁言后 user/message 事件不再产生：等待确认期间用户发消息，
          // 在这里视为拒绝待确认协议（与 user/message 分支同语义），回到 RR 继续改需求。
          if (sawUserMessage) {
            const entry = readSessionEntry(sessionId);
            if (entry && entry.pendingProtocol) {
              rejectPendingProtocol(sessionId)
                .then((result) => log(`禁言期间用户发送消息，已拒绝待确认需求协议：${sessionId} -> ${result && result.workflowId}/${result && result.phase}`))
                .catch((err) => log(`拒绝待确认需求协议失败：${(err && err.message) || err}`));
            }
          }
          return;
        } else if (event.type === 'request/context') {
          // harness 只在路由/容量变化时记录一次真实容量：自带压缩点表只覆盖少数
          // 已查证模型，表外模型（如 deepseek-v4.1-flash）必须靠这里补上窗口，
          // 否则设置页显示的「默认/生效压缩点」与实际决策都会停在 180k。
          const data = event.data && typeof event.data === 'object' ? event.data : {};
          modelWindowCache.rememberRoute({
            provider: data.provider,
            model: data.model,
            contextWindow: data.contextWindow,
          });
          return;
        } else {
          return;
        }
        const entry = readSessionEntry(sessionId);
        if (!entry || !entry.pendingProtocol) return;
        rejectPendingProtocol(sessionId)
          .then((result) => log(`用户发送消息，已拒绝待确认需求协议：${sessionId} -> ${result && result.workflowId}/${result && result.phase}`))
          .catch((err) => log(`拒绝待确认需求协议失败：${(err && err.message) || err}`));
      } catch (err) {
        log(`session/event 处理失败：${(err && err.message) || err}`);
      }
    });

    // ── per-agent model override ─────────────────────────────────────────
    // agent 销毁时清理 scope 供给记录（scope 注册随 scope 释放，map 只防泄漏）。
    ctx.on('agent/disposed', ({ agent }) => {
      try {
        clearScopedTools(agent);
        const key = agent && agent.session ? agent.session.id : undefined;
        if (key !== undefined && agents.has(key)) agents.delete(key);
      } catch (_e) { /* 清理绝不抛错 */ }
    });

    ctx.on('agent/created', ({ agent }) => {
      try {
        if (agent && agent.session && agent.session.id !== void 0) agents.set(agent.session.id, agent);
        // 新 agent 按当前状态补一次 scope 供给（中途接入/恢复会话时生效）。
        try {
          const state = readState(agent);
          const registry = registryFor(agent);
          const stateDef = registry.stateOf(state.workflowId, state.phase);
          const goalRef = stateDef && stateDef.goal && stateDef.goal.ref;
          provisionStageTools(agent, goalRef ? visibleToolsForGoal(goalRef) : []);
        } catch (_e) { /* 供给失败不阻塞创建，沿用手动解锁路径 */ }
        // 恢复/中途接入的会话：立刻备好一份政策（阶段激活时的一次性注入）。
        try {
          if (readState(agent).workflowId && readState(agent).workflowId !== 'IDLE') {
            void injectModeGateContext(agent, 'agentCreated');
          }
        } catch (_e) { /* 政策预投失败不阻塞创建 */ }
        const agentCtx = agent && agent.ctx;
        if (!agentCtx || typeof agentCtx.on !== 'function') return;
        agentCtx.on('agent/request', async (_payload, next) => {
          let state = readState(agent);
          // checklist-2：这里原本按 _payload.messages 估算上下文规模，但 agent/request
          // 的 payload 只有 { agent, turn, step, signal }，根本没有 messages / model /
          // contextWindow，估算恒为空、contextUsage 永远停在 0。上下文计量改到阶段
          // 转移时由 tokenMeter 实测（见 measureAgentContextTokens），故移除该采样。
          // Safety net for the feature-intent approval gate: a new user message
          // while the protocol is awaiting user confirmation rejects it and
          // re-activates REQUIREMENT_RECOGNITION so the agent can revise.
          if (state.pendingProtocol && state.pendingProtocol.status === 'awaiting_user') {
            const messages = Array.isArray(_payload && _payload.messages) ? _payload.messages : [];
            const last = messages[messages.length - 1];
            const realUser = Boolean(last && last.source && last.source.kind === 'user');
            const userTurn = realUser && Boolean(
              last.role === 'user'
              || last.type === 'user/message'
              || (last.type === 'message' && last.role === 'user')
            );
            if (userTurn && agent && agent.session && typeof agent.session.id === 'string') {
              try {
                await rejectPendingProtocol(agent.session.id);
                state = readState(agent);
              } catch (err) {
                log(`agent/request 自动拒绝待确认协议失败：${(err && err.message) || err}`);
              }
            }
          }
          const selected = state.selectedModel;
          const stateDef = registryFor(agent).stateOf(state.workflowId, state.phase);
          const phaseModel = stateDef && stateDef.model ? stateDef.model : null;
          if (phaseModel) {
            if (phaseModel.provider) _payload.provider = phaseModel.provider;
            if (phaseModel.model) _payload.model = phaseModel.model;
            if (phaseModel.reasoningEffort) _payload.reasoningEffort = phaseModel.reasoningEffort;
          }
          if (selected) {
            if (selected.provider) _payload.provider = selected.provider;
            if (selected.model) _payload.model = selected.model;
            if (selected.reasoningEffort) _payload.reasoningEffort = selected.reasoningEffort;
          }
          const phaseOverride = stateModelOverride(state, state.workflowId, state.phase);
          if (phaseOverride) {
            let resolvedThinking = '';
            if (phaseOverride.model) {
              const resolved = resolveStageModel(phaseOverride.model);
              _payload.provider = (resolved && resolved.provider) || 'deepseek-official';
              _payload.model = (resolved && resolved.model) || phaseOverride.model;
              if (resolved && resolved.thinking) resolvedThinking = resolved.thinking;
            }
            if (phaseOverride.reasoningEffort) _payload.reasoningEffort = phaseOverride.reasoningEffort;
            else if (resolvedThinking) _payload.reasoningEffort = resolvedThinking;
          }
          return next();
        });
      } catch (err) {
        log(`安装 agent/request 覆盖失败：${(err && err.message) || err}`);
      }
    });

    new ModeGateGateway(ctx, {
      registryForWorkspace,
      defaultWorkspace,
      modelWindowCache,
      getAgent: (sessionId) => agents.get(sessionId),
      activateStateGoal,
      approveRequirementProtocol: approvePendingProtocol,
      rejectRequirementProtocol: rejectPendingProtocol,
      goalEngine,
      buildAutoGuide,
      restrictions,
      listGrantableTools,
      grantedToolsFor: (agent) => grantedToolsOf(readState(agent)),
      grantTools,
      treeForSession,
      layoutForSession,
      recordFeatureTreeProbe,
      submitFeatureSelection,
    });
  },
};
