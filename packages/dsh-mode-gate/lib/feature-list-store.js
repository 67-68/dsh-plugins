import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { assertTextLength } from './text-limits.js';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Feature list store.
 *
 * Layout:
 *   <workspace>/features.md          one-line index per feature
 *   <workspace>/features/<id>.md     full feature detail
 *
 * checklist-7 fixes the field set and its budgets:
 *   feature id / title / module / status / commit（系统自动生成）+
 *   user_visible_behavior (≤500) + feature_intent (≤50)。
 * commit 不由 Agent 手填，只由系统写入（setCommit），checklist-15 的 git
 * skill 会在每轮 commit 后回填 hash。
 */

export const FEATURE_STATUSES = ['in_progress', 'done'];
export const MAX_USER_VISIBLE_BEHAVIOR = 500;
export const MAX_FEATURE_INTENT = 50;

const INDEX_HEADER = [
  '# Features',
  '',
  '| id | title | module | status | commit |',
  '| --- | --- | --- | --- | --- |',
].join('\n');

function safeId(id) {
  const value = String(id || '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`feature id "${id}" 非法，只允许字母、数字、_ . -`);
  }
  return value;
}

/** 字段级验收：任何写入路径都必须过这一关。同时做归一化（去首尾空白、表格字段压成单行）。 */
function validateFeature(feature) {
  const title = singleLine(feature.title);
  const module = singleLine(feature.module);
  const userVisibleBehavior = String(feature.userVisibleBehavior == null ? '' : feature.userVisibleBehavior).trim();
  const featureIntent = String(feature.featureIntent == null ? '' : feature.featureIntent).trim();
  if (!title) throw new Error('feature 缺少 title。');
  if (!module) throw new Error('feature 缺少 module。');
  if (!FEATURE_STATUSES.includes(feature.status)) {
    throw new Error(`feature status "${feature.status}" 非法，只允许 ${FEATURE_STATUSES.join(' / ')}。`);
  }
  if (!userVisibleBehavior) throw new Error('feature 缺少 user_visible_behavior。');
  assertTextLength(userVisibleBehavior, MAX_USER_VISIBLE_BEHAVIOR, 'user_visible_behavior');
  if (!featureIntent) throw new Error('feature 缺少 feature_intent。');
  assertTextLength(featureIntent, MAX_FEATURE_INTENT, 'feature_intent');
  return {
    id: feature.id,
    title,
    module,
    status: feature.status,
    commit: String(feature.commit || '').trim(),
    completedAt: String(feature.completedAt || '').trim(),
    userVisibleBehavior,
    featureIntent,
    evidence: String(feature.evidence == null ? '' : feature.evidence).trim(),
  };
}

