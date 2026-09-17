import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Behavior-pattern store, one hot file per project.
 *
 * Layout:
 *   <workspace>/patterns/<project>.md          hot file: one line per rule
 *   <workspace>/patterns/<project>/<id>.md     rule detail
 *
 * checklist-3 enforces the hot-file budget and line length. checklist-4
 * extends the detail file with trigger / wrong / right / why / evidence and
 * the two-step write protocol. checklist-6 adds the overwrite (retire /
 * replace) capability plus an append-only audit log.
 *
 * 覆盖原则：**只从 hot 层移除，不删数据**。过期规则的行被清出热文件，
 * 明细文件仍保留并标记 retired，所有变更同时写入 audit 冷文件。
 */

const MAX_LINES = 3;
const MAX_BODY = 20;

/** 审计记录的动作名。 */
export const AUDIT_ACTIONS = ['create', 'rationale', 'retire', 'replace'];

function safeProject(project) {
  const value = String(project || '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`project "${project}" 非法，只允许字母、数字、_ . -`);
  }
  return value;
}

function safeId(id) {
  const value = String(id || '').trim();
  if (!/^P\d+$/.test(value)) throw new Error(`pattern id "${id}" 非法，应为 P + 数字`);
  return value;
}

export function defaultPatternDir(featureIntentDir) {
  return join(dirname(resolve(String(featureIntentDir || ''))), 'patterns');
}

