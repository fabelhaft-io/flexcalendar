import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodingAgent } from '@mastra/core/coding-agent';
import {
  Workspace,
  LocalFilesystem,
  WORKSPACE_TOOLS,
  type WorkspaceToolHookContext,
  type WorkspaceToolBeforeHookResult,
} from '@mastra/core/workspace';
import { hardenedSandbox } from '../lib/sandbox.js';
import { FRONTEND_EXTRA_PATHS, SHARED_READONLY_PATH, SHARED_READONLY_PREFIXES } from '../lib/handoff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const guardrails = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'guardrails.md'), 'utf8');

// Least-privilege exceptions to basePath containment — CLAUDE.md and the rest of docs/ are
// reference-only reading, README.md/frontend.md are exactly what the "Update in-scope docs"
// step in this agent's own instructions asks it to write. Everything else outside
// bread-sheet-app/ stays unreachable. Read-vs-write within these extras is enforced by the
// beforeToolCall hook below, not by this list — allowedPaths only governs reachability.
const ALLOWED_PATHS = [
  `../${SHARED_READONLY_PATH}`,
  ...SHARED_READONLY_PREFIXES.map((p) => `../${p}`),
  ...FRONTEND_EXTRA_PATHS.map((p) => `../${p}`),
];

const WRITE_TOOL_NAMES = new Set<string>([
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
  WORKSPACE_TOOLS.FILESYSTEM.DELETE,
  WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
]);

/**
 * CLAUDE.md and docs/ are readable (see ALLOWED_PATHS) but must stay read-only — only
 * bread-sheet-app/ itself plus this pillar's two documented doc exceptions are writable.
 * allowedPaths alone can't express that asymmetry (it only gates reachability), so this
 * mirrors reviewer-agent.ts's beforeToolCall pattern: intercept every write-capable workspace
 * tool and reject it unless the resolved target falls inside basePath or is one of
 * FRONTEND_EXTRA_PATHS.
 */
function makeBeforeToolCall(basePath: string, worktreePath: string) {
  const writableExtras = new Set(FRONTEND_EXTRA_PATHS.map((p) => path.join(worktreePath, p)));
  return (ctx: WorkspaceToolHookContext): void | WorkspaceToolBeforeHookResult => {
    if (!WRITE_TOOL_NAMES.has(ctx.workspaceToolName)) return;
    const targetPath = (ctx.input as { path?: unknown })?.path;
    if (typeof targetPath !== 'string') return;
    const resolved = path.resolve(basePath, targetPath);
    const withinBasePath = resolved === basePath || resolved.startsWith(basePath + path.sep);
    if (withinBasePath || writableExtras.has(resolved)) return;
    return {
      proceed: false,
      output: {
        error:
          `Refused: outside bread-sheet-app/ this role may only write README.md or ` +
          `docs/architecture/frontend.md — CLAUDE.md and the rest of docs/ are read-only. ` +
          `Got path "${targetPath}".`,
      },
    };
  };
}

