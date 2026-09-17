import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Journal store — the cold layer for 进展流水.
 *
 * 行为模式热文件只放可复用规则；「本轮做了什么」这类进展流水被
 * journal-guard 拒绝后应该落到这里。journal 是冷数据，默认不注入
 * hot 上下文（默认注入策略由 checklist-16 负责）。
 *
 * 布局：<root>/<project>.md，按日期追加小节。
 */

function safeProject(project) {
  const value = String(project || '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`project "${project}" 非法，只允许字母、数字、_ . -`);
  }
  return value;
}

export function defaultJournalDir(featureIntentDir) {
  return join(dirname(resolve(String(featureIntentDir || ''))), 'journal');
}

export function createJournalStore(rootDir) {
  const root = resolve(String(rootDir || ''));

  function filePath(project) {
    return join(root, `${safeProject(project)}.md`);
  }

  function append(project, text, { at = Date.now() } = {}) {
    const body = String(text == null ? '' : text).trim();
    if (!body) throw new Error('journal 内容不能为空。');
    mkdirSync(root, { recursive: true });
    const path = filePath(project);
    const stamp = new Date(at).toISOString();
    const head = existsSync(path) ? readFileSync(path, 'utf8') : `# Journal: ${safeProject(project)}\n`;
    const entry = `\n## ${stamp}\n\n- ${body.replace(/\r?\n/g, '\n  ')}\n`;
    writeFileSync(path, `${head.replace(/\s*$/, '')}\n${entry}`, 'utf8');
    return { path, project: safeProject(project) };
  }

  function read(project) {
    const path = filePath(project);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  return { root, filePath, append, read };
}
