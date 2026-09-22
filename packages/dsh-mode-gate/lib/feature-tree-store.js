import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

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

/** 目录里是否有真实内容（空目录不算命中）。 */
function dirHasContent(dir) {
  try {
    return readdirSync(dir).some((entry) => !entry.startsWith('.'));
  } catch (_err) {
    return false;
  }
}

/** 发现扫描时跳过的目录（依赖/产物/系统目录，避免在 workspace 里乱翻）。 */
const DISCOVERY_SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target',
  '.next', '.turbo', '.cache', 'venv', '__pycache__', 'Pods', 'Library', 'Applications',
]);

/** 相对路径的尾部是否命中某个候选目录名（大小写不敏感，兼容 DOCUMENT/DOCUMENTATION）。 */
function matchesCandidate(relPath, candidates) {
  const segs = String(relPath || '').toLowerCase().split('/');
  for (const candidate of candidates) {
    const wanted = String(candidate || '').toLowerCase().split('/');
    if (segs.length < wanted.length) continue;
    if (segs.slice(segs.length - wanted.length).join('/') === wanted.join('/')) return true;
  }
  return false;
}

/**
 * 在一个 workspace 里发现所有 feature intent 目录（相对 workspace 的路径）。
 *
 * 场景：workspace 可能是「多个项目的容器」（例如 /Users/x/projects 下每个子项目
 * 各有一份 feature_intents）。这时不能只看 workspace 根层，而要往下找。
 *
 * @param {string} workspaceRoot 工作区根目录
 * @param {string[]} candidates 候选相对目录名（如 feature_intents、document/feature_intent）
 * @param {{maxDepth?: number}} [options] maxDepth 为向下递归的层数（默认 3）
 * @returns {Array<{rel: string, abs: string}>} 命中的目录（有内容才算），按 rel 排序
 */
export function discoverFeatureIntentDirs(workspaceRoot, candidates, options) {
  const root = resolve(String(workspaceRoot || ''));
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) => typeof c === 'string' && c.trim());
  const maxDepth = options && Number.isFinite(options.maxDepth) ? options.maxDepth : 3;
  const out = [];
  const seen = new Set();
  const walk = (dir, rel, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name.startsWith('.') || DISCOVERY_SKIP_DIRS.has(name)) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const childAbs = join(dir, name);
      if (matchesCandidate(childRel, list)) {
        // intent 目录本身是叶子：有内容才算命中，且不再往里递归。
        if (dirHasContent(childAbs) && !seen.has(childRel)) {
          seen.add(childRel);
          out.push({ rel: childRel, abs: childAbs });
        }
        continue;
      }
      walk(childAbs, childRel, depth + 1);
    }
  };
  walk(root, '', 0);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

/**
 * @param {string} featureIntentDir 根目录
 * @param {{mounts?: Array<{rel: string, abs: string}>}} [options]
 *        mounts：把若干**已有**的 feature intent 目录挂成顶层 overview 文件夹。
 *        overview 本身即文件夹（可嵌套），所以挂载不引入新的节点类型：
 *        顶层文件夹下依然是 overview / feature intent 的同一套树。
 */
