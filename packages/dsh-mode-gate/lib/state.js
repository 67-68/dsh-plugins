import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { normalizeCompressionOverrides } from './model-compression.js';

/** Durable mode-gate state file. */
export const STATE_FILE = join(homedir(), '.dsh', 'mode-gate-state.json');

export const IDLE_WORKFLOW_ID = 'IDLE';
export const IDLE_STATE_ID = 'IDLE';

/** User-editable model catalog, persisted top-level in the state file. */
export const DEFAULT_MODEL_CATALOG = [
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek-V4-Flash',
    description: '快速轻量模型，适合简单、明确的机械任务。',
    provider: 'deepseek-official',
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    description: '旗舰模型，适合复杂分析、架构设计与高质量代码。',
    provider: 'deepseek-official',
  },
];

export function normalizeModelCatalog(value) {
  if (!Array.isArray(value)) return DEFAULT_MODEL_CATALOG.map((entry) => ({ ...entry }));
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: typeof entry.name === 'string' ? entry.name.trim() : id,
      description: typeof entry.description === 'string' ? entry.description.trim() : '',
      provider: typeof entry.provider === 'string' && entry.provider.trim() ? entry.provider.trim() : 'deepseek-official',
    });
  }
  return out.length > 0 ? out : DEFAULT_MODEL_CATALOG.map((entry) => ({ ...entry }));
}

/**
 * User-editable codename -> concrete model map, persisted top-level.
 * Each entry: { alias, provider, model }. Workflow stages reference `alias`;
 * the alias is resolved to { provider, model } at model-switch time.
 */
export function normalizeModelAliases(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const alias = typeof entry.alias === 'string' ? entry.alias.trim() : '';
    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : '';
    const model = typeof entry.model === 'string' ? entry.model.trim() : '';
    if (alias.length === 0 || model.length === 0 || seen.has(alias)) continue;
    seen.add(alias);
    out.push({
      alias,
      provider: provider || 'deepseek-official',
      model,
    });
  }
  return out;
}

/** Resolve one alias string to { provider, model }; null when unmapped. */
export function resolveModelAlias(aliases, alias) {
  const key = typeof alias === 'string' ? alias.trim() : '';
  if (!key) return null;
  const list = Array.isArray(aliases) ? aliases : [];
  const hit = list.find((entry) => entry && entry.alias === key);
  return hit ? { provider: hit.provider, model: hit.model } : null;
}

/** User-editable per-state prompt + auto-guide toggle + model override, persisted top-level. */
export const WORKFLOW_REASONING_EFFORTS = new Set(['high', 'low', 'no', 'max']);

/**
 * One stage progress requirement:
 *   { kind: 'file', path }
 *   { kind: 'skill', name, requireTrueField, trueField }
 */
export function normalizeRequirements(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.kind === 'file') {
      const path = typeof raw.path === 'string' ? raw.path.trim() : '';
      if (path.length > 0) out.push({ kind: 'file', path });
      continue;
    }
    if (raw.kind === 'skill') {
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      if (name.length === 0) continue;
      const requireTrueField = raw.requireTrueField === true;
      const rawField = typeof raw.trueField === 'string' ? raw.trueField.trim() : '';
      out.push({
        kind: 'skill',
        name,
        requireTrueField,
        trueField: requireTrueField ? (rawField || 'ok') : '',
      });
    }
  }
  return out;
}

function normalizeOverrideFields(override) {
  const next = {};
  if (!override || typeof override !== 'object') return next;
  if (typeof override.prompt === 'string') next.prompt = override.prompt.trim();
  if (typeof override.autoGuide === 'boolean') next.autoGuide = override.autoGuide;
  if (typeof override.model === 'string' && override.model.trim()) next.model = override.model.trim();
  if (typeof override.reasoningEffort === 'string' && WORKFLOW_REASONING_EFFORTS.has(override.reasoningEffort.trim())) {
    next.reasoningEffort = override.reasoningEffort.trim();
  }
  if (Array.isArray(override.requirements)) next.requirements = normalizeRequirements(override.requirements);
  if (typeof override.restriction === 'string' && override.restriction.trim()) {
    next.restriction = override.restriction.trim();
  }
  return next;
}

/** Stable stage id: `<workflowId>.<stateId>`; a workflow state references one stage definition. */
export function stageIdFor(workflowId, stateId) {
  return `${workflowId}.${stateId}`;
}

export function normalizeStageOverrides(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [stageId, override] of Object.entries(value)) {
    if (typeof stageId !== 'string' || stageId.length === 0) continue;
    const next = normalizeOverrideFields(override);
    if (Object.keys(next).length > 0) out[stageId] = next;
  }
  return out;
}

