import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

import { createFeatureIntentStore } from './feature-intent-store.js';
import { createFeatureTreeStore, assertLogicalPath, discoverFeatureIntentDirs } from './feature-tree-store.js';
import { createFeatureListStore, defaultFeatureListDir } from './feature-list-store.js';
import { createPatternStore, defaultPatternDir } from './pattern-store.js';
import { createJournalStore, defaultJournalDir } from './journal-store.js';
import { createHistoryStore, defaultHistoryDir } from './history-store.js';
import { readHeadCommit } from './git-commit.js';
import { runGitUpdate } from './git-update.js';
import { createArchitectureStore, defaultArchitecturePath, assertArchitectureReason, assertArchitectureSelfCheckFresh, limitedDigest } from './architecture-store.js';
import { generateDependencyMap, buildDependencyGraph, MAX_DEPENDENCY_TOKENS } from './dependency-map.js';
import { budgetDecision, estimateMessagesTokens, trackContextUsage, resetContextPeak, resolveBudgetModelId } from './context-budget.js';
import { compressContext, assertLongTermDocsFirst } from './context-compressor.js';
import { assertNotProgress, assertReasonValid, assertSelfCheckFresh } from './pattern-gate.js';
import { createGoalEngine } from './goal-engine.js';
import { MODEL_COMPRESSION_TABLE, effectiveCompressionPoint, normalizeCompressionOverrides } from './model-compression.js';
import { createBuiltinGoals } from './goals.js';
import { assertTextLength } from './text-limits.js';
import { createRestrictionStore, getRestrictionOrBuiltin, isSkillDeniedByRestriction, isToolDeniedByRestriction, matchRestrictionDenyCommand, BUILTIN_RESTRICTION_SETS } from './restrictions.js';
import { createWorkflowRegistry, expandHome, BUILTIN_WORKFLOW_DIR } from './workflows.js';
import {
  createDynamicPlan,
  extractEntryFields,
  staticPlanCurrent,
  staticPlanPendingCount,
} from './plans.js';
import { resolveTransition } from './transitions.js';
import {
  IDLE_STATE_ID,
  IDLE_WORKFLOW_ID,
  WORKFLOW_REASONING_EFFORTS,
  formatCapabilities,
  loadStateStore,
  normalizeModelAliases,
  normalizeModelCatalog,
  normalizeRequirements,
  normalizeStageOverrides,
  normalizeWorkflowOverrides,
  readSessionEntry,
  readState,
  resolveModelAlias,
  saveStateStore,
  stageIdFor,
  writeState,
} from './state.js';
import {
  ALWAYS_ALLOWED,
  KNOWN_WRITE_TOOLS,
  toolDisposition,
} from './permissions.js';
import {
  classifyCommand,
  extractCommandVerbs,
  isAlwaysAllowedBash,
  isGitMutation,
  matchBashDeny,
  normalizeDenyList,
} from './bash.js';


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