export function createPatternStore(rootDir) {
  const root = resolve(String(rootDir || ''));

  function indexPath(project) {
    return join(root, `${safeProject(project)}.md`);
  }

  function projectDir(project) {
    return join(root, safeProject(project));
  }

  function detailPath(project, id) {
    const safe = safeId(id);
    const target = resolve(projectDir(project), `${safe}.md`);
    const base = resolve(projectDir(project));
    if (target !== base && !target.startsWith(base + sep)) {
      throw new Error(`pattern id "${id}" 越界`);
    }
    return target;
  }

  function ensureProject(project) {
    mkdirSync(root, { recursive: true });
    mkdirSync(projectDir(project), { recursive: true });
  }

  function parseIndex(project) {
    const path = indexPath(project);
    if (!existsSync(path)) return [];
    const rows = [];
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = /^\s*-\s*\[(P\d+)\]\s*(.*)$/.exec(line);
      if (!match) continue;
      rows.push({ id: match[1], body: match[2].trim() });
    }
    return rows;
  }

  function writeIndex(project, rows) {
    const body = rows.map((row) => `- [${row.id}] ${row.body}`).join('\n');
    writeFileSync(indexPath(project), `# Patterns\n\n${body}${body ? '\n' : ''}`, 'utf8');
  }

  function writeDetail(project, rule) {
    // 可选字段只在有值时落盘，保持明细文件整洁。
    const extras = [];
    if (rule.supersedes) extras.push(`- supersedes: ${rule.supersedes}`);
    if (rule.supersededBy) extras.push(`- supersededBy: ${rule.supersededBy}`);
    if (rule.retired) extras.push(`- retired: ${rule.retired}`);
    if (rule.retireReason) extras.push(`- retireReason: ${rule.retireReason}`);
    writeFileSync(
      detailPath(project, rule.id),
      [
        `# ${rule.id}`,
        '',
        `- id: ${rule.id}`,
        `- body: ${rule.body || ''}`,
        `- trigger: ${rule.trigger || ''}`,
        `- wrong: ${rule.wrong || ''}`,
        `- right: ${rule.right || ''}`,
        `- why: ${rule.why || ''}`,
        `- evidence: ${rule.evidence || ''}`,
        ...extras,
        '',
      ].join('\n'),
      'utf8',
    );
    return detailPath(project, rule.id);
  }

  // ── 审计日志（append-only 冷文件，绝不进入 hot 上下文）─────────────────
  function auditPath(project) {
    return join(root, `${safeProject(project)}.audit.md`);
  }

  function appendAudit(project, { action, id, note = '', detail = '' }) {
    if (!AUDIT_ACTIONS.includes(action)) throw new Error(`未知审计动作 "${action}"`);
    ensureProject(project);
    const path = auditPath(project);
    const head = existsSync(path) ? readFileSync(path, 'utf8') : `# Pattern audit: ${safeProject(project)}\n`;
    const line = `- ${new Date().toISOString()} [${action}] ${id}${note ? ` — ${note}` : ''}${detail ? ` | ${detail}` : ''}`;
    writeFileSync(path, `${head.replace(/\s*$/, '')}\n${line}\n`, 'utf8');
    return path;
  }

  function readAudit(project) {
    const path = auditPath(project);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  function get(project, id) {
    const path = detailPath(project, id);
    if (!existsSync(path)) return null;
    const text = readFileSync(path, 'utf8');
    const field = (name) => {
      // 注意：[ \t]* 不能用 \s*，否则贪婪匹配会跨过换行，把下一行内容吞进空字段。
      const match = new RegExp(`^-[ \t]*${name}:[ \t]*(.*)$`, 'im').exec(text);
      return match ? match[1].trim() : '';
    };
    return {
      id: safeId(id),
      body: field('body'),
      trigger: field('trigger'),
      wrong: field('wrong'),
      right: field('right'),
      why: field('why'),
      evidence: field('evidence'),
      supersedes: field('supersedes'),
      supersededBy: field('supersededBy'),
      retired: field('retired'),
      retireReason: field('retireReason'),
      path,
      isRetired: Boolean(field('retired')),
    };
  }

  function list(project) {
    return parseIndex(project);
  }

  /**
   * 找出五字段不完整的规则。project 省略时扫描 root 下所有热文件。
   * 返回 [{ project, id, missing: ['why','evidence'] }]。
   */
  function listIncomplete(project) {
    const projects = project
      ? [safeProject(project)]
      : listProjects();
    const out = [];
    for (const name of projects) {
      for (const row of parseIndex(name)) {
        const detail = get(name, row.id);
        if (!detail) {
          out.push({ project: name, id: row.id, missing: ['detail'] });
          continue;
        }
        const missing = ['trigger', 'wrong', 'right', 'why', 'evidence'].filter((field) => !detail[field]);
        if (missing.length) out.push({ project: name, id: row.id, missing });
      }
    }
    return out;
  }

  function listProjects() {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => existsSync(join(root, `${entry.name}.md`)))
      .map((entry) => entry.name)
      .sort();
  }

  function appendLines(project, lines) {
    ensureProject(project);
    const input = Array.isArray(lines) ? lines : [];
    if (input.length > MAX_LINES) {
      throw new Error(`单次最多写入 ${MAX_LINES} 行行为模式（当前 ${input.length} 行）。`);
    }
    const bodies = input
      .map((line) => String(line == null ? '' : line).trim())
      .filter((line) => line.length > 0);
    for (const body of bodies) {
      if (body.length > MAX_BODY) {
        throw new Error(`行为模式每行正文不能超过 ${MAX_BODY} 字（当前 ${body.length} 字）：${body}`);
      }
    }
    const rows = parseIndex(project);
    let max = 0;
    for (const row of rows) {
      const match = /^P(\d+)$/.exec(row.id);
      if (match) max = Math.max(max, Number(match[1]));
    }
    const written = [];
    for (const body of bodies) {
      const id = `P${String(++max).padStart(3, '0')}`;
      const row = { id, body };
      writeDetail(project, row);
      rows.push(row);
      written.push(row);
    }
    writeIndex(project, rows);
    return { written, skipped: input.length - bodies.length, path: indexPath(project), root };
  }
  /** 分配 id、写明细与热文件、记 create 审计。addRule / replace 共用。 */
  function insertRule(project, { trigger, wrong, right, body, why = '', evidence = '', supersedes = '' }) {
    ensureProject(project);
    const rows = parseIndex(project);
    let max = 0;
    for (const row of rows) {
      const match = /^P(\d+)$/.exec(row.id);
      if (match) max = Math.max(max, Number(match[1]));
    }
    const id = `P${String(++max).padStart(3, '0')}`;
    const rule = { id, body, trigger, wrong, right, why, evidence, supersedes };
    writeDetail(project, rule);
    rows.push({ id, body });
    writeIndex(project, rows);
    appendAudit(project, { action: 'create', id, detail: body });
    return rule;
  }

  function addRule(project, { trigger, wrong, right, body: bodyInput }) {
    ensureProject(project);
    const triggerText = String(trigger || '').trim();
    const wrongText = String(wrong || '').trim();
    const rightText = String(right || '').trim();
    if (!triggerText || !wrongText || !rightText) {
      throw new Error('第一步必须提供 trigger、wrong、right 三个字段。');
    }
    // 热文件只保留一行摘要：优先使用调用方给的 body，否则用 trigger → right。
    // 无论哪种来源都必须满足 20 字预算，超长时要求调用方压缩摘要。
    const providedBody = String(bodyInput || '').trim();
    const body = providedBody || `${triggerText} → ${rightText}`;
    if (body.length > MAX_BODY) {
      throw new Error(
        `热文件行正文不能超过 ${MAX_BODY} 字（当前 ${body.length} 字）：${body}。` +
          '请在 facts 步骤额外传一个更短的 body 摘要（≤20 字），详细内容仍写在 trigger/wrong/right 里。',
      );
    }
    const rule = insertRule(project, {
      trigger: triggerText,
      wrong: wrongText,
      right: rightText,
      body,
    });
    return { id: rule.id, body: rule.body, path: detailPath(project, rule.id), hotPath: indexPath(project) };
  }

  function addRationale(project, id, { why, evidence }) {
    ensureProject(project);
    const existing = get(project, id);
    if (!existing) throw new Error(`pattern ${id} 不存在，请先完成第一步 trigger/wrong/right 写入。`);
    const whyText = String(why || '').trim();
    const evidenceText = String(evidence || '').trim();
    if (!whyText || !evidenceText) {
      throw new Error('第二步必须提供 why、evidence 两个字段。');
    }
    writeDetail(project, { ...existing, why: whyText, evidence: evidenceText });
    appendAudit(project, { action: 'rationale', id: existing.id, detail: 'why/evidence 已补全' });
    return { id: existing.id, path: detailPath(project, existing.id) };
  }

  /**
   * 覆盖：把过期规则从 hot 层清除。
   * 只移除热文件里的行，明细保留并标记 retired（不删数据，可审计）。
   */
  function retire(project, id, { reason }) {
    ensureProject(project);
    const reasonText = String(reason || '').trim();
    if (!reasonText) throw new Error('覆盖必须提供 reason，作为可审计的变更说明。');
    const rows = parseIndex(project);
    const row = rows.find((entry) => entry.id === safeId(id));
    const existing = get(project, id);
    if (!row && !existing) throw new Error(`pattern ${id} 不存在，无法覆盖。`);
    if (existing && existing.isRetired) throw new Error(`pattern ${id} 已经过期（retired），无需重复覆盖。`);
    const next = rows.filter((entry) => entry.id !== safeId(id));
    writeIndex(project, next);
    if (existing) {
      writeDetail(project, { ...existing, retired: new Date().toISOString(), retireReason: reasonText });
    }
    // 明细缺失的孤儿行也要能清除，否则会永久卡住五字段门禁。
    appendAudit(project, {
      action: 'retire',
      id: safeId(id),
      note: reasonText,
      detail: existing ? existing.body : '（明细缺失，仅清除孤儿行）',
    });
    return {
      id: safeId(id),
      removedLine: existing ? existing.body : (row ? row.body : ''),
      orphan: !existing,
      path: detailPath(project, id),
      auditPath: auditPath(project),
    };
  }

  /**
   * 覆盖并替换：retire 旧行 + 写一条新规则，两条规则互相留引用。
   * 新规则必须自带完整五字段（why/evidence 也必填）。
   */
  function replace(project, id, { trigger, wrong, right, body: bodyInput, why, evidence, reason }) {
    // 先做完全部校验再动手：否则校验失败会留下「旧的已被清除、新的没写进去」的半成品。
    ensureProject(project);
    const triggerText = String(trigger || '').trim();
    const wrongText = String(wrong || '').trim();
    const rightText = String(right || '').trim();
    const whyText = String(why || '').trim();
    const evidenceText = String(evidence || '').trim();
    if (!triggerText || !wrongText || !rightText || !whyText || !evidenceText) {
      throw new Error('替换必须一次性提供完整五字段：trigger、wrong、right、why、evidence。');
    }
    const reasonText = String(reason || '').trim();
    if (!reasonText) throw new Error('覆盖必须提供 reason，作为可审计的变更说明。');
    // 新规则的摘要沿用 addRule 的预算与回退规则。
    const providedBody = String(bodyInput || '').trim();
    const newBody = providedBody || `${triggerText} → ${rightText}`;
    if (newBody.length > MAX_BODY) {
      throw new Error(
        `热文件行正文不能超过 ${MAX_BODY} 字（当前 ${newBody.length} 字）：${newBody}。` +
          '请在 body 参数传一个更短的摘要（≤20 字）。',
      );
    }
    // 目标必须存在且未过期（与 retire 的校验保持一致）。
    const rows = parseIndex(project);
    const row = rows.find((entry) => entry.id === safeId(id));
    const target = get(project, id);
    if (!row && !target) throw new Error(`pattern ${id} 不存在，无法覆盖。`);
    if (target && target.isRetired) throw new Error(`pattern ${id} 已经过期（retired），无需重复覆盖。`);

    const retired = retire(project, id, { reason: reasonText });
    // 关键：新规则必须带上 why/evidence，否则会留下五字段不全的规则。
    const created = insertRule(project, {
      trigger: triggerText,
      wrong: wrongText,
      right: rightText,
      body: newBody,
      why: whyText,
      evidence: evidenceText,
      supersedes: retired.id,
    });
    const oldDetail = get(project, retired.id);
    if (oldDetail) writeDetail(project, { ...oldDetail, supersededBy: created.id });
    appendAudit(project, { action: 'replace', id: retired.id, note: reasonText, detail: `→ ${created.id}` });
    return { retiredId: retired.id, id: created.id, body: created.body, hotPath: indexPath(project), auditPath: auditPath(project) };
  }



  return {
    root,
    indexPath,
    auditPath,
    list,
    listIncomplete,
    listProjects,
    get,
    appendLines,
    addRule,
    addRationale,
    retire,
    replace,
    readAudit,
  };
}
