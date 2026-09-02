import { defineTool } from '@deepseek-ai/dsh-tools';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MODES = ['READ_ONLY', 'PLAN_ONLY', 'WRITE_ENABLED'];
const DEFAULT_MODE = 'READ_ONLY';

const STATE_FILE = join(homedir(), '.dsh', 'mode-gate-state.json');

/** Default bash deny-list entries; overridable from the Web settings tab. */
const DEFAULT_BASH_DENY_LIST = [
  {
    id: 'deny-web-fetch',
    commands: ['curl', 'wget'],
    reason: '禁止使用 curl/wget 抓取网页，请改用 read_url 工具',
  },
];

/** Tools that are always allowed regardless of mode / declared target. */
const ALWAYS_ALLOWED = new Set(['declare_target', 'switch_mode', 'skill_search', 'request_extra']);

/** Tools allowed without a declared target (besides ALWAYS_ALLOWED). */
const ALLOWED_WITHOUT_TARGET = new Set([
  'ask_user_question', 'get_goal', 'todo_write', 'skill_search', 'request_extra',
]);

/** Tools considered safe in READ_ONLY (and therefore PLAN_ONLY too). */
const READ_ONLY_TOOLS = new Set([
  'read', 'grep', 'glob', 'skill', 'skill_search', 'skill_load', 'read_image',
  'web_search', 'list_agents', 'get_goal', 'job_list', 'job_output', 'ask_user_question',
  'read_url', 'read_url_batch', 'read_url_links', 'read_url_site',
]);

const READ_ONLY_TOOL_GLOBS = ['cordis_inspect_*'];

function matchesReadOnlyToolGlob(name) {
  return READ_ONLY_TOOL_GLOBS.some((pattern) => {
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return re.test(name);
  });
}

/** Tools considered planning-safe on top of READ_ONLY. */
const PLAN_TOOLS = new Set(['todo_write', 'exit_plan_mode']);

/** Generated mode-specific prompt lines. */
const MODE_RULES = {
  READ_ONLY: '- READ_ONLY：只读。bash 仅允许已声明的只读命令；禁止写入/危险命令；网页阅读只用 read_url 工具。',
  PLAN_ONLY: '- PLAN_ONLY：只读 + 规划（todo_write / exit_plan_mode）；bash 仅允许已声明的只读命令；网页阅读只用 read_url 工具。',
  WRITE_ENABLED: '- WRITE_ENABLED：可写，但危险 bash 命令仍需人工授权；网页阅读只用 read_url 工具。',
};

/** Tool names that are always considered writes when classified by name. */
const KNOWN_WRITE_TOOLS = new Set([
  'write', 'edit', 'create', 'apply_patch', 'patch', 'str_replace_editor',
]);

/**
 * Lightweight shell-command classifier.
 * Splits on top-level pipes / separators, tokenizes each simple command,
 * and classifies by verb and output-redirection targets.
 * Returns 'dangerous', 'mutating', or 'read-only'.
 */
const MUTATING_VERBS = new Set([
  'rm', 'mv', 'cp', 'install', 'ln', 'chmod', 'chown', 'chgrp',
  'touch', 'mkdir', 'rmdir', 'tee', 'truncate',
]);
const DANGEROUS_VERBS = new Set(['sudo', 'mkfs', 'dd']);
const MUTATING_GIT_SUBCOMMANDS = new Set(['add', 'commit', 'mv', 'rm']);
const DANGEROUS_GIT_SUBCOMMANDS = new Set(['push', 'reset', 'clean']);
const DOWNLOAD_VERBS = new Set(['curl', 'wget']);
const SHELL_VERBS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const HARMLESS_WRITE_TARGETS = new Set(['&1', '&2']);

function stripOuterQuotes(token) {
  if (token.length >= 2 && ((token[0] === "'" && token[token.length - 1] === "'") || (token[0] === '"' && token[token.length - 1] === '"'))) {
    return token.slice(1, -1);
  }
  return token;
}

function splitShellSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  let escaped = false;
  const flush = () => {
    const seg = current.trim();
    if (seg.length > 0) segments.push(seg);
    current = '';
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === '\\') { current += ch; escaped = true; continue; }
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === '|') { flush(); continue; }
    if (ch === '&' && command[i + 1] === '&') { flush(); i += 1; continue; }
    if (ch === ';') { flush(); continue; }
    current += ch;
  }
  flush();
  return segments;
}

function tokenizeSimpleCommand(segment) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  const flush = () => {
    if (current.length > 0) tokens.push(stripOuterQuotes(current));
    current = '';
  };
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === '\\') { current += ch; escaped = true; continue; }
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === ' ' || ch === '\t') { flush(); continue; }
    current += ch;
  }
  flush();
  return tokens;
}

function redirectOpOf(token) {
  return /^(?:(\d+|&)>>?|>>?|<<?|<<<|&>|&>>)$/.test(token) ? token : null;
}

function isHarmlessWriteTarget(target) {
  if (target === void 0) return false;
  const t = String(target).trim();
  return HARMLESS_WRITE_TARGETS.has(t) || t.startsWith('/dev/');
}

function analyzeSimpleCommand(tokens) {
  let commandWord = null;
  const commandTokens = [];
  let mutatingRedirect = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const op = redirectOpOf(token);

    if (op !== null) {
      const target = tokens[i + 1];
      if (op === '<' || op === '<<' || op === '<<<') {
        if (target !== void 0) i += 1;
        continue;
      }
      if (op.startsWith('2') && isHarmlessWriteTarget(target)) {
        if (target !== void 0) i += 1;
        continue;
      }
      if (!op.startsWith('2') && isHarmlessWriteTarget(target)) {
        if (target !== void 0) i += 1;
        continue;
      }
      mutatingRedirect = true;
      if (target !== void 0) i += 1;
      continue;
    }

    if (commandWord === null && !token.includes('=')) {
      commandWord = token;
    }
    commandTokens.push(token);
  }

  if (commandWord === null) return { kind: 'read-only' };

  const base = commandWord.split('/').pop();

  if (DANGEROUS_VERBS.has(base)) return { kind: 'dangerous' };
  if (base === 'chmod' && commandTokens.includes('-R') && commandTokens.includes('777')) return { kind: 'dangerous' };
  if (base === 'rm' && commandTokens.includes('-rf') && commandTokens.includes('/')) return { kind: 'dangerous' };
  if (MUTATING_VERBS.has(base)) return { kind: 'mutating' };

  if (base === 'git') {
    const sub = commandTokens[1];
    if (DANGEROUS_GIT_SUBCOMMANDS.has(sub)) return { kind: 'dangerous' };
    if (MUTATING_GIT_SUBCOMMANDS.has(sub)) return { kind: 'mutating' };
  }

  if (mutatingRedirect) return { kind: 'mutating' };
  return { kind: 'read-only' };
}

function classifyCommand(command) {
  const cmd = String(command || '');
  const segments = splitShellSegments(cmd);

  const pipeline = segments.map((segment) => {
    const tokens = tokenizeSimpleCommand(segment);
    const first = tokens.find((token) => redirectOpOf(token) === null && !token.includes('='));
    return first === void 0 ? '' : first.split('/').pop();
  }).filter(Boolean).join('|');

  const pipelineCommands = pipeline.split('|');
  if (pipelineCommands.length > 1 && DOWNLOAD_VERBS.has(pipelineCommands[0]) && SHELL_VERBS.has(pipelineCommands[pipelineCommands.length - 1])) {
    return 'dangerous';
  }

  for (const segment of segments) {
    const result = analyzeSimpleCommand(tokenizeSimpleCommand(segment));
    if (result.kind === 'dangerous') return 'dangerous';
    if (result.kind === 'mutating') return 'mutating';
  }

  return 'read-only';
}

/** Return the command verb (basename of first command word) for each top-level shell segment. */
function extractCommandVerbs(command) {
  const segments = splitShellSegments(String(command || ''));
  const verbs = [];
  for (const segment of segments) {
    const tokens = tokenizeSimpleCommand(segment);
    const first = tokens.find((token) => redirectOpOf(token) === null && !token.includes('='));
    if (first !== void 0) verbs.push(first.split('/').pop());
  }
  return verbs;
}

