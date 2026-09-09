import { defineTool } from '@deepseek-ai/dsh-tools';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createFeatureIntentStore } from './feature-intent-store.js';
import { createGoalEngine } from './goal-engine.js';
import { createBuiltinGoals } from './goals.js';
import { modelCatalogText } from './protocols.js';

/**
 * mode-gate phases:
 * - PRESET_ACTION: probe preset actions; no-match falls through to requirement
 *   recognition, match skips straight to IMPLEMENT.
 * - REQUIREMENT_RECOGNITION: merged READ_ONLY + PLAN_ONLY permission plus the
 *   feature-intent reading / appending / protocol submission loop.
 * - IMPLEMENT: the former WRITE_ENABLED permission.
 */
const PHASES = ['PRESET_ACTION', 'REQUIREMENT_RECOGNITION', 'IMPLEMENT'];
const DEFAULT_PHASE = 'PRESET_ACTION';

const LEGACY_MODE_TO_PHASE = {
  READ_ONLY: 'REQUIREMENT_RECOGNITION',
  PLAN_ONLY: 'REQUIREMENT_RECOGNITION',
  WRITE_ENABLED: 'IMPLEMENT',
};

const STATE_FILE = join(homedir(), '.dsh', 'mode-gate-state.json');

/** Default bash deny-list entries; overridable from the Web settings tab. */
const DEFAULT_BASH_DENY_LIST = [
  {
    id: 'deny-web-fetch',
    commands: ['curl', 'wget'],
    reason: '禁止使用 curl/wget 抓取网页，请改用 read_url 工具',
  },
];

/** User-editable model catalog, persisted top-level in the state file. */
const DEFAULT_MODEL_CATALOG = [
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

/** task_mode -> default model id. Per-task model_override can override these. */
const DEFAULT_TASK_MODES = {
  simple: { model: 'deepseek-v4-flash' },
  complex: { model: 'deepseek-v4-pro' },
};

/** Harmless read-only bash built-ins that never need to be declared. */
const ALWAYS_ALLOWED_BASH_VERBS = new Set(['echo', 'printf', 'pwd', 'cd', 'true', 'false']);

/** Tools that are always allowed regardless of mode / declared target. */
const ALWAYS_ALLOWED = new Set(['declare_target', 'switch_mode', 'skill_search', 'request_extra', 'dev_tool_search']);

/** Tools allowed without a declared target (besides ALWAYS_ALLOWED). */
const ALLOWED_WITHOUT_TARGET = new Set([
  'ask_user_question', 'get_goal', 'todo_write', 'skill_search', 'request_extra', 'dev_tool_search',
]);

/** Tools considered safe in READ_ONLY (and therefore PLAN_ONLY too). */
const READ_ONLY_TOOLS = new Set([
  'read', 'grep', 'glob', 'skill', 'skill_search', 'skill_load', 'read_image',
  'web_search', 'list_agents', 'get_goal', 'job_list', 'job_output', 'ask_user_question',
  'read_url', 'read_url_batch', 'read_url_links', 'read_url_site', 'dev_tool_search',
  'list_feature_intents', 'get_feature_intent',
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

/** Phase-specific prompt lines. */
const MODE_RULES = {
  PRESET_ACTION: '- PRESET_ACTION：探测 preset action；只允许 list_preset_actions / submit_preset_action；bash 禁用。',
  REQUIREMENT_RECOGNITION: '- REQUIREMENT_RECOGNITION：只读 + 规划 + feature intent 工具；bash 仅允许已声明的只读命令；禁止写文件。',
  IMPLEMENT: '- IMPLEMENT：可写，但危险 bash 命令仍需人工授权；feature_intent 目录仍禁止直接写。',
};

/** Map a public phase to the permission level used by toolDisposition. */
function permissionModeForPhase(phase) {
  return phase === 'IMPLEMENT' ? 'WRITE_ENABLED' : 'PLAN_ONLY';
}

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

/**
 * Shell reserved words. `do`/`then`/`else`/`elif` are skipped when they
 * prefix a body segment (the real command follows them); the other keywords
 * indicate a compound-command header like `for url in ...` and therefore a
 * segment with no simple command verb at all.
 */
const COMPOUND_HEAD_KEYWORDS = new Set(['for', 'while', 'until', 'if', 'case', 'select', 'coproc', 'function']);
const BODY_KEYWORDS = new Set(['do', 'then', 'else', 'elif']);
const SHELL_KEYWORDS = new Set([...COMPOUND_HEAD_KEYWORDS, ...BODY_KEYWORDS, 'done', 'fi', 'esac', 'in']);

function stripOuterQuotes(token) {
  if (token.length >= 2 && ((token[0] === "'" && token[token.length - 1] === "'") || (token[0] === '"' && token[token.length - 1] === '"'))) {
    return token.slice(1, -1);
  }
  return token;
}

function findParenEnd(command, openParenIndex) {
  let depth = 1;
  let quote = null;
  let escaped = false;
  for (let i = openParenIndex + 1; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '(') { depth += 1; continue; }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return command.length - 1;
}

function findBacktickEnd(command, openIndex) {
  let escaped = false;
  for (let i = openIndex + 1; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '`') return i;
  }
  return command.length - 1;
}

/** Locate a `<<`/`<<-` heredoc body. Returns null when no delimiter follows. */
function readHeredocRange(command, opIndex) {
  let p = opIndex + 2;
  if (command[p] === '-') p += 1;
  while (p < command.length && (command[p] === ' ' || command[p] === '\t')) p += 1;
  const tokenStart = p;
  while (p < command.length && !/[\s;|&<>]/.test(command[p])) p += 1;
  if (p === tokenStart) return null;
  const delimiter = stripOuterQuotes(command.slice(tokenStart, p));
  if (!delimiter) return null;

  const newline = command.indexOf('\n', opIndex);
  if (newline === -1) {
    return { bodyStart: command.length, bodyEnd: command.length - 1, scanResume: command.length };
  }

  const bodyStart = newline + 1;
  let lineStart = bodyStart;
  for (let pos = bodyStart; pos <= command.length; pos += 1) {
    if (pos === command.length || command[pos] === '\n') {
      let line = command.slice(lineStart, pos);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.replace(/^\t+/, '') === delimiter) {
        return { bodyStart, bodyEnd: lineStart - 1, scanResume: pos };
      }
      if (pos === command.length) break;
      lineStart = pos + 1;
    }
  }
  return { bodyStart, bodyEnd: command.length - 1, scanResume: command.length };
}

/** Mask heredoc bodies so their content is never parsed as shell segments. */
function maskHeredocs(command) {
  const chars = command.split('');
  let quote = null;
  let escaped = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '$' && command[i + 1] === '(') {
      i = findParenEnd(command, i + 1);
      continue;
    }
    if (ch === '`') {
      i = findBacktickEnd(command, i);
      continue;
    }
    if (ch === '<' && command[i + 1] === '<') {
      const range = readHeredocRange(command, i);
      if (range !== null) {
        for (let j = range.bodyStart; j <= range.bodyEnd; j += 1) {
          if (chars[j] !== '\n') chars[j] = ' ';
        }
        i = range.scanResume;
      }
    }
  }
  return chars.join('');
}

