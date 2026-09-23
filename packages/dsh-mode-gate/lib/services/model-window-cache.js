/**
 * 观测到的模型上下文窗口（真实路由容量）。
 *
 * 唯一来源是 harness 记录的 `request/context` 会话事件（provider / model /
 * contextWindow）。自带压缩点表（model-compression.js）只覆盖少数已查证模型：
 * 表外模型拿不到窗口就只能回落到 180k 默认值，而 180k 对 128k 窗口的模型等于
 * 「永不触发压缩」——设置页因此也显示不出可信的「上下文窗口 / 生效值」。
 *
 * 本模块只做观测与查询，不做任何策略判断：默认值与用户填写的优先级仍由
 * model-compression.js 决定。查不到窗口时返回 null，调用方按原逻辑回落。
 *
 * 注意：这是**进程内**缓存（不落盘）。重启后靠新会话的 request/context 事件
 * 重新填充；缺失期间行为与改动前一致，不会更差。
 */

export function createModelWindowCache() {
  /** @type {Map<string, { contextWindow: number, provider: string, at: number }>} */
  const byModel = new Map();

  /**
   * 记录一次真实路由容量。窗口必须为正数才记账（provider 可缺省）。
   * @returns {boolean} 是否记录成功。
   */
  function rememberRoute(route) {
    const source = route && typeof route === 'object' ? route : {};
    const model = typeof source.model === 'string' ? source.model.trim() : '';
    const contextWindow = Number(source.contextWindow);
    if (!model || !Number.isFinite(contextWindow) || contextWindow <= 0) return false;
    const provider = typeof source.provider === 'string' ? source.provider.trim() : '';
    byModel.set(model, { contextWindow: Math.floor(contextWindow), provider, at: Date.now() });
    return true;
  }

  /** 查模型窗口；未观测到返回 null（调用方回落）。 */
  function windowFor(modelId) {
    const ref = typeof modelId === 'string' ? modelId.trim() : '';
    if (!ref) return null;
    const hit = byModel.get(ref);
    return hit && Number.isFinite(hit.contextWindow) ? hit.contextWindow : null;
  }

  /** 已观测到的模型列表，供设置页把表外模型也列进表格。 */
  function entries() {
    return [...byModel.entries()].map(([modelId, value]) => ({ modelId, ...value }));
  }

  return { rememberRoute, windowFor, entries };
}
