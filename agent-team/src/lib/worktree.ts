import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface Worktree {
  path: string;
  branch: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function branchExists(repoRoot: string, branch: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates (or reuses, for a resumed run) the requirement's worktree at
 * `../calendar-flex-agent-<ID>` on branch `feat/<ID>-<slug>` off `baseBranch`.
 */
export function ensureWorktree(repoRoot: string, requirementId: string, branchName: string, baseBranch: string): Worktree {
  const branch = `feat/${branchName}`;
  const worktreePath = path.resolve(repoRoot, '..', `calendar-flex-agent-${requirementId}`);

  const existingWorktrees = git(['worktree', 'list', '--porcelain'], repoRoot);
  if (existingWorktrees.includes(`worktree ${worktreePath}\n`)) {
    refreshFromBase(worktreePath, branch, baseBranch);
    return { path: worktreePath, branch };
  }
  if (fs.existsSync(worktreePath)) {
    throw new Error(`${worktreePath} exists but is not a git worktree of ${repoRoot}; move it away first.`);
  }

  if (branchExists(repoRoot, branch)) {
    git(['worktree', 'add', worktreePath, branch], repoRoot);
    refreshFromBase(worktreePath, branch, baseBranch);
  } else {
    git(['worktree', 'add', worktreePath, '-b', branch, baseBranch], repoRoot);
  }
  return { path: worktreePath, branch };
}

/**
 * Brings a reused branch up to date with its base. A conflict stops the run instead of handing
 * an agent a conflicted tree to "resolve": that's a human's call.
 */
function refreshFromBase(worktreePath: string, branch: string, baseBranch: string): void {
  const behind = git(['rev-list', '--count', `${branch}..${baseBranch}`], worktreePath).trim();
  if (behind === '0') return;
  try {
    git(['merge', '--no-edit', baseBranch], worktreePath);
  } catch (err) {
    try {
      git(['merge', '--abort'], worktreePath);
    } catch {
      // Nothing to abort — the merge refused to start (most often an unclean worktree).
    }
    throw new Error(
      `Branch ${branch} is ${behind} commit(s) behind ${baseBranch} and could not be updated ` +
        `automatically:\n${(err as Error).message}\nResolve it by hand in ${worktreePath}, then re-run.`,
    );
  }
}

/**
 * The objective (not model-reported) list of files changed on the branch so far, relative to
 * the worktree root: `diff <base>...HEAD` plus working-tree status. `--untracked-files=all`
 * matters: plain porcelain collapses a new directory to `server/`, which no file-level scope
 * filter would ever match, so a whole new tree would silently go uncommitted.
 */
export function getChangedFiles(worktreePath: string, baseBranch: string): string[] {
  const committed = git(['diff', '--name-only', `${baseBranch}...HEAD`], worktreePath)
    .split('\n')
    .filter(Boolean);
  const uncommitted: string[] = [];
  const entries = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktreePath).split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    uncommitted.push(entry.slice(3));
    // Renames/copies carry the source path as the next NUL-separated field.
    if (xy.includes('R') || xy.includes('C')) uncommitted.push(entries[++i]);
  }
  return [...new Set([...committed, ...uncommitted])];
}

/** Files with uncommitted changes only (what a cleanup can still revert). */
export function getUncommittedFiles(worktreePath: string): { tracked: string[]; untracked: string[] } {
  const tracked: string[] = [];
  const untracked: string[] = [];
  const entries = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktreePath).split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    (xy === '??' ? untracked : tracked).push(entry.slice(3));
    if (xy.includes('R') || xy.includes('C')) tracked.push(entries[++i]);
  }
  return { tracked, untracked };
}

function existsInHead(worktreePath: string, file: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `HEAD:${file}`], { cwd: worktreePath, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Moves out-of-scope, uncommitted agent output out of the worktree into `quarantineDir` (so
 * nothing is lost if `--paths` was simply too narrow) and restores tracked files to HEAD.
 * Only ever called with paths the scope filter rejected.
 */
export function quarantineFiles(worktreePath: string, files: string[], quarantineDir: string): string[] {
  const { tracked, untracked } = getUncommittedFiles(worktreePath);
  const moved: string[] = [];
  for (const f of files) {
    if (!tracked.includes(f) && !untracked.includes(f)) continue;
    const src = path.join(worktreePath, f);
    if (fs.existsSync(src)) {
      const dest = path.join(quarantineDir, f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
    // Drop any index entry and the file, then restore HEAD's version if HEAD has one. This also
    // covers the new side of a staged rename, which is "tracked" but absent from HEAD.
    git(['rm', '-q', '--cached', '--ignore-unmatch', '--', f], worktreePath);
    fs.rmSync(src, { force: true });
    if (existsInHead(worktreePath, f)) git(['checkout', 'HEAD', '--', f], worktreePath);
    moved.push(f);
  }
  return moved;
}

/**
 * Stages and commits exactly `files` — nothing else. Agents have no git write access (see
 * sandbox.ts), so this is the only path from on-disk change to commit.
 */
export function commitFiles(worktreePath: string, files: string[], message: string): boolean {
  if (files.length === 0) return false;
  git(['add', '-A', '--', ...files], worktreePath);
  const staged = git(['diff', '--cached', '--name-only'], worktreePath).trim();
  if (!staged) return false;
  git(['commit', '-m', message], worktreePath);
  return true;
}

/**
 * Run bookkeeping lives in the worktree's own git dir, which the sandbox mounts read-only, so
 * only the coordinator can change it. Counting commits instead would miss runs that produced
 * nothing committable.
 */
function runCounterPath(worktreePath: string): string {
  const gitDir = git(['rev-parse', '--absolute-git-dir'], worktreePath).trim();
  return path.join(gitDir, 'calendar-flex-agent-runs');
}

export function readImplementerRuns(worktreePath: string): number {
  try {
    return Number.parseInt(fs.readFileSync(runCounterPath(worktreePath), 'utf8'), 10) || 0;
  } catch {
    return 0;
  }
}

export function recordImplementerRun(worktreePath: string, runs: number): void {
  fs.writeFileSync(runCounterPath(worktreePath), `${runs}\n`);
}
