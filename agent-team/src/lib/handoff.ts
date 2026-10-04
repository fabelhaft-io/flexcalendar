import { z } from 'zod';

// The typed contract between coordinator and agents. Mastra validates the implementer's/
// reviewer's final turn against these schemas (agent.generate(..., { structuredOutput }))
// instead of the coordinator regex-matching prose for a magic word like "BLOCKED" — see
// docs/architecture/agent-dev-team.md's "Typed handoff" section for why.
const checkResult = z.enum(['pass', 'fail', 'not_run']);

export const implementerHandoffSchema = z.object({
  status: z.enum(['DONE', 'BLOCKED']),
  filesChanged: z
    .array(z.string())
    .describe('Repo-relative paths (from the worktree root) of every file added/modified/deleted.'),
  testResults: z.object({
    typecheck: checkResult,
    lint: checkResult,
    unitTests: checkResult,
  }),
  summary: z.string().describe('One-paragraph human-readable summary of what changed and why — used as the coordinator commit message.'),
  openQuestions: z
    .array(z.string())
    .describe('Ambiguities or out-of-scope findings — never silently guessed at or fixed. Empty array if none.'),
});
export type ImplementerHandoff = z.infer<typeof implementerHandoffSchema>;

export const reviewerHandoffSchema = z.object({
  status: z.enum(['PASS', 'BLOCKED']),
  findingsDocPath: z.string().describe('Repo-relative path to the findings doc this review wrote.'),
  prTitle: z.string().describe('PR title the coordinator should use when opening the PR — only used when status is PASS.'),
  prBody: z.string().describe('PR body (markdown) the coordinator should use when opening the PR — only used when status is PASS.'),
  testMatrix: z.object({
    serverTypecheck: checkResult,
    serverTests: checkResult,
    appTypecheck: checkResult,
    appLint: checkResult,
    appTests: checkResult,
    e2eTests: checkResult,
  }),
  openQuestions: z
    .array(z.string())
    .describe('Required when status is BLOCKED — what specifically needs to change. Empty array when PASS.'),
});
export type ReviewerHandoff = z.infer<typeof reviewerHandoffSchema>;

const PILLAR_PREFIX = { frontend: 'bread-sheet-app/', backend: 'server/' } as const;

// Kept as the single source of truth for the "extra" (outside the pillar prefix) paths an
// implementer's file tools are allowed to reach — see the ALLOWED_PATHS consts in
// frontend-agent.ts/backend-agent.ts, which import these to build their LocalFilesystem
// allowlist (with a `../` prefix, since those are relative to the pillar's basePath).
export const FRONTEND_EXTRA_PATHS = ['README.md', 'docs/architecture/frontend.md'] as const;
export const BACKEND_EXTRA_PATHS = ['docs/architecture/backend.md'] as const;
export const BACKEND_EXTRA_PREFIXES = ['docs/bruno/'] as const;
// CLAUDE.md and the rest of docs/ are granted read-only to both pillars for reference — an
// implementer legitimately needs e.g. docs/architecture/agent-dev-team.md (the shared contract)
// or another pillar's architecture doc, and being unable to read it directly used to mean either
// giving up or routing around the restriction with `git show HEAD:docs/...` (which works, since
// the file-tool sandbox and the OS shell sandbox both only ever restricted *writes* here, not
// reads via git plumbing) — pure wasted tool-call budget for something that should be a plain
// read. Never committed by anyone but the coordinator's own docs/-scoped reviewer commit path.
export const SHARED_READONLY_PATH = 'CLAUDE.md';
export const SHARED_READONLY_PREFIXES = ['docs/'] as const;

export interface InvokedPillars {
  frontend: boolean;
  backend: boolean;
}

/**
 * Objective, coordinator-computed cross-check — doesn't trust the implementers' self-reported
 * `filesChanged` at all. Physical filesystem containment (see frontend-agent.ts/backend-agent.ts)
 * already stops file-tool writes outside a pillar; combined with the OS-level sandbox hardening
 * in sandbox.ts, this catches (and the coordinator's commit step, not just a warning, now
 * enforces) anything outside every invoked pillar plus its documented doc exceptions.
 */
export function findOutOfPillarFiles(changedFiles: string[], invokedPillars: InvokedPillars): string[] {
  const committable = new Set(filterCommittableImplementerFiles(changedFiles, invokedPillars));
  return changedFiles.filter((f) => !committable.has(f));
}

/**
 * The real set of files the coordinator is willing to `git add`/commit after an implementer
 * turn — pillar-prefixed files plus each pillar's documented doc exceptions. Anything else a
 * shell command might have touched is simply never staged, regardless of what the implementer's
 * self-reported `filesChanged` claims — this is what closes the "agent commits something
 * outside its pillar" gap for good, not just OS-level sandboxing (which stops the write itself,
 * but a determined `write + git commit` in one shell invocation can still smuggle content into
 * the real git object database — verified experimentally; see docs/architecture/agent-dev-team.md).
 */
export function filterCommittableImplementerFiles(changedFiles: string[], invokedPillars: InvokedPillars): string[] {
  const prefixes: string[] = [];
  const exactPaths = new Set<string>();
  if (invokedPillars.frontend) {
    prefixes.push(PILLAR_PREFIX.frontend);
    FRONTEND_EXTRA_PATHS.forEach((p) => exactPaths.add(p));
  }
  if (invokedPillars.backend) {
    prefixes.push(PILLAR_PREFIX.backend, ...BACKEND_EXTRA_PREFIXES);
    BACKEND_EXTRA_PATHS.forEach((p) => exactPaths.add(p));
  }
  return changedFiles.filter((f) => prefixes.some((prefix) => f.startsWith(prefix)) || exactPaths.has(f));
}

/** Same idea as filterCommittableImplementerFiles, for the reviewer's docs/-and-FEATURES.md scope. */
export function filterCommittableReviewerFiles(changedFiles: string[]): string[] {
  return changedFiles.filter((f) => f === 'FEATURES.md' || f.startsWith('docs/'));
}