/** Return the inner text of every `$(...)` / backtick substitution in a word. */
function commandSubstitutions(word) {
  const substitutions = [];
  for (let i = 0; i < word.length; i += 1) {
    if (word[i] === '$' && word[i + 1] === '(') {
      const end = findParenEnd(word, i + 1);
      if (end > i + 2) substitutions.push(word.slice(i + 2, end));
      i = end;
    } else if (word[i] === '`') {
      const end = findBacktickEnd(word, i);
      if (end > i + 1) substitutions.push(word.slice(i + 1, end));
      i = end;
    }
  }
  return substitutions;
}


function splitShellSegments(command) {
  const masked = maskHeredocs(String(command || ''));
  const segments = [];
  let current = '';
  let quote = null;
  let escaped = false;
  const flush = () => {
    const seg = current.trim();
    if (seg.length > 0) segments.push(seg);
    current = '';
  };
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === '\\') { current += ch; escaped = true; continue; }
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === '$' && masked[i + 1] === '(') {
      const end = findParenEnd(masked, i + 1);
      current += masked.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = findBacktickEnd(masked, i);
      current += masked.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === '|' && masked[i + 1] === '|') { flush(); i += 1; continue; }
    if (ch === '&' && masked[i + 1] === '&') { flush(); i += 1; continue; }
    if (ch === '|') { flush(); continue; }
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
    if (ch === '$' && segment[i + 1] === '(') {
      const end = findParenEnd(segment, i + 1);
      current += segment.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = findBacktickEnd(segment, i);
      current += segment.slice(i, end + 1);
      i = end;
      continue;
    }
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

/** First simple command word in a tokenized segment, ignoring shell syntax. */
function firstCommandWord(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const op = redirectOpOf(token);
    if (op !== null) {
      if (tokens[i + 1] !== void 0) i += 1;
      continue;
    }
    if (token.includes('=')) continue;
    const base = token.split('/').pop();
    if (base === 'time') continue;
    if (COMPOUND_HEAD_KEYWORDS.has(base)) return null;
    if (BODY_KEYWORDS.has(base)) continue;
    if (SHELL_KEYWORDS.has(base)) return null;
    return base;
  }
  return null;
}

/** Worst safety classification among all command substitutions in `tokens`. */
function worstSubstitutionKind(tokens) {
  let worst = 'read-only';
  for (const token of tokens) {
    for (const inner of commandSubstitutions(token)) {
      const kind = classifyCommand(inner);
      if (kind === 'dangerous') return 'dangerous';
      if (kind === 'mutating') worst = 'mutating';
    }
  }
  return worst;
}

