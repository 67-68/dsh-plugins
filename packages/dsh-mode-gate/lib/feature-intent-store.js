import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';

/**
 * Append-only store for raw feature-intent records.
 *
 * Feature intents are deliberately log-like: each entry is appended to the
 * end of a per-project `.md` file. The store never rewrites or truncates an
 * existing file. Creating a NEW file is the only `writeFileSync` path, and it
 * requires a `project_overview` so the first record describes the project.
 */
export function createFeatureIntentStore(featureIntentDir) {
  const root = resolve(String(featureIntentDir || ''));

  function pathFor(name) {
    if (typeof name !== 'string') throw new Error('feature intent name 必须是字符串');
    const clean = basename(String(name).trim()).replace(/\.md$/i, '');
    if (clean.length === 0) throw new Error('feature intent name 不能为空');
    if (clean !== String(name).trim().replace(/\.md$/i, '')) {
      throw new Error(`feature intent name "${name}" 非法，只能使用文件名（不带目录，可选 .md 后缀）`);
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(clean)) {
      throw new Error(`feature intent name "${clean}" 含非法字符，只允许字母、数字、_ . -`);
    }
    const target = resolve(root, `${clean}.md`);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`feature intent name "${name}" 越界`);
    }
    return { name: clean, file: `${clean}.md`, path: target };
  }

  function ensureRoot() {
    mkdirSync(root, { recursive: true });
  }

  function titleOf(body) {
    if (typeof body !== 'string') return '';
    const firstHeading = body.split(/\r?\n/).find((line) => /^#\s+/.test(line.trim()));
    if (firstHeading) return firstHeading.trim().replace(/^#\s+/, '');
    const firstLine = body.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (!firstLine) return '';
    const compact = firstLine.trim().replace(/^#+\s*/, '');
    return compact.length > 80 ? `${compact.slice(0, 80)}…` : compact;
  }

  async function list() {
    ensureRoot();
    const out = [];
    const dirents = readdirSync(root);
    for (const dirent of dirents) {
      if (!dirent.endsWith('.md')) continue;
      const name = dirent.slice(0, -3);
      const filePath = join(root, dirent);
      try {
        const stat = statSync(filePath);
        const body = readFileSync(filePath, 'utf8');
        out.push({
          name,
          file: dirent,
          title: titleOf(body),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      } catch (err) {
        out.push({ name, file: dirent, title: '', size: 0, mtime: '', error: String((err && err.message) || err) });
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  function get(name) {
    const resolved = pathFor(name);
    if (!existsSync(resolved.path)) {
      throw new Error(`feature intent "${resolved.file}" 不存在。请先调用 list_feature_intents 查看可用文件。`);
    }
    return {
      ...resolved,
      content: readFileSync(resolved.path, 'utf8'),
    };
  }

  /**
   * Append one raw record. When the file does not exist yet, `projectOverview`
   * is mandatory and becomes the opening project description.
   */
  function append(name, entry, projectOverview) {
    ensureRoot();
    const resolved = pathFor(name);
    const created = !existsSync(resolved.path);
    if (created) {
      const overview = typeof projectOverview === 'string' ? projectOverview.trim() : '';
      if (overview.length === 0) {
        throw new Error('目标 feature intent 文件不存在，创建时必须填写 project_overview 字段（项目对应内容）。');
      }
      writeFileSync(
        resolved.path,
        `# ${resolved.name}\n\n## Project Overview\n\n${overview}\n`,
      );
    }
    const record = typeof entry === 'string' ? entry.trim() : '';
    if (record.length === 0) throw new Error('feature intent 记录内容不能为空');
    appendFileSync(
      resolved.path,
      `\n---\n\n## ${new Date().toISOString()}\n\n${record}\n`,
    );
    return {
      name: resolved.name,
      file: resolved.file,
      path: resolved.path,
      created,
    };
  }

  return { dir: root, list, get, append, pathFor };
}
