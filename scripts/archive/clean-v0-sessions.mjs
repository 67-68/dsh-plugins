#!/usr/bin/env node
/**
 * clean-v0-sessions.mjs — 清洗 DSH 升级后无法迁移的 v0 历史 session 日志。
 *
 * 背景（DSH 升级引入的 v0→v1 强制迁移拒绝两类历史脏数据）：
 *   1. `permission/preset` 事件 data 带旧版写入的 `origin` 字段，新版冻结 v0
 *      清单只认 `preset`，迁移抛 "unexpected member"。
 *   2. 旧版 dsh-mode-gate / dsh-message-edit 写入的自定义事件
 *      (`modeGate/mode`、`modeGate/target`、`message-edit/version`) 不在冻结
 *      v0 清单里，迁移抛 "unknown historical event type ... even when
 *      ignorable"（补 `ignorable` 无效，必须物理删除）。
 *
 * 清洗算法（已用真实数据 + 官方 sessionFormatCatalog 迁移器验证）：
 *   - 删除上述未知类型事件（普通事件）；
 *   - 删除 `permission/preset` data 的 `origin` 字段（保留事件本体）；
 *   - 删除事件后 seq 断裂，需重排：普通事件重排 `seq`，packed run
 *     (reasoning-chunks / text-chunks / tool-call-chunks) 重排 `seq0`；
 *   - 引用重映射：`sourceEventSeqs` 与 `surfaceOp.start/end` 中指向已删
 *     事件的引用直接删除（悬空），其余引用减去「前面被删掉的事件数」偏移；
 *   - 清洗后用官方 sessionFormatCatalog 迁移器做完整校验，失败则不写盘。
 *
 * 用法：
 *   node clean-v0-sessions.mjs [--apply] [--sessions <dir>] [--backup <dir>] [--skip id1,id2]
 *
 *   默认 dry-run：只报告会改哪些文件、每个文件的清洗结果，不写任何文件。
 *   --apply：先全量备份，再逐文件清洗 + 校验 + 重新 zstd 压缩。
 *   --sessions：session 根目录（默认 $HOME/.dsh/sessions）。
 *   --backup：备份目录（默认 $HOME/.dsh/session-clean-backups-<时间戳>）。
 *   --skip：额外跳过的 session id（逗号分隔），叠加在内置默认跳过名单上。
 *
 * 要求：本机需有 `zstd` 可执行文件（macOS 默认在 /opt/homebrew/bin/zstd）。
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DSH_GLOBAL_ROOT = "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules";
const sessionFormatCatalog = require(
  join(DSH_GLOBAL_ROOT, "@deepseek-ai", "dsh-session-format-catalog", "lib", "index.js"),
).sessionFormatCatalog;

// ── 配置 ────────────────────────────────────────────────────────────────────

const UNKNOWN_EVENT_TYPES = new Set([
  "modeGate/mode",
  "modeGate/target",
  "message-edit/version",
]);

/** 历史注入事件：旧版 mode-experience 写入的「通用经验」提示，v2→v3 迁移器
 *  不认其 source.kind="mode-experience-gated"，且它是自动注入文本（非用户
 *  真实输入），删除不影响会话语义。通过删除集合一并物理删除。 */
const INJECTED_SOURCE_KINDS = new Set(["mode-experience-gated"]);

/** source.kind 归一化：旧版 dsh-at-file 写入的 @ 引用消息 source 带
 *  kind="at-file-mention" + relative 字段，v0→v1 迁移器不认该 kind 也不认
 *  relative 成员。该消息本质是用户输入（内容为 <workspace-reference> 标记），
 *  归一化为 kind:"user"（删 relative）。 */
const SOURCE_KIND_NORMALIZE = {
  "at-file-mention": "user",
};
const PACKED_TYPES = new Set([
  "reasoning-chunks",
  "text-chunks",
  "tool-call-chunks",
]);
const ORIGIN_STRIP_TYPES = new Set(["permission/preset"]);

