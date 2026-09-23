/**
 * Progress-log guard for the behavior-pattern layer.
 *
 * 行为模式（hot 层）只放「跨轮复用」的规则；「本轮做了什么」属于进展流水，
 * 应该写进 journal 冷层。这里用一个**显式、可审计**的 marker 表做判断：
 *
 *   - 不猜语义，不做相似度判断（用户明确要求「不做相似度判断」）；
 *   - 命中哪个 marker 会原样回给调用方，方便改写而不是盲猜；
 *   - 新增 marker 必须同时补一条 selfcheck 用例。
 *
 * 命中即拒绝并提示改写入 journal。
 */

/** 一条 marker：{ id, label, test }。label 会出现在拒绝信息里。 */
const PROGRESS_MARKERS = [
  { id: 'this-round', label: '本轮/这一轮/第N轮', test: (text) => /本轮|这一轮|第\s*\d+\s*轮/.test(text) },
  { id: 'iteration', label: 'iteration', test: (text) => /iteration/i.test(text) },
  { id: 'done-status', label: '已完成/完成度/进度/剩余/待办', test: (text) => /已完成|完成度|进度|剩余|待办/.test(text) },
  { id: 'todo-marker', label: 'TODO/TBD', test: (text) => /\bTODO\b|\bTBD\b/i.test(text) },
  { id: 'task-id', label: 'checklist-N / goal-N', test: (text) => /\bchecklist-\d+\b|\bgoal-\d+\b/i.test(text) },
  { id: 'pattern-id', label: 'P000 形式的编号', test: (text) => /\bP\d{3}\b/.test(text) },
  { id: 'date', label: 'ISO 日期', test: (text) => /\b\d{4}-\d{2}-\d{2}\b/.test(text) },
  { id: 'commit', label: 'commit hash', test: (text) => /\bcommit\b/i.test(text) && /\b[0-9a-f]{7,40}\b/i.test(text) },
  { id: 'past-tense', label: '提交了/写入了/跑通了/通过了', test: (text) => /提交了|写入了|跑通了|通过了/.test(text) },
];

/**
 * @returns {{ progress: boolean, marker: string|null, label: string|null }}
 */
export function detectProgress(text) {
  const value = String(text == null ? '' : text);
  if (!value.trim()) return { progress: false, marker: null, label: null };
  for (const marker of PROGRESS_MARKERS) {
    let hit = false;
    try {
      hit = Boolean(marker.test(value));
    } catch {
      hit = false;
    }
    if (hit) return { progress: true, marker: marker.id, label: marker.label };
  }
  return { progress: false, marker: null, label: null };
}

/** 供文档/UI 展示的 marker 表 id 列表。 */
export function progressMarkerIds() {
  return PROGRESS_MARKERS.map((marker) => marker.id);
}

/** 统一的拒绝文案：既指出命中项，也给出 journal 落点。 */
export function progressRejectionText(field, detection, journalPath) {
  const where = journalPath ? `请改写入 journal（${journalPath}）` : '请改写入 journal';
  return `${field} 看起来是进展流水（命中「${detection.label}」），不是可复用的行为模式；${where}。`;
}
