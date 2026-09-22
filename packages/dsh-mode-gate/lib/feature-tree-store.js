import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

/**
 * Feature intent 树状存储（overview + feature intent，递归同构）。
 *
 * 目录布局（相对 featureIntentDir）：
 *   - 顶层 `<id>.md`                → feature intent（叶子）
 *   - 顶层 `<folder>/overview.md`   → feature overview（文件夹节点，自身也是一份 intent 文档）
 *   - `<folder>/<child>.md`         → 该 overview 下的 feature intent
 *   - `<folder>/<sub>/overview.md`  → 嵌套 overview（同构，可无限叠加）
 *
 * 同构 pattern：每个 overview 目录内都有一份 `overview.md`（该层自己的意图说明）
 * 以及任意数量的子 intent / 子 overview；层级由目录嵌套自然表达。
 *
 * 兼容性：历史扁平的顶层 `.md` 直接作为根层 feature intent 显示，无需迁移。
 */

export const OVERVIEW_FILE = 'overview.md';

/** 逻辑路径分隔符统一为 `/`（与文件系统无关的稳定表示）。 */
function toLogical(path) {
  return String(path || '').split(sep).join('/');
}

/** 校验一段相对逻辑路径（可含 `/` 分层）：每段只能是安全文件名。 */
export function assertLogicalPath(raw, label = 'name') {
  const text = String(raw == null ? '' : raw).trim().replace(/^\/+|\/+$/g, '');
  if (text.length === 0) throw new Error(`${label} 不能为空`);
  const segments = text.split('/');
  for (const segment of segments) {
    if (!/^[a-zA-Z0-9._-]+$/.test(segment)) {
      throw new Error(`${label} "${raw}" 含非法字符，每层只允许字母、数字、_ . -`);
    }
    if (segment === '.' || segment === '..') throw new Error(`${label} "${raw}" 非法`);
  }
  return segments.join('/');
}

function stripMd(name) {
  return String(name).replace(/\.md$/i, '');
}