export function normalizeWorkflowOverrides(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [workflowId, states] of Object.entries(value)) {
    if (!states || typeof states !== 'object') continue;
    const nextStates = {};
    for (const [stateId, override] of Object.entries(states)) {
      const next = normalizeOverrideFields(override);
      if (Object.keys(next).length > 0) nextStates[stateId] = next;
    }
    if (Object.keys(nextStates).length > 0) out[workflowId] = nextStates;
  }
  return out;
}

/**
 * Migrate legacy per-(workflow,state) overrides into stage-scoped overrides.
 * A stage already carrying a different override is a conflict: keep the legacy
 * entry instead of guessing which one wins, so no user config is lost.
 */
export function migrateWorkflowOverridesToStageOverrides(workflowOverrides, stageOverrides) {
  const nextStage = { ...(stageOverrides || {}) };
  const nextLegacy = {};
  for (const [workflowId, states] of Object.entries(workflowOverrides || {})) {
    if (!states || typeof states !== 'object') continue;
    for (const [stateId, override] of Object.entries(states)) {
      const stageId = stageIdFor(workflowId, stateId);
      const existing = nextStage[stageId];
      if (existing === void 0) {
        nextStage[stageId] = { ...override };
        continue;
      }
      if (JSON.stringify(existing) !== JSON.stringify(override)) {
        nextLegacy[workflowId] = { ...(nextLegacy[workflowId] || {}), [stateId]: override };
      }
    }
  }
  return { stageOverrides: nextStage, workflowOverrides: nextLegacy };
}

function emptyStaticPlan() {
  return { source: 'feature-intent.checklist', featureIntentFile: null, items: [], currentId: null, createdAt: 0 };
}

function emptyDynamicPlan() {
  return { scope: 'state', stateId: null, goalId: null, goalText: null, items: [], updatedAt: 0 };
}

function emptyLoopMemory() {
  return { iteration: 0, blocks: [], updatedAt: 0 };
}

/** Map a legacy phase/mode onto a v2 { workflowId, phase }. */
export function migrateLegacyPhase(entry) {
  const raw = String((entry && (entry.phase || entry.mode)) || '').trim().toUpperCase();
  if (entry && typeof entry.workflowId === 'string' && entry.workflowId) {
    return { workflowId: entry.workflowId, phase: raw || IDLE_STATE_ID, migrationNotice: null };
  }
  switch (raw) {
    case 'PRESET_ACTION':
      return { workflowId: 'simple-action', phase: 'PRESET_ACTION', migrationNotice: null };
    case 'REQUIREMENT_RECOGNITION':
      return { workflowId: 'create', phase: 'REQUIREMENT_RECOGNITION', migrationNotice: null };
    case 'IMPLEMENT':
      return {
        workflowId: IDLE_WORKFLOW_ID,
        phase: IDLE_STATE_ID,
        migrationNotice: '旧会话处于已删除的 IMPLEMENT 阶段，已回到 IDLE。请重新选择 CREATE 工作流。',
      };
    default:
      return { workflowId: IDLE_WORKFLOW_ID, phase: IDLE_STATE_ID, migrationNotice: null };
  }
}

/** Normalize one raw session entry into the v2 shape. */
export function normalizeSessionEntry(entry) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const migrated = migrateLegacyPhase(source);
  const goal = source.goal && typeof source.goal === 'object'
    ? { iteration: 0, ...source.goal }
    : null;
  return {
    workflowId: migrated.workflowId,
    phase: migrated.phase,
    mode: migrated.phase,
    target: source.target && typeof source.target === 'object' ? source.target : null,
    skills: Array.isArray(source.skills) ? source.skills.filter((s) => typeof s === 'string' && s.trim()) : [],
    bash: Array.isArray(source.bash) ? source.bash.filter((s) => typeof s === 'string' && s.trim()) : [],
    goal,
    staticPlan: source.staticPlan && typeof source.staticPlan === 'object' ? source.staticPlan : emptyStaticPlan(),
    dynamicPlan: source.dynamicPlan && typeof source.dynamicPlan === 'object'
      ? { ...emptyDynamicPlan(), ...source.dynamicPlan }
      : emptyDynamicPlan(),
    loopMemory: source.loopMemory && typeof source.loopMemory === 'object' ? source.loopMemory : emptyLoopMemory(),
    selectedModel: source.selectedModel && typeof source.selectedModel === 'object' ? source.selectedModel : null,
    featureIntentFile: typeof source.featureIntentFile === 'string' ? source.featureIntentFile : null,
    requirementSummary: typeof source.requirementSummary === 'string' ? source.requirementSummary : null,
    chosenPresetAction: typeof source.chosenPresetAction === 'string' ? source.chosenPresetAction : null,
    presetActionTitle: typeof source.presetActionTitle === 'string' ? source.presetActionTitle : null,
    presetActionContent: typeof source.presetActionContent === 'string' ? source.presetActionContent : null,
    workspace: typeof source.workspace === 'string' ? source.workspace : null,
    migrationNotice: migrated.migrationNotice || (typeof source.migrationNotice === 'string' ? source.migrationNotice : null),
    pendingProtocol: source.pendingProtocol && typeof source.pendingProtocol === 'object' ? source.pendingProtocol : null,
    patternSelfCheck: source.patternSelfCheck && typeof source.patternSelfCheck === 'object' ? source.patternSelfCheck : null,
    patternRound: source.patternRound && typeof source.patternRound === 'object' ? source.patternRound : null,
    architectureSelfCheck: source.architectureSelfCheck && typeof source.architectureSelfCheck === 'object' ? source.architectureSelfCheck : null,
    contextUsage: source.contextUsage && typeof source.contextUsage === 'object' ? source.contextUsage : null,
    contextBudget: source.contextBudget && typeof source.contextBudget === 'object' ? source.contextBudget : null,
    compression: source.compression && typeof source.compression === 'object' ? source.compression : null,
    requirementProgress: source.requirementProgress && typeof source.requirementProgress === 'object' ? source.requirementProgress : {},
    userInputs: Array.isArray(source.userInputs) ? source.userInputs.filter((s) => typeof s === 'string' && s.trim()) : [],
  };
}

