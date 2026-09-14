import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

import { createFeatureIntentStore } from './feature-intent-store.js';
import { createGoalEngine } from './goal-engine.js';
import { createBuiltinGoals } from './goals.js';
import { createWorkflowRegistry, expandHome, BUILTIN_WORKFLOW_DIR } from './workflows.js';
import { createProjectExperienceStore, defaultProjectExperienceDir } from './project-experience.js';
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
  normalizeModelCatalog,
  normalizeTaskModes,
  normalizeWorkflowOverrides,
  readSessionEntry,
  readState,
  saveStateStore,
  writeState,
} from './state.js';
import {
  ALWAYS_ALLOWED,
  ALLOWED_WITHOUT_TARGET,
  KNOWN_WRITE_TOOLS,
  toolDisposition,
} from './permissions.js';
import {
  classifyCommand,
  extractCommandVerbs,
  isAlwaysAllowedBash,
  matchBashDeny,
  normalizeDenyList,
  undeclaredBashVerbs,
} from './bash.js';
import { modelCatalogText } from './protocols.js';

const CONTROL_TOOLS = new Set([
  'declare_target', 'switch_mode', 'skill_search', 'skill_load', 'request_extra',
  'dev_tool_search', 'submit_state', 'list_workflows', 'get_workflow_state', 'select_workflow',
]);

