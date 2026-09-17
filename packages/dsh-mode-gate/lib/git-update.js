import { execFileSync } from 'node:child_process';
import { readHeadCommit } from './git-commit.js';

/**
 * Git update（插件进程内执行，**不是** agent 的 bash 工具）。
 *
 * checklist-15：agent 不得直接执行 git 修改命令；每轮更新通过
 * git_commit 工具调用本模块，完成 add -A + commit + push，
 * 并把 commit hash 自动回填进功能列表。
 */

function run(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const stderr = String((err && err.stderr) || '').trim();
    const message = String((err && err.message) || '').trim();
    throw new Error(stderr || message || `git ${args.join(' ')} 执行失败`);
  }
}

function tryRun(cwd, args) {
  try {
    return { ok: true, out: run(cwd, args) };
  } catch (err) {
    return { ok: false, err: String((err && err.message) || '').trim() };
  }
}

function pushWithFallback(cwd, branch) {
  const first = tryRun(cwd, ['push']);
  if (first.ok) return first;
  if (branch) {
    const fallback = tryRun(cwd, ['push', '-u', 'origin', branch]);
    if (fallback.ok) return fallback;
    return { ok: false, err: fallback.err || first.err };
  }
  return { ok: false, err: first.err };
}

/**
 * 执行一轮 git update。
 * @param {string} cwd 工作区路径
 * @param {string} message commit message
 * @returns {Promise<object>|object} 结构化 update；noop/skipped 时不会抛错。
 */
export function runGitUpdate(cwd, message) {
  if (!cwd) {
    return { skipped: true, reason: 'no-workspace', note: '无法确定工作区，跳过 git update。' };
  }
  const commitMessage = String(message || '').trim();
  if (!commitMessage) throw new Error('commit message 不能为空。');

  const inside = tryRun(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out !== 'true') {
    return { skipped: true, reason: 'not-a-git-repo', note: '当前工作区不是 git 仓库，跳过 git update（commit hash 未回填）。' };
  }

  const add = tryRun(cwd, ['add', '-A', '--']);
  if (!add.ok) throw new Error(`git add 失败：${add.err}`);

  const staged = !(tryRun(cwd, ['diff', '--cached', '--quiet']).ok);
  if (staged) {
    const commit = tryRun(cwd, ['commit', '-m', commitMessage]);
    if (!commit.ok) throw new Error(`git commit 失败：${commit.err}`);
  }

  const head = readHeadCommit(cwd);
  if (!head) {
    return { skipped: true, reason: 'no-commits', note: '当前仓库还没有任何提交，跳过 push（commit hash 未回填）。' };
  }

  const branchRes = tryRun(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRes.ok ? branchRes.out : '';
  const push = pushWithFallback(cwd, branch);
  if (!push.ok) throw new Error(`git push 失败：${push.err}`);

  const commit = readHeadCommit(cwd) || head;
  return {
    skipped: false,
    noop: !staged,
    branch,
    commit,
    message: staged ? commitMessage : '',
    pushed: true,
    pushOutput: push.out,
    note: staged ? '' : '本轮没有新的文件改动需要提交；已尝试推送现有提交。',
  };
}