/** Normalize a bash deny-list payload. `undefined` means "use the built-in default". */
function normalizeDenyList(value) {
  if (value === void 0) return DEFAULT_BASH_DENY_LIST.map((entry) => ({ ...entry, commands: [...entry.commands] }));
  if (!Array.isArray(value)) return DEFAULT_BASH_DENY_LIST.map((entry) => ({ ...entry, commands: [...entry.commands] }));
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const commands = Array.isArray(entry.commands)
      ? entry.commands.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim())
      : (typeof entry.command === 'string' && entry.command.trim() ? [entry.command.trim()] : []);
    if (commands.length === 0) continue;
    out.push({
      id: typeof entry.id === 'string' && entry.id ? entry.id : `deny-${out.length + 1}`,
      commands,
      reason: typeof entry.reason === 'string' ? entry.reason : '',
    });
  }
  return out;
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [];
}

function readBashDenyList() {
  return loadStateStore().bashDenyList;
}

function saveBashDenyList(entries) {
  const store = loadStateStore();
  store.bashDenyList = normalizeDenyList(entries);
  saveStateStore(store);
  return store.bashDenyList;
}

function matchBashDeny(command, denyList) {
  const verbs = extractCommandVerbs(command);
  for (const entry of denyList) {
    for (const banned of entry.commands) {
      if (verbs.includes(banned)) return entry;
    }
  }
  return null;
}

function isBashDeclared(command, declaredBash) {
  const set = new Set(declaredBash);
  return extractCommandVerbs(command).every((verb) => set.has(verb));
}

/**
 * Load the durable mode-gate state from `~/.dsh/mode-gate-state.json`.
 * The shape is `{ sessions: { [sessionId]: { mode, target, skills, bash } }, bashDenyList }`.
 * State is keyed by session id so a resumed session folds back to the
 * mode/target/capabilities it had; bashDenyList is global.
 * Session-log custom events are NOT used: the harness's persistence read path
 * only accepts its own known event types and refuses logs containing unknown
 * non-ignorable types (SessionFormatUnsupportedError).
 */
function loadStateStore() {
  try {
    if (!existsSync(STATE_FILE)) return { sessions: {}, bashDenyList: normalizeDenyList() };
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      return {
        sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
        bashDenyList: normalizeDenyList(parsed.bashDenyList),
      };
    }
    return { sessions: {}, bashDenyList: normalizeDenyList() };
  } catch (_err) {
    return { sessions: {}, bashDenyList: normalizeDenyList() };
  }
}

