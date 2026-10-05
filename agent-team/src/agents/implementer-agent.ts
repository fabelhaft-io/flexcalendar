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
import { handoffInstruction, implementerHandoffSchema, isWritable } from '../lib/handoff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const guardrails = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'guardrails.md'), 'utf8');

const WRITE_TOOL_NAMES = new Set<string>([
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
  WORKSPACE_TOOLS.FILESYSTEM.DELETE,
  WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
]);

/**
 * The whole worktree is reachable for reading, but every write-capable file tool is rejected
 * unless its target is inside the run's writable paths. `mkdir` may also create the ancestors of
 * a writable prefix (e.g. `server/` on the way to `server/caldav/`), which grants nothing.
 */
function makeBeforeToolCall(worktreePath: string, writablePaths: string[]) {
  return (ctx: WorkspaceToolHookContext): void | WorkspaceToolBeforeHookResult => {
    if (!WRITE_TOOL_NAMES.has(ctx.workspaceToolName)) return;
    const targetPath = (ctx.input as { path?: unknown })?.path;
    const refuse = (why: string): WorkspaceToolBeforeHookResult => ({
      proceed: false,
      output: {
        error:
          `Refused: ${why}. This run may only write under: ${writablePaths.join(', ')}. ` +
          'Report anything else you think needs changing under openQuestions.',
      },
    });
    if (typeof targetPath !== 'string') return refuse('no path given');
    const rel = path.relative(worktreePath, path.resolve(worktreePath, targetPath)).split(path.sep).join('/');
    if (rel.startsWith('..') || path.isAbsolute(rel)) return refuse(`"${targetPath}" is outside the worktree`);
    if (isWritable(rel, writablePaths)) return;
    if (
      ctx.workspaceToolName === WORKSPACE_TOOLS.FILESYSTEM.MKDIR &&
      (isWritable(`${rel}/`, writablePaths) || writablePaths.some((p) => p.endsWith('/') && p.startsWith(`${rel}/`)))
    ) {
      return;
    }
    return refuse(`"${rel}" is not in this run's writable paths`);
  };
}

export function createImplementerAgent({
  model,
  worktreePath,
  repoRoot,
  writablePaths,
  environmentFacts,
}: {
  model: string;
  worktreePath: string;
  repoRoot: string;
  writablePaths: string[];
  environmentFacts: string;
}) {
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: worktreePath }),
    sandbox: hardenedSandbox({
      workspacePath: worktreePath,
      // git is read-only (status/diff/log work, commit fails): the coordinator owns every commit,
      // which is what closes the "write + git commit in one shell call" gap OS sandboxing alone
      // can't. The worktree's `.git` is a pointer file into repoRoot/.git/worktrees/<name>.
      readOnlyPaths: [path.join(worktreePath, '.git'), path.join(repoRoot, '.git')],
    }),
    tools: { hooks: { beforeToolCall: makeBeforeToolCall(worktreePath, writablePaths) } },
  });

  return createCodingAgent({
    id: 'calendar-flex-implementer',
    name: 'calendar-flex Implementer',
    model,
    workspace,
    instructions: `${guardrails}

---

${environmentFacts}

---

You are the **implementer**. Your workspace is the requirement's worktree at \`${worktreePath}\`;
you can read the whole repo with your file tools and with plain shell commands. You may write
only under these paths (a trailing \`/\` means the whole directory tree, otherwise exactly that
file):

${writablePaths.map((p) => `- \`${p}\``).join('\n')}

Your shell is sandboxed at the OS level: nothing outside the worktree is writable (except a
private tool cache), and the coordinator moves any file you change outside the writable paths
out of the worktree after your turn, so it never reaches the branch.

Working procedure:
1. Read the requirement, its epic context, the working agreement and the invariants in the task
   prompt. If a findings doc from an earlier attempt is included, start from it: it lists what
   the reviewer needs fixed. Read the spec docs the prompt names before writing code; skim
   rather than re-read what the prompt already quotes.
2. If anything is ambiguous, contradicts the docs, or needs an unpinned decision, stop and
   report \`BLOCKED\` with the question. Don't guess.
3. Implement the requirement, scoped to it only.
4. Add tests that would fail on a real bug in what you built.
5. Run every check you can in the sandbox — format check, lint, type check, unit tests, and any
   new script or Make target on its happy path — and fix failures before finishing. Record each
   command, its exit code and what it printed in \`commandsRun\`.
6. Do **not** run \`git add\`/\`git commit\`; leave your changes uncommitted on disk.
7. Your final turn is validated against a schema: \`filesChanged\` holds repo-relative paths,
   \`testResults\` reflects what you actually ran (\`not_run\` is honest; never claim \`pass\` for
   a check you skipped), and \`openQuestions\` holds ambiguities, follow-ups and every check that
   needs the local stack, as the exact commands the reviewer should run.

Spend your tool-call budget on implementation and step 5, not on open-ended exploration. Don't
retry the same verification more than once if it already gave you an answer.

${handoffInstruction(implementerHandoffSchema)}`,
  });
}