/** No-decorator Remote marker shim. */
function markRemoteMethods(cls, methodNames) {
  const initializers = [];
  for (const name of methodNames) {
    Remote(name)(undefined, {
      kind: 'method',
      name,
      static: false,
      private: false,
      access: { has: (o) => name in o, get: (o) => o[name] },
      addInitializer: (fn) => { initializers.push(fn); },
    });
  }
  const probe = Object.create(cls.prototype);
  for (const fn of initializers) fn.call(probe);
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

/** Remote service exposing durable mode-gate state and settings payloads. */
class ModeGateGateway extends TypertRemoteService {
  static inject = [];
  constructor(ctx, options) {
    super(ctx, 'modeGate');
    this.options = options || {};
  }
  async getState(args) {
    const sessionId = args && args.sessionId;
    const entry = readSessionEntry(sessionId);
    const store = loadStateStore();
    const registry = this.options.registryForWorkspace(entry.workspace || this.options.defaultWorkspace || null);
    const wf = registry.get(entry.workflowId);
    const states = (wf && Array.isArray(wf.states) ? wf.states : []).map((state) => ({
      id: state.id,
      label: state.label || state.id,
    }));
    return {
      workflowId: entry.workflowId,
      phase: entry.phase,
      mode: entry.phase,
      target: entry.target,
      goal: entry.goal,
      staticPlan: entry.staticPlan,
      dynamicPlan: entry.dynamicPlan,
      loopMemory: entry.loopMemory,
      selectedModel: entry.selectedModel,
      featureIntentFile: entry.featureIntentFile,
      chosenPresetAction: entry.chosenPresetAction,
      workspace: entry.workspace || null,
      modelCatalog: store.modelCatalog,
      modelAliases: store.modelAliases || [],
      pendingProtocol: entry.pendingProtocol,
      workflow: wf
        ? { id: wf.id, label: wf.label || wf.id, states, phaseIndex: states.findIndex((state) => state.id === entry.phase) }
        : null,
    };
  }
  async getWorkflows(args) {
    const sessionId = args && args.sessionId;
    const entry = readSessionEntry(sessionId);
    const registry = this.options.registryForWorkspace(entry.workspace || this.options.defaultWorkspace || null);
    return {
      workspace: entry.workspace || this.options.defaultWorkspace || null,
      workflows: registry.listForModal().map((wf) => ({
        id: wf.id,
        label: wf.label,
        description: wf.description,
        ui: wf.ui || {},
        startState: wf.startState,
      })),
    };
  }
  // feature intent 树属于「每个项目自己的文件」：store 必须按 session 的
  // workspace 解析，不能用一个全局目录（否则换个项目就看不到 / 串项目）。
  featureTreeFor(sessionId) {
    if (typeof this.options.treeForSession !== 'function') return null;
    return this.options.treeForSession(sessionId);
  }
  /** 记录最近一次 getFeatureTree 的解析结果（写入 state.featureTreeProbe，供排查空树）。 */
  recordFeatureTreeProbe(summary) {
    if (typeof this.options.recordFeatureTreeProbe === 'function') this.options.recordFeatureTreeProbe(summary);
  }
  async getFeatureTree(args) {
    const sessionId = args && args.sessionId;
    console.log('[dsh-mode-gate] [feature-tree] getFeatureTree 调用：sessionId=' + (typeof sessionId === 'string' ? sessionId : '(非字符串:' + typeof sessionId + ')'));
    if (!sessionId) {
      const error = '缺少 sessionId：feature 树按会话所属项目解析。若界面是旧版前端（浏览器缓存了插件的 client bundle），请硬刷新页面（Cmd+Shift+R）后重试。';
      console.log(`[dsh-mode-gate] [feature-tree] 缺少 sessionId，直接报错（多半是前端拿不到当前会话，或旧 bundle 没传 sessionId）。`);
      this.recordFeatureTreeProbe({ sessionId: null, source: 'none', liveCwd: null, entryWorkspace: null, workspace: null, mode: null, flat: null, pinned: false, dir: null, storeDir: null, storeDirExists: false, roots: [], treeSize: 0, error });
      return { ok: false, error };
    }
    const store = this.featureTreeFor(sessionId);
    const layout = typeof this.options.layoutForSession === 'function' ? this.options.layoutForSession(sessionId) : null;
    let storeDirExists = false;
    try {
      const d = store ? store.dir : null;
      storeDirExists = typeof d === 'string' && d.length > 0 && existsSync(d) && statSync(d).isDirectory();
    } catch (_err) { /* 探测失败即视为不存在 */ }
    const base = {
      sessionId,
      source: layout ? layout.source : 'none',
      liveCwd: layout ? layout.liveCwd : null,
      entryWorkspace: layout ? layout.entryWorkspace : null,
      workspace: layout ? layout.workspace : null,
      mode: layout && !layout.flat ? 'mounts' : 'flat',
      flat: layout ? Boolean(layout.flat) : null,
      pinned: Boolean(layout && layout.pinned),
      dir: store ? store.dir : null,
      storeDir: store ? store.dir : null,
      storeDirExists,
      roots: layout ? layout.rels || [] : [],
    };
    console.log(`[dsh-mode-gate] [feature-tree] 解析结果：source=${base.source} liveCwd=${base.liveCwd} entryWorkspace=${base.entryWorkspace} workspace=${base.workspace} mode=${base.mode} pinned=${base.pinned} storeDir=${base.storeDir} storeDirExists=${storeDirExists} roots=${JSON.stringify(base.roots)}`);
    if (!store) {
      const error = '无法确定该会话的项目目录（session 里没有 workspace），请先进入 CREATE 工作流。';
      console.log(`[dsh-mode-gate] [feature-tree] store 为空（workspace 解析失败），报错。`);
      this.recordFeatureTreeProbe({ ...base, treeSize: 0, error });
      return { ok: false, error };
    }
    try {
      const tree = store.tree();
      console.log(`[dsh-mode-gate] [feature-tree] 取树成功：顶层节点数=${tree.length}。`);
      this.recordFeatureTreeProbe({ ...base, treeSize: tree.length, error: null });
      return {
        ok: true,
        dir: store.dir,
        mode: base.mode,
        workspace: layout ? layout.workspace : '',
        pinned: Boolean(layout && layout.pinned),
        roots: base.roots,
        tree,
      };
    } catch (err) {
      const error = String((err && err.message) || err);
      console.log(`[dsh-mode-gate] [feature-tree] 取树抛错：${error}`);
      this.recordFeatureTreeProbe({ ...base, treeSize: 0, error });
      return { ok: false, error };
    }
  }
  async getFeatureNode(args) {
    const store = this.featureTreeFor(args && args.sessionId);
    if (!store) return { ok: false, error: 'feature tree store 未初始化' };
    try {
      const type = args && args.type === 'overview' ? 'overview' : 'intent';
      const path = args && args.path;
      return { ok: true, ...store.contentOf(type, path) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }
  async createFeatureNode(args) {
    const store = this.featureTreeFor(args && args.sessionId);
    if (!store) return { ok: false, error: 'feature tree store 未初始化' };
    try {
      const kind = args && args.kind === 'overview' ? 'overview' : 'intent';
      const parent = args && typeof args.parent === 'string' ? args.parent.trim() : '';
      const name = args && args.name;
      const body = args && args.body;
      const result = kind === 'overview'
        ? store.createOverview(parent, name, body)
        : store.createIntent(parent, name, body);
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }
  async submitFeatureSelection(args) {
    const sessionId = args && args.sessionId;
    const selection = Array.isArray(args && args.selection) ? args.selection : [];
    if (typeof this.options.submitFeatureSelection !== 'function') {
      return { ok: false, error: 'mode-gate 尚未初始化 submitFeatureSelection' };
    }
    return this.options.submitFeatureSelection(sessionId, selection);
  }
  async selectWorkflow(args) {
    const sessionId = args && args.sessionId;
    const workflowId = args && args.workflowId;
    const stateId = (args && args.stateId) || null;
    const entry = readSessionEntry(sessionId);
    const registry = this.options.registryForWorkspace(entry.workspace || this.options.defaultWorkspace || null);
    const wf = registry.get(workflowId);
    if (!wf) return { ok: false, error: `未知工作流 ${String(workflowId)}` };
    const start = stateId || wf.startState;
    const stateDef = registry.stateOf(workflowId, start);
    if (!stateDef) return { ok: false, error: `工作流 ${workflowId} 不存在状态 ${start}` };
    const agent = this.options.getAgent ? this.options.getAgent(sessionId) : null
      || { session: { id: sessionId, header: { cwd: entry.workspace } } };
    if (typeof this.options.activateStateGoal !== 'function') {
      return { ok: false, error: 'mode-gate 尚未初始化 activateStateGoal' };
    }
    const activated = await this.options.activateStateGoal(agent, workflowId, start);
    return { ok: true, workflowId, state: start, ...(activated && activated.prompt ? { prompt: activated.prompt } : {}) };
  }
  async getBashDenyList() {
    return { entries: readBashDenyList() };
  }
  async setBashDenyList(args) {
    const store = loadStateStore();
    store.bashDenyList = normalizeDenyList(args && args.entries);
    saveStateStore(store);
    return { entries: store.bashDenyList };
  }
  async getModelCatalog() {
    return { entries: loadStateStore().modelCatalog };
  }
  async setModelCatalog(args) {
    const store = loadStateStore();
    store.modelCatalog = normalizeModelCatalog(args && args.entries);
    saveStateStore(store);
    return { entries: store.modelCatalog };
  }
  async getModelAliases() {
    return { entries: loadStateStore().modelAliases || [] };
  }
  async getModelCompressionTable() {
    const overrides = loadStateStore().compressionOverrides || {};
    const table = MODEL_COMPRESSION_TABLE.map((entry) => {
      const builtin = effectiveCompressionPoint(entry.modelId, entry.contextWindow, {});
      const effective = effectiveCompressionPoint(entry.modelId, entry.contextWindow, overrides);
      return {
        modelId: entry.modelId,
        provider: entry.provider,
        contextWindow: entry.contextWindow,
        defaultPoint: builtin.point,
        point: effective.point,
        origin: effective.origin,
        label: effective.label,
        sourceUrl: entry.sourceUrl || '',
        note: entry.note || '',
      };
    });
    return { table, overrides };
  }
  async getCompressionOverrides() {
    return { overrides: loadStateStore().compressionOverrides || {} };
  }
  async setCompressionOverrides(args) {
    const store = loadStateStore();
    store.compressionOverrides = normalizeCompressionOverrides(args && args.overrides);
    saveStateStore(store);
    return { overrides: store.compressionOverrides };
  }
  async setModelAliases(args) {
    const store = loadStateStore();
    store.modelAliases = normalizeModelAliases(args && args.entries);
    saveStateStore(store);
    return { entries: store.modelAliases };
  }
  async getRestriction(args) {
    return getRestrictionOrBuiltin(this.options.restrictions, args && args.id);
  }
  async getRestrictions() {
    const sets = await this.options.restrictions.list();
    const seen = new Set(sets.map((entry) => entry && entry.id));
    for (const builtin of Object.values(BUILTIN_RESTRICTION_SETS)) {
      if (!seen.has(builtin.id)) sets.push({ ...builtin, builtin: true });
    }
    sets.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return { sets };
  }
  async setRestriction(args) {
    return await this.options.restrictions.save(args && args.set);
  }
  async deleteRestriction(args) {
    return await this.options.restrictions.remove(args && args.id);
  }
  async getWorkflowSettings() {
    const registry = this.options.registryForWorkspace(this.options.defaultWorkspace || null);
    const store = loadStateStore();
    return {
      workspace: this.options.defaultWorkspace || null,
      workflows: registry.list().map((wf) => ({
        id: wf.id,
        label: wf.label,
        description: wf.description,
        kind: wf.kind,
        startState: wf.startState,
        states: (wf.states || []).map((state) => {
          const stageId = stageIdFor(wf.id, state.id);
          const stageOverride = (store.stageOverrides && store.stageOverrides[stageId]) || {};
          const legacyOverride = (store.workflowOverrides && store.workflowOverrides[wf.id] && store.workflowOverrides[wf.id][state.id]) || {};
          const override = { ...legacyOverride, ...stageOverride };
          const defaultAuto = Boolean(state.goal || (Array.isArray(state.transitions) && state.transitions.length > 0));
          const goalEngine = this.options.goalEngine;
          const goalRef = state.goal && state.goal.ref ? state.goal.ref : null;
          const goalDef = goalEngine && typeof goalEngine.get === 'function' ? goalEngine.get(goalRef) : null;
          const builtinRequirements = goalDef && Array.isArray(goalDef.requiredCalls)
            ? goalDef.requiredCalls.map((req) => ({ kind: 'skill', name: req.tool, requireTrueField: false, trueField: 'ok' }))
            : [];
          const hasOverrideRequirements = Object.prototype.hasOwnProperty.call(override, 'requirements');
          const requirements = normalizeRequirements(
            hasOverrideRequirements
              ? override.requirements
              : (Array.isArray(state.requirements) ? state.requirements : builtinRequirements),
          );
          const autoGuideText = typeof this.options.buildAutoGuide === 'function'
            ? this.options.buildAutoGuide(state, goalDef)
            : '';
          return {
            id: state.id,
            stageId,
            label: state.label || state.id,
            description: typeof state.description === 'string' ? state.description : '',
            prompt: typeof override.prompt === 'string' ? override.prompt : (typeof state.prompt === 'string' ? state.prompt : ''),
            autoGuide: typeof override.autoGuide === 'boolean' ? override.autoGuide : defaultAuto,
            ignorePrompt: override.ignorePrompt === true,
            autoGuideText,
            goalRef: state.goal && state.goal.ref ? state.goal.ref : null,
            hasTransitions: Array.isArray(state.transitions) && state.transitions.length > 0,
            permissions: state.permissions || null,
            model: typeof override.model === 'string' ? override.model : '',
            reasoningEffort: typeof override.reasoningEffort === 'string'
              ? override.reasoningEffort
              : (state.model && state.model.reasoningEffort ? state.model.reasoningEffort : ''),
            requirements,
          };
        }),
      })),
      overrides: store.workflowOverrides,
      stageOverrides: store.stageOverrides,
    };
  }
  async setWorkflowOverride(args) {
    const workflowId = args && args.workflowId;
    const stateId = args && args.stateId;
    const patch = args && args.patch;
    if (typeof workflowId !== 'string' || typeof stateId !== 'string' || !patch || typeof patch !== 'object') {
      return { ok: false, error: 'setWorkflowOverride 需要 workflowId / stateId / patch' };
    }
    const registry = this.options.registryForWorkspace(this.options.defaultWorkspace || null);
    const stateDef = registry.stateOf(workflowId, stateId);
    if (!stateDef) return { ok: false, error: `未知状态 ${workflowId} / ${stateId}` };
    const store = loadStateStore();
    const overrides = normalizeWorkflowOverrides(store.workflowOverrides);
    const wfOverrides = { ...(overrides[workflowId] || {}) };
    const current = { ...(wfOverrides[stateId] || {}) };
    if (typeof patch.prompt === 'string') current.prompt = patch.prompt.trim();
    if (typeof patch.autoGuide === 'boolean') current.autoGuide = patch.autoGuide;
    if (typeof patch.model === 'string') {
      const modelId = patch.model.trim();
      if (modelId) current.model = modelId;
      else delete current.model;
    }
    if (patch.reasoningEffort === null || (typeof patch.reasoningEffort === 'string' && patch.reasoningEffort.trim() === '')) {
      delete current.reasoningEffort;
    } else if (typeof patch.reasoningEffort === 'string') {
      const effort = patch.reasoningEffort.trim();
      if (!WORKFLOW_REASONING_EFFORTS.has(effort)) {
        return { ok: false, error: 'reasoningEffort 必须是 high / low / no / max 或空字符串' };
      }
      current.reasoningEffort = effort;
    }
    if (Array.isArray(patch.requirements)) {
      const requirements = normalizeRequirements(patch.requirements);
      if (requirements.length > 0) current.requirements = requirements;
      else delete current.requirements;
    }
    if (typeof patch.restriction === 'string') {
      const ref = patch.restriction.trim();
      if (ref) current.restriction = ref;
      else delete current.restriction;
    }
    if (Object.keys(current).length > 0) wfOverrides[stateId] = current;
    else delete wfOverrides[stateId];
    if (Object.keys(wfOverrides).length > 0) overrides[workflowId] = wfOverrides;
    else delete overrides[workflowId];
    store.workflowOverrides = overrides;
    saveStateStore(store);
    return { ok: true, workflowOverrides: overrides };
  }
  async setStageOverride(args) {
    const stageId = args && args.stageId;
    const patch = args && args.patch;
    if (typeof stageId !== 'string' || stageId.length === 0 || !patch || typeof patch !== 'object') {
      return { ok: false, error: 'setStageOverride 需要 stageId / patch' };
    }
    const store = loadStateStore();
    const stageOverrides = normalizeStageOverrides(store.stageOverrides);
    const current = { ...(stageOverrides[stageId] || {}) };
    if (typeof patch.prompt === 'string') current.prompt = patch.prompt.trim();
    if (typeof patch.autoGuide === 'boolean') current.autoGuide = patch.autoGuide;
    if (typeof patch.model === 'string') {
      const modelId = patch.model.trim();
      if (modelId) current.model = modelId;
      else delete current.model;
    }
    if (patch.reasoningEffort === null || (typeof patch.reasoningEffort === 'string' && patch.reasoningEffort.trim() === '')) {
      delete current.reasoningEffort;
    } else if (typeof patch.reasoningEffort === 'string') {
      const effort = patch.reasoningEffort.trim();
      if (!WORKFLOW_REASONING_EFFORTS.has(effort)) {
        return { ok: false, error: 'reasoningEffort 必须是 high / low / no / max 或空字符串' };
      }
      current.reasoningEffort = effort;
    }
    if (Array.isArray(patch.requirements)) {
      const requirements = normalizeRequirements(patch.requirements);
      if (requirements.length > 0) current.requirements = requirements;
      else delete current.requirements;
    }
    if (typeof patch.restriction === 'string') {
      const ref = patch.restriction.trim();
      if (ref) current.restriction = ref;
      else delete current.restriction;
    }
    if (Object.keys(current).length > 0) stageOverrides[stageId] = current;
    else delete stageOverrides[stageId];
    store.stageOverrides = stageOverrides;
    saveStateStore(store);
    return { ok: true, stageOverrides };
  }

  async approveRequirementProtocol(args) {
    if (typeof this.options.approveRequirementProtocol !== 'function') {
      return { ok: false, error: 'approveRequirementProtocol 未配置' };
    }
    return this.options.approveRequirementProtocol(args && args.sessionId);
  }
  async rejectRequirementProtocol(args) {
    if (typeof this.options.rejectRequirementProtocol !== 'function') {
      return { ok: false, error: 'rejectRequirementProtocol 未配置' };
    }
    return this.options.rejectRequirementProtocol(args && args.sessionId);
  }
}
markRemoteMethods(ModeGateGateway, [
  'getState', 'getWorkflows', 'selectWorkflow',
  'getFeatureTree', 'getFeatureNode', 'createFeatureNode', 'submitFeatureSelection',
  'getBashDenyList', 'setBashDenyList',
  'getModelCatalog', 'setModelCatalog', 'getModelAliases', 'setModelAliases', 'getModelCompressionTable',
  'getCompressionOverrides', 'setCompressionOverrides',
  'getRestrictions', 'getRestriction', 'setRestriction', 'deleteRestriction',
  'getWorkflowSettings', 'setWorkflowOverride', 'setStageOverride',
  'approveRequirementProtocol', 'rejectRequirementProtocol',
]);

export default {
  name: 'mode-gate',
  inject: ['tools', 'systemPrompt', 'skills'],

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

    function registryFor(agent) {
      return registryForWorkspace(workspaceOf(agent, defaultWorkspace));
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
        // 无 goal 的状态（含 IDLE）：只清理 scope，不供给。
        provisionStageTools(agent, []);
        return { prompt, messages: [] };
      }
      const result = await goalEngine.activate(goalRef, envFor(agent, state), state);
      const targetText = result.prompt || effectiveStatePrompt(state, workflowId, stateId, stateDef) || stateId;
      writeState(agent, { ...basePatch, ...result.statePatch, target: { target: targetText, mode: stateId } });
      applyStateModelSelection(agent, workflowId, stateId);
      await injectModeGateContext(agent, 'state');
      // 按本状态 goal 可见集供给 scope 工具（与门禁同一份名单）。
      provisionStageTools(agent, visibleToolsForGoal(goalRef));
      return result;
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
      const peakForBudget = Number.isFinite(usageForBudget.peakTokens) && usageForBudget.peakTokens > 0
        ? usageForBudget.peakTokens
        : usageForBudget.tokens;
      const contextBudget = budgetDecision({
        workflowId: state.workflowId,
        stateId: state.phase,
        contextTokens: peakForBudget,
        modelId: resolveBudgetModelId([
          stageModelForBudget && stageModelForBudget.model ? stageModelForBudget.model : '',
          state.selectedModel && state.selectedModel.model ? state.selectedModel.model : '',
          phaseModelForBudget,
          usageForBudget.modelId,
        ]),
        contextWindow: usageForBudget.contextWindow,
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
        contextBudget: {
          ...contextBudget,
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
      const list = Array.isArray(toolNames) ? toolNames : [];
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
    registerTool({
      name: 'switch_mode',
      description: '请求切换工作流/状态。切换需要用户批准，批准后立即生效。',
      parameters: {
        workflow: { type: 'string', required: true, description: '目标工作流 id，例如 create / simple-action / IDLE。' },
        state: { type: 'string', description: '目标状态 id；省略时使用工作流 startState。' },
        reason: { type: 'string', description: '一句话说明为什么切换。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
    });;

    registerTool({
      name: 'list_workflows',
      description: '列出当前工作区所有可用工作流及其按钮信息。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
    });;

    registerTool({
      name: 'get_workflow_state',
      description: '读取当前会话的 mode-gate 工作流状态（workflow/state/target/checklist/dynamicPlan/loopMemory）。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
    });;

    registerTool({
      name: 'select_workflow',
      description: '从 IDLE 选择并进入一个工作流（等价于 /mode <workflowId>）。',
      parameters: {
        workflow_id: { type: 'string', required: true, description: '工作流 id，例如 create / simple-action。' },
        state: { type: 'string', description: '可选起始状态；省略时使用工作流 startState。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
    });;

    registerTool({
      name: 'submit_state',
      description: '结束当前状态/目标并交给引擎推进（用于研究、执行、调试、总结、preset action 执行）。',
      parameters: {
        summary: { type: 'string', description: '本状态完成了什么的一句话总结。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        const agent = exec.agent;
        if (agent === void 0) throw new Error('submit_state 需要 agent 上下文');
        const result = await submitGoalTool(agent, 'submit_state', args || {});
        const state = readState(agent);
        return JSON.stringify({ ok: true, phase: state.phase, workflowId: state.workflowId, ...(result.prompt ? { prompt: result.prompt } : {}) }, null, 2);
      },
    });;

    registerTool({
      name: 'list_preset_actions',
      description: '列出所有 preset-action 候选 skill 的 id、说明与匹配条件。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute() {
        return JSON.stringify({
          ok: true,
          actions: presetActionSkills.map((skill) => ({
            id: skill.id, name: skill.name, title: skill.title, description: skill.description,
            match: skill.match, model: skill.model, reasoning_effort: skill.reasoningEffort, content: skill.content,
          })),
        }, null, 2);
      },
    });;

    registerTool({
      name: 'submit_preset_action',
      description: '提交 preset-action 探测协议。命中时填写 skill_id；未命中时填写 no_match: true。',
      parameters: {
        skill_id: { type: 'string', description: '命中的 preset action id。' },
        no_match: { type: 'boolean', description: '未命中时填写 true。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        const agent = exec.agent;
        if (agent === void 0) throw new Error('submit_preset_action 需要 agent 上下文');
        const result = await submitGoalTool(agent, 'submit_preset_action', args || {});
        const state = readState(agent);
        return JSON.stringify({ ok: true, phase: state.phase, workflowId: state.workflowId, ...(result.prompt ? { prompt: result.prompt } : {}) }, null, 2);
      },
    });;

    registerTool({
      name: 'list_feature_intents',
      description: '列出 feature intent 目录下的所有需求意图文件。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
    });;

    registerTool({
      name: 'get_feature_intent',
      description: '读取指定的 feature intent 文件内容。',
      parameters: { name: { type: 'string', required: true, description: 'feature intent 文件名（不带目录，可选 .md 后缀）。' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
      // 项目内的长期记忆 store：按 exec.agent 的 workspace 解析。
      const { featureIntents } = storesFor(exec.agent);
        const resolved = featureIntents.get(args.name);
        return JSON.stringify({ ok: true, name: resolved.name, file: resolved.file, path: resolved.path, content: resolved.content }, null, 2);
      },
    });;

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
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
    });;

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
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
    });;

    // ── journal（冷层）：进展流水的落点 ───────────────────────────────────
    registerTool({
      name: 'journal_append',
      description: '把进展流水写入 journal 冷层（不进入 hot 上下文）。行为模式拒绝进展流水时会指向这里。',
      parameters: {
        project: { type: 'string', description: '项目名；省略时使用当前 feature intent 文件名。' },
        text: { type: 'string', required: true, description: '进展内容。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
    });;

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
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
    });;

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
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
    });;

    registerTool({
      name: 'pattern_list',
      description: '只读当前项目行为模式热文件（一行一条规则摘要）：ACCUMULATE 检查已有规则是否过期时使用，不读明细、不读短期对话。',
      parameters: {
        project: { type: 'string', description: '项目名；省略时使用当前 feature intent 文件名。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
    });;
    registerTool({
      name: 'pattern_audit',
      description: '查看行为模式的变更记录（audit 冷文件）：create / rationale / retire / replace 的完整流水。',
      parameters: {
        project: { type: 'string', description: '项目名；省略时使用当前 feature intent 文件名。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
      // 项目内的长期记忆 store：按 exec.agent 的 workspace 解析。
      const { patternStore } = storesFor(exec.agent);
        const state = readState(exec.agent);
        const project = (typeof args.project === 'string' && args.project.trim()) || state.featureIntentFile;
        if (!project) throw new Error('无法确定 project：请传 project 参数，或先完成 feature intent 记录。');
        const text = patternStore.readAudit(project);
        return text || `（${project} 暂无变更记录）`;
      },
    });;

    // ── architecture（结构层）写入：专用 reason 自查 + 有界写入 ────────────
    // 与行为模式同构：先 architecture_reason 完成必要性自查，再 architecture_write。
    // reason 只存 state 与 architecture.audit.md，绝不写入 architecture.md。
    registerTool({
      name: 'architecture_reason',
      description: '写入 architecture.md 前的专用必要性自查。必填 reason，说明本轮为何要沉淀/修改某条稳定结构事实。reason 只用于门禁与审计，不写入 architecture.md。',
      parameters: {
        reason: { type: 'string', required: true, description: '自查结论：为什么这是值得长期沉淀的稳定结构事实（4-200 字，不能是进展流水）。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
    });;

    registerTool({
      name: 'architecture_write',
      description: '写入 architecture.md。必须先在本 goal 激活期调用 architecture_reason 提交 reason，否则拒绝。mode=section 只更新一个结构 section（推荐），mode=replace 整篇替换。写入前校验 ≤120 行/约 1000 tokens 且不混入进展流水；reason 只写 audit，不写文档。',
      parameters: {
        mode: { type: 'string', enum: ['section', 'replace'], description: 'section（默认）更新单节；replace 整篇替换。' },
        section: { type: 'string', description: 'mode=section 时要 upsert 的 section（id 或中文标题，如 modules / 模块职责）。' },
        content: { type: 'string', required: true, description: 'mode=section 时为该节正文；mode=replace 时为整篇 architecture.md 内容。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
    });;

    registerTool({
      name: 'architecture_audit',
      description: '查看 architecture.md 的变更记录（audit 冷文件）：每次写入的时间、行数/tokens 与 reason。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(_args, exec) {
      // 项目内的长期记忆 store：按 exec.agent 的 workspace 解析。
      const { architecture } = storesFor(exec.agent);
        const text = architecture.readAudit();
        return text || '（architecture.md 暂无变更记录）';
      },
    });;

    // ── 按需轻量依赖图（代码导航）────────────────────────────────────────
    // 不常驻注入；只在调用时生成，单次输出硬上限 1024 tokens。
    registerTool({
      name: 'dependency_map',
      description: `按需生成轻量代码依赖图（源码相对 import/require 关系），用于代码导航；单次输出硬上限 ${MAX_DEPENDENCY_TOKENS} tokens，超预算自动截断并提示用 focus 收窄。`,
      parameters: {
        root: { type: 'string', description: '相对 workspace 的扫描根目录；省略时扫描整个 workspace。' },
        focus: { type: 'string', description: '只看与某个路径/模块相关的子图（命中文件及其 1 跳邻居）。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
    });;

    // ── 上下文压缩（ACCUMULATE 收尾动作）────────────────────────────────
    // 顺序门禁：必须先完成长期文档整理（pattern_reason + pattern_write）才允许压缩。
    // 压缩 hot loopMemory，并尽力压缩 harness 旧会话；结果写入 state.compression。
    registerTool({
      name: 'compress_context',
      description: 'ACCUMULATE 的上下文压缩（专用）。必须先完成长期文档整理（pattern_reason + pattern_write）才能调用。压缩后引擎会进入 INIT。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(_args, exec) {
      // 项目内的长期记忆 store：按 exec.agent 的 workspace 解析。
      const { architecture, featureIntents, featureList } = storesFor(exec.agent);
        const agent = exec.agent;
        const state = readState(agent);
        assertLongTermDocsFirst((state.goal && state.goal.calls) || {});
        const result = await compressContext(agent, ctx, state);
        writeState(agent, {
          loopMemory: result.loopMemory,
          compression: result.compression,
          contextUsage: resetContextPeak(readState(agent).contextUsage),
        });
        return JSON.stringify({ ok: true, ...result.compression, message: '上下文压缩完成，可以 submit_state 进入 INIT。' }, null, 2);
      },
    });;

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
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(_args, exec) {
        return JSON.stringify(await doGotoAccumulation(exec.agent), null, 2);
      },
    });;

    // accumulation_and_init：先沉淀后初始化（用户显式要求时使用；
    // 压缩后峰值重置，下一轮重新累积）。
    // 顺序与 ACCUMULATE 一致：必须先完成长期文档整理（pattern_reason +
    // pattern_write），再压缩，最后进入 INIT。还没整理时报错提示先整理，
    // 可先调 goto_accumulation 逐步沉淀，或补完文档整理后重试本工具。
    registerTool({
      name: 'accumulation_and_init',
      description: '手动沉淀并初始化：先整理长期文档（pattern_reason + pattern_write），再压缩上下文，然后进入 INIT。用户显式要求压缩时使用。仅 CREATE 工作流可用。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(_args, exec) {
        return JSON.stringify(await doAccumulationAndInit(exec.agent), null, 2);
      },
    });;

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
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
    });;

    registerTool({
      name: 'finish_feature',
      description: '完成一个功能：必须提供真实证据（例如验证命令与结果）。系统会置 status=done、记录完成时间，并自动读取当前 HEAD 的 commit hash 写入功能列表。',
      parameters: {
        feature_id: { type: 'string', description: 'feature id；省略时使用当前 feature intent 文件名。' },
        evidence: { type: 'string', required: true, description: '真实证据，例如验证命令、测试输出或可核对的结论。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
    });;

    registerTool({
      name: 'git_commit',
      description: 'Git 更新（checklist-15）：每轮更新用本工具完成 git add -A + commit + push，输出可审计 update，并把 commit hash 自动写入功能列表。Agent 不要直接执行 git 修改命令。',
      parameters: {
        message: { type: 'string', description: 'commit message；省略时按当前 feature 与 checklist goal 自动生成。' },
        feature_id: { type: 'string', description: '要回填 commit 的 feature id；省略时使用当前 feature intent 文件名。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
    });;

    registerTool({
      name: 'get_feature',
      description: '独立查看入口：按 feature id 返回索引行与完整详情（user_visible_behavior / feature_intent / 完成证据等）。',
      parameters: {
        feature_id: { type: 'string', description: 'feature id；省略时使用当前 feature intent 文件名。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
    });;

    registerTool({
      name: 'submit_requirement_protocol',
      description: '提交需求识别协议。提交后会在“工作流”界面等待用户确认：接受则进入功能列表更新，随后经 INIT 初始化本轮上下文再进入 RESEARCH；发送任意消息则视为拒绝并继续修改需求。',
      parameters: {
        protocol: { type: 'string', required: true, description: '固定为 requirement-recognition。' },
        version: { type: 'number', required: true, description: '固定为 1。' },
        feature_intent_file: { type: 'string', required: true, description: '本次查看/追加过的 feature intent 文件名。' },
        summary: { type: 'string', required: true, description: '一句话任务摘要。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
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
    });;

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
      log('手动沉淀 / 命令已注册：/goto-accumulation、/accumulation-and-init、/skip-mode、/init');
    });


    // ── tool interception ────────────────────────────────────────────────
    ctx.on('tools/pre-execute', (exec, next) => {
      const name = exec.name;

      // 需求识别等阶段会锁定自行解锁新工具的能力：dev_tool_search /
      // request_extra 直接拒绝（必须放在 request_extra 的 ask 分支之前）。
      // submit_state / switch_mode 不受影响，agent 仍可推进阶段。
      if (name === 'dev_tool_search' || name === 'request_extra') {
        try {
          if (exec.agent && goalEngine.unlockLocked(readState(exec.agent))) {
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

      if (isFeatureIntentDirectWrite(name, exec.arguments, storesFor(agent).dir)) {
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
      if (restrictionSet && isToolDeniedByRestriction(restrictionSet, name)) {
        return Promise.resolve({ kind: 'deny', reason: `当前阶段引用的限制「${restrictionSet.label || restrictionSet.id}」禁止使用工具 ${name}。` });
      }
      if (restrictionSet && (name === 'skill_load' || name === 'skill')) {
        const requestedSkill = exec.arguments && typeof exec.arguments.name === 'string' ? exec.arguments.name : '';
        if (requestedSkill && isSkillDeniedByRestriction(restrictionSet, requestedSkill)) {
          return Promise.resolve({ kind: 'deny', reason: `当前阶段引用的限制「${restrictionSet.label || restrictionSet.id}」禁止使用 skill "${requestedSkill}"。` });
        }
      }
      const activeGoalDef = goalEngine.defFor(state);
      if (state.goal && state.goal.status === 'active' && activeGoalDef) {
        const allowed = goalEngine.allowedToolSet(activeGoalDef);
        if (!allowed.has(name)) {
          return Promise.resolve({
            kind: 'deny',
            reason: `当前目标 "${activeGoalDef.id}" 进行中，只允许：${[...allowed].join(', ')}。${name} 不在其中；请先完成当前目标或调用 submit_state。`,
          });
        }
      }

      if (name === 'bash' || name === 'pwsh') {
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
      const decision = toolDisposition(name, stateDef.permissions || {});
      if (decision.kind === 'deny') return Promise.resolve(decision);

      if (name === 'str_replace_editor' && stateDef.permissions && stateDef.permissions.write === false) {
        if (exec.arguments && exec.arguments.command === 'view') return next();
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
      } catch (err) {
        log(`INIT 禁言判定失败：${(err && err.message) || err}`);
      }
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
          // INIT 禁言路径：用户消息被 pre-step reject 拦下、从 inbox 移除，不会产生
          // user/message 事件；不在这里捞，需求分解阶段就读不到「用户原话」。
          const data = event.data && typeof event.data === 'object' ? event.data : {};
          if (data.target !== 'next-turn' || !Array.isArray(data.inserted)) return;
          for (const item of data.inserted) {
            const source = item && item.source;
            if (!source || source.kind !== 'user') continue;
            captureUserText(sessionId, extractUserText({ data: item }), source);
          }
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
        const agentCtx = agent && agent.ctx;
        if (!agentCtx || typeof agentCtx.on !== 'function') return;
        agentCtx.on('agent/request', async (_payload, next) => {
          let state = readState(agent);
          // checklist-11：记录本次请求的上下文规模估算，供阶段转移时的硬编码预算判定使用。
          const requestMessages = Array.isArray(_payload && _payload.messages) ? _payload.messages : [];
          if (requestMessages.length > 0) {
            const contextTokens = estimateMessagesTokens(requestMessages);
            const payloadModel = _payload && typeof _payload.model === 'string' ? _payload.model : '';
            const payloadWindow = _payload && Number.isFinite(_payload.contextWindow) ? _payload.contextWindow : NaN;
            writeState(agent, {
              contextUsage: trackContextUsage(state.contextUsage, {
                tokens: contextTokens,
                modelId: payloadModel,
                contextWindow: payloadWindow,
                workflowId: state.workflowId,
                stateId: state.phase,
              }),
            });
          }
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
      getAgent: (sessionId) => agents.get(sessionId),
      activateStateGoal,
      approveRequirementProtocol: approvePendingProtocol,
      rejectRequirementProtocol: rejectPendingProtocol,
      goalEngine,
      buildAutoGuide,
      restrictions,
      treeForSession,
      layoutForSession,
      recordFeatureTreeProbe,
      submitFeatureSelection,
    });
  },
};
