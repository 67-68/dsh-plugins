/**
 * Model context compression points.
 *
 * Verified sources:
 * - https://www.kimi.com/code/docs/en/kimi-code/models.html
 * - https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files
 *
 * Built-in default rules (shown verbatim in the settings UI):
 * - Verified models use their verified golden point.
 * - Models with context window < 150k compress at ~80% of the window.
 * - All other models compress at ~180k by default.
 * - A user-filled value (compressionOverrides) always wins over the default.
 */

export const MODEL_COMPRESSION_TABLE = [
  {
    modelId: 'k3',
    provider: 'kimi-code',
    contextWindow: 1048576,
    goldenPoint: 262144,
    verified: true,
    sourceUrl: 'https://www.kimi.com/code/docs/en/kimi-code/models.html',
    note: 'Kimi K3 flagship, 1M context. Golden point at ~25%.',
  },
  {
    modelId: 'k3-256k',
    provider: 'kimi-code',
    contextWindow: 262144,
    goldenPoint: null,
    verified: true,
    sourceUrl: 'https://www.kimi.com/code/docs/en/kimi-code/models.html',
    note: 'Kimi K3 256K context. Built-in default applies the 80%/180k rules.',
  },
  {
    modelId: 'kimi-for-coding',
    provider: 'kimi-code',
    contextWindow: 1048576,
    goldenPoint: 262144,
    verified: true,
    sourceUrl: 'https://www.kimi.com/code/docs/en/kimi-code/models.html',
    note: 'Kimi K2.8 Preview, 1M context. Golden point at ~25%.',
  },
  {
    modelId: 'kimi-for-coding-highspeed',
    provider: 'kimi-code',
    contextWindow: 262144,
    goldenPoint: null,
    verified: true,
    sourceUrl: 'https://www.kimi.com/code/docs/en/kimi-code/models.html',
    note: 'Kimi K2.7 Code HighSpeed, 256K context. Built-in default applies the 80%/180k rules.',
  },
  {
    modelId: 'deepseek-v4-pro',
    provider: 'deepseek-official',
    contextWindow: 128000,
    goldenPoint: null,
    verified: false,
    sourceUrl: '',
    note: 'Unverified. Built-in default applies the 80%/180k rules.',
  },
  {
    modelId: 'deepseek-v4-flash',
    provider: 'deepseek-official',
    contextWindow: 128000,
    goldenPoint: null,
    verified: false,
    sourceUrl: '',
    note: 'Unverified. Built-in default applies the 80%/180k rules.',
  },
];

export const SMALL_WINDOW_THRESHOLD = 150000;
export const SMALL_WINDOW_RATIO = 0.8;
export const DEFAULT_COMPRESSION_POINT = 180000;

/**
 * Built-in default compression point for a model (user overrides excluded).
 * - Verified table entries use their verified golden point.
 * - Context window < 150k: ~80% of the window.
 * - Otherwise (including unknown window): 180k.
 * Returns { point, label, entry } where label is '证' or '自带'.
 */
export function resolveCompressionPoint(modelId, contextWindow) {
  const entry = MODEL_COMPRESSION_TABLE.find((m) => m.modelId === modelId) || null;
  if (entry && entry.verified && Number.isFinite(entry.goldenPoint)) {
    return { point: entry.goldenPoint, label: '证', entry };
  }
  const window = entry && Number.isFinite(entry.contextWindow)
    ? entry.contextWindow
    : (Number.isFinite(contextWindow) ? contextWindow : null);
  if (window !== null && window < SMALL_WINDOW_THRESHOLD) {
    return { point: Math.floor(window * SMALL_WINDOW_RATIO), label: '自带', entry };
  }
  return { point: DEFAULT_COMPRESSION_POINT, label: '自带', entry };
}

/** Normalize user-filled per-model compression points: { [modelId]: tokens }. */
export function normalizeCompressionOverrides(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [key, raw] of Object.entries(value)) {
    const modelId = typeof key === 'string' ? key.trim() : '';
    const point = Number(raw);
    if (!modelId || !Number.isFinite(point) || point <= 0) continue;
    out[modelId] = Math.floor(point);
  }
  return out;
}

/**
 * Effective compression point: user-filled value wins, otherwise built-in default.
 * Returns { point, origin, label, entry } where origin is '用户填写' or '自带'.
 */
export function effectiveCompressionPoint(modelId, contextWindow, overrides) {
  const resolved = resolveCompressionPoint(modelId, contextWindow);
  const filled = overrides && typeof overrides === 'object'
    ? Number(overrides[typeof modelId === 'string' ? modelId.trim() : ''])
    : NaN;
  if (Number.isFinite(filled) && filled > 0) {
    return { point: Math.floor(filled), origin: '用户填写', label: resolved.label, entry: resolved.entry };
  }
  return { point: resolved.point, origin: '自带', label: resolved.label, entry: resolved.entry };
}