export function createFeatureTreeStore(featureIntentDir, options) {
  const root = resolve(String(featureIntentDir || ''));
  const mounts = (options && Array.isArray(options.mounts) ? options.mounts : [])
    .filter((mount) => mount && typeof mount.abs === 'string' && mount.abs.trim() && typeof mount.rel === 'string' && mount.rel.trim())
    .map((mount) => ({
      rel: String(mount.rel).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
      abs: resolve(mount.abs),
    }))
    .filter((mount) => mount.rel.length > 0);

  function ensureRoot() {
    mkdirSync(root, { recursive: true });
  }

  /** 逻辑路径 → 绝对路径（并做越界检查）；空路径表示根目录自身。 */
  function absPathOf(logical) {
    const raw = String(logical == null ? '' : logical).trim();
    if (raw === '' || raw === '.' || raw === '/') return { logical: '', path: root };
    const clean = assertLogicalPath(raw);
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

  /** 把一个已发现的 feature intent 目录挂成顶层 overview 文件夹。 */
  function mountNode(mount) {
    const overviewPath = join(mount.abs, OVERVIEW_FILE);
    const hasOverview = existsSync(overviewPath);
    const meta = hasOverview ? readMeta(overviewPath, mount.rel) : { name: mount.rel, title: '', size: 0, mtime: '' };
    return {
      type: 'overview',
      name: mount.rel,
      path: mount.rel,
      mounted: true,
      hasOverview,
      ...meta,
      children: scanDir(mount.abs, mount.rel),
    };
  }

  /** 读取整棵树（根节点数组）。 */
  function tree() {
    // 多项目 workspace：顶层就是各个项目目录（文件夹），不是所有子目录。
    if (mounts.length > 0) {
      return mounts.map((mount) => mountNode(mount)).sort((a, b) => a.path.localeCompare(b.path));
    }
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

  /** 多项目 workspace 下，顶层不允许直接写（必须先选一个项目目录）。 */
  function assertParentWritable(parentLogical) {
    if (mounts.length > 0 && !parentLogical) {
      throw new Error('当前 workspace 下发现多个 feature intent 目录：请先选择要写入的项目目录（顶层文件夹）作为父 overview。');
    }
  }

  /** 在指定父路径下创建一个 overview（文件夹节点，含 overview.md）。 */
  function createOverview(parentLogical, name, body) {
    assertParentWritable(parentLogical);
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
    assertParentWritable(parentLogical);
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
    if (!existsSync(file)) throw new Error(`节点 "${logical || '(根)'}" 的文档不存在`);
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

  /**
   * 收集本次选择需要注入的 architecture.md：沿树上溯，每一层「文件夹」
   * （各级 overview 目录 + 根目录）下若有 architecture.md 就纳入；去重、父在前。
   *
   * @param {Array<{type:string,path:string}>} selection 选中的节点
   * @returns {Array<{level:string,path:string,content:string}>} 存在且非空的架构文件
   */
  function architecturesFor(selection) {
    const items = Array.isArray(selection) ? selection : [];
    // 1. 展开每项为「它自己所属的目录链」：intent 的目录链是其父目录；overview 的是它自身。
    const dirs = [];
    const seenDirs = new Set();
    const pushDir = (logical) => {
      if (seenDirs.has(logical)) return;
      seenDirs.add(logical);
      dirs.push(logical);
    };
    for (const item of items) {
      if (!item || typeof item.path !== 'string') continue;
      let segments;
      try {
        segments = assertLogicalPath(item.path).split('/');
      } catch (_err) {
        continue;
      }
      const isOverview = item.type === 'overview';
      // intent：路径末段是文件名，目录链到倒数第二段；overview：整个路径都是目录。
      const dirSegments = isOverview ? segments : segments.slice(0, -1);
      for (let i = dirSegments.length; i >= 0; i -= 1) {
        pushDir(dirSegments.slice(0, i).join('/'));
      }
    }
    // 2. 父在前排序：按目录深度升序（根 '' 最先）。
    dirs.sort((a, b) => {
      const da = a ? a.split('/').length : 0;
      const db = b ? b.split('/').length : 0;
      return da - db || a.localeCompare(b);
    });
    // 3. 每层若存在非空 architecture.md 就纳入（去重）。
    //    根层额外看「intent 目录的父目录」：architecture.md 的默认位置就是
    //    dirname(featureIntentDir)（例如 documentation/feature_intents →
    //    documentation/architecture.md），父目录即最外层，放在最前。
    const out = [];
    const seenPaths = new Set();
    for (const dir of dirs) {
      const candidates = dir
        ? [join(root, dir, 'architecture.md')]
        : [join(dirname(root), 'architecture.md'), join(root, 'architecture.md')];
      for (const file of candidates) {
        if (!existsSync(file)) continue;
        if (seenPaths.has(file)) continue;
        let text = '';
        try {
          text = readFileSync(file, 'utf8');
        } catch (_err) {
          continue;
        }
        if (!text.trim()) continue;
        seenPaths.add(file);
        out.push({ level: dir || '(根)', path: file, content: text });
      }
    }
    return out;
  }

  /** 每层 architecture.md 的父目录（供生成 code map）。 */
  function architectureDirsFor(selection) {
    return architecturesFor(selection).map((entry) => dirname(entry.path));
  }

  /**
   * 定位一个节点，返回它的完整层级信息：
   *   - node：节点自身（type/path/name/title）
   *   - ancestors：从根到该节点父级的每一层（父在前，直到没有为止）
   *   - children：全部**直属**下属（overview 的下一层 overview / intent）
   *
   * 找不到时抛错（未知路径）。
   */
  function describeNode(logical) {
    const clean = assertLogicalPath(logical);
    // 逐层下钻定位节点；同时记录父链。挂载的顶层文件夹路径可能有多段
    // （如 documentation/feature_intents），因此按「路径前缀」下钻。
    let levelNodes = tree();
    const ancestors = [];
    let found = null;
    let prefix = '';
    let rest = clean;
    while (rest && !found) {
      const full = prefix ? `${prefix}/${rest}` : rest;
      const exact = (levelNodes || []).find((node) => node.path === full);
      const branch = exact || (levelNodes || []).find((node) => node.path && full.startsWith(`${node.path}/`));
      if (!branch) {
        throw new Error(`节点 "${clean}" 不存在（在 "${rest}" 处断开）。请先用 feature_tree 不带参数查看根层级。`);
      }
      if (exact) {
        found = exact;
        break;
      }
      ancestors.push({ type: branch.type, path: branch.path, name: branch.name, title: branch.title || '' });
      levelNodes = branch.children || [];
      prefix = branch.path;
      rest = full.slice(branch.path.length + 1);
    }
    if (!found) throw new Error(`节点 "${clean}" 不存在。`);
    const children = (found.children || []).map((node) => ({
      type: node.type,
      path: node.path,
      name: node.name,
      title: node.title || '',
      hasChildren: Boolean(node.children && node.children.length > 0),
    }));
    return {
      node: { type: found.type, path: found.path, name: found.name, title: found.title || '' },
      ancestors,
      children,
    };
  }

  return {
    dir: root,
    tree,
    flatten,
    createOverview,
    createIntent,
    contentOf,
    ancestorsOf,
    architecturesFor,
    architectureDirsFor,
    describeNode,
  };
}