function findZstd() {
  const candidates = ["/opt/homebrew/bin/zstd", "/usr/local/bin/zstd", "zstd"];
  for (const c of candidates) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error("zstd not found on PATH (expected /opt/homebrew/bin/zstd)");
}

const ZSTD = findZstd();

// ── 命令行参数 ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const flagValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const APPLY = hasFlag("--apply");
// --restore=<backupDir>：把备份目录里的原始 session 文件恢复到 sessions 根目录
// （用于把被污染的文件回滚到清洗前的完好原文），之后可重跑 --apply 清洗。
const RESTORE = flagValue("--restore", "");
// --reframe：只把单 frame 的 .jsonl.zstd 重新编码为 DSH 要求的多 frame
// （第一帧=header 行），不改内容。用于修复早期 compress() 单 frame 的产物。
const REFRAME = hasFlag("--reframe");
const SESSIONS_DIR = resolve(flagValue("--sessions", join(homedir(), ".dsh", "sessions")));
const BACKUP_DIR = resolve(
  flagValue("--backup", join(homedir(), ".dsh", `session-clean-backups-${Date.now()}`)),
);

// 显式跳过的 session id 名单（不清洗，保持原样）。逗号分隔。
// session-bbdc7466-f84e-47b2-9513-064e48abe80e：旧版 fork 会话，header
// seedLength=111 与物理文件不匹配（旧版记录 bug），删事件后
// inheritedEventCount 超界，无法清洗。保持原样（它本来就打不开）。
const SKIP_SESSION_IDS = new Set(
  (flagValue("--skip", "") || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);
const DEFAULT_SKIP = [
  "session-bbdc7466-f84e-47b2-9513-064e48abe80e",
];
for (const id of DEFAULT_SKIP) SKIP_SESSION_IDS.add(id);

// ── 工具函数 ────────────────────────────────────────────────────────────────

function decompress(file) {
  return execFileSync(ZSTD, ["-dc", file], { encoding: "utf8", maxBuffer: 1 << 30 });
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * 原子写入 DSH 会话文件：全程「临时文件 + shell 流式」，最后 rename 原子替换。
 *
 * 为什么不用 execFileSync 的 input（大 buffer）：4.8MB 级内容走 Node 的
 * stdin 管道会死锁（实测两次被 SIGKILL），且中途写入会产生半截文件，被 DSH
 * 读出后叠加损坏。
 *
 * DSH 要求「多 frame」zstd：第一个 frame 必须恰好是 header 一行（含换行），
 * 其余内容进第二个 frame（assertZstdHeaderFrame / readFirstZstdLine 契约）。
 */
function atomicWriteSession(file, headerLine, rowsText) {
  const tmp = mkdtempSync(join(tmpdir(), "dsh-write-"));
  try {
    const hdr = join(tmp, "hdr.jsonl");
    const body = join(tmp, "body.jsonl");
    const f1 = join(tmp, "f1.zst");
    const f2 = join(tmp, "f2.zst");
    const out = join(tmp, "out.zst");
    // header 行（含换行）；rows 为空时 body 给空文件
    writeFileSync(hdr, headerLine, "utf8");
    writeFileSync(body, rowsText ?? "", "utf8");
    // 分别压缩
    execFileSync("/bin/sh", ["-c", `${shellQuote(ZSTD)} -q -f -o ${shellQuote(f1)} ${shellQuote(hdr)}`], { maxBuffer: 1 << 20 });
    execFileSync("/bin/sh", ["-c", `${shellQuote(ZSTD)} -q -f -o ${shellQuote(f2)} ${shellQuote(body)}`], { maxBuffer: 1 << 20 });
    // 拼接两帧 → 目标同目录临时文件 → 原子 rename
    const destTmp = `${file}.tmp-${process.pid}`;
    execFileSync("/bin/sh", ["-c", `cat ${shellQuote(f1)} ${shellQuote(f2)} > ${shellQuote(destTmp)}`], { maxBuffer: 1 << 20 });
    execFileSync("/bin/sh", ["-c", `mv -f ${shellQuote(destTmp)} ${shellQuote(file)}`], { maxBuffer: 1 << 20 });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function listSessionFiles(dir) {
  const out = [];
  function walk(d) {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name === "session.jsonl.zstd") out.push(p);
    }
  }
  walk(dir);
  return out;
}

/** 解析 JSONL 为行对象数组；返回 { header, rows }。 */
function parseJsonl(text) {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const parsed = lines.map((l) => JSON.parse(l));
  return { header: parsed[0], rows: parsed.slice(1) };
}

/** 清洗单文件内容，返回 { header, rows }。失败抛错。 */
function cleanSession(parsed) {
  const { header, rows } = parsed;

  // 判断一个事件是否为「注入事件」：source.kind 在 INJECTED_SOURCE_KINDS 里。
  const isInjected = (row) => {
    const src = row && row.data && typeof row.data === "object" ? row.data.source : undefined;
    return typeof src === "object" && src !== null && INJECTED_SOURCE_KINDS.has(src.kind);
  };

  // 收集要删除的普通事件 seq
  const deletedSeqs = new Set();
  for (const row of rows) {
    if (UNKNOWN_EVENT_TYPES.has(row.type) || isInjected(row)) deletedSeqs.add(row.seq);
  }
  const deletedSorted = [...deletedSeqs].sort((a, b) => a - b);

  // 某 seq 之前的删除累计偏移
  function offsetBefore(seq) {
    let c = 0;
    for (const d of deletedSorted) if (d < seq) c += 1;
    return c;
  }
  function isDeleted(seq) {
    return deletedSeqs.has(seq);
  }

  const cleaned = [];
  for (const row of rows) {
    if (UNKNOWN_EVENT_TYPES.has(row.type) || isInjected(row)) continue; // 物理删除

    const out = { ...row };

    if (PACKED_TYPES.has(row.type)) {
      // packed run：重排 seq0
      out.seq0 = row.seq0 - offsetBefore(row.seq0);
    } else {
      out.seq = row.seq - offsetBefore(row.seq);

      // 删除 permission/preset 的 origin 字段
      if (ORIGIN_STRIP_TYPES.has(row.type) && row.data && typeof row.data === "object" && "origin" in row.data) {
        const { origin: _origin, ...rest } = row.data;
        out.data = rest;
      }

      // source.kind 归一化：at-file-mention -> user（删 relative）
      if (out.data && typeof out.data === "object" && out.data.source && typeof out.data.source === "object") {
        const src = out.data.source;
        if (SOURCE_KIND_NORMALIZE[src.kind] !== undefined) {
          const { relative: _relative, ...rest } = src;
          out.data = { ...out.data, source: { ...rest, kind: SOURCE_KIND_NORMALIZE[src.kind] } };
        }
      }

      // 通用 seq 引用 remap：单值悬空删除，否则减偏移；数组成员悬空删除。
      const remapSeqRef = (x) => {
        if (Array.isArray(x)) return x.map(remapSeqRef).filter((v) => v !== null);
        if (typeof x === "number") {
          if (isDeleted(x)) return null;
          return x - offsetBefore(x);
        }
        return x;
      };

      // 重映射 sourceEventSeqs
      if (row.sourceEventSeqs !== undefined) {
        out.sourceEventSeqs = remapSeqRef(row.sourceEventSeqs);
      }

      // 重映射 surfaceOp start/end
      if (row.surfaceOp && typeof row.surfaceOp === "object") {
        const sop = { ...row.surfaceOp };
        for (const k of ["start", "end"]) {
          if (typeof sop[k] === "number") {
            if (isDeleted(sop[k])) sop[k] = null;
            else sop[k] = sop[k] - offsetBefore(sop[k]);
          }
        }
        out.surfaceOp = sop;
      }

      // 重映射 data 内的 seq 引用字段（session/title 的 messageSeqs、
      // session/title-llm-request 的 messageSeqs、command/done 的 sourceEventSeq）。
      // 这些字段引用必须保留（不能悬空删除），只做减偏移。
      // 注意：基于 out.data（已删 origin 的），而不是 row.data，否则 origin 会被带回来。
      if (out.data && typeof out.data === "object") {
        const data = { ...out.data };
        if (Array.isArray(data.messageSeqs)) {
          data.messageSeqs = data.messageSeqs.map((s) =>
            typeof s === "number" ? s - offsetBefore(s) : s,
          );
        }
        if (typeof data.sourceEventSeq === "number") {
          data.sourceEventSeq = data.sourceEventSeq - offsetBefore(data.sourceEventSeq);
        }
        if (typeof data.throughSeq === "number") {
          data.throughSeq = data.throughSeq - offsetBefore(data.throughSeq);
        }
        out.data = data;
      }
    }

    cleaned.push(out);
  }

  return { header, rows: cleaned };
}

/** 用官方迁移器完整校验清洗结果；通过返回 true，否则抛出携带原因的错误。 */
function validateCleaned(parsed) {
  const { header, rows } = parsed;
  const restore = sessionFormatCatalog.createRestore(header, {
    recovery: "strict",
    validation: "transformed",
  });
  for (const row of rows) restore.decodeRow(row);
  restore.finish();
  return true;
}

/**
 * 断言事件的 seq 连续（packed run 用 seq0 + 展开长度推进）。
 * 这是防污染的第二道闸：迁移器对某些 seq 断裂容忍，但 DSH 实际读取会拒绝。
 */
function assertSeqContiguous(parsed) {
  let expected = 0;
  for (let i = 0; i < parsed.rows.length; i++) {
    const r = parsed.rows[i];
    if (PACKED_TYPES.has(r.type)) {
      const cnt = (r.data && (r.data.texts || r.data.args || r.data.toolCalls || []).length) || 0;
      if (r.seq0 !== expected) {
        throw new Error(`seq gap at row ${i + 1}: packed ${r.type} seq0=${r.seq0} expected=${expected}`);
      }
      expected += cnt;
    } else {
      if (r.seq !== expected) {
        throw new Error(`seq gap at row ${i + 1}: ${r.type} seq=${r.seq} expected=${expected}`);
      }
      expected += 1;
    }
  }
  return expected;
}

// ── debug-one：对单个文件跑完整流程，dump 中间状态，定位污染点 ────────────
const DEBUG_ONE = flagValue("--debug-one", "");
if (DEBUG_ONE) {
  const text = decompress(DEBUG_ONE);
  const raw = readFileSync(DEBUG_ONE);
  console.log(`[debug] file=${DEBUG_ONE}`);
  console.log(`[debug] frames=${countZstdFrames(raw)} bytes=${raw.length} textLen=${text.length}`);
  const sIn = jsonStats(text);
  console.log(`[debug] INPUT  lines=${sIn.lines} headerOk=${sIn.headerOk} parseErrors=${sIn.parseErrors} top=${sIn.top}`);
  let inTexts = 0;
  for (const line of text.split("\n").filter((l) => l.trim())) {
    const o = JSON.parse(line);
    if (o.type === "reasoning-chunks") inTexts += (o.data.texts || []).length;
  }
  console.log(`[debug] INPUT  totalReasoningTexts=${inTexts}`);

  const parsed = parseJsonl(text);
  const cleaned = cleanSession(parsed);
  const outText = [JSON.stringify(cleaned.header), ...cleaned.rows.map((r) => JSON.stringify(r))].join("\n") + "\n";
  let outTexts = 0;
  for (const r of cleaned.rows) if (r.type === "reasoning-chunks") outTexts += (r.data.texts || []).length;
  const sOut = jsonStats(outText);
  console.log(`[debug] CLEAN  lines=${outText.lines} totalReasoningTexts=${outTexts} top=${sOut.top}`);
  // 打印 seq0 附近的 packed run
  for (const r of cleaned.rows) {
    if (r.type === "reasoning-chunks" && r.seq0 >= 120 && r.seq0 <= 140) {
      console.log(`[debug]   cleaned seq0=${r.seq0} cnt=${(r.data.texts || []).length}`);
    }
  }

  // compress round-trip 验证
  const compressed = compress(outText);
  const tmpOut = join(tmpdir(), `dsh-dbg-${Date.now()}.zstd`);
  writeFileSync(tmpOut, compressed);
  const back = decompress(tmpOut);
  console.log(`[debug] COMPRESS frames=${countZstdFrames(compressed)} bytes=${compressed.length} roundtripEqual=${back === outText}`);
  if (back !== outText) {
    console.log(`[debug]   outText.length=${outText.length} back.length=${back.length}`);
    // 找第一个差异位置
    const n = Math.min(outText.length, back.length);
    for (let i = 0; i < n; i++) {
      if (outText[i] !== back[i]) {
        console.log(`[debug]   first diff at char ${i}: out=${JSON.stringify(outText.slice(i - 40, i + 40))} back=${JSON.stringify(back.slice(i - 40, i + 40))}`);
        break;
      }
    }
  }
  rmSync(tmpOut, { force: true });
  process.exit(0);
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

// ── restore 分支：从备份目录把原始文件恢复到 sessions 根目录 ──────────────
if (RESTORE) {
  const srcDir = resolve(RESTORE);
  const backupFiles = listSessionFiles(srcDir);
  if (backupFiles.length === 0) {
    console.log(`no session files under backup dir ${srcDir}`);
    process.exit(1);
  }
  let restored = 0;
  for (const bf of backupFiles) {
    const rel = bf.slice(srcDir.length + 1);
    const dest = join(SESSIONS_DIR, rel);
    mkdirSync(dirname(dest), { recursive: true });
    // 原子恢复：copy 到临时文件再 rename
    const destTmp = `${dest}.restore-${process.pid}`;
    writeFileSync(destTmp, readFileSync(bf));
    execFileSync("/bin/sh", ["-c", `mv -f ${shellQuote(destTmp)} ${shellQuote(dest)}`], { maxBuffer: 1 << 20 });
    restored += 1;
  }
  console.log(`restored ${restored} files from ${srcDir} -> ${SESSIONS_DIR}`);
  process.exit(0);
}

const files = listSessionFiles(SESSIONS_DIR);
if (files.length === 0) {
  console.log(`no session.jsonl.zstd files found under ${SESSIONS_DIR}`);
  process.exit(0);
}

console.log(`mode: ${REFRAME ? "REFRAME (re-encode zstd frames)" : APPLY ? "APPLY (write + backup)" : "DRY-RUN (no writes)"}`);
console.log(`sessions dir: ${SESSIONS_DIR}`);
console.log(`files found:  ${files.length}\n`);

// ── 诊断工具 ────────────────────────────────────────────────────────────────

/** 统计 zstd frame magic (0x28B52FFD) 出现次数。 */
function countZstdFrames(buf) {
  let n = 0;
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) n += 1;
  }
  return n;
}

/** 对 JSONL 文本做统计诊断（返回一行摘要）。 */
function jsonStats(text) {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const types = Object.create(null);
  let headerOk = false;
  let parseErrors = 0;
  for (let i = 0; i < lines.length; i++) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      parseErrors += 1;
      continue;
    }
    const t = typeof obj.type === "string" ? obj.type : "(no-type)";
    types[t] = (types[t] || 0) + 1;
    if (i === 0 && t === "session") headerOk = true;
  }
  const top = Object.entries(types)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
  return { lines: lines.length, headerOk, parseErrors, top };
}

