import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

import { createFeatureIntentStore } from './feature-intent-store.js';
import { createFeatureListStore, defaultFeatureListDir } from './feature-list-store.js';
import { createPatternStore, defaultPatternDir } from './pattern-store.js';
import { createJournalStore, defaultJournalDir } from './journal-store.js';
import { createHistoryStore, defaultHistoryDir } from './history-store.js';
import { readHeadCommit } from './git-commit.js';
import { runGitUpdate } from './git-update.js';
import { createArchitectureStore, defaultArchitecturePath, assertArchitectureReason, assertArchitectureSelfCheckFresh } from './architecture-store.js';
import { generateDependencyMap, MAX_DEPENDENCY_TOKENS } from './dependency-map.js';
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

    const globalDefaultIntentDir = join(homedir(), '.dsh', 'feature_intents');
    const featureIntentDir = expandHome(
      typeof cfg.featureIntentDir === 'string' && cfg.featureIntentDir.trim()
        ? cfg.featureIntentDir.trim()
        : globalDefaultIntentDir,
    );
    const presetActionDir = expandHome(
      typeof cfg.presetActionDir === 'string' && cfg.presetActionDir.trim()
        ? cfg.presetActionDir.trim()
        : join(homedir(), '.dsh', 'preset-actions'),
    );
    const defaultWorkspace = dirname(resolve(featureIntentDir));
    const featureListDir = expandHome(
      typeof cfg.featureListDir === 'string' && cfg.featureListDir.trim()
        ? cfg.featureListDir.trim()
        : defaultFeatureListDir(featureIntentDir),
    );
    const patternDir = expandHome(
      typeof cfg.patternDir === 'string' && cfg.patternDir.trim()
        ? cfg.patternDir.trim()
        : defaultPatternDir(featureIntentDir),
    );
    const journalDir = expandHome(
      typeof cfg.journalDir === 'string' && cfg.journalDir.trim()
        ? cfg.journalDir.trim()
        : defaultJournalDir(featureIntentDir),
    );
    const historyDir = expandHome(
      typeof cfg.historyDir === 'string' && cfg.historyDir.trim()
        ? cfg.historyDir.trim()
        : defaultHistoryDir(featureIntentDir),
    );
    const architecturePath = expandHome(
      typeof cfg.architecturePath === 'string' && cfg.architecturePath.trim()
        ? cfg.architecturePath.trim()
        : defaultArchitecturePath(featureIntentDir),
    );
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

    const featureIntents = createFeatureIntentStore(featureIntentDir);
    const restrictions = createRestrictionStore(restrictionsDir);
    const featureList = createFeatureListStore(featureListDir);
    const patternStore = createPatternStore(patternDir);
    const journal = createJournalStore(journalDir);
    const history = createHistoryStore(historyDir);
    const architecture = createArchitectureStore(architecturePath);
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
      return {
        featureIntents,
        featureList,
        patternStore,
        journal,
        history,
        architecture,
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
      const payload = {
        provider: (resolved && resolved.provider) || 'deepseek-official',
        model: (resolved && resolved.model) || override.model,
        ...(override.reasoningEffort ? { reasoningEffort: override.reasoningEffort } : {}),
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

    async function activateStateGoal(agent, workflowId, stateId) {
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
      if (!goalRef) {
        const isIdle = workflowId === 'IDLE' || stateId === 'IDLE';
        const prompt = effectiveStatePrompt(state, workflowId, stateId, stateDef) || `当前状态：${stateId}`;
        writeState(agent, {
          ...basePatch,
          goal: null,
          target: isIdle ? null : { target: prompt, mode: stateId },
        });
        applyStateModelSelection(agent, workflowId, stateId);
        void injectModeGateContext(agent, 'state');
        return { prompt, messages: [] };
      }
      const result = await goalEngine.activate(goalRef, envFor(agent, state), state);
      const targetText = result.prompt || effectiveStatePrompt(state, workflowId, stateId, stateDef) || stateId;
      writeState(agent, { ...basePatch, ...result.statePatch, target: { target: targetText, mode: stateId } });
      applyStateModelSelection(agent, workflowId, stateId);
      void injectModeGateContext(agent, 'state');
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
      return activateStateGoal(agent, nextWorkflow, nextState);
    }

    async function buildPendingProtocolDisplay(agent, parsed) {
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
      const stagePrompt = effectiveStatePrompt(state, state.workflowId, state.phase, stateDef);
      const awaitingUser = Boolean(state.pendingProtocol && state.pendingProtocol.status === 'awaiting_user');
      const autoGuide = !awaitingUser && autoGuideEnabled(state, state.workflowId, state.phase, stateDef)
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
      text: () => {
        try {
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
    ctx.tools.register(defineTool({
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
    }));

    ctx.tools.register(defineTool({
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
    }));

    ctx.tools.register(defineTool({
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
    }));

    ctx.tools.register(defineTool({
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
    }));

    ctx.tools.register(defineTool({
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
    }));

    ctx.tools.register(defineTool({
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
    }));

    ctx.tools.register(defineTool({
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
    }));

    ctx.tools.register(defineTool({
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
    }));

    ctx.tools.register(defineTool({
      name: 'list_feature_intents',
      description: '列出 feature intent 目录下的所有需求意图文件。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute() {
        const intents = await featureIntents.list();
        return JSON.stringify({ ok: true, dir: featureIntents.dir, intents }, null, 2);
      },
    }));

    ctx.tools.register(defineTool({
      name: 'get_feature_intent',
      description: '读取指定的 feature intent 文件内容。',
      parameters: { name: { type: 'string', required: true, description: 'feature intent 文件名（不带目录，可选 .md 后缀）。' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args) {
        const resolved = featureIntents.get(args.name);
        return JSON.stringify({ ok: true, name: resolved.name, file: resolved.file, path: resolved.path, content: resolved.content }, null, 2);
      },
    }));

    ctx.tools.register(defineTool({
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
        return JSON.stringify({ ok: true, ...result, message: `已追加到 ${result.file}${result.created ? '（新建文件）' : ''}` }, null, 2);
      },
    }));

    // ── behavior-pattern self-check（专用自查 skill）──────────────────────
    // 写入行为模式前必须先提交 reason 完成「这是否是用户强调/纠正过的模式」自查。
    // reason 只存在 state 里用于审计，绝不写入 patterns 目标文件。
    const MAX_PATTERNS_PER_ROUND = 3;
    ctx.tools.register(defineTool({
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
    }));

    // ── journal（冷层）：进展流水的落点 ───────────────────────────────────
    ctx.tools.register(defineTool({
      name: 'journal_append',
      description: '把进展流水写入 journal 冷层（不进入 hot 上下文）。行为模式拒绝进展流水时会指向这里。',
      parameters: {
        project: { type: 'string', description: '项目名；省略时使用当前 feature intent 文件名。' },
        text: { type: 'string', required: true, description: '进展内容。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        const state = readState(exec.agent);
        const project = (typeof args.project === 'string' && args.project.trim()) || state.featureIntentFile || '';
        if (!project) throw new Error('无法确定 project：请传 project 参数，或先完成 feature intent 记录。');
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text) throw new Error('journal 内容不能为空。');
        const result = journal.append(project, text);
        return JSON.stringify({ ok: true, ...result }, null, 2);
      },
    }));

    ctx.tools.register(defineTool({
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
    }));

    ctx.tools.register(defineTool({
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
    }));

    ctx.tools.register(defineTool({
      name: 'pattern_list',
      description: '只读当前项目行为模式热文件（一行一条规则摘要）：ACCUMULATE 检查已有规则是否过期时使用，不读明细、不读短期对话。',
      parameters: {
        project: { type: 'string', description: '项目名；省略时使用当前 feature intent 文件名。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        const state = readState(exec.agent);
        const project = (typeof args.project === 'string' && args.project.trim()) || state.featureIntentFile;
        if (!project) throw new Error('无法确定 project：请传 project 参数，或先完成 feature intent 记录。');
        const rows = patternStore.list(project);
        if (!rows.length) return `（${project} 热文件暂无规则）`;
        return rows.map((row) => `- [${row.id}] ${row.body}`).join('\n');
      },
    }));
    ctx.tools.register(defineTool({
      name: 'pattern_audit',
      description: '查看行为模式的变更记录（audit 冷文件）：create / rationale / retire / replace 的完整流水。',
      parameters: {
        project: { type: 'string', description: '项目名；省略时使用当前 feature intent 文件名。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        const state = readState(exec.agent);
        const project = (typeof args.project === 'string' && args.project.trim()) || state.featureIntentFile;
        if (!project) throw new Error('无法确定 project：请传 project 参数，或先完成 feature intent 记录。');
        const text = patternStore.readAudit(project);
        return text || `（${project} 暂无变更记录）`;
      },
    }));

    // ── architecture（结构层）写入：专用 reason 自查 + 有界写入 ────────────
    // 与行为模式同构：先 architecture_reason 完成必要性自查，再 architecture_write。
    // reason 只存 state 与 architecture.audit.md，绝不写入 architecture.md。
    ctx.tools.register(defineTool({
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
    }));

    ctx.tools.register(defineTool({
      name: 'architecture_write',
      description: '写入 architecture.md。必须先在本 goal 激活期调用 architecture_reason 提交 reason，否则拒绝。mode=section 只更新一个结构 section（推荐），mode=replace 整篇替换。写入前校验 ≤120 行/约 1000 tokens 且不混入进展流水；reason 只写 audit，不写文档。',
      parameters: {
        mode: { type: 'string', enum: ['section', 'replace'], description: 'section（默认）更新单节；replace 整篇替换。' },
        section: { type: 'string', description: 'mode=section 时要 upsert 的 section（id 或中文标题，如 modules / 模块职责）。' },
        content: { type: 'string', required: true, description: 'mode=section 时为该节正文；mode=replace 时为整篇 architecture.md 内容。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
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
    }));

    ctx.tools.register(defineTool({
      name: 'architecture_audit',
      description: '查看 architecture.md 的变更记录（audit 冷文件）：每次写入的时间、行数/tokens 与 reason。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute() {
        const text = architecture.readAudit();
        return text || '（architecture.md 暂无变更记录）';
      },
    }));

    // ── 按需轻量依赖图（代码导航）────────────────────────────────────────
    // 不常驻注入；只在调用时生成，单次输出硬上限 1024 tokens。
    ctx.tools.register(defineTool({
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
    }));

    // ── 上下文压缩（ACCUMULATE 收尾动作）────────────────────────────────
    // 顺序门禁：必须先完成长期文档整理（pattern_reason + pattern_write）才允许压缩。
    // 压缩 hot loopMemory，并尽力压缩 harness 旧会话；结果写入 state.compression。
    ctx.tools.register(defineTool({
      name: 'compress_context',
      description: 'ACCUMULATE 的上下文压缩（专用）。必须先完成长期文档整理（pattern_reason + pattern_write）才能调用。压缩后引擎会进入 INIT。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(_args, exec) {
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
    }));

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

    // ── 手动压缩触发（用户显式要求时调用，常控工具，各阶段可用）────────
    // goto_accumulation：跳入 ACCUMULATION，走正常沉淀流程（长期文档整理 +
    // compress_context + submit_state → INIT）。
    ctx.tools.register(defineTool({
      name: 'goto_accumulation',
      description: '手动触发压缩：跳入 ACCUMULATION 阶段，走正常沉淀流程（先整理长期文档，再 compress_context，最后 submit_state 进入 INIT）。仅 CREATE 工作流可用。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(_args, exec) {
        return JSON.stringify(await doGotoAccumulation(exec.agent), null, 2);
      },
    }));

    // accumulation_and_init：先沉淀后初始化（用户显式要求时使用；
    // 压缩后峰值重置，下一轮重新累积）。
    // 顺序与 ACCUMULATE 一致：必须先完成长期文档整理（pattern_reason +
    // pattern_write），再压缩，最后进入 INIT。还没整理时报错提示先整理，
    // 可先调 goto_accumulation 逐步沉淀，或补完文档整理后重试本工具。
    ctx.tools.register(defineTool({
      name: 'accumulation_and_init',
      description: '手动沉淀并初始化：先整理长期文档（pattern_reason + pattern_write），再压缩上下文，然后进入 INIT。用户显式要求压缩时使用。仅 CREATE 工作流可用。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(_args, exec) {
        return JSON.stringify(await doAccumulationAndInit(exec.agent), null, 2);
      },
    }));

    ctx.tools.register(defineTool({
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
    }));

    ctx.tools.register(defineTool({
      name: 'finish_feature',
      description: '完成一个功能：必须提供真实证据（例如验证命令与结果）。系统会置 status=done、记录完成时间，并自动读取当前 HEAD 的 commit hash 写入功能列表。',
      parameters: {
        feature_id: { type: 'string', description: 'feature id；省略时使用当前 feature intent 文件名。' },
        evidence: { type: 'string', required: true, description: '真实证据，例如验证命令、测试输出或可核对的结论。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
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
    }));

    ctx.tools.register(defineTool({
      name: 'git_commit',
      description: 'Git 更新（checklist-15）：每轮更新用本工具完成 git add -A + commit + push，输出可审计 update，并把 commit hash 自动写入功能列表。Agent 不要直接执行 git 修改命令。',
      parameters: {
        message: { type: 'string', description: 'commit message；省略时按当前 feature 与 checklist goal 自动生成。' },
        feature_id: { type: 'string', description: '要回填 commit 的 feature id；省略时使用当前 feature intent 文件名。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
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
    }));

    ctx.tools.register(defineTool({
      name: 'get_feature',
      description: '独立查看入口：按 feature id 返回索引行与完整详情（user_visible_behavior / feature_intent / 完成证据等）。',
      parameters: {
        feature_id: { type: 'string', description: 'feature id；省略时使用当前 feature intent 文件名。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
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
    }));

    ctx.tools.register(defineTool({
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
    }));

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
      log('手动沉淀 / 命令已注册：/goto-accumulation、/accumulation-and-init');
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

      if (isFeatureIntentDirectWrite(name, exec.arguments, featureIntents.dir)) {
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
    ctx.on('session/event', (session, event) => {
      try {
        if (!event || event.type !== 'user/message') return;
        const source = event.data && event.data.source;
        if (!source || source.kind !== 'user') return;
        const sessionId = typeof session === 'string'
          ? session
          : (session && (session.id ?? session.sessionId));
        if (typeof sessionId !== 'string') return;
        const entry = readSessionEntry(sessionId);
        const text = extractUserText(event);
        if (text && entry.workflowId && entry.workflowId !== 'IDLE') {
          writeState(agentFor(sessionId), {
            userInputs: [...(entry.userInputs || []), text],
          });
        }
        if (!entry || !entry.pendingProtocol) return;
        rejectPendingProtocol(sessionId)
          .then((result) => log(`用户发送消息，已拒绝待确认需求协议：${sessionId} -> ${result && result.workflowId}/${result && result.phase}`))
          .catch((err) => log(`拒绝待确认需求协议失败：${(err && err.message) || err}`));
      } catch (err) {
        log(`session/event 处理失败：${(err && err.message) || err}`);
      }
    });

    // ── per-agent model override ─────────────────────────────────────────
    ctx.on('agent/created', ({ agent }) => {
      try {
        if (agent && agent.session && agent.session.id !== void 0) agents.set(agent.session.id, agent);
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
            if (phaseOverride.model) {
              const resolved = resolveStageModel(phaseOverride.model);
              _payload.provider = (resolved && resolved.provider) || 'deepseek-official';
              _payload.model = (resolved && resolved.model) || phaseOverride.model;
            }
            if (phaseOverride.reasoningEffort) _payload.reasoningEffort = phaseOverride.reasoningEffort;
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
    });
  },
};
