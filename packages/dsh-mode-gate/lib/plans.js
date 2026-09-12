/**
 * Checklists, static plans and dynamic plans.
 *
 * A static plan is the durable list of acceptance goals parsed from the
 * feature-intent checklist. A dynamic plan is the agent's per-state scratch
 * plan (mirrored from todo_write but owned by mode-gate state).
 */

const CHECKLIST_HEADING_RE = /^#{2,4}\s*(?:checklist|计划列表|验收清单|可验收清单|checklist\s*&\s*acceptance)\s*$/i;

/** Parse list items under a checklist heading. Supports `- [ ] x`, `- x`, `1. x`. */
export function parseChecklist(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const items = [];
  let inChecklist = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,6}\s+/.test(trimmed)) {
      inChecklist = CHECKLIST_HEADING_RE.test(trimmed);
      continue;
    }
    if (!inChecklist) continue;
    const match = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(trimmed);
    if (!match) continue;
    let text = match[1].trim();
    if (/^\[[xX]\]/.test(text)) continue;
    text = text.replace(/^\[[ xX]\]\s*/, '').trim();
    if (text.length > 0) items.push(text);
  }
  return items;
}

/** Extract the three feature-intent fields from one appended entry. */
export function extractEntryFields(entry) {
  const text = String(entry || '');
  const section = (name) => {
    const re = new RegExp(`^#{2,4}\\s*${name}\\s*$`, 'im');
    const match = re.exec(text);
    if (!match) return '';
    const rest = text.slice(match.index + match[0].length);
    const nextHeading = rest.search(/^#{1,6}\s+/m);
    return (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
  };
  const userWords = section('用户原话') || section('user words') || section('用户原话记录');
  const understanding = section('Agent 理解') || section('理解') || section('agent understanding');
  const checklistText = section('Checklist') || section('checklist') || section('计划列表');
  const checklist = parseChecklist(`## Checklist\n${checklistText}`);
  return { userWords, understanding, checklist };
}

/** Build the markdown written by update_feature_intent. */
export function buildEntryMarkdown({ userWords, understanding, checklist }) {
  const items = Array.isArray(checklist) ? checklist.filter((item) => typeof item === 'string' && item.trim()) : [];
  const blocks = [];
  if (userWords) blocks.push(`### 用户原话\n\n${String(userWords).trim()}`);
  if (understanding) blocks.push(`### Agent 理解\n\n${String(understanding).trim()}`);
  if (items.length > 0) blocks.push(`### Checklist\n\n${items.map((item) => `- [ ] ${item}`).join('\n')}`);
  return blocks.join('\n\n');
}

export function createStaticPlan(items, featureIntentFile, idPrefix = 'checklist') {
  const list = Array.isArray(items) ? items : [];
  return {
    source: 'feature-intent.checklist',
    featureIntentFile: featureIntentFile || null,
    items: list.map((text, index) => ({
      id: `${idPrefix}-${index + 1}`,
      text: String(text),
      status: 'pending',
      completedAt: null,
    })),
    currentId: null,
    createdAt: Date.now(),
  };
}

export function staticPlanPendingCount(plan) {
  const items = plan && Array.isArray(plan.items) ? plan.items : [];
  return items.filter((item) => item.status !== 'completed').length;
}

export function staticPlanCurrent(plan) {
  if (!plan || !Array.isArray(plan.items)) return null;
  const byId = plan.currentId ? plan.items.find((item) => item.id === plan.currentId) : null;
  if (byId && byId.status !== 'completed') return byId;
  return plan.items.find((item) => item.status !== 'completed') || null;
}

/** Mark the current item in_progress; returns a new plan object. */
export function beginCurrentStaticItem(plan) {
  if (!plan || !Array.isArray(plan.items)) return plan;
  const current = staticPlanCurrent(plan);
  if (!current) return { ...plan, currentId: null };
  return {
    ...plan,
    currentId: current.id,
    items: plan.items.map((item) => (item.id === current.id
      ? { ...item, status: 'in_progress' }
      : item)),
  };
}

/** Complete the current item and advance currentId to the next pending item. */
export function advanceStaticPlan(plan) {
  if (!plan || !Array.isArray(plan.items)) return plan;
  const current = staticPlanCurrent(plan);
  const items = plan.items.map((item) => (current && item.id === current.id
    ? { ...item, status: 'completed', completedAt: Date.now() }
    : item));
  const next = items.find((item) => item.status !== 'completed') || null;
  return { ...plan, items, currentId: next ? next.id : null };
}

export function createDynamicPlan(todos, stateId) {
  const list = Array.isArray(todos) ? todos : [];
  return {
    scope: 'state',
    stateId: stateId || null,
    items: list
      .filter((item) => item && typeof item.content === 'string' && item.content.trim())
      .map((item, index) => ({
        id: `dynamic-${index + 1}`,
        content: item.content.trim(),
        status: ['pending', 'in_progress', 'completed'].includes(item.status) ? item.status : 'pending',
      })),
    updatedAt: Date.now(),
  };
}

export function dynamicPlanPendingCount(plan) {
  const items = plan && Array.isArray(plan.items) ? plan.items : [];
  return items.filter((item) => item.status !== 'completed').length;
}

/** Evaluate a structured transition condition against the current context. */
export function evaluateCondition(when, context) {
  if (!when || typeof when !== 'object') return false;
  const type = String(when.type || '');
  const value = when.value;
  switch (type) {
    case 'always':
      return true;
    case 'goal.completed':
      return Boolean(context.goalCompleted);
    case 'goal.failed':
      return Boolean(context.goalFailed);
    case 'presetAction.matched':
      return Boolean(context.presetActionMatched);
    case 'presetAction.unmatched':
      return context.presetActionMatched === false;
    case 'staticPlan.pending':
      return compare(staticPlanPendingCount(context.staticPlan), when.op, value);
    case 'dynamicPlan.pending':
      return compare(dynamicPlanPendingCount(context.dynamicPlan), when.op, value);
    case 'user.approved':
      return Boolean(context.userApproved);
    case 'user.replied':
      return Boolean(context.userReplied);
    default:
      return false;
  }
}

function compare(left, op, right) {
  const a = Number(left);
  const b = Number(right);
  switch (op) {
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '!=':
      return a !== b;
    case '==':
    default:
      return a === b;
  }
}