const T0 = Date.now();
const elapsed = () => `${((Date.now() - T0) / 1000).toFixed(1)}s`;

/**
 * 用「临时文件 + shell 流式」把单 frame 文件重压为多 frame（首帧=header 行）。
 * 关键：大文件绝不能经 Node 的 input/output buffer（execFileSync 大 input 会
 * 管道死锁）；全程用 shell 重定向，只在最后读一次产物。
 * 返回 { framesBefore, framesAfter, bytesBefore, bytesAfter }。
 */
function reframeFileOnDisk(file) {
  const bufBefore = readFileSync(file);
  const framesBefore = countZstdFrames(bufBefore);
  const tmp = mkdtempSync(join(tmpdir(), "dsh-reframe-"));
  try {
    const all = join(tmp, "all.jsonl");
    const hdr = join(tmp, "hdr.jsonl");
    const body = join(tmp, "body.jsonl");
    const f1 = join(tmp, "f1.zst");
    const f2 = join(tmp, "f2.zst");
    const out = join(tmp, "out.zst");
    const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    // 解压原文件到临时明文
    execFileSync("/bin/sh", ["-c", `${shq(ZSTD)} -dc ${shq(file)} > ${shq(all)}`], { maxBuffer: 1 << 20 });
    // 首行 = header；其余 = body
    execFileSync("/bin/sh", ["-c", `head -n 1 ${shq(all)} > ${shq(hdr)}`], { maxBuffer: 1 << 20 });
    execFileSync("/bin/sh", ["-c", `tail -n +2 ${shq(all)} > ${shq(body)}`], { maxBuffer: 1 << 20 });
    // 分别压缩（文件→文件）
    execFileSync("/bin/sh", ["-c", `${shq(ZSTD)} -q -f -o ${shq(f1)} ${shq(hdr)}`], { maxBuffer: 1 << 20 });
    execFileSync("/bin/sh", ["-c", `${shq(ZSTD)} -q -f -o ${shq(f2)} ${shq(body)}`], { maxBuffer: 1 << 20 });
    // 拼接两帧
    execFileSync("/bin/sh", ["-c", `cat ${shq(f1)} ${shq(f2)} > ${shq(out)}`], { maxBuffer: 1 << 20 });
    const bufAfter = readFileSync(out);
    const framesAfter = countZstdFrames(bufAfter);
    // 写回
    writeFileSync(file, bufAfter);
    return { framesBefore, framesAfter, bytesBefore: bufBefore.length, bytesAfter: bufAfter.length };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── reframe 分支：只重压 frame 结构 ─────────────────────────────────────────
if (REFRAME) {
  let reframed = 0;
  let skipped = 0;
  const reframeFailures = [];
  for (const file of files) {
    const rel = file.replace(SESSIONS_DIR + "/", "");
    let raw;
    try {
      raw = readFileSync(file);
    } catch (e) {
      reframeFailures.push([rel, `read failed: ${e.message}`]);
      console.log(`[reframe][${elapsed()}] FAIL   ${rel} :: read failed: ${e.message}`);
      continue;
    }
    const framesBefore = countZstdFrames(raw);
    // 诊断：JSON 统计（解压后）
    let stats = null;
    if (process.env.DSH_CLEAN_VERBOSE === "1") {
      try {
        stats = jsonStats(decompress(file));
      } catch (e) {
        stats = { error: e.message };
      }
    }
    if (framesBefore >= 2) {
      skipped += 1;
      console.log(
        `[reframe][${elapsed()}] skip   ${rel} :: frames=${framesBefore} bytes=${raw.length}` +
          (stats ? ` lines=${stats.lines} headerOk=${stats.headerOk} top=${stats.top}` : ""),
      );
      continue;
    }
    // 单帧：需要重压。先备份原文件，再就地重压。
    try {
      const backupPath = join(BACKUP_DIR, rel);
      mkdirSync(dirname(backupPath), { recursive: true });
      writeFileSync(backupPath, raw); // 备份单帧原文（可回滚）
      const r = reframeFileOnDisk(file);
      reframed += 1;
      console.log(
        `[reframe][${elapsed()}] OK     ${rel} :: frames ${r.framesBefore}->${r.framesAfter} bytes ${r.bytesBefore}->${r.bytesAfter}` +
          (stats ? ` lines=${stats.lines} headerOk=${stats.headerOk} top=${stats.top}` : ""),
      );
    } catch (e) {
      reframeFailures.push([rel, `reframe failed: ${e.message}`]);
      console.log(`[reframe][${elapsed()}] FAIL   ${rel} :: ${e.message}`);
    }
  }
  console.log(
    `\nreframe summary @${elapsed()}: reframed=${reframed} already-ok=${skipped} failed=${reframeFailures.length} total=${files.length}`,
  );
  if (reframeFailures.length > 0) {
    for (const [f, msg] of reframeFailures) console.log(`  ${f}: ${msg}`);
    process.exit(1);
  }
  console.log(`\n(注：reframe 直接就地写回；原文件备份见下方建议)`);
  process.exit(0);
}

let cleanCount = 0;
let cleanPassCount = 0;
let cleanFailCount = 0;
let skipCount = 0;
const failures = [];

for (const file of files) {
  // 跳过名单（按 session id 匹配文件名）
  const fileSessionId = file.match(/session-[0-9a-f-]{36}/)?.[0];
  if (fileSessionId && SKIP_SESSION_IDS.has(fileSessionId)) {
    console.log(`[skip]    ${file.replace(SESSIONS_DIR + "/", "")} (in skip list, untouched)`);
    skipCount += 1;
    continue;
  }

  let text;
  try {
    text = decompress(file);
  } catch (e) {
    failures.push([file, `decompress failed: ${e.message}`]);
    continue;
  }

  let parsed;
  try {
    parsed = parseJsonl(text);
  } catch (e) {
    failures.push([file, `parse failed: ${e.message}`]);
    continue;
  }

  // 判断是否需要清洗
  const needsClean = parsed.rows.some((r) => {
    const src = r && r.data && typeof r.data === "object" ? r.data.source : undefined;
    const injected = typeof src === "object" && src !== null && INJECTED_SOURCE_KINDS.has(src.kind);
    const normalizeKind =
      typeof src === "object" && src !== null && SOURCE_KIND_NORMALIZE[src.kind] !== undefined;
    return (
      UNKNOWN_EVENT_TYPES.has(r.type) ||
      injected ||
      normalizeKind ||
      (ORIGIN_STRIP_TYPES.has(r.type) && r.data && typeof r.data === "object" && "origin" in r.data)
    );
  });
  if (!needsClean) {
    skipCount += 1;
    continue;
  }

  cleanCount += 1;
  let cleaned;
  try {
    cleaned = cleanSession(parsed);
    validateCleaned(cleaned); // 官方迁移器完整校验（唯一权威）
    // roundtrip 预检：内存对象 → JSON 文本 → 解析 → 再校验。
    // 若此处失败，说明 JSON 序列化环节有损（与写盘无关）。
    const rtText =
      [JSON.stringify(cleaned.header), ...cleaned.rows.map((r) => JSON.stringify(r))].join("\n") + "\n";
    validateCleaned(parseJsonl(rtText));
  } catch (e) {
    cleanFailCount += 1;
    failures.push([file, `clean/validate failed: ${e.message}`]);
    continue;
  }

  cleanPassCount += 1;
  const rel = file.replace(SESSIONS_DIR + "/", "");

  if (APPLY) {
    const backupPath = join(BACKUP_DIR, rel);
    mkdirSync(dirname(backupPath), { recursive: true });
    writeFileSync(backupPath, readFileSync(file)); // 原文件字节级备份

    // 原子写入：header 行独立一帧 + rows 一帧，临时文件 + rename。
    const headerLine = JSON.stringify(cleaned.header) + "\n";
    const rowsText = cleaned.rows.length > 0 ? cleaned.rows.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
    atomicWriteSession(file, headerLine, rowsText);

    // 写回后立刻复读，用官方迁移器校验（确认原子写入无损）。
    validateCleaned(parseJsonl(decompress(file)));
    console.log(`CLEANED  ${rel}  (rows ${parsed.rows.length} -> ${cleaned.rows.length})`);
  } else {
    const changed = parsed.rows.length - cleaned.rows.length;
    console.log(`[dry-run] ${rel}  (deleted ${changed} unknown events)`);
  }
}

console.log(`\nsummary: clean=${cleanCount} passed=${cleanPassCount} failed=${cleanFailCount} skipped=${skipCount} total=${files.length}`);
if (failures.length > 0) {
  console.log("\nfailures:");
  for (const [f, msg] of failures) console.log(`  ${f}: ${msg}`);
  process.exit(1);
}

if (APPLY) {
  console.log(`\nbackups written to: ${BACKUP_DIR}`);
} else {
  console.log("\ndry-run only — no files were modified. Re-run with --apply to commit.");
}
