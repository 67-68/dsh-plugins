import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * History store — 历史对话冷库（checklist-16）。
 *
 * 与 journal 一样属于不常看的短期数据：默认不注入 hot 上下文，
 * 需要时用 read 工具按需查看。feature intent 提交成功时由系统
 * 自动 append 一条历史对话整理记录。
 *
 * 布局：<root>/<project>.md，按时间戳追加小节。
 */

function safeProject(project) {
  const value = String(project || '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`project "${project}" 非法，只允许字母、数字、_ . -`);
  }
  return value;
}

export function defaultHistoryDir(featureIntentDir) {
  return join(dirname(resolve(String(featureIntentDir || ''))), 'history');
}

function renderEntry(fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const checklist = Array.isArray(f.checklist) ? f.checklist.filter((item) => typeof item === 'string' && item.trim()) : [];
  const lines = [];
  if (f.summary) lines.push(`- summary: ${String(f.summary).trim()}`);
  if (f.userWords) lines.push('', '## 用户原话', '', String(f.userWords).trim());
  if (f.understanding) lines.push('', '## Agent 理解', '', String(f.understanding).trim());
  if (f.userVisibleBehavior) lines.push('', '## 用户可见行为', '', String(f.userVisibleBehavior).trim());
  if (f.featureIntent) lines.push('', '## 功能意图', '', String(f.featureIntent).trim());
  if (checklist.length > 0) lines.push('', '## Checklist', '', checklist.map((item) => `- [ ] ${item}`).join('\n'));
  return lines.join('\n').trim();
}

export function createHistoryStore(rootDir) {
  const root = resolve(String(rootDir || ''));

  function filePath(project) {
    return join(root, `${safeProject(project)}.md`);
  }

  function append(project, fields, { at = Date.now() } = {}) {
    const safe = safeProject(project);
    const body = renderEntry(fields);
    if (!body) throw new Error('history 内容不能为空。');
    mkdirSync(root, { recursive: true });
    const path = filePath(safe);
    const stamp = new Date(at).toISOString();
    const head = existsSync(path) ? readFileSync(path, 'utf8') : `# History: ${safe}\n`;
    const entry = `\n## ${stamp}\n\n${body}\n`;
    writeFileSync(path, `${head.replace(/\s*$/, '')}\n${entry}`, 'utf8');
    return { path, project: safe };
  }

  function read(project) {
    const path = filePath(project);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  return { root, filePath, append, read };
}
