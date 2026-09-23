import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// 本文件位于 lib/engine/，内置工作流在包根 workflows/（package.json files 含
// "workflows"），需上两级再进 workflows；少一级会指向不存在的 lib/workflows，
// collectDir 静默返回空 → byId 无 IDLE → 抛「workflow 配置缺少内置 IDLE 定义」。
export const BUILTIN_WORKFLOW_DIR = resolve(HERE, '..', '..', 'workflows');

export function expandHome(path) {
  if (typeof path !== 'string' || path.length === 0) return path;
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function readJsonFile(file) {
  const raw = readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`workflow 配置 JSON 解析失败：${file}：${(err && err.message) || err}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Validate one workflow definition; throws with a human-readable reason. */
export function validateWorkflow(wf, source) {
  const where = source ? ` (${source})` : '';
  assert(wf && typeof wf === 'object', `workflow 必须是对象${where}`);
  assert(typeof wf.id === 'string' && wf.id.length > 0, `workflow 缺少 id${where}`);
  assert(wf.kind === 'idle' || wf.kind === 'workflow', `workflow "${wf.id}" 的 kind 必须是 idle 或 workflow${where}`);
  assert(Array.isArray(wf.states) && wf.states.length > 0, `workflow "${wf.id}" 缺少 states${where}`);
  const ids = new Set();
  for (const state of wf.states) {
    assert(state && typeof state.id === 'string' && state.id.length > 0, `workflow "${wf.id}" 存在缺少 id 的 state${where}`);
    assert(!ids.has(state.id), `workflow "${wf.id}" 存在重复 state id "${state.id}"${where}`);
    ids.add(state.id);
    if (state.transitions !== undefined) {
      assert(Array.isArray(state.transitions), `state "${wf.id}.${state.id}" 的 transitions 必须是数组${where}`);
      for (const tr of state.transitions) {
        assert(tr && typeof tr === 'object', `state "${wf.id}.${state.id}" 存在非法 transition${where}`);
        assert(tr.when && typeof tr.when === 'object' && typeof tr.when.type === 'string', `state "${wf.id}.${state.id}" 的 transition 缺少 when.type${where}`);
        assert(tr.to !== undefined, `state "${wf.id}.${state.id}" 的 transition 缺少 to${where}`);
      }
    }
  }
  assert(ids.has(wf.startState), `workflow "${wf.id}" 的 startState "${wf.startState}" 不在 states 中${where}`);
  if (wf.kind === 'idle') assert(wf.id === 'IDLE', `kind: idle 的工作流 id 必须是 IDLE${where}`);
  return wf;
}

function mergeWorkflow(base, override) {
  const states = new Map();
  for (const state of base.states) states.set(state.id, state);
  for (const state of override.states || []) {
    const previous = states.get(state.id);
    states.set(state.id, previous ? { ...previous, ...state } : state);
  }
  return {
    ...base,
    ...override,
    ui: { ...(base.ui || {}), ...(override.ui || {}) },
    states: [...states.values()],
  };
}

function collectDir(dir, log) {
  const out = [];
  if (!dir) return out;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (_err) {
    return out;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = join(dir, entry);
    try {
      if (!statSync(file).isFile()) continue;
      const parsed = readJsonFile(file);
      const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.workflows) ? parsed.workflows : [parsed]);
      for (const wf of list) out.push(validateWorkflow(wf, file));
    } catch (err) {
      log(`workflow 配置加载失败：${file}：${(err && err.message) || err}`);
    }
  }
  return out;
}

/**
 * Merge workflow definitions from low -> high precedence.
 * Returns a Map keyed by workflow id.
 */
export function mergeWorkflowLists(lists) {
  const merged = new Map();
  for (const list of lists) {
    for (const wf of list) {
      const previous = merged.get(wf.id);
      merged.set(wf.id, previous ? mergeWorkflow(previous, wf) : wf);
    }
  }
  return merged;
}

function dirsSignature(dirs) {
  return dirs.filter(Boolean).join('|');
}

/**
 * Workflow registry with per-workspace lazily built definitions.
 * @param {{ builtinDir?: string, globalDir?: string, workspaceDir?: (workspace: string) => string, log?: (msg: string) => void }} options
 */
export function createWorkflowRegistry(options = {}) {
  const builtinDir = options.builtinDir || BUILTIN_WORKFLOW_DIR;
  const globalDir = options.globalDir || join(homedir(), '.dsh', 'workflows');
  const workspaceDir = typeof options.workspaceDir === 'function'
    ? options.workspaceDir
    : (workspace) => (workspace ? join(workspace, 'workflows') : null);
  const log = typeof options.log === 'function' ? options.log : () => {};
  const cache = new Map();

  function build(workspace) {
    const dirs = [builtinDir, globalDir, workspaceDir(workspace)];
    const key = dirsSignature(dirs);
    if (cache.has(key)) return cache.get(key);
    const lists = dirs.map((dir) => collectDir(dir, log));
    const byId = mergeWorkflowLists(lists);
    if (!byId.has('IDLE')) {
      throw new Error('workflow 配置缺少内置 IDLE 定义');
    }
    const registry = {
      workspace: workspace || null,
      dirs,
      byId,
      get: (id) => byId.get(id) || null,
      list: () => [...byId.values()],
      listForModal: () => [...byId.values()]
        .filter((wf) => wf.kind === 'workflow' && wf.ui && wf.ui.showInIdleModal !== false)
        .sort((a, b) => ((a.ui && a.ui.order) || 0) - ((b.ui && b.ui.order) || 0)),
      stateOf: (workflowId, stateId) => {
        const wf = byId.get(workflowId);
        if (!wf) return null;
        return (wf.states || []).find((state) => state.id === stateId) || null;
      },
      startStateOf: (workflowId) => {
        const wf = byId.get(workflowId);
        return wf ? wf.startState : null;
      },
    };
    cache.set(key, registry);
    return registry;
  }

  return {
    builtinDir,
    globalDir,
    forWorkspace: build,
    invalidate: () => cache.clear(),
  };
}
