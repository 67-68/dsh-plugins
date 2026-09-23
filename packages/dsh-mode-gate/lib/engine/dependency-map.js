/**
 * 按需生成的轻量依赖图（代码导航用）。
 *
 * 只扫描源码里的相对 import / require / 动态 import，输出「文件 → 内部依赖文件」
 * 的紧凑列表。**不常驻注入**，只在 Agent 主动调用 dependency_map 时生成；
 * 单次输出硬上限 MAX_DEPENDENCY_TOKENS（1024）tokens，超出即截断并提示用 focus 收窄。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { estimateTokens } from '../stores/architecture-store.js';

export const MAX_DEPENDENCY_TOKENS = 1024;
export const MAX_SCAN_FILES = 800;

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'coverage', 'out', 'vendor', 'tmp',
  '__pycache__', '.git', '.next', '.turbo', '.cache', '.venv', 'venv',
]);

const SOURCE_EXTS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'];

function toPosix(value) {
  return String(value).split(sep).join('/');
}

/** 从源码里抽取所有 specifier（去重保序）。 */
export function extractSpecifiers(source) {
  const text = String(source == null ? '' : source);
  const out = [];
  const push = (value) => {
    if (value && !out.includes(value)) out.push(value);
  };
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) push(match[1]);
  }
  return out;
}

export function isRelativeSpecifier(specifier) {
  const value = String(specifier == null ? '' : specifier);
  return value === '.' || value === '..' || value.startsWith('./') || value.startsWith('../');
}

/** 递归收集源码文件（相对扫描根的 posix 路径），跳过依赖/构建目录。 */
export function scanSourceFiles(root, options = {}) {
  const base = resolve(String(root || ''));
  const maxFiles = options.maxFiles || MAX_SCAN_FILES;
  const files = [];
  const walk = (dir) => {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf('.');
      if (dot < 0) continue;
      if (!SOURCE_EXTS.includes(entry.name.slice(dot))) continue;
      files.push(toPosix(relative(base, full)));
    }
  };
  walk(base);
  files.sort();
  return { root: base, files, truncated: files.length >= maxFiles };
}

/** 把相对 specifier 解析为扫描集合内的文件路径；解析不到返回 null。 */
export function resolveSpecifier(fromRel, specifier, fileSet) {
  const raw = toPosix(join(dirname(fromRel), String(specifier)));
  const candidates = [];
  if (SOURCE_EXTS.some((ext) => raw.endsWith(ext))) {
    candidates.push(raw);
  } else {
    for (const ext of SOURCE_EXTS) candidates.push(`${raw}${ext}`);
    for (const ext of SOURCE_EXTS) candidates.push(`${raw}/index${ext}`);
  }
  return candidates.find((candidate) => fileSet.has(candidate)) || null;
}

/** 构建文件 → 内部依赖的文件图。 */
export function buildDependencyGraph(root, options = {}) {
  const scan = scanSourceFiles(root, options);
  const fileSet = new Set(scan.files);
  const edges = new Map();
  for (const rel of scan.files) {
    let source = '';
    try {
      source = readFileSync(join(scan.root, rel), 'utf8');
    } catch (_err) {
      source = '';
    }
    const targets = [];
    for (const specifier of extractSpecifiers(source)) {
      if (!isRelativeSpecifier(specifier)) continue;
      const resolved = resolveSpecifier(rel, specifier, fileSet);
      if (resolved && resolved !== rel && !targets.includes(resolved)) targets.push(resolved);
    }
    targets.sort();
    edges.set(rel, targets);
  }
  return { root: scan.root, files: scan.files, edges, truncated: scan.truncated };
}

/** 渲染依赖图，硬保证估算 tokens ≤ maxTokens（默认 1024）。 */
export function renderDependencyMap(graph, options = {}) {
  const maxTokens = Math.max(200, options.maxTokens || MAX_DEPENDENCY_TOKENS);
  const focus = String(options.focus == null ? '' : options.focus).trim();
  const focusPosix = toPosix(focus);
  const files = Array.isArray(graph && graph.files) ? graph.files : [];
  const edges = graph && graph.edges instanceof Map ? graph.edges : new Map();
  const header = [
    `# 依赖图（按需生成，≤${maxTokens} tokens）`,
    `根：${graph && graph.root ? graph.root : ''}`,
  ];
  const rows = [];
  const focusMatch = (value) => !focusPosix || String(value).includes(focusPosix);
  let edgeTotal = 0;
  for (const rel of files) {
    const targets = edges.get(rel) || [];
    if (targets.length > 0) edgeTotal += targets.length;
    if (focus) {
      const relevant = focusMatch(rel) || targets.some((target) => focusMatch(target));
      if (!relevant) continue;
    }
    if (targets.length === 0) continue;
    rows.push(`- ${rel} → ${targets.join(', ')}`);
  }
  const summary = [
    `文件：${files.length} 个${graph && graph.truncated ? '（已达到扫描上限，可能不全）' : ''}`,
    `内部依赖边：${edgeTotal} 条`,
    focus ? `focus：${focus}` : '',
  ].filter(Boolean);
  const note = `（已截断：依赖图超过 ${maxTokens} tokens；请用 focus 参数收窄到相关模块。）`;
  const head = [...header, ...summary, ''];
  const headText = head.join('\n');
  const reserved = estimateTokens(headText) + estimateTokens(`\n\n${note}`);
  const body = [];
  let truncated = false;
  if (rows.length === 0) {
    body.push('（没有发现相对路径依赖；请确认扫描根目录，或用 focus 收窄。）');
  } else {
    for (const row of rows) {
      const candidate = [...body, row].join('\n');
      if (estimateTokens(candidate) + reserved > maxTokens) {
        truncated = true;
        break;
      }
      body.push(row);
    }
  }
  let lines = [...head, ...body];
  if (truncated) lines = [...lines, '', note];
  let text = lines.join('\n');
  // 兜底：极端情况下只保留头部 + 提示，确保硬上限。
  if (estimateTokens(text) > maxTokens) {
    text = [...header, ...summary, '', note].join('\n');
  }
  return { text, tokens: estimateTokens(text), rows: body.length, edgeTotal, truncated, maxTokens };
}

/** 一步到位：扫描 + 建图 + 有界渲染。 */
export function generateDependencyMap(root, options = {}) {
  const graph = buildDependencyGraph(root, options);
  const rendered = renderDependencyMap(graph, options);
  return { ...rendered, fileCount: graph.files.length, root: graph.root };
}