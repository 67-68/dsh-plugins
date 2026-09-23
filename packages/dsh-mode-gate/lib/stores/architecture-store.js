import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { detectProgress } from '../services/journal-guard.js';
import { isSelfCheckFresh, assertReasonValid } from '../services/pattern-gate.js';

/**
 * architecture.md —— 常驻 limited prompt（结构层）。
 *
 * 只放**稳定的结构事实**：系统上下文、模块职责、依赖方向与禁止边、关键
 * invariant、entrypoint、不要碰的目录、ADR 链接。
 *
 * 硬约束：
 *   - ≤ MAX_LINES 行，且 ≤ MAX_TOKENS 估算 tokens；
 *   - 不混入功能状态或进展流水（复用 journal-guard 逐行检出）；
 *   - 注入时永远走 limitedDigest()，超预算一律截断，保证不会炸上下文。
 */

export const ARCHITECTURE_SECTIONS = [
  { id: 'context', label: '系统上下文' },
  { id: 'modules', label: '模块职责' },
  { id: 'dependencies', label: '依赖方向与禁止边' },
  { id: 'invariants', label: '关键 invariant' },
  { id: 'entrypoints', label: 'entrypoint' },
  { id: 'do-not-touch', label: '不要碰的目录' },
  { id: 'adr', label: 'ADR 链接' },
];

export const MAX_LINES = 120;
export const MAX_TOKENS = 1000;

export function defaultArchitecturePath(featureIntentDir) {
  return join(dirname(resolve(String(featureIntentDir || ''))), 'architecture.md');
}

// ── 写入前的必要性自查门禁（专用 skill: architecture_reason）──────────────
// 与行为模式同构：写入必须先在本 goal 激活期提交 reason；reason 只进 state
// 与 audit 冷文件，绝不写入 architecture.md。

export const ARCHITECTURE_SELF_CHECK_MISSING_MESSAGE =
  '写入 architecture.md 前必须先调用 architecture_reason 提交 reason，完成「这是否是值得长期沉淀的结构事实」必要性自查（缺项会被拒绝）。';

export function assertArchitectureSelfCheckFresh(selfCheck, goal) {
  if (!isSelfCheckFresh(selfCheck, goal)) throw new Error(ARCHITECTURE_SELF_CHECK_MISSING_MESSAGE);
}

export function assertArchitectureReason(reason) {
  return assertReasonValid(reason, {
    subject: '这是否是值得长期沉淀的结构事实（而不是本轮进展或功能状态）',
    hint: '哪一条稳定结构事实需要沉淀',
  });
}

/** 把 section id 或中文标题解析为声明的 section；未知时返回 null。 */
export function sectionByLabel(label) {
  const key = String(label == null ? '' : label).trim();
  if (!key) return null;
  return ARCHITECTURE_SECTIONS.find((section) => section.id === key || section.label === key) || null;
}

/**
 * 单节 upsert：按「## 标题」定位并替换该节正文；不存在则追加到文末。
 * 保留未知 section 与原有顺序，避免整篇覆盖丢失内容。
 */
