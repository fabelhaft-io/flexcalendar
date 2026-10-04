import { execFileSync } from 'node:child_process';
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
    git(['rev-parse', '--verify', '--quiet', branch], repoRoot);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates (or reuses, for a resumed BLOCKED run) the ticket's dedicated worktree on
 * branch `agent/<ticketId>` off `baseBranch` — the isolation boundary from the shared
 * contract in agent-team/src/prompts/guardrails.md.
 *
 * `baseBranch` defaults to `main` (see config.ts's BASE_BRANCH), which is correct once
 * this orchestrator itself has landed on `main`. Until then, point it at whichever
 * branch actually has agent-team/ + the ticket, or every spawned agent starts in a
 * worktree missing its own instructions.
 */
export function ensureWorktree(repoRoot: string, ticketId: string, baseBranch: string): Worktree {
  const branch = `agent/${ticketId}`;
  const worktreePath = path.resolve(repoRoot, '..', `bread-sheet-agent-${ticketId}`);

  const existingWorktrees = git(['worktree', 'list', '--porcelain'], repoRoot);
  if (existingWorktrees.includes(`worktree ${worktreePath}`)) {
    refreshFromBase(worktreePath, branch, baseBranch);
    return { path: worktreePath, branch };
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
 * Brings a *reused* ticket branch — a resumed `BLOCKED` run — up to date with its base.
 *
 * Without this, a resumed run works against the repo as it stood when the branch was first
 * cut. That includes `agent-team/src/prompts/guardrails.md`, which Harness A's agents read
 * from the worktree by relative path, so a stale branch means agents following a superseded
 * contract. The timing makes it the likely case rather than an edge case: guardrail changes
 * tend to land right after a bad run, which is exactly when a `BLOCKED` branch is sitting
 * there waiting to be re-run. (Harness B reads guardrails from the launching checkout via
 * `__dirname`, so it isn't affected by that specific staleness — but a reused branch is
 * equally missing every other `main`-side fix since it was cut, which is the general case
 * this covers.)
 *
 * A conflict stops the run instead of handing an agent a conflicted tree to "resolve":
 * that's a human's call, and coordinator-owned git (see docs/architecture/agent-dev-team.md)
 * exists precisely so an agent never gets the opportunity.
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
      `Ticket branch ${branch} is ${behind} commit(s) behind ${baseBranch} and could not be ` +
        `updated automatically:\n${(err as Error).message}\n` +
        `Resolve it by hand in ${worktreePath} (merge or rebase ${baseBranch}, or delete the ` +
        `worktree to start the ticket fresh), then re-run. Stopping rather than letting agents ` +
        `work against a stale or conflicted tree.`
    );
  }
}

/**
 * The objective (not model-reported) list of files changed on the ticket branch so far,
 * relative to the worktree root — used by handoff.ts's findOutOfPillarFiles to cross-check
 * an implementer's self-reported filesChanged against what actually happened on disk.
 * Includes uncommitted changes (git diff has no commit yet to compare when an agent hasn't
 * committed), so this is `diff <base>...HEAD` plus working-tree status, deduped.
 */
export function getChangedFiles(worktreePath: string, baseBranch: string): string[] {
  const committed = git(['diff', '--name-only', `${baseBranch}...HEAD`], worktreePath)
    .split('\n')
    .filter(Boolean);
  const uncommitted = git(['status', '--porcelain'], worktreePath)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
  return [...new Set([...committed, ...uncommitted])];
}

/**
 * Stages and commits exactly `files` — nothing else, regardless of what else is sitting
 * uncommitted in the worktree. This is the enforcement point: agents no longer have git write
 * access at all (see sandbox.ts), so the coordinator is the only thing that can ever turn a
 * real, on-disk change into a real commit, and it only does so for files a caller has already
 * filtered through handoff.ts's filterCommittableImplementerFiles/filterCommittableReviewerFiles.
 * No-ops (returns false) if `files` is empty or nothing in it actually has a diff to stage.
 */
export function commitFiles(worktreePath: string, files: string[], message: string): boolean {
  if (files.length === 0) return false;
  git(['add', '--', ...files], worktreePath);
  const staged = git(['diff', '--cached', '--name-only'], worktreePath).trim();
  if (!staged) return false;
  git(['commit', '-m', message], worktreePath);
  return true;
}

export function pushBranch(worktreePath: string, branch: string): void {
  git(['push', '-u', 'origin', branch], worktreePath);
}

/** Runs `gh pr create` and returns the PR URL gh prints to stdout on success. */
export function createPullRequest(
  worktreePath: string,
  opts: { base: string; head: string; title: string; body: string },
): string {
  const output = execFileSync(
    'gh',
    ['pr', 'create', '--base', opts.base, '--head', opts.head, '--title', opts.title, '--body', opts.body],
    { cwd: worktreePath, encoding: 'utf8' },
  );
  return output.trim().split('\n').pop() ?? '';
}