export function createFrontendAgent({
  model,
  worktreePath,
  repoRoot,
  environmentFacts,
}: {
  model: string;
  worktreePath: string;
  repoRoot: string;
  environmentFacts: string;
}) {
  const basePath = path.join(worktreePath, 'bread-sheet-app');
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath, allowedPaths: ALLOWED_PATHS }),
    sandbox: hardenedSandbox({
      workspacePath: basePath,
      // Read-only: git status/diff/log work for the agent's own inspection, but it can never
      // commit — the coordinator owns every commit now (see coordinator.ts), which is what
      // closes the "write + git commit in one shell call" gap OS sandboxing alone can't (a
      // write that never reaches real disk can still get captured into a real commit if the
      // same invocation commits it — verified experimentally). The worktree's own docs/ (not
      // repoRoot's — repoRoot's working tree can carry unrelated uncommitted edits from
      // whoever else is using the main checkout, which must never leak into a sandboxed run)
      // is also bound read-only here so plain shell commands (cat/grep/find) can reach it
      // directly, matching the file-tool grant below — without this an agent could still only
      // reach docs/ via the `git show HEAD:docs/...` workaround, which is what actually
      // happened on a live P9-003 run and burned tool-call budget it didn't need to.
      readOnlyPaths: [
        path.join(worktreePath, '.git'),
        path.join(repoRoot, '.git'),
        path.join(worktreePath, 'docs'),
      ],
    }),
    tools: { hooks: { beforeToolCall: makeBeforeToolCall(basePath, worktreePath) } },
  });

  return createCodingAgent({
    id: 'dev-frontend',
    name: 'BreadSheet Frontend Implementer',
    model,
    workspace,
    instructions: `${guardrails}

---

${environmentFacts}

If your task prompt includes findings from a prior attempt at this ticket (a previous run's
findings doc or fix-cycle feedback), read that first — it usually already answers "what's
blocking this," and re-deriving it via a broad exploratory sweep just burns tokens and time for
the same answer.

---

You are the **frontend implementer** role. Your workspace is rooted at \`bread-sheet-app/\`
inside the ticket's worktree, and your file tools (read/write/edit/list/delete/grep) are
physically confined there — they cannot reach \`server/\` or \`terraform/\` even by mistake.
Narrow exceptions: \`../CLAUDE.md\` and everything under \`../docs/\` are reachable **read-only**
for reference (both file tools and plain shell commands like \`cat\`/\`grep\` reach it directly
— you never need to route around this with \`git show HEAD:docs/...\`), and
\`../README.md\`/\`../docs/architecture/frontend.md\` are reachable read-write because step 5
below asks you to update them; a write attempt anywhere else outside \`bread-sheet-app/\` is
rejected with a clear error. Your shell tool is also sandboxed (OS-level, not just
instruction) — writes outside \`bread-sheet-app/\` won't reach the real filesystem even if the
command reports success, so don't be alarmed if a stray \`cd .. && echo\` seems to "work" but
the file never actually appears. \`git\` is read-only for you (\`status\`/\`diff\`/\`log\` work
fine) — **you cannot commit**, by design; see the working procedure below.

Read \`../CLAUDE.md\` for frontend architecture conventions — Expo Router structure,
\`features/\` modules, \`lib/offline\`, \`formatApiError\` — before writing code. Prefer an
existing pattern over a new one.

Working procedure:
1. You will be given a ticket's full text and acceptance criteria in the task prompt. If
   anything is ambiguous or contradicts the current code, say so explicitly in your final
   report instead of guessing.
2. Implement the change, scoped to the ticket only.
3. Add or update tests alongside the change.
4. Run \`npm run lint\`, \`npm run typecheck\`, and \`npm test\` (via the execute_command tool,
   cwd is already your workspace root) and fix failures before finishing.
5. Update in-scope docs (\`../docs/architecture/frontend.md\`, \`../README.md\`) if the change
   affects them.
6. Do **not** run \`git add\`/\`git commit\` — it will fail (read-only), and it isn't your job
   anyway. Leave your changes uncommitted on disk; the coordinator stages and commits
   everything inside \`bread-sheet-app/\` (plus the two doc exceptions above) once your turn
   ends, using your \`summary\` field below as the commit message.
7. Your final turn is validated against a structured schema (the coordinator reads it
   programmatically, not by re-parsing your prose) — \`filesChanged\` must be actual
   repo-relative paths from the worktree root (e.g. \`bread-sheet-app/app/(tabs)/index.tsx\`),
   \`testResults\` must reflect what you actually ran (\`not_run\` is a valid, honest answer —
   never claim \`pass\` for a check you skipped), and \`openQuestions\` is where ambiguity or
   out-of-scope findings go, never into the diff.

Your tool-call budget for this turn is finite. Spend it on implementation and the checks in
step 4, not open-ended exploration: trust the "Known environment" facts above instead of
re-probing them (checking for Java/Android SDK/Maestro yourself when they're already listed
above is exactly the kind of redundant call that eats the budget for nothing), and don't retry
the same verification command more than once if it already gave you an answer. If you're
genuinely unsure whether you have enough budget left to finish cleanly, stop and report your
honest structured handoff now (\`BLOCKED\`, with what's left in \`openQuestions\`) rather than
continuing until you run out mid-task with nothing to report at all.`,
  });
}
