import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { matchBashDeny, normalizeDenyList } from './bash.js';

/**
 * 通用 AI 限制抽象（一套限制配置）。
 *
 * {
 *   id: string,            // 文件名（不带后缀），仅字母数字 _ . -
 *   label: string,         // 展示名
 *   mode: 'blacklist' | 'whitelist',  // 二选一，同套配置只能用其一
 *   denyCommands: [{ commands: string[], reason: string }],  // 仅 blacklist
 *   denySkills: string[],                                    // 仅 blacklist
 *   denyTools: string[],                                     // 仅 blacklist（禁整个工具，如 read/grep）
 *   allowSkills: string[],                                   // 仅 whitelist
 * }
 *
 * 互斥规则：blacklist 模式下 allowSkills 必须为空；whitelist 模式下
 * denyCommands / denySkills / denyTools 必须为空。违反时 normalize 抛错，保存被拒绝。
 */

export const RESTRICTION_MODES = ['blacklist', 'whitelist'];

function cleanStringArray(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/** 校验并规整一套限制配置；违反黑白互斥时抛错。 */
export function normalizeRestrictionSet(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('限制配置必须是对象');
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error(`限制 id "${raw.id}" 非法，只允许字母、数字、_ . -`);
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : id;
  const mode = typeof raw.mode === 'string' ? raw.mode.trim() : '';
  if (mode !== 'blacklist' && mode !== 'whitelist') {
    throw new Error(`限制 "${id}" 的 mode 必须是 blacklist 或 whitelist 之一`);
  }
  // 注意：normalizeDenyList(undefined) 会注入默认条目；未填写时必须视为空，避免误触发互斥校验。
  const denyCommands = raw.denyCommands === void 0 ? [] : normalizeDenyList(raw.denyCommands);
  const denySkills = cleanStringArray(raw.denySkills);
  const denyTools = cleanStringArray(raw.denyTools);
  const allowSkills = cleanStringArray(raw.allowSkills);
  if (mode === 'blacklist' && allowSkills.length > 0) {
    throw new Error(`限制 "${id}" 为 blacklist 模式，不能同时填写 allowSkills（白名单）；一套配置只能使用其中之一`);
  }
  if (mode === 'whitelist' && (denyCommands.length > 0 || denySkills.length > 0 || denyTools.length > 0)) {
    throw new Error(`限制 "${id}" 为 whitelist 模式，不能同时填写 denyCommands / denySkills / denyTools（黑名单）；一套配置只能使用其中之一`);
  }
  return { id, label, mode, denyCommands, denySkills, denyTools, allowSkills };
}

/**
 * 内置限制（文件缺失时回退，保证 INIT 等引用开箱即用，不写盘）。
 * no-code-read：禁全部文件查看工具，INIT 默认引用。
 */
export const BUILTIN_RESTRICTION_SETS = {
  'no-code-read': {
    id: 'no-code-read',
    label: '不读代码（INIT 默认引用）',
    mode: 'blacklist',
    denyCommands: [],
    denySkills: [],
    denyTools: [
      'read', 'grep', 'glob', 'str_replace_editor',
      'read_url', 'read_url_batch', 'read_url_links', 'read_url_site',
      'read_image', 'web_search',
    ],
    allowSkills: [],
  },
};

/** 取限制集：文件优先，缺失时回退到同名内置；都没有则抛错。 */
export function getRestrictionOrBuiltin(store, id) {
  const key = typeof id === 'string' ? id.trim() : '';
  if (!key) throw new Error('限制引用为空');
  if (store && typeof store.get === 'function') {
    try {
      return { ...store.get(key), builtin: false };
    } catch (_err) {
      // 文件缺失则尝试内置回退
    }
  }
  const builtin = BUILTIN_RESTRICTION_SETS[key];
  if (builtin) return { ...builtin, builtin: true };
  throw new Error(`限制 "${key}" 不存在（无文件也无内置）`);
}

/** 黑名单模式：命令命中 denyCommands 时返回命中的条目，否则 null。白名单模式不管命令。 */
export function matchRestrictionDenyCommand(set, command) {
  if (!set || set.mode !== 'blacklist') return null;
  if (!Array.isArray(set.denyCommands) || set.denyCommands.length === 0) return null;
  return matchBashDeny(command, set.denyCommands);
}

/**
 * 工具是否被该套限制拒绝（仅 blacklist 的 denyTools 生效；
 * whitelist 只约束 skill，工具走 state 权限）。
 */
export function isToolDeniedByRestriction(set, toolName) {
  if (!set || set.mode !== 'blacklist') return false;
  if (typeof toolName !== 'string' || !toolName) return false;
  return Array.isArray(set.denyTools) && set.denyTools.includes(toolName);
}

/**
 * skill 是否被该套限制拒绝：
 * - blacklist：命中 denySkills 即拒绝；
 * - whitelist：不在 allowSkills 即拒绝（空 allowSkills = 全部拒绝）。
 */
export function isSkillDeniedByRestriction(set, skillName) {
  if (!set || typeof skillName !== 'string' || !skillName) return false;
  if (set.mode === 'blacklist') {
    return Array.isArray(set.denySkills) && set.denySkills.includes(skillName);
  }
  if (set.mode === 'whitelist') {
    return !(Array.isArray(set.allowSkills) && set.allowSkills.includes(skillName));
  }
  return false;
}

/**
 * 限制套件的文件存储：一套限制一个 JSON 文件。
 * 与 feature-intent-store 同模式：安全文件名、禁目录穿越。
 */
export function createRestrictionStore(restrictionsDir) {
  const root = resolve(String(restrictionsDir || ''));

  function pathFor(id) {
    const clean = basename(String(id || '').trim()).replace(/\.json$/i, '');
    if (!clean || !/^[a-zA-Z0-9._-]+$/.test(clean)) {
      throw new Error(`限制 id "${id}" 非法，只能使用文件名（不带目录，可选 .json 后缀）`);
    }
    if (clean !== String(id || '').trim().replace(/\.json$/i, '')) {
      throw new Error(`限制 id "${id}" 非法，不能包含目录`);
    }
    const target = resolve(root, `${clean}.json`);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`限制 id "${id}" 越界`);
    }
    return { id: clean, file: `${clean}.json`, path: target };
  }

  function ensureRoot() {
    mkdirSync(root, { recursive: true });
  }

  async function list() {
    ensureRoot();
    const out = [];
    let dirents = [];
    try {
      dirents = readdirSync(root);
    } catch (_err) {
      return out;
    }
    for (const dirent of dirents) {
      if (!dirent.endsWith('.json')) continue;
      const filePath = join(root, dirent);
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf8'));
        const set = normalizeRestrictionSet({ ...raw, id: dirent.slice(0, -5) });
        const stat = statSync(filePath);
        out.push({ ...set, file: dirent, mtime: stat.mtime.toISOString() });
      } catch (err) {
        out.push({ id: dirent.slice(0, -5), file: dirent, label: dirent.slice(0, -5), mode: '', error: String((err && err.message) || err) });
      }
    }
    out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return out;
  }

  function get(id) {
    const resolved = pathFor(id);
    if (!existsSync(resolved.path)) {
      throw new Error(`限制 "${resolved.file}" 不存在`);
    }
    const raw = JSON.parse(readFileSync(resolved.path, 'utf8'));
    return { ...normalizeRestrictionSet({ ...raw, id: resolved.id }), file: resolved.file, path: resolved.path };
  }

  function save(raw) {
    ensureRoot();
    const set = normalizeRestrictionSet(raw);
    const resolved = pathFor(set.id);
    const created = !existsSync(resolved.path);
    writeFileSync(resolved.path, JSON.stringify(set, null, 2));
    return { ...set, file: resolved.file, path: resolved.path, created };
  }

  function remove(id) {
    const resolved = pathFor(id);
    if (!existsSync(resolved.path)) {
      throw new Error(`限制 "${resolved.file}" 不存在`);
    }
    unlinkSync(resolved.path);
    return { id: resolved.id, file: resolved.file, deleted: true };
  }

  return { dir: root, list, get, save, remove, pathFor };
}
