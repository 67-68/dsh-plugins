#!/usr/bin/env node
/**
 * strip-origin-only.mjs — 只删除 `permission/preset` 事件 data 里的 `origin`
 * 字段，不删事件、不重排 seq、不动任何其他内容。用于「仅 origin 问题」的
 * 会话（事件数不变，故 seq 天然保持连续，零风险）。
 *
 * 背景：v0 迁移器拒绝 `permission/preset` data 里的 `origin` 成员。
 *
 * 用法：
 *   node strip-origin-only.mjs            # dry-run
 *   node strip-origin-only.mjs --apply    # 备份 + 原地重写（多帧 zstd）
 */

import { execFileSync } from "node:child_process";
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";

const APPLY = process.argv.includes("--apply");
const ROOT = join(homedir(), ".dsh", "sessions");
const BACKUP = join(homedir(), ".dsh", `origin-strip-backups-${Date.now()}`);
const ZSTD = "/opt/homebrew/bin/zstd";
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

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

/** 原子写多帧：header 行一帧 + body 一帧。 */
function atomicWrite(file, headerLine, bodyText) {
  const tmp = mkdtempSync(join(tmpdir(), "dsh-origin-"));
  try {
    const hdr = join(tmp, "h");
    const body = join(tmp, "b");
    const f1 = join(tmp, "f1");
    const f2 = join(tmp, "f2");
    writeFileSync(hdr, headerLine, "utf8");
    writeFileSync(body, bodyText, "utf8");
    execFileSync("/bin/sh", ["-c", `${shq(ZSTD)} -q -f -o ${shq(f1)} ${shq(hdr)}`], { maxBuffer: 1 << 20 });
    execFileSync("/bin/sh", ["-c", `${shq(ZSTD)} -q -f -o ${shq(f2)} ${shq(body)}`], { maxBuffer: 1 << 20 });
    const destTmp = `${file}.tmp-${process.pid}`;
    execFileSync("/bin/sh", ["-c", `cat ${shq(f1)} ${shq(f2)} > ${shq(destTmp)}`], { maxBuffer: 1 << 20 });
    execFileSync("/bin/sh", ["-c", `mv -f ${shq(destTmp)} ${shq(file)}`], { maxBuffer: 1 << 20 });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

let changed = 0;
let skipped = 0;
let total = 0;
for (const file of walk(ROOT)) {
  total += 1;
  const text = execFileSync(ZSTD, ["-dc", file], { encoding: "utf8", maxBuffer: 1 << 30 });
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  let hits = 0;
  const outLines = lines.map((l, idx) => {
    if (idx === 0) return l; // header 原样
    let r;
    try {
      r = JSON.parse(l);
    } catch {
      return l;
    }
    if (r.type === "permission/preset" && r.data && typeof r.data === "object" && "origin" in r.data) {
      const { origin: _o, ...rest } = r.data;
      hits += 1;
      return JSON.stringify({ ...r, data: rest });
    }
    return l;
  });
  if (hits === 0) {
    skipped += 1;
    continue;
  }
  changed += 1;
  const rel = file.slice(ROOT.length + 1);
  console.log(`[strip] ${rel}  (origin fields removed: ${hits})`);
  if (APPLY) {
    const bp = join(BACKUP, rel);
    mkdirSync(dirname(bp), { recursive: true });
    writeFileSync(bp, readFileSync(file));
    const headerLine = outLines[0] + "\n";
    const bodyText = outLines.slice(1).map((l) => l + "\n").join("");
    atomicWrite(file, headerLine, bodyText);
  }
}

console.log(`\ntotal=${total} changed=${changed} skipped=${skipped}${APPLY ? `  backups=${BACKUP}` : "  (dry-run)"}`);
