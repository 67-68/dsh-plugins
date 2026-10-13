// Remote gateway — extracted from lib/index.js (behavior unchanged).
// Instantiated in apply() with workspace/engine callbacks (see index.js).
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { existsSync, statSync } from "node:fs";
import { normalizeDenyList } from "../engine/bash.js";
import {
  loadStateStore,
  normalizeModelAliases,
  normalizeModelCatalog,
  normalizeRequirements,
  normalizeStageCommandSets,
  normalizeStageOverrides,
  normalizeUniversalCommands,
  normalizeWorkflowOverrides,
  readSessionEntry,
  saveStateStore,
  stageIdFor,
  WORKFLOW_REASONING_EFFORTS,
} from "../engine/state.js";
import {
  effectiveCompressionPoint,
  MODEL_COMPRESSION_TABLE,
  normalizeCompressionOverrides,
} from "../services/model-compression.js";
import {
  BUILTIN_RESTRICTION_SETS,
  BUILTIN_STAGE_COMMAND_SETS,
  getRestrictionOrBuiltin,
} from "../stores/restrictions.js";

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
  /**
   * /grant 下拉的数据源：列出当前会话可授权的工具及已授权集合。
   * 走 Remote 是因为下拉选项必须由客户端在打开面板时拉取（见 client.js）。
   */
  async getGrantableTools(args) {
    const sessionId = args && args.sessionId;
    const agent = (this.options.getAgent ? this.options.getAgent(sessionId) : null)
      || { session: { id: sessionId, header: { cwd: readSessionEntry(sessionId).workspace } } };
    const tools = typeof this.options.listGrantableTools === 'function'
      ? this.options.listGrantableTools(agent)
      : [];
    const granted = typeof this.options.grantedToolsFor === 'function'
      ? this.options.grantedToolsFor(agent)
      : [];
    return { ok: true, tools, granted };
  }
  /** 客户端下拉选中后调用：把工具授权给该会话。 */
  async grantTool(args) {
    const sessionId = args && args.sessionId;
    const names = args && args.tools;
    const agent = (this.options.getAgent ? this.options.getAgent(sessionId) : null)
      || { session: { id: sessionId, header: { cwd: readSessionEntry(sessionId).workspace } } };
    if (typeof this.options.grantTools !== 'function') {
      return { ok: false, error: 'mode-gate 尚未初始化 grantTools' };
    }
    return this.options.grantTools(agent, names, { allowUnknown: false });
  }
  async getBashDenyList() {
    // 与 index.js 顶层同名 helper 同逻辑（内联避免跨层引用）。
    return { entries: normalizeDenyList(loadStateStore().bashDenyList) };
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
    const cache = this.options.modelWindowCache || null;
    /** 自带表条目 + 实测观测到的窗口，两者合成一行。 */
    const rowFor = ({ modelId, provider, contextWindow, sourceUrl, note }) => {
      const observed = Number.isFinite(contextWindow) ? contextWindow : null;
      const builtin = effectiveCompressionPoint(modelId, observed, {});
      const effective = effectiveCompressionPoint(modelId, observed, overrides);
      return {
        modelId,
        provider,
        contextWindow: observed,
        defaultPoint: builtin.point,
        point: effective.point,
        origin: effective.origin,
        label: effective.label,
        sourceUrl: sourceUrl || '',
        note: note || '',
      };
    };
    const seen = new Set();
    const table = MODEL_COMPRESSION_TABLE.map((entry) => {
      seen.add(entry.modelId);
      // 自带表里窗口为空的条目（当前没有）优先用实测值补全。
      const contextWindow = Number.isFinite(entry.contextWindow)
        ? entry.contextWindow
        : (cache ? cache.windowFor(entry.modelId) : null);
      return rowFor({ ...entry, contextWindow });
    });
    // 表外模型（实际在用的路由）：设置页必须也能看到它们的窗口与默认压缩点，
    // 否则用户只能看到一个 180k 的假默认值。
    if (cache) {
      for (const entry of cache.entries()) {
        if (seen.has(entry.modelId)) continue;
        seen.add(entry.modelId);
        table.push(rowFor({
          modelId: entry.modelId,
          provider: entry.provider || '-',
          contextWindow: entry.contextWindow,
          sourceUrl: '',
          note: '窗口来自实际路由（request/context）',
        }));
      }
    }
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
  /**
   * 限制套件编辑器「初始命令 / Universal 命令」下拉的数据源：
   * 返回当前会话可见的工具名 + 描述（内置 + 插件 + 已供给的 scope 工具）。
   */
  async getCommandCatalog(args) {
    const sessionId = args && args.sessionId;
    const agent = (this.options.getAgent ? this.options.getAgent(sessionId) : null)
      || { session: { id: sessionId, header: { cwd: readSessionEntry(sessionId).workspace } } };
    const tools = typeof this.options.listGrantableTools === 'function'
      ? this.options.listGrantableTools(agent)
      : [];
    return { ok: true, tools };
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
  /**
   * 全局 Universal 注入命令（设置-工作流页编辑，对所有工作流所有 state 生效）。
   * 限制套件里显式声明了非空 universalCommands 则覆盖它，否则继承这里。
   */
  async getUniversalCommands() {
    const store = loadStateStore();
    return { ok: true, commands: normalizeUniversalCommands(store.universalCommands) };
  }
  async setUniversalCommands(args) {
    const store = loadStateStore();
    store.universalCommands = normalizeUniversalCommands(args && args.commands);
    saveStateStore(store);
    return { ok: true, commands: store.universalCommands };
  }
    /**
     * 阶段命令 Set 可配置表（设置-限制页展示/编辑）。
     * 返回内置阶段与用户覆盖合并后的全量表，
     * 每行 { key, label, builtinInitial, effectiveInitial, overridden }。
     */
  async getStageCommandSets() {
    const store = loadStateStore();
    const overrides = normalizeStageCommandSets(store.stageCommandSets);
    const rows = Object.entries(BUILTIN_STAGE_COMMAND_SETS).map(([key, builtin]) => {
      const over = overrides[key];
      const builtinInitial = Array.isArray(builtin.initialCommands) ? [...builtin.initialCommands] : [];
      return {
        key,
        label: (over && over.label) || builtin.label || key,
        builtinInitial,
        effectiveInitial: over ? [...over.initialCommands] : builtinInitial,
        overridden: Boolean(over),
      };
    });
    return { ok: true, sets: rows };
  }
  async setStageCommandSet(args) {
    const key = args && typeof args.key === 'string' ? args.key.trim() : '';
    const cleaned = normalizeStageCommandSets({
      [key]: { label: args && args.label, initialCommands: args && args.initialCommands },
    });
    if (!cleaned[key]) throw new Error(`阶段 Set key "${key}" 非法，应为 <workflowId>.<stateId> 形式`);
    const store = loadStateStore();
    const overrides = normalizeStageCommandSets(store.stageCommandSets);
    overrides[key] = cleaned[key];
    store.stageCommandSets = overrides;
    saveStateStore(store);
    return { ok: true, key, set: overrides[key] };
  }
    /** 删除用户覆盖，恢复该阶段的内置 Set。 */
  async deleteStageCommandSet(args) {
    const key = args && typeof args.key === 'string' ? args.key.trim() : '';
    const store = loadStateStore();
    const overrides = normalizeStageCommandSets(store.stageCommandSets);
    delete overrides[key];
    store.stageCommandSets = overrides;
    saveStateStore(store);
    return { ok: true, key };
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
  'getUniversalCommands', 'setUniversalCommands',
  'getStageCommandSets', 'setStageCommandSet', 'deleteStageCommandSet',
  'getWorkflowSettings', 'setWorkflowOverride', 'setStageOverride',
  'approveRequirementProtocol', 'rejectRequirementProtocol',
  // /grant 下拉的数据源与授权入口（客户端 popupSelect 调用）。
  'getGrantableTools', 'grantTool',
  // 限制套件编辑器「初始命令 / Universal 命令」下拉的数据源。
  'getCommandCatalog',
]);

export { ModeGateGateway };
