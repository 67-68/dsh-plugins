/**
 * Bash command classifier + read-only whitelist for mode-gate.
 *
 * The classifier half is extracted verbatim from the legacy index.js so the
 * existing security behavior is preserved. On top of it, READ_ONLY_BASH_VERBS
 * describes commands that are allowed in EVERY state without being declared in
 * declare_target, as long as the command still classifies as read-only and does
 * not carry a write-capable flag.
 */

/** Default bash deny-list entries; overridable from the Web settings tab. */
export const DEFAULT_BASH_DENY_LIST = [
  {
    id: 'deny-web-fetch',
    commands: ['curl', 'wget'],
    reason: '禁止使用 curl/wget 抓取网页，请改用 read_url 工具',
  },
];

/** Harmless read-only bash built-ins that never need to be declared. */
export const ALWAYS_ALLOWED_BASH_VERBS = new Set(['echo', 'printf', 'pwd', 'cd', 'true', 'false']);

/**
 * Simple read-only commands allowed in every state without declaration.
 * Every verb here is additionally guarded: the whole command must classify as
 * read-only, and verbs with write-capable flags are rejected by the guard table.
 */
export const READ_ONLY_BASH_VERBS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'wc', 'pwd', 'echo', 'printf',
  'true', 'false', 'cd', 'which', 'whoami', 'date', 'file', 'stat', 'du', 'df',
  'basename', 'dirname', 'realpath', 'readlink', 'jq', 'tree', 'cut', 'tr',
  'sed', 'find', 'sort',
]);

/** Per-verb write-capable flags that disqualify an otherwise read-only verb. */
export const READ_ONLY_VERB_GUARDS = {
  sed: ['-i', '--in-place'],
  find: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'],
  sort: ['-o', '--output'],
};

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `flag` appears as a standalone token in the raw command string. */
function hasStandaloneFlag(command, flag) {
  return new RegExp(`(^|[\\s;|&])${escapeRegExp(flag)}([\\s;|&]|$)`).test(String(command || ''));
}

/**
 * Whether a command is safe to run in every state without declaring its verbs.
 * Requires: non-empty verbs, all verbs whitelisted, no guard flag, and the
 * overall classifier verdict to be read-only.
 */
export function isAlwaysAllowedBash(command) {
  const verbs = extractCommandVerbs(command);
  if (verbs.length === 0) return false;
  for (const verb of verbs) {
    if (ALWAYS_ALLOWED_BASH_VERBS.has(verb)) continue;
    if (!READ_ONLY_BASH_VERBS.has(verb)) return false;
    const guards = READ_ONLY_VERB_GUARDS[verb];
    if (Array.isArray(guards) && guards.some((flag) => hasStandaloneFlag(command, flag))) return false;
  }
  return classifyCommand(command) === 'read-only';
}

/** Commands that must be declared unless the whole command is harmlessly read-only. */
export function undeclaredBashVerbs(command, declaredBash) {
  if (isAlwaysAllowedBash(command)) return [];
  const set = new Set(declaredBash);
  return extractCommandVerbs(command).filter((verb) => !set.has(verb) && !ALWAYS_ALLOWED_BASH_VERBS.has(verb));
}
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

function classifyCommandBase(command) {
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
function matchBashDeny(command, denyList) {
  const verbs = extractCommandVerbs(command);
  for (const entry of denyList) {
    for (const banned of entry.commands) {
      if (verbs.includes(banned)) return entry;
    }
  }
  return null;
}

/** Extra write-capable flags on otherwise read-only verbs. */
function commandHasWriteGuard(command) {
  for (const [verb, flags] of Object.entries(READ_ONLY_VERB_GUARDS)) {
    if (!extractCommandVerbs(command).includes(verb)) continue;
    if (flags.some((flag) => hasStandaloneFlag(command, flag))) return true;
  }
  return false;
}

/**
 * Public classifier: the extracted base verdict, upgraded to `mutating` when a
 * whitelisted verb carries a write-capable flag (sed -i, find -exec, sort -o).
 */
function classifyCommand(command) {
  const base = classifyCommandBase(command);
  if (commandHasWriteGuard(command)) return base === 'dangerous' ? 'dangerous' : 'mutating';
  return base;
}

export { classifyCommand, extractCommandVerbs, matchBashDeny, normalizeDenyList, stringArray };
