import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

/**
 * project-experience store.
 *
 * Layout (sibling of feature_intents, no DOCUMENT layer):
 *   <workspace>/project-experience/<project>/intro.md
 *   <workspace>/project-experience/<project>/map-of-content.md
 *   <workspace>/project-experience/<project>/anti-patterns.md
 *   <workspace>/project-experience/<project>/core-state-tree.md
 */

export const EXPERIENCE_FILES = [
  { key: 'intro', file: 'intro.md', label: '项目介绍' },
  { key: 'mapOfContent', file: 'map-of-content.md', label: '系统拓扑 (Map of Content)' },
  { key: 'antiPatterns', file: 'anti-patterns.md', label: '血泪法则 (Anti-patterns & Rules)' },
  { key: 'coreStateTree', file: 'core-state-tree.md', label: '核心状态树' },
];

export const EXPERIENCE_FILE_BY_KEY = new Map(EXPERIENCE_FILES.map((entry) => [entry.key, entry]));
export const EXPERIENCE_FILE_BY_NAME = new Map(EXPERIENCE_FILES.map((entry) => [entry.file, entry]));

/** Default project-experience dir: sibling of the feature-intent dir. */
export function defaultProjectExperienceDir(featureIntentDir) {
  return join(dirname(resolve(String(featureIntentDir || ''))), 'project-experience');
}

function safeProjectName(name) {
  const clean = basename(String(name || '').trim()).replace(/\.md$/i, '');
  if (clean.length === 0) throw new Error('project 名称不能为空');
  if (!/^[a-zA-Z0-9._-]+$/.test(clean)) {
    throw new Error(`project 名称 "${clean}" 含非法字符，只允许字母、数字、_ . -`);
  }
  return clean;
}

export function createProjectExperienceStore(rootDir) {
  const root = resolve(String(rootDir || ''));

  function dirFor(project) {
    const name = safeProjectName(project);
    const target = resolve(root, name);
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`project "${name}" 越界`);
    return { name, dir: target };
  }

  function ensureRoot() {
    mkdirSync(root, { recursive: true });
  }

  /** Create the folder, intro and three empty files when missing. Idempotent. */
  function ensureProject(project, overview) {
    ensureRoot();
    const { name, dir } = dirFor(project);
    mkdirSync(dir, { recursive: true });
    const introPath = join(dir, 'intro.md');
    if (!existsSync(introPath)) {
      const text = typeof overview === 'string' && overview.trim()
        ? overview.trim()
        : `# ${name}\n\n（项目介绍待补充）`;
      writeFileSync(introPath, `${text}\n`);
    }
    for (const entry of EXPERIENCE_FILES) {
      if (entry.key === 'intro') continue;
      const file = join(dir, entry.file);
      if (!existsSync(file)) writeFileSync(file, `# ${entry.label}\n`);
    }
    return { name, dir };
  }

  function listProjects() {
    ensureRoot();
    const out = [];
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch (_err) {
        continue;
      }
      out.push({
        project: entry,
        dir,
        hasIntro: existsSync(join(dir, 'intro.md')),
      });
    }
    out.sort((a, b) => a.project.localeCompare(b.project));
    return out;
  }

  function readProject(project) {
    const { name, dir } = dirFor(project);
    if (!existsSync(dir)) {
      throw new Error(`project-experience "${name}" 不存在。请先创建对应 feature intent，或检查 project 名称。`);
    }
    const files = {};
    for (const entry of EXPERIENCE_FILES) {
      const file = join(dir, entry.file);
      files[entry.key] = existsSync(file) ? readFileSync(file, 'utf8') : '';
    }
    return { project: name, dir, files };
  }

  function resolveFile(project, fileKey) {
    const { name, dir } = dirFor(project);
    const entry = EXPERIENCE_FILE_BY_KEY.get(fileKey) || EXPERIENCE_FILE_BY_NAME.get(fileKey);
    if (!entry) {
      throw new Error(`未知 project-experience 文件 "${fileKey}"。可用：${EXPERIENCE_FILES.map((e) => `${e.key}(${e.file})`).join(', ')}`);
    }
    return { project: name, dir, entry, path: join(dir, entry.file) };
  }

  /** Append-only write. Creates the file when missing. */
  function append(project, fileKey, content) {
    ensureProject(project);
    const { path } = resolveFile(project, fileKey);
    const text = String(content || '').trim();
    if (text.length === 0) throw new Error('append 内容不能为空');
    const prefix = existsSync(path) && readFileSync(path, 'utf8').trim().length > 0 ? '\n\n' : '';
    appendFileSync(path, `${prefix}${text}\n`);
    return { project, file: resolveFile(project, fileKey).entry.file, path, mode: 'append' };
  }

  /** Full overwrite. Callers must obtain user approval first. */
  function overwrite(project, fileKey, content) {
    ensureProject(project);
    const { path, entry } = resolveFile(project, fileKey);
    const text = String(content || '');
    writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`);
    return { project, file: entry.file, path, mode: 'overwrite' };
  }

  /** Current content plus a naive line diff summary for approval prompts. */
  function diff(project, fileKey, nextContent) {
    const { path, entry } = resolveFile(project, fileKey);
    const previous = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const before = previous.split(/\r?\n/);
    const after = String(nextContent || '').split(/\r?\n/);
    let removed = 0;
    let added = 0;
    const max = Math.max(before.length, after.length);
    for (let i = 0; i < max; i += 1) {
      if (before[i] === undefined) added += 1;
      else if (after[i] === undefined) removed += 1;
      else if (before[i] !== after[i]) { added += 1; removed += 1; }
    }
    return { project, file: entry.file, path, previous, removed, added };
  }

  return {
    root,
    dirFor,
    ensureProject,
    listProjects,
    readProject,
    append,
    overwrite,
    diff,
    resolveFile,
  };
}
