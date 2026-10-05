import { z } from 'zod';

// The typed contract between coordinator and agents. The coordinator validates the implementer's/
// reviewer's final turn against these schemas (parseHandoff) instead of regex-matching prose for
// a magic word like "BLOCKED".
const checkResult = z.enum(['pass', 'fail', 'not_run']);

export const implementerHandoffSchema = z.object({
  status: z.enum(['DONE', 'BLOCKED']),
  filesChanged: z
    .array(z.string())
    .describe('Repo-relative paths (from the worktree root) of every file added/modified/deleted.'),
  testResults: z.object({
    format: checkResult,
    lint: checkResult,
    typecheck: checkResult,
    unitTests: checkResult,
  }),
  commandsRun: z
    .array(
      z.object({
        command: z.string(),
        exitCode: z
          .number()
          .int()
          .nullable()
          .describe('The real exit code; null only when the command produced none (killed, timed out).'),
        note: z.string(),
      }),
    )
    .describe('Every verification command you actually ran, with its real exit code and a one-line note on the output.'),
  summary: z
    .string()
    .describe('One-paragraph human-readable summary of what changed and why — used as the coordinator commit message.'),
  openQuestions: z
    .array(z.string())
    .describe('Ambiguities, follow-ups and anything you could not verify in the sandbox — never silently guessed at or fixed. Empty array if none.'),
});
export type ImplementerHandoff = z.infer<typeof implementerHandoffSchema>;

export const reviewerHandoffSchema = z.object({
  status: z.enum(['PASS', 'BLOCKED']),
  findingsDocPath: z.string().describe('Repo-relative path to the findings doc this review wrote.'),
  checks: z
    .array(z.object({ command: z.string(), result: checkResult }))
    .describe('Every check you ran, or not_run with the reason in openQuestions.'),
  openQuestions: z
    .array(z.string())
    .describe('Required when status is BLOCKED — what specifically needs to change. Empty array when PASS.'),
});
export type ReviewerHandoff = z.infer<typeof reviewerHandoffSchema>;

export type ParsedHandoff<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Validates an agent's final text against a handoff schema. The final text may wrap the JSON
 * object in a code fence or a sentence of prose; everything from the first `{` to the last `}` is
 * the candidate. On failure, `error` says why (JSON syntax or the schema issues), for the run's
 * diagnostics.
 */
export function parseHandoff<T>(schema: z.ZodType<T>, text: string): ParsedHandoff<T> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) return { ok: false, error: 'The final text contains no JSON object.' };
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return { ok: false, error: `The final text is not valid JSON: ${(err as Error).message}` };
  }
  const result = schema.safeParse(json);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: z.prettifyError(result.error) };
}

/**
 * The instruction that tells an agent the exact shape of its final turn. Mastra passes the schema
 * as the provider's response format, but providers without JSON-schema output (DeepSeek's JSON
 * mode) never see it, so the agent gets it in its instructions as well.
 */
export function handoffInstruction(schema: z.ZodType): string {
  return (
    'Your final message is your handoff, and nothing else: one JSON object, no prose, no code ' +
    `fence, matching this JSON Schema:\n\n${JSON.stringify(z.toJSONSchema(schema))}`
  );
}

/**
 * Paths no agent may write, whatever `--paths` says. The harness itself, the orchestrator's
 * skills and git metadata are off-limits so an agent can't loosen its own rules; secrets are never
 * committed (`06` working agreement 8). `.env.example` is the one `.env*` file that is allowed.
 */
const FORBIDDEN_DIRS = ['.git', 'agent-team', '.claude', '.agents'] as const;
const SECRET_FILE_RE = /(^|\/)(\.env(\..+)?|.*\.(pem|key|p12|pfx|jks|keystore|mobileprovision)|id_(rsa|ed25519|ecdsa)(\.pub)?)$/i;

export function isSecretPath(file: string): boolean {
  return SECRET_FILE_RE.test(file) && !/(^|\/)\.env\.example$/.test(file);
}

/**
 * Validates and normalises the `--paths` CLI value. A prefix ending in `/` grants a directory
 * tree; anything else grants exactly that one file (e.g. `Makefile`, `CONTRIBUTING.md`).
 */
export function parseWritablePaths(raw: string): string[] {
  const entries = raw
    .split(',')
    .map((p) => p.trim().replace(/^\.\//, ''))
    .filter(Boolean);
  if (entries.length === 0) throw new Error('--paths needs at least one repo-relative path prefix.');
  for (const p of entries) {
    if (p.startsWith('/') || p.split('/').includes('..')) {
      throw new Error(`--paths entry "${p}" must be repo-relative and must not contain "..".`);
    }
    if (isForbidden(p)) {
      throw new Error(`--paths entry "${p}" overlaps a path agents may never write (${FORBIDDEN_DIRS.join(', ')}).`);
    }
    if (isSecretPath(p)) throw new Error(`--paths entry "${p}" names a secrets file.`);
  }
  return entries;
}

function isForbidden(p: string): boolean {
  const trimmed = p.replace(/\/+$/, '');
  return FORBIDDEN_DIRS.some((d) => trimmed === d || trimmed.startsWith(`${d}/`));
}

export function isWritable(file: string, writablePaths: string[]): boolean {
  if (isSecretPath(file) || isForbidden(file)) return false;
  return writablePaths.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));
}

/**
 * The files the coordinator is willing to `git add` after an implementer turn. Anything else a
 * shell command touched is never staged, regardless of the agent's self-reported `filesChanged`
 * — the sandbox stops writes outside the worktree, this is what keeps writes inside the
 * worktree within the requirement's scope.
 */
export function partitionByScope(changedFiles: string[], writablePaths: string[]) {
  const inScope: string[] = [];
  const outOfScope: string[] = [];
  for (const f of changedFiles) (isWritable(f, writablePaths) ? inScope : outOfScope).push(f);
  return { inScope, outOfScope };
}