function analyzeSimpleCommand(tokens) {
  let commandWord = null;
  let commandWordIndex = -1;
  const commandTokens = [];
  let mutatingRedirect = false;
  let suppressCommandWord = false;

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

    commandTokens.push(token);

    if (commandWord === null && !suppressCommandWord) {
      if (token.includes('=')) continue;
      const base = token.split('/').pop();
      if (base === 'time') continue;
      if (COMPOUND_HEAD_KEYWORDS.has(base)) { suppressCommandWord = true; continue; }
      if (BODY_KEYWORDS.has(base)) continue;
      if (SHELL_KEYWORDS.has(base)) { suppressCommandWord = true; continue; }
      commandWord = token;
      commandWordIndex = commandTokens.length - 1;
    }
  }

  const subKind = worstSubstitutionKind(commandTokens);

  if (commandWord === null) return { kind: subKind };

  const base = commandWord.split('/').pop();

  if (DANGEROUS_VERBS.has(base)) return { kind: 'dangerous' };
  if (base === 'chmod' && commandTokens.includes('-R') && commandTokens.includes('777')) return { kind: 'dangerous' };
  if (base === 'rm' && commandTokens.includes('-rf') && commandTokens.includes('/')) return { kind: 'dangerous' };
  if (MUTATING_VERBS.has(base)) return { kind: subKind === 'dangerous' ? 'dangerous' : 'mutating' };

  if (base === 'git') {
    const sub = commandTokens[commandWordIndex + 1];
    if (DANGEROUS_GIT_SUBCOMMANDS.has(sub)) return { kind: 'dangerous' };
    if (MUTATING_GIT_SUBCOMMANDS.has(sub)) return { kind: 'mutating' };
  }

  if (mutatingRedirect) return { kind: subKind === 'dangerous' ? 'dangerous' : 'mutating' };
  return { kind: subKind };
}