function firstLine(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const line = value.split(/\r?\n/)[0].trim();
  return line.replace(/^\[目标\]\s*/, '') || line;
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
  async getTaskModes() {
    return { modes: loadStateStore().taskModes };
  }
  async setTaskModes(args) {
    const store = loadStateStore();
    store.taskModes = normalizeTaskModes(args && args.modes);
    saveStateStore(store);
    return { modes: store.taskModes };
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
          const override = (store.workflowOverrides && store.workflowOverrides[wf.id] && store.workflowOverrides[wf.id][state.id]) || {};
          return {
            id: state.id,
            label: state.label || state.id,
            prompt: typeof state.prompt === 'string' ? state.prompt : '',
            goalRef: state.goal && state.goal.ref ? state.goal.ref : null,
            hasTransitions: Array.isArray(state.transitions) && state.transitions.length > 0,
            permissions: state.permissions || null,
            model: typeof override.model === 'string' ? override.model : '',
            reasoningEffort: typeof override.reasoningEffort === 'string'
              ? override.reasoningEffort
              : (state.model && state.model.reasoningEffort ? state.model.reasoningEffort : ''),
          };
        }),
      })),
      overrides: store.workflowOverrides,
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
    if (Object.keys(current).length > 0) wfOverrides[stateId] = current;
    else delete wfOverrides[stateId];
    if (Object.keys(wfOverrides).length > 0) overrides[workflowId] = wfOverrides;
    else delete overrides[workflowId];
    store.workflowOverrides = overrides;
    saveStateStore(store);
    return { ok: true, workflowOverrides: overrides };
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
  'getModelCatalog', 'setModelCatalog',
  'getTaskModes', 'setTaskModes',
  'getWorkflowSettings', 'setWorkflowOverride',
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
    const projectExperienceDir = expandHome(
      typeof cfg.projectExperienceDir === 'string' && cfg.projectExperienceDir.trim()
        ? cfg.projectExperienceDir.trim()
        : (defaultProjectExperienceDir(featureIntentDir)),
    );
    const globalWorkflowDir = expandHome(
      typeof cfg.workflowsDir === 'string' && cfg.workflowsDir.trim()
        ? cfg.workflowsDir.trim()
        : join(homedir(), '.dsh', 'workflows'),
    );

    const featureIntents = createFeatureIntentStore(featureIntentDir);
    const projectExperience = createProjectExperienceStore(projectExperienceDir);
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

    try {
      ctx.skills.register({
        name: 'project-experience',
        description: '一次性读取项目 project-experience 的系统拓扑、血泪法则、核心状态树。',
        source: 'mode-gate',
        invocation: { modelInvocable: true, userInvocable: true },
        content: [
          '# project-experience',
          '',
          '调用 `read_project_experience` 工具一次性获取当前项目的 intro / 系统拓扑 / 血泪法则 / 核心状态树。',
          '省略 `project` 参数时会自动选择唯一项目，或在多个项目时列出候选。',
        ].join('\n'),
      });
    } catch (err) {
      log(`注册 project-experience skill 失败：${(err && err.message) || err}`);
    }

    // ── goal engine ──────────────────────────────────────────────────────
    const goalEngine = createGoalEngine({ goals: createBuiltinGoals(), log });

    function envFor(agent, state) {
      return {
        featureIntents,
        projectExperience,
        presetActionSkills,
        registry: registryFor(agent),
        workspace: workspaceOf(agent, defaultWorkspace),
        modelCatalog: state ? state.modelCatalog : loadStateStore().modelCatalog,
        taskModes: state ? state.taskModes : loadStateStore().taskModes,
        agent,
        ctx,
        log,
      };
    }

    /** Effective per-state prompt: user override wins, then workflow JSON. */
    function stateOverride(state, workflowId, stateId) {
      const overrides = state && state.workflowOverrides && typeof state.workflowOverrides === 'object'
        ? state.workflowOverrides
        : {};
      const wf = overrides[workflowId];
      return wf && wf[stateId] ? wf[stateId] : null;
    }

    function modelEntryForId(modelId) {
      if (!modelId) return null;
      const catalog = loadStateStore().modelCatalog || [];
      return catalog.find((entry) => entry && entry.id === modelId) || null;
    }

    function stateModelOverride(state, workflowId, stateId) {
      const override = stateOverride(state, workflowId, stateId);
      if (!override) return null;
      const model = typeof override.model === 'string' && override.model.trim() ? override.model.trim() : '';
      const reasoningEffort = typeof override.reasoningEffort === 'string' ? override.reasoningEffort.trim() : '';
      if (!model && !reasoningEffort) return null;
      return { model, reasoningEffort };
    }

    /** Persist a per-state model selection so the client model selector follows immediately. */
    function applyStateModelSelection(agent, workflowId, stateId) {
      if (!agent || !agent.session || typeof agent.session.append !== 'function') return;
      const state = readState(agent);
      const override = stateModelOverride(state, workflowId, stateId);
      if (!override || !override.model) return;
      const entry = modelEntryForId(override.model);
      const payload = {
        provider: (entry && entry.provider) || 'deepseek-official',
        model: override.model,
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
      const basePatch = {
        workflowId,
        phase: stateId,
        mode: stateId,
        workspace: workspaceOf(agent, defaultWorkspace),
        dynamicPlan: { scope: 'state', stateId, items: [], updatedAt: Date.now() },
        pendingProtocol: null,
      };
      if (!goalRef) {
        const prompt = effectiveStatePrompt(state, workflowId, stateId, stateDef) || `当前状态：${stateId}`;
        writeState(agent, { ...basePatch, goal: null, target: { target: prompt, mode: stateId } });
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
      const { nextWorkflow, nextState, loopIncrement, complete } = resolveTransition({
        state,
        stateDef,
        workflowDef: wf,
        signal,
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
      });
      return activateStateGoal(agent, nextWorkflow, nextState);
    }

    async function buildPendingProtocolDisplay(agent, parsed) {
      let fields = { userWords: '', understanding: '', checklist: [] };
      try {
        const file = await featureIntents.get(parsed.featureIntentFile);
        fields = extractEntryFields(latestEntry(file.content));
      } catch (err) {
        log(`读取 feature intent 以生成待确认协议失败：${(err && err.message) || err}`);
      }
      return {
        taskMode: parsed.taskMode,
        summary: parsed.summary,
        featureIntentFile: parsed.featureIntentFile,
        model: parsed.model,
        userWords: fields.userWords,
        understanding: fields.understanding,
        checklist: fields.checklist,
      };
    }

    async function submitGoalTool(agent, toolName, args) {
      const before = readState(agent);
      const submitted = await goalEngine.submit(toolName, args, before, envFor(agent, before));
      if (!submitted.ok) throw new Error(submitted.reason);
      const { result, parsed } = submitted;
      if (toolName === 'submit_requirement_protocol') {
        const display = await buildPendingProtocolDisplay(agent, parsed);
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
      if (toolName === 'submit_state' && (before.phase === 'ACCUMULATION' || (before.workflowId === 'rough' && before.phase === 'IMPLEMENT'))) {
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
            content: [{ type: 'text', text: '需求协议已通过，请现在开始执行当前阶段的工作：先调用 declare_target 声明 Target，然后按阶段目标推进。' }],
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
      const missing = undeclaredBashVerbs(command, state.bash);
      if (missing.length) {
        return {
          kind: 'deny',
          reason: `当前 bash 命令使用了未声明的命令动词：${missing.join(', ')}。完整命令：${command}。请调用 dev_tool_search（或 request_extra）申请额外 bash 命令，或在 declare_target 中补充声明。`,
        };
      }
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
        `当前 Target：${state.target && state.target.target ? firstLine(state.target.target) : '未声明'}`,
        `已声明 skills：${state.skills.length ? state.skills.join(', ') : '（无）'}`,
        `已声明 bash 命令：${state.bash.length ? state.bash.join(', ') : '（无）'}`,
        '规则：',
        '- 工作流状态下，每次行动前必须先调用 declare_target 声明 Target。',
        '- 未声明就调用的 skill_load / bash 命令会被拦截；需要时调用 dev_tool_search（或 request_extra）申请。',
        '- 始终可用：skill_search、switch_mode、dev_tool_search / request_extra、submit_state。',
        '当前禁止的 bash 命令：',
        denyList.length ? denyList.map((entry) => `  - ${entry.commands.join(', ')}：${entry.reason || '已禁止'}`).join('\n') : '  （无）',
      ];
      if (awaitingUser) {
        lines.push('', '当前有需求协议正在等待用户确认。请停止工具调用，等待用户在“工作流”界面点击“接受”，或发送消息以修改需求。');
      }
      if (stagePrompt) lines.push('', '当前阶段说明：', stagePrompt);
      if (autoGuide) lines.push('', autoGuide);
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
        lines.push(...plan.items.map((item) => `  - [${item.status === 'completed' ? 'x' : ' '}] ${item.id}: ${item.text}`));
        if (current) lines.push(`当前 checklist goal：${current.id}`);
      }
      const dynamic = state.dynamicPlan;
      if (dynamic && Array.isArray(dynamic.items) && dynamic.items.length > 0) {
        const goalLabel = dynamic.goalId ? `（goal: ${dynamic.goalId}）` : '';
        lines.push('', `当前动态计划${goalLabel}（本状态内有效，状态切换时清空）：`);
        lines.push(...dynamic.items.map((item) => `  - [${item.status === 'completed' ? 'x' : item.status === 'in_progress' ? '~' : ' '}] ${item.content}`));
      }
      const memory = state.loopMemory;
      if (wf && wf.memory && Array.isArray(wf.memory.injectAtStates) && wf.memory.injectAtStates.includes(state.phase)
        && memory && Array.isArray(memory.blocks) && memory.blocks.length > 0) {
        lines.push('', `Loop Memory（iteration=${memory.iteration || 0}）：`);
        lines.push(...memory.blocks.slice(-8).map((block) => `  - [${block.iteration}] ${block.text}${block.stamp ? `（${block.stamp}）` : ''}`));
      }
      if (state.migrationNotice) lines.push('', `迁移提示：${state.migrationNotice}`);
      return lines.join('\n');
    }

    ctx.systemPrompt.context({
      name: 'mode-gate:policy',
      order: 95,
      text: (assembleCtx) => buildModeGatePolicyText(assembleCtx && assembleCtx.agent),
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
    ctx.tools.register(defineTool({
      name: 'declare_target',
      description: '声明当前任务目标（Target），并同时声明本次需要的 skills 和 bash 命令。工作流状态下必须在其他工具调用之前使用。',
      parameters: {
        target: { type: 'string', required: true, description: '任务目标/任务名。' },
        mode: { type: 'string', description: '可选，预期状态 id。' },
        skills: { type: 'array', items: { type: 'string' }, description: '本次需要的 skill 名称列表。' },
        bash: { type: 'array', items: { type: 'string' }, description: '本次需要的 bash 命令动词列表。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        const agent = exec.agent;
        if (agent === void 0) throw new Error('declare_target 需要 agent 上下文');
        const before = readState(agent);
        const skills = Array.isArray(args.skills) ? args.skills.filter((s) => typeof s === 'string' && s.trim()) : [];
        const bash = Array.isArray(args.bash) ? args.bash.filter((s) => typeof s === 'string' && s.trim()) : [];
        writeState(agent, {
          target: { target: args.target, mode: args.mode || before.phase },
          skills,
          bash,
          workspace: workspaceOf(agent, defaultWorkspace),
        });
        const state = readState(agent);
        const registry = registryFor(agent);
        const stateDef = registry.stateOf(state.workflowId, state.phase);
        const hasPending = Boolean(state.pendingProtocol);
        let goalPrompt = '';
        if (!hasPending && stateDef && stateDef.goal && (!state.goal || state.goal.status !== 'active')) {
          const activated = await activateStateGoal(agent, state.workflowId, state.phase);
          goalPrompt = activated && activated.prompt ? activated.prompt : '';
        } else if (state.goal && state.goal.status === 'active' && state.goal.prompt) {
          goalPrompt = state.goal.prompt;
        }
        let refreshed = readState(agent);
        if (goalPrompt) {
          writeState(agent, { target: { target: goalPrompt, mode: refreshed.phase } });
          refreshed = readState(agent);
        }
        return [
          formatCapabilities(refreshed),
          goalPrompt ? `\n当前目标提示：\n${goalPrompt}` : '',
        ].join('\n').trim();
      },
    }));

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
        return `已静默切换到 ${args.workflow_id} / ${stateId}。请先调用 declare_target。${activated && activated.prompt ? `\n当前阶段：${activated.prompt}` : ''}`;
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
        if (!presetActionSkills.length) return '（暂无 preset action）';
        return JSON.stringify(presetActionSkills.map((skill) => ({
          id: skill.id, name: skill.name, title: skill.title, description: skill.description,
          match: skill.match, model: skill.model, reasoning_effort: skill.reasoningEffort, content: skill.content,
        })), null, 2);
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
        return JSON.stringify({ dir: featureIntents.dir, intents }, null, 2);
      },
    }));

    ctx.tools.register(defineTool({
      name: 'get_feature_intent',
      description: '读取指定的 feature intent 文件内容。',
      parameters: { name: { type: 'string', required: true, description: 'feature intent 文件名（不带目录，可选 .md 后缀）。' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args) {
        const resolved = featureIntents.get(args.name);
        return JSON.stringify({ name: resolved.name, file: resolved.file, path: resolved.path, content: resolved.content }, null, 2);
      },
    }));

    ctx.tools.register(defineTool({
      name: 'update_feature_intent',
      description: '向 feature intent 追加一条记录，包含三个 field：用户原话、Agent 理解、可验收 checklist。文件新建时会自动创建 project-experience 文件夹与 intro。',
      parameters: {
        name: { type: 'string', required: true, description: 'feature intent 文件名（不带目录，可选 .md 后缀）。' },
        user_words: { type: 'string', required: true, description: '用户原话（尽量逐字保留）。' },
        understanding: { type: 'string', required: true, description: 'Agent 对需求的理解与拆解。' },
        checklist: { type: 'array', items: { type: 'string' }, required: true, description: '可验收节点，例如「按钮在 xx 处出现」。' },
        project_overview: { type: 'string', description: '仅当文件不存在时必填：项目概述，同时写入 project-experience/intro.md。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args) {
        const checklist = Array.isArray(args.checklist) ? args.checklist.filter((s) => typeof s === 'string' && s.trim()) : [];
        if (checklist.length === 0) throw new Error('checklist 不能为空，请提供至少一个可验收节点。');
        const result = featureIntents.append(
          args.name,
          { userWords: args.user_words, understanding: args.understanding, checklist },
          args.project_overview,
        );
        let project = null;
        if (result.created) {
          project = projectExperience.ensureProject(result.name, args.project_overview);
        }
        return JSON.stringify({ ok: true, ...result, project: project ? project.name : null, message: `已追加到 ${result.file}${result.created ? '（新建文件）' : ''}` }, null, 2);
      },
    }));

    ctx.tools.register(defineTool({
      name: 'submit_requirement_protocol',
      description: '提交需求识别协议。提交后会在“工作流”界面等待用户确认：接受则进入 RESEARCH，发送任意消息则视为拒绝并继续修改需求。',
      parameters: {
        protocol: { type: 'string', required: true, description: '固定为 requirement-recognition。' },
        version: { type: 'number', required: true, description: '固定为 1。' },
        task_mode: { type: 'string', enum: ['simple', 'complex'], required: true, description: 'simple / complex。' },
        model_override: { type: 'object', additionalProperties: true, description: '可选模型覆盖。' },
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

    ctx.tools.register(defineTool({
      name: 'read_project_experience',
      description: '一次性读取 project-experience：intro、系统拓扑、血泪法则、核心状态树。省略 project 时自动选择唯一项目或列出候选。',
      parameters: {
        project: { type: 'string', description: '项目文件夹名，通常与 feature intent 同名。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args) {
        const requested = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : '';
        let project = requested;
        if (!project) {
          const projects = projectExperience.listProjects();
          if (projects.length === 0) throw new Error(`project-experience 目录为空：${projectExperience.root}。请先创建 feature intent 记录。`);
          if (projects.length > 1) {
            return JSON.stringify({ projects: projects.map((p) => p.project), hint: '存在多个项目，请指定 project 参数。' }, null, 2);
          }
          project = projects[0].project;
        }
        const result = projectExperience.readProject(project);
        return JSON.stringify({ ...result, dir: result.dir, files: result.files }, null, 2);
      },
    }));

    ctx.tools.register(defineTool({
      name: 'update_project_experience',
      description: '写入 project-experience。append 直接写入；overwrite / diff 会作为申请提交给用户批准。',
      parameters: {
        project: { type: 'string', description: '项目名；省略时使用当前 feature intent 文件同名项目。' },
        file: { type: 'string', required: true, description: 'intro / mapOfContent / antiPatterns / coreStateTree（或文件名）。' },
        mode: { type: 'string', enum: ['append', 'overwrite', 'diff'], required: true, description: '写入模式。' },
        content: { type: 'string', required: true, description: '要写入的内容。' },
        reason: { type: 'string', description: 'overwrite/diff 时说明修改理由。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        const agent = exec.agent;
        const state = readState(agent);
        const project = (typeof args.project === 'string' && args.project.trim()) || state.featureIntentFile;
        if (!project) throw new Error('无法确定 project：请传 project 参数，或先完成 feature intent 记录。');
        if (args.mode === 'append') {
          return JSON.stringify({ ok: true, ...projectExperience.append(project, args.file, args.content) }, null, 2);
        }
        return JSON.stringify({ ok: true, ...projectExperience.overwrite(project, args.file, args.content) }, null, 2);
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
            text: `已静默进入 ${wf.label}（${workflowId} / ${wf.startState}）。请先调用 declare_target。${activated && activated.prompt ? `\n当前阶段：${activated.prompt}` : ''}`,
          };
        },
      });
    });

    // ── tool interception ────────────────────────────────────────────────
    ctx.on('tools/pre-execute', (exec, next) => {
      const name = exec.name;
      if (name === 'declare_target') return next();

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

      if (name === 'update_project_experience') {
        const mode = exec.arguments && exec.arguments.mode;
        if (mode === 'overwrite' || mode === 'diff') {
          let summary = '';
          try {
            const project = (exec.arguments.project && exec.arguments.project.trim()) || state.featureIntentFile;
            if (project) {
              const d = projectExperience.diff(project, exec.arguments.file, exec.arguments.content);
              summary = `（将删除约 ${d.removed} 行、新增约 ${d.added} 行）`;
            }
          } catch (_err) { /* preview is best-effort */ }
          return Promise.resolve({
            kind: 'ask',
            reason: `是否允许 ${mode} 修改 project-experience/${exec.arguments.file}？${summary}${exec.arguments.reason ? `原因：${exec.arguments.reason}` : ''}`,
          });
        }
      }

      if (!stateDef || state.workflowId === IDLE_WORKFLOW_ID) {
        // IDLE is intentionally unrestricted; only the global guards above apply.
        return next();
      }

      if (!state.target && !CONTROL_TOOLS.has(name) && !ALLOWED_WITHOUT_TARGET.has(name)) {
        return Promise.resolve({ kind: 'deny', reason: '尚未声明 Target。请先调用 declare_target 声明当前任务目标。' });
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
        const decision = bashDecision(command, stateDef, state);
        return decision.kind === 'allow' ? next() : Promise.resolve(decision);
      }

      if (name === 'skill_load' || name === 'skill') {
        const requested = typeof exec.arguments && typeof exec.arguments.name === 'string' ? exec.arguments.name : '';
        if (requested && !state.skills.includes(requested)) {
          return Promise.resolve({
            kind: 'deny',
            reason: `skill "${requested}" 未声明。请先用 skill_search 查看，再用 dev_tool_search（或 request_extra）申请额外 skill。`,
          });
        }
      }

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

        const def = goalEngine.defFor(state);
        if (!def) return decision;
        // Only read_project_experience counts a failed call as a valid attempt
        // (empty project-experience must still allow BASE_READ to submit_state).
        // Other required calls (todo_write, update_feature_intent, ...) must
        // actually succeed before submit_state will accept them.
        const countErrorCall = name === 'read_project_experience';
        if (!(result && result.isError === true) || countErrorCall) {
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
        if (goalEngine.isAutoCompleted(after, def)) {
          const raw = await goalEngine.autoComplete(after, envFor(agent, after));
          if (raw) await completeGoal(agent, raw);
        }
      } catch (err) {
        log(`post-execute 目标推进失败：${(err && err.message) || err}`);
      }
      return decision;
    });

    // ── feature-intent approval: sending a user message rejects the pending protocol ──
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
              const entry = modelEntryForId(phaseOverride.model);
              _payload.provider = (entry && entry.provider) || 'deepseek-official';
              _payload.model = phaseOverride.model;
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
    });
  },
};