export function loadStateStore() {
  const base = {
    version: 2,
    sessions: {},
    bashDenyList: undefined,
    modelCatalog: normalizeModelCatalog(),
    modelAliases: [],
    compressionOverrides: {},
    workflowOverrides: normalizeWorkflowOverrides(),
    stageOverrides: {},
    workflowRegistryVersion: 1,
  };
  try {
    if (!existsSync(STATE_FILE)) return base;
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return base;
    const migrated = migrateWorkflowOverridesToStageOverrides(
      normalizeWorkflowOverrides(parsed.workflowOverrides),
      normalizeStageOverrides(parsed.stageOverrides),
    );
    return {
      version: 2,
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
      bashDenyList: parsed.bashDenyList,
      modelCatalog: normalizeModelCatalog(parsed.modelCatalog),
      modelAliases: normalizeModelAliases(parsed.modelAliases),
      compressionOverrides: normalizeCompressionOverrides(parsed.compressionOverrides),
      workflowOverrides: migrated.workflowOverrides,
      stageOverrides: migrated.stageOverrides,
      workflowRegistryVersion: parsed.workflowRegistryVersion || 1,
    };
  } catch (_err) {
    return base;
  }
}

export function saveStateStore(store) {
  try {
    mkdirSync(join(homedir(), '.dsh'), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ ...store, version: 2 }, null, 2));
  } catch (err) {
    console.log('[dsh-mode-gate] state save failed:', err && err.message);
  }
}

/** Read the durable session state, normalized to v2. */
export function readSessionEntry(sessionId) {
  const store = loadStateStore();
  const raw = sessionId !== void 0 ? store.sessions[sessionId] : void 0;
  return normalizeSessionEntry(raw);
}

export function readState(agent) {
  const sessionId = agent?.session?.id;
  const entry = readSessionEntry(sessionId);
  const store = loadStateStore();
  return { ...entry, modelCatalog: store.modelCatalog, modelAliases: store.modelAliases || [], workflowOverrides: store.workflowOverrides, stageOverrides: store.stageOverrides };
}

export function writeState(agent, patch) {
  const sessionId = agent?.session?.id;
  if (sessionId === void 0) return;
  const store = loadStateStore();
  const current = normalizeSessionEntry(store.sessions[sessionId]);
  const next = normalizeSessionEntry({ ...current, ...patch });
  store.sessions[sessionId] = next;
  saveStateStore(store);
}

function firstGoalLine(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return null;
  const first = text.split(/\r?\n/)[0].trim();
  return first.replace(/^\[目标\]\s*/, '') || first;
}

export function formatCapabilities(state) {
  const goalTarget = state.goal && state.goal.status === 'active' && state.goal.prompt
    ? firstGoalLine(state.goal.prompt)
    : null;
  return [
    `当前工作流：${state.workflowId || IDLE_WORKFLOW_ID}`,
    `当前状态：${state.phase || IDLE_STATE_ID}`,
    ...(goalTarget ? [`当前目标：${goalTarget}`] : []),
    '始终可用：skill_search（查看所有 skill）、switch_mode（请求切换阶段）、dev_tool_search / request_extra、submit_state。',
  ].join('\n');
}