export function upsertSection(text, label, body) {
  const section = sectionByLabel(label);
  if (!section) {
    const available = ARCHITECTURE_SECTIONS.map((entry) => `${entry.id}（${entry.label}）`).join('、');
    throw new Error(`未知架构 section「${label}」；可用：${available}。`);
  }
  const bodyLines = String(body == null ? '' : body).replace(/\s+$/, '').split(/\r?\n/);
  const lines = String(text == null ? '' : text).replace(/\n+$/, '').split(/\r?\n/);
  const target = `## ${section.label}`;
  const start = lines.findIndex((line) => {
    const match = /^(#{2,4})\s*(.+?)\s*$/.exec(line);
    return Boolean(match) && (match[2] === section.label || match[2] === section.id);
  });
  let out;
  if (start === -1) {
    const base = lines.length === 1 && lines[0].trim() === '' ? [] : lines;
    out = [...base, '', target, '', ...bodyLines];
  } else {
    const level = /^(#{2,4})/.exec(lines[start])[1].length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      const match = /^(#{2,4})\s*(.+?)\s*$/.exec(lines[i]);
      if (match && match[1].length <= level) {
        end = i;
        break;
      }
    }
    const block = [target, ''];
    if (bodyLines.length && bodyLines[0].trim() !== '') block.push(...bodyLines);
    out = [...lines.slice(0, start), ...block, ...lines.slice(end)];
  }
  const cleaned = [];
  for (const line of out) {
    const value = line.replace(/\s+$/, '');
    if (!value.trim() && cleaned.length && !cleaned[cleaned.length - 1].trim()) continue;
    cleaned.push(value);
  }
  const joined = cleaned.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
  return joined ? `${joined}\n` : '';
}

/**
 * CJK 感知的 token 估算：CJK 字符约 1 token/字，其余按 4 字符/token。
 * 只用相对保守的上界估计，避免把上下文预算算小。
 */
export function estimateTokens(text) {
  const value = String(text == null ? '' : text);
  let cjk = 0;
  let other = 0;
  for (const ch of value) {
    if (/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export function countLines(text) {
  const value = String(text == null ? '' : text);
  if (!value) return 0;
  return value.replace(/\n$/, '').split('\n').length;
}

/** 把 markdown 拆成 「## 标题 -> 正文」的有序列表。 */
export function parseSections(text) {
  const value = String(text == null ? '' : text);
  const out = [];
  let current = null;
  for (const line of value.split(/\r?\n/)) {
    const heading = /^#{2,4}\s*(.+?)\s*$/.exec(line);
    if (heading) {
      current = { title: heading[1].trim(), lines: [] };
      out.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else {
      if (!out.length || out[0].title !== null) out.unshift({ title: null, lines: [] });
      out[0].lines.push(line);
    }
  }
  return out.map((section) => ({ title: section.title, body: section.lines.join('\n').trim() }));
}

/** 逐行检出功能状态 / 进展流水。 */
export function findForbiddenLines(text) {
  const out = [];
  String(text == null ? '' : text)
    .split(/\r?\n/)
    .forEach((line, index) => {
      const detection = detectProgress(line);
      if (detection.progress) out.push({ line: index + 1, text: line.trim(), label: detection.label });
    });
  return out;
}

/**
 * 校验架构文档。返回 { ok, violations, warnings, sections, lineCount, tokens }。
 * 不在预算内或混入进展流水时 ok=false，并给出可读原因。
 */
export function validateArchitecture(text) {
  const value = String(text == null ? '' : text);
  const violations = [];
  const warnings = [];
  const lineCount = countLines(value);
  const tokens = estimateTokens(value);
  if (lineCount > MAX_LINES) violations.push(`超过 ${MAX_LINES} 行（当前 ${lineCount} 行）`);
  if (tokens > MAX_TOKENS) violations.push(`超过约 ${MAX_TOKENS} tokens（当前约 ${tokens}）`);
  const forbidden = findForbiddenLines(value);
  if (forbidden.length > 0) {
    const sample = forbidden.slice(0, 3).map((entry) => `第 ${entry.line} 行「${entry.text}」（命中 ${entry.label}）`).join('；');
    violations.push(`混入了功能状态或进展流水：${sample}${forbidden.length > 3 ? ` 等 ${forbidden.length} 处` : ''}`);
  }
  const present = new Set(parseSections(value).map((section) => section.title));
  const missing = ARCHITECTURE_SECTIONS.filter((section) => ![...present].some((title) => title && title.includes(section.label)));
  if (missing.length > 0) warnings.push(`缺少 section：${missing.map((section) => section.label).join('、')}`);
  return { ok: violations.length === 0, violations, warnings, lineCount, tokens, sections: parseSections(value) };
}

/**
 * 常驻注入用的 limited prompt：只保留已声明的 section，并硬截断到预算内。
 * 无论源文件多大，返回内容都不会超过 MAX_LINES 行 / MAX_TOKENS tokens；
 * 截断提示本身也计入预算，不会被最后的 token 兜底裁剪掉。
 */
export function limitedDigest(text) {
  const value = String(text == null ? '' : text);
  const sections = parseSections(value).filter((section) => section.title);
  const head = '# 架构（limited prompt）';
  const note = '（已截断：architecture.md 超出 limited prompt 预算，请精简。）';
  if (sections.length === 0) {
    return [head, '', '（architecture.md 还没有结构 section；请在 ACCUMULATE 阶段沉淀，或运行对应 skill。）'].join('\n');
  }
  // 预算里预留标题 + 空行 + 截断提示，保证提示不会被裁掉。
  const bodyBudgetLines = Math.max(1, MAX_LINES - 3);
  const bodyBudgetTokens = Math.max(40, MAX_TOKENS - estimateTokens(head) - estimateTokens(note) - 4);
  const body = [];
  let dropped = false;
  for (const section of sections) {
    const block = ['', `## ${section.title}`, ...section.body.split(/\r?\n/)];
    if (body.length + block.length > bodyBudgetLines) dropped = true;
    for (const line of block) {
      if (body.length >= bodyBudgetLines) {
        dropped = true;
        break;
      }
      body.push(line);
    }
    if (body.length >= bodyBudgetLines) break;
  }
  const beforeTrim = body.length;
  while (body.length > 0 && estimateTokens([head, ...body].join('\n')) > bodyBudgetTokens) body.pop();
  if (body.length < beforeTrim) dropped = true;
  const lines = [head, ...body];
  if (dropped) lines.push('', note);
  return lines.join('\n');
}

export function createArchitectureStore(rootPath) {
  const path = resolve(String(rootPath || ''));
  const auditPath = join(dirname(path), 'architecture.audit.md');

  function read() {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  function status() {
    const text = read();
    const report = validateArchitecture(text);
    return { path, exists: existsSync(path), empty: !text.trim(), ...report };
  }

  /** 常驻注入内容：文件不存在或为空时返回 ''（不注入）。 */
  function prompt() {
    const text = read();
    if (!text.trim()) return '';
    return limitedDigest(text);
  }

  /** append-only 变更审计：reason 落在这里，不落进 architecture.md。 */
  function appendAudit(entry) {
    const value = entry && typeof entry === 'object' ? entry : {};
    mkdirSync(dirname(auditPath), { recursive: true });
    const head = existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : '# Architecture audit（append-only）\n';
    const stamp = new Date().toISOString();
    const reason = String(value.reason || '').replace(/\s+/g, ' ').trim();
    const detail = String(value.detail || '').replace(/\s+/g, ' ').trim();
    const parts = [`- ${stamp} [${value.action || 'write'}] ${value.lineCount || 0} 行 / ${value.tokens || 0} tokens`];
    if (reason) parts.push(`reason: ${reason}`);
    if (detail) parts.push(`（${detail}）`);
    writeFileSync(auditPath, `${head.replace(/\s*$/, '')}\n${parts.join(' — ')}\n`, 'utf8');
  }

  /** 校验并整篇写入。reason 必填且只进 audit。 */
  function write(text, options = {}) {
    const reason = assertArchitectureReason(options.reason);
    if (!String(text == null ? '' : text).trim()) throw new Error('architecture.md 内容不能为空；请提供结构内容。');
    const report = validateArchitecture(text);
    if (!report.ok) {
      throw new Error(`architecture.md 校验失败：${report.violations.join('；')}`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(text), 'utf8');
    appendAudit({ action: options.action || 'write', reason, lineCount: report.lineCount, tokens: report.tokens });
    return {
      path,
      lineCount: report.lineCount,
      tokens: report.tokens,
      warnings: report.warnings,
      sections: report.sections.map((section) => section.title).filter(Boolean),
    };
  }

  /** 只更新一个结构 section（推荐）：先合并再整篇校验/写入。 */
  function writeSection(label, body, options = {}) {
    const merged = upsertSection(read(), label, body);
    return write(merged, { ...options, action: options.action || 'section' });
  }

  function readAudit() {
    return existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : '';
  }

  return {
    path,
    auditPath,
    read,
    status,
    prompt,
    validate: () => validateArchitecture(read()),
    write,
    writeSection,
    appendAudit,
    readAudit,
  };
}
