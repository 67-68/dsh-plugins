#!/usr/bin/env node
/**
 * fix-live-two.mjs — 清洗「含 message-edit/version 事件」的 live 会话。
 *
 * 与 clean-v0-sessions 的差异：只删除 `message-edit/version`（旧版
 * dsh-message-edit 写入、迁移器拒绝的类型），并重排 seq；同时对
 * `at-file-mention` 的 source 归一化为 `user`。其余一律不动。
 *
 * 用法：node fix-live-two.mjs [--apply]
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { sessionFormatCatalog } = require(
  "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js",
);
const ZSTD = "/opt/homebrew/bin/zstd";
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const APPLY = process.argv.includes("--apply");
const ROOT = join(homedir(), ".dsh", "sessions");
const BACKUP = join(homedir(), ".dsh", `live-two-backups-${Date.now()}`);

const PACKED = new Set(["reasoning-chunks", "text-chunks", "tool-call-chunks"]);
const UNKNOWN = new Set(["message-edit/version"]);

function atomicWrite(file, hl, bt) {
  const t = mkdtempSync(join(tmpdir(), "fx-"));
  try {
    const h = join(t, "h"), b = join(t, "b"), f1 = join(t, "1"), f2 = join(t, "2");
    writeFileSync(h, hl, "utf8");
    writeFileSync(b, bt, "utf8");
    execFileSync("/bin/sh", ["-c", `${shq(ZSTD)} -q -f -o ${shq(f1)} ${shq(h)}`], { maxBuffer: 1 << 20 });
    execFileSync("/bin/sh", ["-c", `${shq(ZSTD)} -q -f -o ${shq(f2)} ${shq(b)}`], { maxBuffer: 1 << 20 });
    const dt = `${file}.tmp-${process.pid}`;
    execFileSync("/bin/sh", ["-c", `cat ${shq(f1)} ${shq(f2)} > ${shq(dt)}`], { maxBuffer: 1 << 20 });
    execFileSync("/bin/sh", ["-c", `mv -f ${shq(dt)} ${shq(file)}`], { maxBuffer: 1 << 20 });
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
}

function walk(d, out = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (n === "session.jsonl.zstd") out.push(p);
  }
  return out;
}

let fixed = 0;
let skipped = 0;
for (const file of walk(ROOT)) {
  const text = execFileSync(ZSTD, ["-dc", file], { encoding: "utf8", maxBuffer: 1 << 30 });
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const header = JSON.parse(lines[0]);
  const rows = lines.slice(1).map((l) => JSON.parse(l));

  const del = new Set();
  for (const r of rows) if (UNKNOWN.has(r.type)) del.add(r.seq);
  if (del.size === 0) {
    skipped += 1;
    continue;
  }
  const ds = [...del].sort((a, b) => a - b);
  const off = (s) => {
    let c = 0;
    for (const d of ds) if (d < s) c += 1;
    return c;
  };
  const isDel = (s) => del.has(s);

  const out = [];
  for (const r of rows) {
    if (UNKNOWN.has(r.type)) continue;
    const o = { ...r };
    // source 归一化（at-file-mention -> user，删 relative），先做，独立于 seq 重排。
    if (o.data && typeof o.data === "object" && o.data.source && typeof o.data.source === "object") {
      if (o.data.source.kind === "at-file-mention") {
        const { relative: _r, ...rest } = o.data.source;
        o.data = { ...o.data, source: { ...rest, kind: "user" } };
      }
    }
    if (PACKED.has(r.type)) {
      o.seq0 = r.seq0 - off(r.seq0);
    } else {
      o.seq = r.seq - off(r.seq);
      const remap = (x) => {
        if (Array.isArray(x)) return x.map(remap).filter((v) => v !== null);
        if (typeof x === "number") {
          if (isDel(x)) return null;
          return x - off(x);
        }
        return x;
      };
      if (r.sourceEventSeqs !== undefined) o.sourceEventSeqs = remap(r.sourceEventSeqs);
      if (r.surfaceOp && typeof r.surfaceOp === "object") {
        const s = { ...r.surfaceOp };
        for (const k of ["start", "end"]) {
          if (typeof s[k] === "number") s[k] = isDel(s[k]) ? null : s[k] - off(s[k]);
        }
        o.surfaceOp = s;
      }
      if (o.data && typeof o.data === "object") {
        const d = { ...o.data };
        if (Array.isArray(d.messageSeqs)) {
          d.messageSeqs = d.messageSeqs.map((x) => (typeof x === "number" ? x - off(x) : x));
        }
        o.data = d;
      }
    }
    out.push(o);
  }

  // 官方迁移器校验（内存态）
  try {
    const restore = sessionFormatCatalog.createRestore(header, { recovery: "strict", validation: "transformed" });
    for (const r of out) restore.decodeRow(r);
    restore.finish();
  } catch (e) {
    console.log(`[FAIL] ${file.replace(ROOT + "/", "")} :: ${e.message.slice(0, 100)}`);
    continue;
  }

  const rel = file.replace(ROOT + "/", "");
  console.log(`[FIX]  ${rel}  rows ${rows.length} -> ${out.length}`);
  if (APPLY) {
    const bp = join(BACKUP, rel);
    mkdirSync(dirname(bp), { recursive: true });
    writeFileSync(bp, readFileSync(file));
    atomicWrite(file, JSON.stringify(header) + "\n", out.map((r) => JSON.stringify(r)).join("\n") + "\n");
    // 写后复读校验
    const back = execFileSync(ZSTD, ["-dc", file], { encoding: "utf8", maxBuffer: 1 << 30 });
    const bl = back.split("\n").filter((l) => l.trim() !== "");
    const restore2 = sessionFormatCatalog.createRestore(JSON.parse(bl[0]), { recovery: "strict", validation: "transformed" });
    for (let i = 1; i < bl.length; i++) restore2.decodeRow(JSON.parse(bl[i]));
    restore2.finish();
  }
  fixed += 1;
}
console.log(`\nfixed=${fixed} skipped=${skipped}${APPLY ? `  backups=${BACKUP}` : "  (dry-run)"}`);