function titleOf(body) {
  if (typeof body !== 'string') return '';
  const heading = body.split(/\r?\n/).find((line) => /^#\s+/.test(line.trim()));
  if (heading) return heading.trim().replace(/^#\s+/, '');
  const first = body.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!first) return '';
  const compact = first.trim().replace(/^#+\s*/, '');
  return compact.length > 80 ? `${compact.slice(0, 80)}…` : compact;
}

/**
 * @param {string} featureIntentDir 根目录
 */
export function createFeatureTreeStore(featureIntentDir) {
  const root = resolve(String(featureIntentDir || ''));

  function ensureRoot() {
    mkdirSync(root, { recursive: true });
  }

  /** 逻辑路径 → 绝对路径（并做越界检查）。 */
  function absPathOf(logical) {
    const clean = assertLogicalPath(logical);
    const target = resolve(root, clean);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`路径 "${logical}" 越界`);
    }
    return { logical: clean, path: target };
  }

  function readMeta(filePath, fallbackName) {
    try {
      const stat = statSync(filePath);
      const body = readFileSync(filePath, 'utf8');
      return { name: fallbackName, title: titleOf(body), size: stat.size, mtime: stat.mtime.toISOString() };
    } catch (err) {
      return { name: fallbackName, title: '', size: 0, mtime: '', error: String((err && err.message) || err) };
    }
  }

  /** 递归扫描一个目录，返回它的子节点列表（已排序）。 */
  function scanDir(dirPath, logicalPrefix) {
    const out = [];
    let entries;
    try {
      entries = readdirSync(dirPath);
    } catch (_err) {
      return out;
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const full = join(dirPath, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch (_err) {
        continue;
      }
      if (stat.isDirectory()) {
        const logical = logicalPrefix ? `${logicalPrefix}/${entry}` : entry;
        const overviewPath = join(full, OVERVIEW_FILE);
        const hasOverview = existsSync(overviewPath);
        const meta = hasOverview ? readMeta(overviewPath, entry) : { name: entry, title: '', size: 0, mtime: '' };
        out.push({
          type: 'overview',
          name: entry,
          path: logical,
          hasOverview,
          ...meta,
          children: scanDir(full, logical),
        });
        continue;
      }
      if (!entry.toLowerCase().endsWith('.md')) continue;
      // 目录自身的 overview.md 由上层目录节点消费，不再作为同级子项。
      if (entry === OVERVIEW_FILE) continue;
      const logical = logicalPrefix ? `${logicalPrefix}/${entry}` : entry;
      const meta = readMeta(full, stripMd(entry));
      out.push({
        type: 'intent',
        name: stripMd(entry),
        path: logical.replace(/\.md$/i, ''),
        file: relative(root, full).split(sep).join('/'),
        ...meta,
      });
    }
    // overview 在前、intent 在后；同类按名称排序。
    out.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'overview' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  /** 读取整棵树（根节点数组）。 */
  function tree() {
    ensureRoot();
    return scanDir(root, '');
  }

  /** 扁平列出所有节点，附 type/path，便于菜单与校验。 */
  function flatten(nodes) {
    const out = [];
    const walk = (list) => {
      for (const node of list || []) {
        out.push({
          type: node.type,
          name: node.name,
          path: node.path,
          title: node.title,
          hasOverview: node.hasOverview,
        });
        if (node.children) walk(node.children);
      }
    };
    walk(nodes);
    return out;
  }

  /** 在指定父路径下创建一个 overview（文件夹节点，含 overview.md）。 */
  function createOverview(parentLogical, name, body) {
    ensureRoot();
    const cleanName = assertLogicalPath(name, 'overview 名称');
    if (cleanName.includes('/')) throw new Error(`overview 名称 "${name}" 不能包含 "/"`);
    const parent = parentLogical ? absPathOf(parentLogical).path : root;
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      throw new Error(`父 overview "${parentLogical}" 不存在`);
    }
    const dir = join(parent, cleanName);
    if (existsSync(dir)) throw new Error(`overview "${cleanName}" 已存在`);
    mkdirSync(dir, { recursive: true });
    const logical = parentLogical ? `${parentLogical}/${cleanName}` : cleanName;
    const text = String(body == null ? '' : body).trim() || `# ${cleanName}\n`;
    writeFileSync(join(dir, OVERVIEW_FILE), text.endsWith('\n') ? text : `${text}\n`);
    return { type: 'overview', name: cleanName, path: logical, created: true };
  }

  /** 在指定父路径下创建一个 feature intent 叶子文件。 */
  function createIntent(parentLogical, name, body) {
    ensureRoot();
    const cleanName = assertLogicalPath(name, 'feature intent 名称');
    if (cleanName.includes('/')) throw new Error(`feature intent 名称 "${name}" 不能包含 "/"`);
    if (cleanName === stripMd(OVERVIEW_FILE)) throw new Error(`feature intent 名称不能是 "${OVERVIEW_FILE}"`);
    const parent = parentLogical ? absPathOf(parentLogical).path : root;
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      throw new Error(`父 overview "${parentLogical}" 不存在`);
    }
    const file = join(parent, `${cleanName}.md`);
    if (existsSync(file)) throw new Error(`feature intent "${cleanName}" 已存在`);
    const text = String(body == null ? '' : body).trim() || `# ${cleanName}\n`;
    writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
    const logical = parentLogical ? `${parentLogical}/${cleanName}` : cleanName;
    return { type: 'intent', name: cleanName, path: logical, created: true };
  }

  /** 读取某个节点的文档内容（intent 为其 md，overview 为其 overview.md）。 */
  function contentOf(type, logical) {
    const base = absPathOf(logical);
    const file = type === 'overview' ? join(base.path, OVERVIEW_FILE) : `${base.path}.md`;
    if (!existsSync(file)) throw new Error(`节点 "${logical}" 的文档不存在`);
    return { path: relative(root, file).split(sep).join('/'), content: readFileSync(file, 'utf8') };
  }

  /**
   * 沿树上溯：给定一批选中节点路径，收集它们自身及所有祖先 overview 的逻辑路径
   * （去重，父在前）。用于「冒泡收集 overview / architecture.md」。
   */
  function ancestorsOf(selectedPaths) {
    const seen = new Set();
    const out = [];
    for (const raw of selectedPaths || []) {
      const segments = assertLogicalPath(raw).split('/');
      // 从最外层到最内层，逐级累积（末段若是叶子 intent 也保留其路径）。
      for (let i = 1; i <= segments.length; i += 1) {
        const logical = segments.slice(0, i).join('/');
        if (!seen.has(logical)) {
          seen.add(logical);
          out.push(logical);
        }
      }
    }
    return out;
  }

  return {
    dir: root,
    tree,
    flatten,
    createOverview,
    createIntent,
    contentOf,
    ancestorsOf,
  };
}