function classifyCommand(command) {
  const cmd = String(command || '');
  const segments = splitShellSegments(cmd);

  const pipeline = segments.map((segment) => firstCommandWord(tokenizeSimpleCommand(segment))).filter(Boolean).join('|');

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

/** Return the command verb for each top-level shell segment, including verbs inside `$(...)`. */
function extractCommandVerbs(command) {
  const segments = splitShellSegments(String(command || ''));
  const verbs = [];
  for (const segment of segments) {
    const tokens = tokenizeSimpleCommand(segment);
    const outer = firstCommandWord(tokens);
    if (outer !== null) verbs.push(outer);
    for (const token of tokens) {
      for (const inner of commandSubstitutions(token)) {
        for (const verb of extractCommandVerbs(inner)) verbs.push(verb);
      }
    }
  }
  return [...new Set(verbs)];
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

function undeclaredBashVerbs(command, declaredBash) {
  const set = new Set(declaredBash);
  return extractCommandVerbs(command).filter((verb) => !set.has(verb) && !ALWAYS_ALLOWED_BASH_VERBS.has(verb));
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
function normalizeModelCatalog(value) {
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

function normalizeTaskModes(value) {
  const source = value && typeof value === 'object' ? value : DEFAULT_TASK_MODES;
  const out = {};
  for (const mode of ['simple', 'complex']) {
    const entry = source[mode];
    out[mode] = {
      model: entry && typeof entry.model === 'string' && entry.model.trim() ? entry.model.trim() : DEFAULT_TASK_MODES[mode].model,
    };
  }
  return out;
}

function loadStateStore() {
  try {
    if (!existsSync(STATE_FILE)) {
      return {
        sessions: {},
        bashDenyList: normalizeDenyList(),
        modelCatalog: normalizeModelCatalog(),
        taskModes: normalizeTaskModes(),
      };
    }
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      return {
        sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
        bashDenyList: normalizeDenyList(parsed.bashDenyList),
        modelCatalog: normalizeModelCatalog(parsed.modelCatalog),
        taskModes: normalizeTaskModes(parsed.taskModes),
      };
    }
    return {
      sessions: {},
      bashDenyList: normalizeDenyList(),
      modelCatalog: normalizeModelCatalog(),
      taskModes: normalizeTaskModes(),
    };
  } catch (_err) {
    return {
      sessions: {},
      bashDenyList: normalizeDenyList(),
      modelCatalog: normalizeModelCatalog(),
      taskModes: normalizeTaskModes(),
    };
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

function normalizePhase(value) {
  if (PHASES.includes(value)) return value;
  if (LEGACY_MODE_TO_PHASE[value]) return LEGACY_MODE_TO_PHASE[value];
  return DEFAULT_PHASE;
}

function readState(agent, fallbackPhase) {
  const sessionId = agent?.session?.id;
  const store = loadStateStore();
  const entry = sessionId !== void 0 ? store.sessions[sessionId] : void 0;
  const phase = normalizePhase((entry && (entry.phase || entry.mode)) || fallbackPhase || DEFAULT_PHASE);
  return {
    phase,
    mode: phase,
    target: entry && entry.target ? entry.target : null,
    skills: stringArray(entry && entry.skills),
    bash: stringArray(entry && entry.bash),
    goal: entry && entry.goal ? entry.goal : null,
    selectedModel: entry && entry.selectedModel ? entry.selectedModel : null,
    featureIntentFile: entry && entry.featureIntentFile ? entry.featureIntentFile : null,
    taskMode: entry && entry.taskMode ? entry.taskMode : null,
    requirementSummary: entry && entry.requirementSummary ? entry.requirementSummary : null,
    chosenPresetAction: entry && entry.chosenPresetAction ? entry.chosenPresetAction : null,
    modelCatalog: store.modelCatalog,
    taskModes: store.taskModes,
  };
}

function writeState(agent, patch) {
  const sessionId = agent?.session?.id;
  if (sessionId === void 0) return;
  const store = loadStateStore();
  const current = store.sessions[sessionId] || { phase: DEFAULT_PHASE, target: null };
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

  const missing = undeclaredBashVerbs(command, declaredBash);
  if (missing.length) {
    return {
      kind: 'deny',
      reason: `当前 bash 命令使用了未声明的命令动词：${missing.join(', ')}。完整命令：${command}。请调用 dev_tool_search（或 request_extra）申请额外 bash 命令，或在 declare_target 中补充声明。`,
    };
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
    `当前阶段：${state.phase || state.mode}`,
    `当前 Target：${state.target ? state.target.target : '未声明'}`,
    `已声明 skills：${state.skills.length ? state.skills.join(', ') : '（无）'}`,
    `已声明 bash 命令：${state.bash.length ? state.bash.join(', ') : '（无）'}`,
    '始终可用：skill_search（查看所有 skill）、switch_mode（请求切换阶段）、dev_tool_search / request_extra（申请额外 skill/bash）。',
    '要申请额外 skill 或 bash：dev_tool_search({ skills: [...], bash: [...] })（或 request_extra 同参），会作为问题向用户申报。',
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

/** Remote service exposing durable mode-gate state and settings payloads. */
class ModeGateGateway extends TypertRemoteService {
  static inject = [];
  constructor(ctx) {
    super(ctx, 'modeGate');
  }
  async getState(args) {
    const sessionId = args && args.sessionId;
    const store = loadStateStore();
    const entry = typeof sessionId === 'string' ? store.sessions[sessionId] : void 0;
    const phase = normalizePhase((entry && (entry.phase || entry.mode)) || DEFAULT_PHASE);
    return {
      phase,
      mode: phase,
      target: entry && entry.target ? entry.target : null,
      goal: entry && entry.goal ? entry.goal : null,
      selectedModel: entry && entry.selectedModel ? entry.selectedModel : null,
      featureIntentFile: entry && entry.featureIntentFile ? entry.featureIntentFile : null,
      chosenPresetAction: entry && entry.chosenPresetAction ? entry.chosenPresetAction : null,
    };
  }
  async getBashDenyList() {
    return { entries: readBashDenyList() };
  }
  async setBashDenyList(args) {
    const entries = saveBashDenyList(args && args.entries);
    return { entries };
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
}
markRemoteMethods(ModeGateGateway, [
  'getState',
  'getBashDenyList',
  'setBashDenyList',
  'getModelCatalog',
  'setModelCatalog',
  'getTaskModes',
  'setTaskModes',
]);

export default {
  name: 'mode-gate',
  inject: ['tools', 'systemPrompt', 'skills'],

  apply(ctx, config) {
    const defaultPhase = PHASES.includes(config && config.defaultPhase)
      ? config.defaultPhase
      : DEFAULT_PHASE;

    const expandHome = (path) => {
      if (typeof path !== 'string' || path.length === 0) return path;
      if (path === '~') return homedir();
      if (path.startsWith('~/')) return join(homedir(), path.slice(2));
      return path;
    };

    const featureIntentDir = expandHome(
      typeof (config && config.featureIntentDir) === 'string' && config.featureIntentDir.trim()
        ? config.featureIntentDir.trim()
        : join(homedir(), '.dsh', 'DOCUMENT', 'feature_intents'),
    );
    const presetActionDir = expandHome(
      typeof (config && config.presetActionDir) === 'string' && config.presetActionDir.trim()
        ? config.presetActionDir.trim()
        : join(homedir(), '.dsh', 'preset-actions'),
    );

    const featureIntents = createFeatureIntentStore(featureIntentDir);
    const log = (msg) => console.log(`[dsh-mode-gate] ${msg}`);

    let presetActionSkills = [];

    function parsePresetActionMeta(content) {
      const meta = {
        description: '',
        match: '',
        model: 'deepseek-v4-pro',
        provider: 'deepseek-official',
        reasoningEffort: '',
      };
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
        } catch (_err) {
          log(`preset action 元数据 JSON 解析失败：${_err && _err.message}`);
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
        const description = meta.description || `${title}（preset action）`;
        out.push({
          id: dirent.name,
          name: `preset-action-${dirent.name}`,
          title,
          description,
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

    function registerPresetActionSkills() {
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
    }

    presetActionSkills = collectPresetActionSkills();
    registerPresetActionSkills();

    const goalEngine = createGoalEngine({
      goals: createBuiltinGoals(),
      log,
    });

    function envFor(agent) {
      const state = readState(agent, defaultPhase);
      return {
        featureIntents,
        modelCatalog: state.modelCatalog,
        taskModes: state.taskModes,
        presetActionSkills,
        agent,
        ctx,
      };
    }

    async function activateGoal(agent, goalId) {
      const def = goalEngine.get(goalId);
      if (!def) return { prompt: '', messages: [], statePatch: {} };
      const result = await goalEngine.activate(goalId, envFor(agent));
      const patch = { ...(result.statePatch || {}) };
      if (def.phase) patch.phase = def.phase;
      writeState(agent, patch);
      return result;
    }

    async function applyTransition(agent, transition) {
      if (!transition) return null;
      const patch = { ...(transition.statePatch || {}) };
      if (transition.nextPhase) patch.phase = transition.nextPhase;
      if (transition.nextGoal) {
        writeState(agent, patch);
        return activateGoal(agent, transition.nextGoal);
      }
      patch.goal = null;
      writeState(agent, patch);
      return transition;
    }

    async function saveDefaultModelSelection(model) {
      const service = ctx.get('agentDefaultModel');
      if (!service || typeof service.saveSelection !== 'function') return false;
      try {
        await service.saveSelection({
          provider: model.provider || 'deepseek-official',
          model: model.model,
          ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
        });
        return true;
      } catch (err) {
        log(`保存默认模型失败：${(err && err.message) || err}`);
        return false;
      }
    }

    function promptWithSelectedModel(base, state) {
      const model = state.selectedModel;
      if (!model) return base;
      return `${base}\n\n[mode-gate] 本次任务选定模型：${model.provider}/${model.model}${model.reasoningEffort ? `（reasoning_effort=${model.reasoningEffort}）` : ''}`;
    }

    ctx.systemPrompt.section({
      name: 'mode-gate:policy',
      order: 95,
      text: (assembleCtx) => {
        const agent = assembleCtx && assembleCtx.agent;
        const state = readState(agent, defaultPhase);
        const denyList = readBashDenyList();
        const targetText = state.target ? state.target.target : '未声明';
        const targetModeText = state.target && state.target.mode ? state.target.mode : '（未指定）';
        const denyLines = denyList.length
          ? denyList.map((entry) => `  - ${entry.commands.join(', ')}：${entry.reason || '已禁止'}`).join('\n')
          : '  （无）';
        const goalDef = goalEngine.defFor(state);
        const goalPrompt = state.goal && state.goal.prompt ? state.goal.prompt : (goalDef ? goalDef.prompt(envFor(agent)) : '');
        const lines = [
          '[mode-gate]',
          `当前阶段：${state.phase}`,
          `当前 Target：${targetText}`,
          `Target 关联阶段：${targetModeText}`,
          `已声明 skills：${state.skills.length ? state.skills.join(', ') : '（无）'}`,
          `已声明 bash 命令：${state.bash.length ? state.bash.join(', ') : '（无）'}`,
          '规则：',
          '- 每次行动前必须先调用 declare_target 声明 Target，并同时声明本次需要的 skills 和 bash 命令。',
          MODE_RULES[state.phase] || MODE_RULES[DEFAULT_PHASE],
          '- 未声明就调用的 skill_load / bash 命令会被拦截；需要时调用 dev_tool_search（或 request_extra）申请，会作为问题向用户申报。不要花太多算力预判申请清单。',
          '- 始终可用：skill_search（查看所有 skill）、switch_mode（请求切换阶段）、dev_tool_search / request_extra（申请额外 skill/bash）。',
          '当前禁止的 bash 命令：',
          denyLines,
        ];
        if (state.goal && state.goal.status === 'active') {
          lines.push('', '当前目标：', goalPrompt);
        }
        if (state.phase === 'REQUIREMENT_RECOGNITION' && state.goal && state.goal.id === 'feature-intent-update') {
          lines.push('', modelCatalogText(state.modelCatalog, state.taskModes));
        }
        const base = lines.join('\n');
        return promptWithSelectedModel(base, state);
      },
    });

    ctx.tools.register(defineTool({
      name: 'declare_target',
      description: '声明当前任务目标（Target），可选关联一个执行阶段，并同时声明本次需要的 skills 和 bash 命令。必须在其他工具调用之前使用。',
      parameters: {
        target: {
          type: 'string',
          required: true,
          description: '任务目标/任务名，例如 "实现 mode-gate 插件" 或 "plan"。',
        },
        mode: {
          type: 'string',
          enum: [...PHASES],
          description: '该目标预期执行的阶段。缺省则保持当前阶段。',
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
        const before = readState(agent, defaultPhase);
        const skills = stringArray(args.skills);
        const bash = stringArray(args.bash);
        const target = { target: args.target, mode: args.mode };
        const patch = { target, skills, bash };
        const isFresh = !before.target && !before.goal;
        if (isFresh) patch.phase = DEFAULT_PHASE;
        writeState(agent, patch);
        if (isFresh) {
          await activateGoal(agent, 'preset-action-match');
        }
        const state = readState(agent, defaultPhase);
        return [
          `已声明 Target：${args.target}${args.mode ? `，关联阶段：${args.mode}` : ''}`,
          `当前阶段：${state.phase}`,
          `已声明 skills：${skills.length ? skills.join(', ') : '（无）'}`,
          `已声明 bash 命令：${bash.length ? bash.join(', ') : '（无）'}`,
        ].join('\n');
      },
    }));

    ctx.tools.register(defineTool({
      name: 'switch_mode',
      description: '请求切换当前阶段（PRESET_ACTION / REQUIREMENT_RECOGNITION / IMPLEMENT）。切换需要用户批准，批准后立即生效。',
      parameters: {
        mode: {
          type: 'string',
          enum: [...PHASES],
          required: true,
          description: '目标阶段。',
        },
        reason: {
          type: 'string',
          description: '一句话说明为什么要切换阶段。',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const agent = exec.agent;
        if (agent === void 0) throw new Error('switch_mode 需要 agent 上下文');
        writeState(agent, { phase: args.mode });
        return `阶段已切换为 ${args.mode}`;
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
        const state = readState(agent, defaultPhase);
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

    ctx.tools.register(defineTool({
      name: 'list_preset_actions',
      description: '列出所有 preset-action 候选 skill 的 id、说明与匹配条件。只有当前阶段为 PRESET_ACTION 时可用。',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(_args, exec) {
        if (!presetActionSkills.length) return '（暂无 preset action）';
        return JSON.stringify(presetActionSkills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          title: skill.title,
          description: skill.description,
          match: skill.match,
          model: skill.model,
          reasoning_effort: skill.reasoningEffort,
          content: skill.content,
        })), null, 2);
      },
    }));

    ctx.tools.register(defineTool({
      name: 'submit_preset_action',
      description: '提交 preset-action 探测协议。命中时填写 skill_id；未命中时填写 no_match: true。未命中会直接进入普通需求分解阶段。',
      parameters: {
        skill_id: {
          type: 'string',
          description: '命中的 preset action id（来自 list_preset_actions）。',
        },
        no_match: {
          type: 'boolean',
          description: '未命中任何 preset action 时填写 true。',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const agent = exec.agent;
        if (agent === void 0) throw new Error('submit_preset_action 需要 agent 上下文');
        const state = readState(agent, defaultPhase);
        const result = await goalEngine.submit('submit_preset_action', args, state, envFor(agent));
        if (!result.ok) throw new Error(result.reason);
        const transition = result.transition;
        await applyTransition(agent, transition);
        const selectedModel = transition.statePatch && transition.statePatch.selectedModel;
        if (selectedModel) await saveDefaultModelSelection(selectedModel);
        const saved = readState(agent, defaultPhase);
        return JSON.stringify({
          ok: true,
          phase: saved.phase,
          ...(selectedModel ? { selected_model: selectedModel } : {}),
          ...(transition.prompt ? { prompt: transition.prompt } : {}),
        }, null, 2);
      },
    }));

    ctx.tools.register(defineTool({
      name: 'list_feature_intents',
      description: '列出 feature intent 目录下的所有需求意图文件（名称、标题、大小、修改时间）。',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute() {
        const intents = await featureIntents.list();
        return JSON.stringify({ dir: featureIntents.dir, intents }, null, 2);
      },
    }));

    ctx.tools.register(defineTool({
      name: 'get_feature_intent',
      description: '读取指定的 feature intent 文件内容。',
      parameters: {
        name: {
          type: 'string',
          required: true,
          description: 'feature intent 文件名（不带目录，可选 .md 后缀）。',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const resolved = featureIntents.get(args.name);
        return JSON.stringify({
          name: resolved.name,
          file: resolved.file,
          path: resolved.path,
          content: resolved.content,
        }, null, 2);
      },
    }));

    ctx.tools.register(defineTool({
      name: 'update_feature_intent',
      description: '向指定 feature intent 文件追加一条原始需求记录（只在文件末尾 append，不重写）。若文件不存在则创建，创建时必须填写 project_overview。',
      parameters: {
        name: {
          type: 'string',
          required: true,
          description: 'feature intent 文件名（不带目录，可选 .md 后缀）。',
        },
        entry: {
          type: 'string',
          required: true,
          description: '要追加的原始需求记录与简单分析（日志式内容，不要精心排版的五段式文档）。',
        },
        project_overview: {
          type: 'string',
          description: '仅当目标文件不存在时必填：该项目的对应内容概述。',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const result = featureIntents.append(args.name, args.entry, args.project_overview);
        return JSON.stringify({
          ok: true,
          ...result,
          message: `已追加到 ${result.file}${result.created ? '（新建文件）' : ''}`,
        }, null, 2);
      },
    }));

    ctx.tools.register(defineTool({
      name: 'submit_requirement_protocol',
      description: '提交需求识别协议。只有当前阶段为 REQUIREMENT_RECOGNITION 且已追加过 feature intent 后可用。校验失败会返回错误，请修正后重试。',
      parameters: {
        protocol: {
          type: 'string',
          required: true,
          description: '固定为 requirement-recognition。',
        },
        version: {
          type: 'number',
          required: true,
          description: '固定为 1。',
        },
        task_mode: {
          type: 'string',
          enum: ['simple', 'complex'],
          required: true,
          description: '任务模式：simple（默认 flash）/ complex（默认 pro）。',
        },
        model_override: {
          type: 'object',
          additionalProperties: true,
          description: '可选。覆盖 task_mode 默认模型：{ provider, model, reasoning_effort }。',
        },
        feature_intent_file: {
          type: 'string',
          required: true,
          description: '本次查看/追加过的 feature intent 文件名（不带目录，可选 .md 后缀）。',
        },
        summary: {
          type: 'string',
          required: true,
          description: '一句话任务摘要。',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const agent = exec.agent;
        if (agent === void 0) throw new Error('submit_requirement_protocol 需要 agent 上下文');
        const state = readState(agent, defaultPhase);
        const result = await goalEngine.submit('submit_requirement_protocol', args, state, envFor(agent));
        if (!result.ok) throw new Error(result.reason);
        const transition = result.transition;
        const selectedModel = transition.statePatch && transition.statePatch.selectedModel;
        const saved = await applyTransition(agent, transition);
        if (selectedModel) {
          await saveDefaultModelSelection(selectedModel);
        }
        return JSON.stringify({
          ok: true,
          phase: (saved && saved.statePatch && saved.statePatch.phase) || 'IMPLEMENT',
          selected_model: selectedModel,
          ...(transition.prompt ? { prompt: transition.prompt } : {}),
        }, null, 2);
      },
    }));

    function hasFeatureIntentPath(value) {
      const dir = featureIntents.dir;
      if (typeof value === 'string') return value.includes(dir);
      if (Array.isArray(value)) return value.some((item) => hasFeatureIntentPath(item));
      if (value && typeof value === 'object') {
        return Object.values(value).some((item) => hasFeatureIntentPath(item));
      }
      return false;
    }

    function isFeatureIntentDirectWrite(name, args) {
      if (!hasFeatureIntentPath(args)) return false;
      if (KNOWN_WRITE_TOOLS.has(name) || name === 'str_replace_editor') return true;
      if (name === 'bash' || name === 'pwsh') {
        const command = String((args && args.command) || '');
        const kind = classifyCommand(command);
        return kind === 'mutating' || kind === 'dangerous';
      }
      return false;
    }

    ctx.on('tools/pre-execute', (exec, next) => {
      const name = exec.name;

      if (name === 'declare_target') return next();

      if (name === 'switch_mode') {
        const mode = exec.arguments && exec.arguments.mode;
        if (!PHASES.includes(mode)) {
          return Promise.resolve({ kind: 'deny', reason: `无效阶段 ${String(mode)}，可选：${PHASES.join('/')}` });
        }
        const state = readState(exec.agent, defaultPhase);
        if (state.goal && state.goal.status === 'active' && mode !== state.phase) {
          return Promise.resolve({
            kind: 'deny',
            reason: `当前目标未完成（${state.goal.id}），不能切换到 ${mode}。请先完成当前目标或提交协议。`,
          });
        }
        return Promise.resolve({
          kind: 'ask',
          reason: `是否允许把阶段切换到 ${mode}？${exec.arguments && exec.arguments.reason ? `原因：${exec.arguments.reason}` : ''}`,
        });
      }

      if (name === 'request_extra') {
        const requestedSkills = stringArray(exec.arguments && exec.arguments.skills);
        const requestedBash = stringArray(exec.arguments && exec.arguments.bash);
        if (requestedSkills.length || requestedBash.length) {
          const state = readState(exec.agent, defaultPhase);
          const items = [
            ...requestedSkills.map((s) => `skill: ${s}`),
            ...requestedBash.map((b) => `bash: ${b}`),
          ].join('、');
          return Promise.resolve({
            kind: 'ask',
            reason: `是否授予以下额外访问？${items}（当前阶段 ${state.phase}，批准后立即生效）`,
          });
        }
        return next();
      }

      const agent = exec.agent;
      const state = readState(agent, defaultPhase);

      if (!state.target && !ALLOWED_WITHOUT_TARGET.has(name)) {
        return Promise.resolve({
          kind: 'deny',
          reason: '尚未声明 Target。请先调用 declare_target 声明当前任务目标。',
        });
      }

      if (isFeatureIntentDirectWrite(name, exec.arguments)) {
        return Promise.resolve({
          kind: 'deny',
          reason: 'feature_intent 文件禁止直接修改。请使用 update_feature_intent 工具在文件末尾追加记录。',
        });
      }

      if (name === 'update_feature_intent' && state.phase !== 'REQUIREMENT_RECOGNITION') {
        return Promise.resolve({
          kind: 'deny',
          reason: `update_feature_intent 只在 REQUIREMENT_RECOGNITION 阶段可用，当前阶段为 ${state.phase}。`,
        });
      }
      if ((name === 'list_preset_actions' || name === 'submit_preset_action') && state.phase !== 'PRESET_ACTION') {
        return Promise.resolve({
          kind: 'deny',
          reason: `${name} 只在 PRESET_ACTION 阶段可用，当前阶段为 ${state.phase}。`,
        });
      }
      if (name === 'submit_requirement_protocol' && state.phase !== 'REQUIREMENT_RECOGNITION') {
        return Promise.resolve({
          kind: 'deny',
          reason: `submit_requirement_protocol 只在 REQUIREMENT_RECOGNITION 阶段可用，当前阶段为 ${state.phase}。`,
        });
      }

      if (state.goal && state.goal.status === 'active') {
        const def = goalEngine.defFor(state);
        if (def) {
          const allowedTools = goalEngine.allowedToolSet(def);

          if (name === 'bash' || name === 'pwsh') {
            if (!def.allowedBash || def.allowedBash.length === 0) {
              return Promise.resolve({
                kind: 'deny',
                reason: `当前目标「${def.id}」禁止使用 bash。请使用目标允许的工具：${[...allowedTools].join(', ')}`,
              });
            }
            const command = String((exec.arguments && exec.arguments.command) || '');
            const missing = undeclaredBashVerbs(command, state.bash);
            const unallowed = extractCommandVerbs(command).filter((verb) => !def.allowedBash.includes(verb));
            if (missing.length || unallowed.length) {
              return Promise.resolve({
                kind: 'deny',
                reason: `当前目标「${def.id}」只允许 bash 动词：${def.allowedBash.join(', ') || '（无）'}。命令：${command}`,
              });
            }
          }

          if (name !== 'bash' && name !== 'pwsh') {
            if (!allowedTools.has(name)) {
              return Promise.resolve({
                kind: 'deny',
                reason: `当前目标「${def.id}」未完成，只允许工具：${[...allowedTools].join(', ')}。你尝试调用 ${name}。`,
              });
            }
            return next();
          }
        }
      }

      if (name === 'bash' || name === 'pwsh') {
        const command = String((exec.arguments && exec.arguments.command) || '');
        const decision = bashDisposition(command, permissionModeForPhase(state.phase), state.bash, readBashDenyList());
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
        const decision = toolDisposition(name, permissionModeForPhase(state.phase));
        return decision.kind === 'allow' ? next() : Promise.resolve(decision);
      }

      if (name === 'str_replace_editor') {
        const permissionMode = permissionModeForPhase(state.phase);
        if (permissionMode === 'READ_ONLY' || permissionMode === 'PLAN_ONLY') {
          if (exec.arguments && exec.arguments.command === 'view') return next();
          return Promise.resolve({
            kind: 'deny',
            reason: `当前阶段为 ${state.phase}，str_replace_editor 仅允许 view 命令。`,
          });
        }
        return next();
      }

      if (KNOWN_WRITE_TOOLS.has(name)) {
        const permissionMode = permissionModeForPhase(state.phase);
        if (permissionMode === 'READ_ONLY' || permissionMode === 'PLAN_ONLY') {
          return Promise.resolve({ kind: 'deny', reason: `当前阶段为 ${state.phase}，禁止写工具 ${name}。` });
        }
        return next();
      }

      const decision = toolDisposition(name, permissionModeForPhase(state.phase));
      return decision.kind === 'allow' ? next() : Promise.resolve(decision);
    });

    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next();
      try {
        const agent = exec && exec.agent;
        const name = exec && exec.name;
        if (!agent || !name) return decision;
        const state = readState(agent, defaultPhase);
        if (!state.goal || state.goal.status !== 'active') return decision;
        const def = goalEngine.defFor(state);
        if (!def) return decision;
        if (result && result.isError === true) return decision;

        const recorded = goalEngine.recordCall(state, name);
        if (recorded !== state) writeState(agent, recorded);

        const after = readState(agent, defaultPhase);
        if (goalEngine.isAutoCompleted(after, def)) {
          const transition = await goalEngine.autoComplete(after, envFor(agent));
          if (transition) await applyTransition(agent, transition);
        }
      } catch (err) {
        log(`post-execute 目标推进失败：${(err && err.message) || err}`);
      }
      return decision;
    });

    // Best-effort per-agent model override: when a preset action / protocol
    // selects a model for the session, agent/request is patched for that
    // session when the harness routes a request through this agent. If the
    // session has already logged its selection, the request remains on the old
    // model; saveDefaultModelSelection above already persisted the new default
    // for future sessions and the prompt tells the user how to switch.
    ctx.on('agent/created', ({ agent }) => {
      try {
        const agentCtx = agent && agent.ctx;
        if (!agentCtx || typeof agentCtx.on !== 'function') return;
        agentCtx.on('agent/request', async (_payload, next) => {
          const resolved = await next();
          const state = readState(agent, defaultPhase);
          const selected = state.selectedModel;
          if (!selected) return resolved;
          return {
            ...resolved,
            provider: selected.provider || resolved.provider,
            model: selected.model || resolved.model,
            ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
          };
        });
      } catch (err) {
        log(`安装 agent/request 覆盖失败：${(err && err.message) || err}`);
      }
    });

    // Remote service consumed by the Web settings/footer to read durable state.
    new ModeGateGateway(ctx);
  },
};
