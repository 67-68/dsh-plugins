/**
 * Pure gate logic for writing behavior patterns (checklist-5).
 *
 * 单独抽成纯函数模块，方便脱离 DSH runtime 做单测：
 *   1. 写入前必须先提交 reason 自查（专用 skill: pattern_reason）；
 *   2. reason 必须是本 goal 激活期内提交的（跨轮失效）；
 *   3. 规则内容命中进展流水 marker 时拒绝，并提示改写入 journal。
 *
 * 这里**不做相似度/去重判断**（用户明确要求）。
 */

import { detectProgress, progressRejectionText } from './journal-guard.js';

export const SELF_CHECK_MISSING_MESSAGE =
  '写入行为模式前必须先调用 pattern_reason 提交 reason，完成「是否是用户强调/纠正过的模式」自查（缺项会被拒绝）。';

/** reason 自查是否对当前 goal 激活期有效。 */
export function isSelfCheckFresh(selfCheck, goal) {
  if (!selfCheck || typeof selfCheck !== 'object') return false;
  if (!goal || typeof goal !== 'object') return false;
  if (!goal.id || selfCheck.goalId !== goal.id) return false;
  if (selfCheck.goalStartedAt === undefined || selfCheck.goalStartedAt === null) return false;
  return selfCheck.goalStartedAt === goal.startedAt;
}

/** 断言自查有效，否则抛出可读错误。 */
export function assertSelfCheckFresh(selfCheck, goal) {
  if (!isSelfCheckFresh(selfCheck, goal)) throw new Error(SELF_CHECK_MISSING_MESSAGE);
}

/**
 * 校验一条规则的内容不是进展流水。
 * @param {{body?, trigger?, wrong?, right?, why?, evidence?}} rule
 * @param {string|null} journalPath 命中时提示的 journal 落点
 */
export function assertNotProgress(rule, journalPath) {
  const fields = [
    ['body', rule.body],
    ['trigger', rule.trigger],
    ['wrong', rule.wrong],
    ['right', rule.right],
    ['why', rule.why],
    ['evidence', rule.evidence],
  ];
  for (const [field, value] of fields) {
    const detection = detectProgress(value);
    if (detection.progress) {
      throw new Error(progressRejectionText(field, detection, journalPath));
    }
  }
}

/**
 * 校验 reason 自查内容本身。
 * subject / hint 可定制，默认文案保持行为模式（pattern）语义不变，
 * 供架构写入等其它「写入前 reason 自查」复用。
 */
export function assertReasonValid(reason, options = {}) {
  const subject = options.subject || '这是否是用户强调或纠正过的模式';
  const hint = options.hint || '这是哪条用户强调/纠正';
  const text = String(reason == null ? '' : reason).trim();
  if (!text) throw new Error(`自查缺项：必须提供 reason，说明${subject}。`);
  if (text.length < 4) throw new Error(`reason 太短（${text.length} 字），请具体说明${hint}。`);
  if (text.length > 200) throw new Error(`reason 超过 200 字（当前 ${text.length} 字）。`);
  const detection = detectProgress(text);
  if (detection.progress) {
    throw new Error(`${progressRejectionText('reason', detection, null)}reason 应该写「${hint}」，而不是本轮进展。`);
  }
  return text;
}
