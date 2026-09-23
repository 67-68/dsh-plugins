#!/usr/bin/env node
/**
 * quarantine-archived-sessions.mjs — 把 DSH 已归档的 session 移出 sessions 目录。
 *
 * 背景：DSH 启动时会扫描 `~/.dsh/sessions` 下所有 session 文件建索引；其中
 * 早期（v0 格式）会议话因迁移契约变化无法读取，会拖垮启动。用户只需要
 * 「未归档」的会话正常工作，因此把归档集合（`workspace.json` 的
 * `archivedSessionIds`）里的 session 目录整体移到隔离目录，不删、可回滚。
 *
 * 保号规则：**完全按 archivedSessionIds 判定**，与路径新旧无关 ——
 * 旧路径（如 --Users-...-Documents-dsh-plugins--）里未归档的同样保留。
 *
 * 用法：
 *   node quarantine-archived-sessions.mjs            # dry-run（只报告）
 *   node quarantine-archived-sessions.mjs --apply    # 实际移移
 *   node quarantine-archived-sessions.mjs --apply --to <dir>   # 指定隔离目录
 *
 * 隔离目录默认：`~/.dsh/sessions-quarantine-<时间戳>`（可随时整体移回）。
 */

import { readFileSync, readdirSync, statSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const toIdx = args.indexOf("--to");
const QUAR = toIdx !== -1 && args[toIdx + 1]
  ? args[toIdx + 1]
  : join(homedir(), ".dsh", `sessions-quarantine-${Date.now()}`);

const ROOT = join(homedir(), ".dsh", "sessions");
const WORKSPACE_JSON = join(homedir(), ".dsh", "storages", "workspace.json");
const ZSTD = "/opt/homebrew/bin/zstd";
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const ws = JSON.parse(readFileSync(WORKSPACE_JSON, "utf8"));
const archived = new Set(ws.global?.archivedSessionIds ?? []);

function listSessionFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (n === "session.jsonl.zstd") out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** 读取一个 session 文件的真实 id（`session-*` 目录直接取目录名，否则解首行 header）。 */
function readId(file) {
  const bn = basename(dirname(file));
  if (/^session-[0-9a-f-]{36}$/.test(bn)) return bn;
  try {
    const out = execFileSync("/bin/sh", ["-c", `${ZSTD} -dc ${shq(file)} | head -n 1`], {
      encoding: "utf8",
      maxBuffer: 1 << 20,
    });
    const obj = JSON.parse(out.trim());
    return typeof obj.id === "string" ? obj.id : null;
  } catch {
    return null;
  }
}

const files = listSessionFiles(ROOT);
let arch = 0;
let live = 0;
let unknown = 0;
const dirsToMove = new Set();

for (const f of files) {
  const id = readId(f);
  const dir = dirname(f);
  if (id === null) {
    unknown += 1;
    console.log(`[unknown-id] ${f}`);
    continue;
  }
  if (archived.has(id)) {
    arch += 1;
    dirsToMove.add(dir);
  } else {
    live += 1;
  }
}

console.log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
console.log(`root: ${ROOT}`);
console.log(`files total=${files.length}  archived=${arch}  live=${live}  unknownId=${unknown}`);
console.log(`quarantine dir: ${QUAR}`);
console.log(`dirs to move: ${dirsToMove.size}`);

if (APPLY) {
  let moved = 0;
  for (const dir of dirsToMove) {
    const rel = dir.slice(ROOT.length + 1);
    const dest = join(QUAR, rel);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(dir, dest);
    moved += 1;
  }
  console.log(`\nmoved ${moved} archived session dirs -> ${QUAR}`);
  console.log(`(回滚：把该目录下的内容移回 ${ROOT})`);
} else {
  console.log(`\ndry-run only — re-run with --apply to move.`);
}
