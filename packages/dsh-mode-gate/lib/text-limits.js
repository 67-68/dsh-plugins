/**
 * 字数限制的统一 20% 宽限。
 *
 * 模型对字数感知不准，容易卡在边界：prompt 里仍写原上限（要求模型按原值输出），
 * 校验时按 `上限 × 1.2` 放行。所有字数上限校验都走这里，不要各写各的。
 */

export const LENGTH_TOLERANCE_RATIO = 1.2;

/** 含宽限的实际放行字数（向上取整）。 */
export function toleratedLength(limit) {
  return Math.ceil(Number(limit) * LENGTH_TOLERANCE_RATIO);
}

/**
 * 断言文本长度在宽限内。超限时抛错，错误信息同时给出原上限、宽限上限与当前字数。
 * @param {unknown} text 待校验文本
 * @param {number} limit prompt 中要求的上限（模型仍按此值输出）
 * @param {string} label 字段名（出现在错误信息中）
 */
export function assertTextLength(text, limit, label) {
  const value = String(text == null ? '' : text);
  const allowed = toleratedLength(limit);
  if (value.length > allowed) {
    throw new Error(`${label}超过 ${limit} 字（当前 ${value.length} 字，含 20% 宽限后上限 ${allowed} 字）。`);
  }
}
