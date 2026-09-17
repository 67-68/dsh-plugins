import { execFileSync } from 'node:child_process';

/**
 * 只读 git 辅助（插件进程内执行，**不是** agent 的 bash 工具）。
 *
 * checklist-15 规定 agent 不得直接执行 git 修改命令；这里只读 HEAD，
 * 用于把 commit hash 自动回填进功能列表。
 */

const HASH_RE = /^[0-9a-f]{7,40}$/i;

export function isCommitHash(value) {
  return HASH_RE.test(String(value || '').trim());
}

/** 读取当前 HEAD 的 commit hash；不在 git 仓库或失败时返回 ''。 */
export function readHeadCommit(cwd) {
  if (!cwd) return '';
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return isCommitHash(out) ? out : '';
  } catch {
    return '';
  }
}