function cell(text) {
  return String(text == null ? '' : text)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** 按未转义的 | 切分索引行，并把 \| 还原成 |。 */
function splitRow(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    const next = inner[i + 1];
    if (ch === '\\' && (next === '|' || next === '\\')) {
      cur += next;
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells.map((value) => value.trim());
}

/** 表格单元格是单行值：标题/模块必须没有换行。 */
function singleLine(text) {
  return String(text == null ? '' : text).replace(/\r?\n/g, ' ').trim();
}

function section(text, name) {
  const re = new RegExp(`^#{2,4}\\s*${name}\\s*$`, 'im');
  const match = re.exec(text);
  if (!match) return '';
  const rest = text.slice(match.index + match[0].length);
  const nextHeading = rest.search(/^#{1,6}\s+/m);
  return (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
}

export function defaultFeatureListDir(featureIntentDir) {
  return join(dirname(resolve(String(featureIntentDir || ''))), 'features');
}

export function createFeatureListStore(rootDir) {
  const root = resolve(String(rootDir || ''));
  const indexPath = join(dirname(root), 'features.md');

  function ensureRoot() {
    mkdirSync(root, { recursive: true });
    mkdirSync(dirname(root), { recursive: true });
  }

  function detailPath(id) {
    const safe = safeId(id);
    const target = resolve(root, `${safe}.md`);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`feature id "${id}" 越界`);
    }
    return target;
  }

  function parseIndex() {
    if (!existsSync(indexPath)) return [];
    const rows = [];
    for (const line of readFileSync(indexPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('|')) continue;
      const cells = splitRow(trimmed);
      if (cells.length < 5) continue;
      const [id, title, module, status, commit] = cells;
      if (!id || id === 'id' || /^-+$/.test(id)) continue;
      rows.push({ id, title, module, status, commit });
    }
    return rows;
  }

  function readIndexFile() {
    if (!existsSync(indexPath)) return '';
    return readFileSync(indexPath, 'utf8');
  }

  function list() {
    return parseIndex();
  }

  function get(id) {
    const path = detailPath(id);
    if (!existsSync(path)) return null;
    const text = readFileSync(path, 'utf8');
    const field = (name) => {
      // 注意：[ \t]* 不能用 \s*，否则贪婪匹配会跨过换行把下一行内容吞进空字段。
      const match = new RegExp(`^-[ \t]*${name}:[ \t]*(.*)$`, 'im').exec(text);
      return match ? match[1].trim() : '';
    };
    return {
      id: safeId(id),
      title: field('title'),
      module: field('module'),
      status: field('status'),
      commit: field('commit'),
      completedAt: field('completedAt'),
      userVisibleBehavior: section(text, 'user_visible_behavior') || section(text, '用户可见行为'),
      featureIntent: section(text, 'feature_intent') || section(text, '功能意图'),
      evidence: section(text, 'completion_evidence') || section(text, '完成证据'),
      path,
    };
  }

  function writeDetail(feature) {
    const lines = [
      `# ${feature.title || feature.id}`,
      '',
      `- id: ${feature.id}`,
      `- title: ${feature.title || ''}`,
      `- module: ${feature.module || ''}`,
      `- status: ${feature.status || ''}`,
      `- commit: ${feature.commit || ''}`,
      `- completedAt: ${feature.completedAt || ''}`,
      '',
      '## user_visible_behavior',
      '',
      feature.userVisibleBehavior || '',
      '',
      '## feature_intent',
      '',
      feature.featureIntent || '',
      '',
      '## completion_evidence',
      '',
      feature.evidence || '',
      '',
    ];
    writeFileSync(detailPath(feature.id), lines.join('\n'), 'utf8');
  }

  function writeIndex(rows) {
    const body = rows.map((row) => `| ${cell(row.id)} | ${cell(row.title)} | ${cell(row.module)} | ${cell(row.status)} | ${cell(row.commit)} |`).join('\n');
    writeFileSync(indexPath, `${INDEX_HEADER}\n${body}${body ? '\n' : ''}`, 'utf8');
  }

  function upsert(input) {
    ensureRoot();
    const id = safeId(input && input.id);
    const current = get(id) || {};
    const explicitStatus = input.status != null ? String(input.status) : null;
    // done 是系统专属状态：显式请求 done 必须走 finish（带真实证据）。
    // 但保留已有的 done（未显式改状态）不算越权，否则完成后连改描述都会被拒。
    if (explicitStatus === 'done') {
      throw new Error('status=done 只能由系统设置：请用 finish_feature 提交真实证据后再完成。');
    }
    const status = explicitStatus != null ? explicitStatus : (current.status || 'in_progress');
    const feature = validateFeature({
      id,
      title: input.title != null ? String(input.title) : (current.title || id),
      module: input.module != null ? String(input.module) : (current.module || id),
      status,
      commit: input.commit != null ? String(input.commit) : (current.commit || ''),
      completedAt: current.completedAt || '',
      userVisibleBehavior: input.userVisibleBehavior != null ? String(input.userVisibleBehavior) : (current.userVisibleBehavior || ''),
      featureIntent: input.featureIntent != null ? String(input.featureIntent) : (current.featureIntent || ''),
      evidence: current.evidence || '',
    });
    writeFeature(feature);
    return { ...feature, indexPath, detailPath: detailPath(id) };
  }

  /** 写详情 + 按 id 更新索引行（不产生重复行）。 */
  function writeFeature(feature) {
    ensureRoot();
    writeDetail(feature);
    const rows = parseIndex();
    const index = rows.findIndex((row) => row.id === feature.id);
    const indexRow = {
      id: feature.id,
      title: feature.title,
      module: feature.module,
      status: feature.status,
      commit: feature.commit,
    };
    if (index >= 0) rows[index] = indexRow;
    else rows.push(indexRow);
    rows.sort((a, b) => a.id.localeCompare(b.id));
    writeIndex(rows);
    return feature;
  }

  /**
   * 系统写入 commit hash（不由 Agent 手填）。
   * 索引行与详情同步，供 checklist-15 的 git skill 每轮回填。
   */
  function setCommit(id, hash) {
    const safe = safeId(id);
    const current = get(safe);
    if (!current) throw new Error(`feature "${safe}" 不存在，无法写入 commit。`);
    const value = String(hash || '').trim();
    if (!value) throw new Error('commit hash 不能为空。');
    if (!/^[0-9a-f]{7,40}$/i.test(value)) throw new Error(`commit hash "${value}" 格式非法（应为 7-40 位十六进制）。`);
    const feature = { ...current, commit: value };
    writeFeature(feature);
    return feature;
  }

  /** 只更新 status，其余字段保持不变；done 必须走 finish（需要真实证据）。 */
  function setStatus(id, status) {
    const safe = safeId(id);
    const current = get(safe);
    if (!current) throw new Error(`feature "${safe}" 不存在，无法更新 status。`);
    if (!FEATURE_STATUSES.includes(status)) {
      throw new Error(`feature status "${status}" 非法，只允许 ${FEATURE_STATUSES.join(' / ')}。`);
    }
    if (status === 'done') {
      throw new Error('status=done 只能由系统完成流程设置：请用 finish_feature 提交真实证据。');
    }
    const feature = { ...current, status };
    writeFeature(feature);
    return feature;
  }

  /**
   * 系统完成流程：必须有真实证据，系统置 done 并写入 commit hash。
   * commit 由调用方（插件）自动读取 HEAD 得到，不由 Agent 手填。
   */
  function finish(id, { evidence, commit = '', at = Date.now() } = {}) {
    const safe = safeId(id);
    const current = get(safe);
    if (!current) throw new Error(`feature "${safe}" 不存在，无法完成。`);
    const evidenceText = String(evidence == null ? '' : evidence).trim();
    if (!evidenceText) throw new Error('完成必须有真实证据：请提供 evidence（例如验证命令与结果）。');
    if (evidenceText.length < 8) throw new Error(`evidence 太短（${evidenceText.length} 字），请给出可核对的验证结果。`);
    const commitText = String(commit || '').trim();
    if (commitText && !/^[0-9a-f]{7,40}$/i.test(commitText)) {
      throw new Error(`commit hash "${commitText}" 格式非法（应为 7-40 位十六进制）。`);
    }
    const feature = {
      ...current,
      status: 'done',
      evidence: evidenceText,
      commit: commitText || current.commit || '',
      completedAt: new Date(at).toISOString(),
    };
    writeFeature(feature);
    return feature;
  }

  return { root, indexPath, list, get, upsert, setCommit, setStatus, finish, readIndexFile };
}
