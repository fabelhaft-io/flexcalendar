import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from '@mastra/core/agent';
import {
  Workspace,
  LocalFilesystem,
  WORKSPACE_TOOLS,
  type WorkspaceToolHookContext,
  type WorkspaceToolBeforeHookResult,
} from '@mastra/core/workspace';
import { hardenedSandbox } from '../lib/sandbox.js';
import { handoffInstruction, reviewerHandoffSchema } from '../lib/handoff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const guardrails = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'guardrails.md'), 'utf8');

// The opt-in Mastra reviewer (`--with-reviewer`). By default the human-side reviewer reviews
// instead. It must not patch code: every write-capable workspace tool is rejected unless the
// target is exactly this requirement's findings doc.
const WRITE_TOOL_NAMES = new Set<string>([
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
  WORKSPACE_TOOLS.FILESYSTEM.DELETE,
  WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
]);

function makeBeforeToolCall(worktreePath: string, findingsDocPath: string) {
  return (ctx: WorkspaceToolHookContext): void | WorkspaceToolBeforeHookResult => {
    if (!WRITE_TOOL_NAMES.has(ctx.workspaceToolName)) return;
    const targetPath = (ctx.input as { path?: unknown })?.path;
    const rel =
      typeof targetPath === 'string'
        ? path.relative(worktreePath, path.resolve(worktreePath, targetPath)).split(path.sep).join('/')
        : '';
    const allowed =
      rel === findingsDocPath ||
      (ctx.workspaceToolName === WORKSPACE_TOOLS.FILESYSTEM.MKDIR && findingsDocPath.startsWith(`${rel}/`));
    if (allowed) return;
    return {
      proceed: false,
      output: {
        error:
          `Refused: the reviewer may only write ${findingsDocPath}, got "${String(targetPath)}". ` +
          'Report this as a finding instead of editing it.',
      },
    };
  };
}

export function createReviewerAgent({
  model,
  worktreePath,
  repoRoot,
  baseBranch,
  findingsDocPath,
  environmentFacts,
}: {
  model: string;
  worktreePath: string;
  repoRoot: string;
  baseBranch: string;
  findingsDocPath: string;
  environmentFacts: string;
}) {
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: worktreePath }),
    sandbox: hardenedSandbox({
      workspacePath: worktreePath,
      readOnlyPaths: [path.join(worktreePath, '.git'), path.join(repoRoot, '.git')],
    }),
    tools: { hooks: { beforeToolCall: makeBeforeToolCall(worktreePath, findingsDocPath) } },
  });

  return new Agent({
    id: 'flexcalendar-reviewer',
    name: 'flexcalendar Reviewer',
    model,
    workspace,
    instructions: `${guardrails}

---

${environmentFacts}

---

You are the **reviewer**. You can read and run commands anywhere in the worktree; you may write
only \`${findingsDocPath}\`. You do not fix code, commit, push or open PRs. The base branch is
\`${baseBranch}\`.

Working procedure:
1. Read the requirement in the task prompt and run \`git diff ${baseBranch}...HEAD\`.
2. Run every check that works in the sandbox (format, lint, type check, unit tests, new scripts
   on their happy path). Stack-dependent checks can't run here: list them as not_run.
3. Walk the acceptance criteria one by one against the diff and the output, applying the
   Verification rules. Check the INV-* invariants and that nothing outside the requirement's
   scope changed.
4. Write \`${findingsDocPath}\`: verdict, each criterion with the command and observed output,
   invariant checks, and concrete fix requests.
5. Your final turn is validated against a schema. \`openQuestions\` must be concrete and
   non-empty whenever \`status\` is \`BLOCKED\`: it is what the next fix cycle is handed. Any
   criterion that needs the local stack and wasn't executed means \`BLOCKED\`.

${handoffInstruction(reviewerHandoffSchema)}`,
  });
}