function saveStateStore(store) {
  try {
    mkdirSync(join(homedir(), '.dsh'), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.log('[dsh-mode-gate] state save failed:', err && err.message);
  }
}

function readState(agent, fallbackMode) {
  const sessionId = agent?.session?.id;
  const store = loadStateStore();
  const entry = sessionId !== void 0 ? store.sessions[sessionId] : void 0;
  return {
    mode: entry && MODES.includes(entry.mode) ? entry.mode : (fallbackMode || DEFAULT_MODE),
    target: entry && entry.target ? entry.target : null,
    skills: stringArray(entry && entry.skills),
    bash: stringArray(entry && entry.bash),
  };
}

function writeState(agent, patch) {
  const sessionId = agent?.session?.id;
  if (sessionId === void 0) return;
  const store = loadStateStore();
  const current = store.sessions[sessionId] || { mode: DEFAULT_MODE, target: null };
  store.sessions[sessionId] = { ...current, ...patch };
  saveStateStore(store);
}

function toolDisposition(name, mode) {
  if (ALWAYS_ALLOWED.has(name)) return { kind: 'allow' };
  if (mode === 'READ_ONLY') {
    if (READ_ONLY_TOOLS.has(name) || matchesReadOnlyToolGlob(name)) return { kind: 'allow' };
    return { kind: 'deny', reason: `当前模式为 READ_ONLY，工具 ${name} 不在只读白名单内。` };
  }
  if (mode === 'PLAN_ONLY') {
    if (READ_ONLY_TOOLS.has(name) || matchesReadOnlyToolGlob(name) || PLAN_TOOLS.has(name)) return { kind: 'allow' };
    return { kind: 'deny', reason: `当前模式为 PLAN_ONLY，工具 ${name} 不允许执行。` };
  }
  return { kind: 'allow' };
}

/** Decide a bash/pwsh command in the current mode. */
function bashDisposition(command, mode, declaredBash, denyList) {
  const deny = matchBashDeny(command, denyList);
  if (deny) {
    return { kind: 'deny', reason: deny.reason || `命令 ${deny.commands.join('/')} 已被禁止。` };
  }

  if (!isBashDeclared(command, declaredBash)) {
    return { kind: 'deny', reason: `当前 bash 命令未声明：${command}。请调用 request_extra 申请额外 bash 命令。` };
  }

  const kind = classifyCommand(command);
  if (mode === 'READ_ONLY' || mode === 'PLAN_ONLY') {
    if (kind === 'read-only') return { kind: 'allow' };
    return { kind: 'deny', reason: `当前模式为 ${mode}，禁止执行写入/危险命令：${command}` };
  }
  if (kind === 'dangerous') {
    return { kind: 'ask', reason: `检测到危险命令，需要人工授权：${command}` };
  }
  return { kind: 'allow' };
}

function formatCapabilities(state) {
  return [
    `当前模式：${state.mode}`,
    `当前 Target：${state.target ? state.target.target : '未声明'}`,
    `已声明 skills：${state.skills.length ? state.skills.join(', ') : '（无）'}`,
    `已声明 bash 命令：${state.bash.length ? state.bash.join(', ') : '（无）'}`,
    '始终可用：skill_search（查看所有 skill）、switch_mode（请求切换模式）、request_extra（申请额外 skill/bash）。',
    '要申请额外 skill 或 bash：request_extra({ skills: [...], bash: [...] })，会作为问题向用户申报。',
  ].join('\n');
}

/**
 * No-decorator Remote marker shim: feeds `Remote(name)` a hand-built method
 * context so the marker lands in typert's private WeakMap, exactly like the
 * TS decorator output would. Same helper as dsh-music-alert uses.
 */
function markRemoteMethods(cls, methodNames) {
  const initializers = [];
  for (const name of methodNames) {
    Remote(name)(undefined, {
      kind: 'method',
      name,
      static: false,
      private: false,
      access: { has: (o) => name in o, get: (o) => o[name] },
      addInitializer: (fn) => {
        initializers.push(fn);
      },
    });
  }
  const proto = cls.prototype;
  const probe = Object.create(proto);
  for (const fn of initializers) fn.call(probe);
}

/** Remote service exposing the durable mode-gate state and bash deny-list. */
class ModeGateGateway extends TypertRemoteService {
  static inject = [];
  constructor(ctx) {
    super(ctx, 'modeGate');
  }
  async getState(args) {
    const sessionId = args && args.sessionId;
    const store = loadStateStore();
    const entry = typeof sessionId === 'string' ? store.sessions[sessionId] : void 0;
    return {
      mode: entry && MODES.includes(entry.mode) ? entry.mode : DEFAULT_MODE,
      target: entry && entry.target ? entry.target : null,
    };
  }
  async getBashDenyList() {
    return { entries: readBashDenyList() };
  }
  async setBashDenyList(args) {
    const entries = saveBashDenyList(args && args.entries);
    return { entries };
  }
}
markRemoteMethods(ModeGateGateway, ['getState', 'getBashDenyList', 'setBashDenyList']);

export default {
  name: 'mode-gate',
  inject: ['tools', 'systemPrompt'],

  apply(ctx, config) {
    const defaultMode = config && MODES.includes(config.defaultMode) ? config.defaultMode : DEFAULT_MODE;

    ctx.systemPrompt.section({
      name: 'mode-gate:policy',
      order: 95,
      text: (assembleCtx) => {
        const agent = assembleCtx && assembleCtx.agent;
        const state = readState(agent, defaultMode);
        const denyList = readBashDenyList();
        const targetText = state.target ? state.target.target : '未声明';
        const targetModeText = state.target && state.target.mode ? state.target.mode : '（未指定）';
        const denyLines = denyList.length
          ? denyList.map((entry) => `  - ${entry.commands.join(', ')}：${entry.reason || '已禁止'}`).join('\n')
          : '  （无）';
        return [
          '[mode-gate]',
          `当前模式：${state.mode}`,
          `当前 Target：${targetText}`,
          `Target 关联模式：${targetModeText}`,
          `已声明 skills：${state.skills.length ? state.skills.join(', ') : '（无）'}`,
          `已声明 bash 命令：${state.bash.length ? state.bash.join(', ') : '（无）'}`,
          '规则：',
          '- 每次行动前必须先调用 declare_target 声明 Target，并同时声明本次需要的 skills 和 bash 命令。',
          MODE_RULES[state.mode] || MODE_RULES[DEFAULT_MODE],
          '- 未声明就调用的 skill_load / bash 命令会被拦截；需要时调用 request_extra 申请，会作为问题向用户申报。不要花太多算力预判申请清单。',
          '- 始终可用：skill_search（查看所有 skill）、switch_mode（请求切换模式）、request_extra（申请额外 skill/bash）。',
          '当前禁止的 bash 命令：',
          denyLines,
        ].join('\n');
      },
    });

    ctx.tools.register(defineTool({
      name: 'declare_target',
      description: '声明当前任务目标（Target），可选关联一个执行模式，并同时声明本次需要的 skills 和 bash 命令。必须在其他工具调用之前使用。',
      parameters: {
        target: {
          type: 'string',
          required: true,
          description: '任务目标/任务名，例如 "实现 mode-gate 插件" 或 "plan"。',
        },
        mode: {
          type: 'string',
          enum: [...MODES],
          description: '该目标预期执行的模式。缺省则保持当前模式。',
        },
        skills: {
          type: 'array',
          items: { type: 'string' },
          description: '本次任务需要使用的 skill 名称列表（未声明的 skill_load 会被拦截）。',
        },
        bash: {
          type: 'array',
          items: { type: 'string' },
          description: '本次任务需要使用的 bash 命令动词列表，例如 ["ls", "cat", "grep"]。',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const agent = exec.agent;
        if (agent === void 0) throw new Error('declare_target 需要 agent 上下文');
        const skills = stringArray(args.skills);
        const bash = stringArray(args.bash);
        const target = { target: args.target, mode: args.mode };
        writeState(agent, { target, skills, bash });
        return [
          `已声明 Target：${args.target}${args.mode ? `，关联模式：${args.mode}` : ''}`,
          `已声明 skills：${skills.length ? skills.join(', ') : '（无）'}`,
          `已声明 bash 命令：${bash.length ? bash.join(', ') : '（无）'}`,
        ].join('\n');
      },
    }));

    ctx.tools.register(defineTool({
      name: 'switch_mode',
      description: '请求切换当前模式（READ_ONLY / PLAN_ONLY / WRITE_ENABLED）。切换需要用户批准，批准后立即生效。',
      parameters: {
        mode: {
          type: 'string',
          enum: [...MODES],
          required: true,
          description: '目标模式。',
        },
        reason: {
          type: 'string',
          description: '一句话说明为什么要切换模式。',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const agent = exec.agent;
        if (agent === void 0) throw new Error('switch_mode 需要 agent 上下文');
        writeState(agent, { mode: args.mode });
        return `模式已切换为 ${args.mode}`;
      },
    }));

    ctx.tools.register(defineTool({
      name: 'request_extra',
      description: '查看或申请额外的 skill 和 bash 命令访问。无参数时返回当前已声明的 skills 和 bash 命令；带 skills/bash 参数时作为问题向用户申报，批准后立即生效。',
      parameters: {
        skills: {
          type: 'array',
          items: { type: 'string' },
          description: '要申请的 skill 名称列表。',
        },
        bash: {
          type: 'array',
          items: { type: 'string' },
          description: '要申请的 bash 命令动词列表。',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const agent = exec.agent;
        if (agent === void 0) throw new Error('request_extra 需要 agent 上下文');
        const state = readState(agent, defaultMode);
        const requestedSkills = stringArray(args.skills);
        const requestedBash = stringArray(args.bash);
        if (requestedSkills.length || requestedBash.length) {
          const nextSkills = [...new Set([...state.skills, ...requestedSkills])];
          const nextBash = [...new Set([...state.bash, ...requestedBash])];
          writeState(agent, { skills: nextSkills, bash: nextBash });
          return formatCapabilities({ ...state, skills: nextSkills, bash: nextBash });
        }
        return formatCapabilities(state);
      },
    }));

    ctx.on('tools/pre-execute', (exec, next) => {
      const name = exec.name;

      if (name === 'declare_target') return next();

      if (name === 'switch_mode') {
        const mode = exec.arguments?.mode;
        if (!MODES.includes(mode)) {
          return Promise.resolve({ kind: 'deny', reason: `无效模式 ${String(mode)}，可选：${MODES.join('/')}` });
        }
        return Promise.resolve({
          kind: 'ask',
          reason: `是否允许把模式切换到 ${mode}？${exec.arguments?.reason ? `原因：${exec.arguments.reason}` : ''}`,
        });
      }

      if (name === 'request_extra') {
        const requestedSkills = stringArray(exec.arguments?.skills);
        const requestedBash = stringArray(exec.arguments?.bash);
        if (requestedSkills.length || requestedBash.length) {
          const state = readState(exec.agent, defaultMode);
          const items = [
            ...requestedSkills.map((s) => `skill: ${s}`),
            ...requestedBash.map((b) => `bash: ${b}`),
          ].join('、');
          return Promise.resolve({
            kind: 'ask',
            reason: `是否授予以下额外访问？${items}（当前模式 ${state.mode}，批准后立即生效）`,
          });
        }
        return next();
      }

      const agent = exec.agent;
      const state = readState(agent, defaultMode);

      if (!state.target && !ALLOWED_WITHOUT_TARGET.has(name)) {
        return Promise.resolve({
          kind: 'deny',
          reason: '尚未声明 Target。请先调用 declare_target 声明当前任务目标。',
        });
      }

      if (name === 'bash' || name === 'pwsh') {
        const command = String(exec.arguments?.command || '');
        const decision = bashDisposition(command, state.mode, state.bash, readBashDenyList());
        return decision.kind === 'allow' ? next() : Promise.resolve(decision);
      }

      if (name === 'skill_load' || name === 'skill') {
        const requested = typeof exec.arguments?.name === 'string' ? exec.arguments.name : '';
        if (requested && !state.skills.includes(requested)) {
          return Promise.resolve({
            kind: 'deny',
            reason: `skill "${requested}" 未声明。请先用 skill_search 查看，再用 request_extra 申请额外 skill。`,
          });
        }
        const decision = toolDisposition(name, state.mode);
        return decision.kind === 'allow' ? next() : Promise.resolve(decision);
      }

      if (name === 'str_replace_editor') {
        if (state.mode === 'READ_ONLY' || state.mode === 'PLAN_ONLY') {
          if (exec.arguments?.command === 'view') return next();
          return Promise.resolve({
            kind: 'deny',
            reason: `当前模式为 ${state.mode}，str_replace_editor 仅允许 view 命令。`,
          });
        }
        return next();
      }

      if (KNOWN_WRITE_TOOLS.has(name)) {
        if (state.mode === 'READ_ONLY' || state.mode === 'PLAN_ONLY') {
          return Promise.resolve({ kind: 'deny', reason: `当前模式为 ${state.mode}，禁止写工具 ${name}。` });
        }
        return next();
      }

      const decision = toolDisposition(name, state.mode);
      return decision.kind === 'allow' ? next() : Promise.resolve(decision);
    });

    // Remote service consumed by the Web settings/footer to read durable state.
    new ModeGateGateway(ctx);
  },
};
