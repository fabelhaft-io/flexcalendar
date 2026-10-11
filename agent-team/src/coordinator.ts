import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import { loadConfig, parseMaxSteps } from './config.js';
import { findRequirement, branchSlug, resolveSpecDocs, extractH2Section, type Requirement } from './lib/requirements.js';
import {
  ensureWorktree,
  getChangedFiles,
  getUncommittedFiles,
  quarantineFiles,
  commitFiles,
  readImplementerRuns,
  recordImplementerRun,
} from './lib/worktree.js';
import { logAgentProgress } from './lib/progress.js';
import { probeEnvironment, formatEnvironmentFacts } from './lib/environment.js';
import { createImplementerAgent } from './agents/implementer-agent.js';
import { createReviewerAgent } from './agents/reviewer-agent.js';
import {
  implementerHandoffSchema,
  reviewerHandoffSchema,
  partitionByScope,
  parseHandoff,
  type ImplementerHandoff,
  type ReviewerHandoff,
} from './lib/handoff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The first attempt plus two fix cycles (`06` working agreement, guardrails "Stopping conditions"). */
const MAX_FIX_CYCLES = 2;
const MAX_IMPLEMENTER_RUNS = 1 + MAX_FIX_CYCLES;
/** Model turns per implementer or reviewer run: `AGENT_MAX_STEPS`, default 300 (see `config.ts`). */
const MAX_STEPS = parseMaxSteps(process.env.AGENT_MAX_STEPS);
const MAX_FINDINGS_CHARS = 12000;
const MAX_SPEC_DOC_CHARS = 90000;

export interface CoordinatorOptions {
  requirementId: string;
  writablePaths: string[];
  withReviewer: boolean;
  force: boolean;
}

export interface CoordinatorResult {
  ok: boolean;
  summary: string;
}

function log(message: string): void {
  console.log(`[coordinator] ${message}`);
}

function readIfExists(file: string, maxChars: number): string | null {
  try {
    const content = fs.readFileSync(file, 'utf8');
    return content.length > maxChars ? `${content.slice(0, maxChars)}\n…(truncated)` : content;
  } catch {
    return null;
  }
}

/** The `| D-xx | …` rows of `06` for every decision the requirement or its epic cites. */
function citedDecisions(backlog: string, requirement: Requirement): string {
  const ids = new Set(`${requirement.body}\n${requirement.epicContext}`.match(/D-\d{2}/g) ?? []);
  if (ids.size === 0) return '';
  const header = /^\| ID \| Decision .*\n\|[-| ]+\|$/m.exec(backlog)?.[0] ?? '';
  const rows = backlog.split('\n').filter((l) => [...ids].some((id) => l.startsWith(`| ${id} |`)));
  return rows.length ? `${header}\n${rows.join('\n')}` : '';
}

export function buildRequirementPrompt(worktreePath: string, requirement: Requirement, writablePaths: string[]): string {
  const backlog = fs.readFileSync(path.join(worktreePath, 'docs', '06-implementation-backlog.md'), 'utf8');
  const sections: string[] = [
    `# Requirement ${requirement.id}\n\n### ${requirement.heading}\n${requirement.body}`,
    `## Writable paths for this run\n\n${writablePaths.map((p) => `- \`${p}\``).join('\n')}`,
    `## Epic context (${requirement.epicPath})\n\n${requirement.epicContext}`,
    extractH2Section(backlog, 'Agent working agreement') ?? '',
    extractH2Section(backlog, 'Global invariants') ?? '',
  ];
  const decisions = citedDecisions(backlog, requirement);
  if (decisions) sections.push(`## Decisions cited (all Pinned; from docs/06-implementation-backlog.md)\n\n${decisions}`);

  const specDocs = resolveSpecDocs(worktreePath, requirement.specRow);
  let budget = MAX_SPEC_DOC_CHARS;
  const inlined: string[] = [];
  const listedOnly: string[] = [];
  for (const doc of specDocs) {
    const text = fs.readFileSync(path.join(worktreePath, doc), 'utf8');
    if (text.length <= budget) {
      inlined.push(`### ${doc}\n\n${text}`);
      budget -= text.length;
    } else {
      listedOnly.push(doc);
    }
  }
  sections.push(
    `## Spec docs named by the epic (Spec row: ${requirement.specRow})\n\n` +
      (inlined.length ? `${inlined.join('\n\n---\n\n')}\n\n` : '') +
      (listedOnly.length ? `Not inlined (size budget); read them yourself: ${listedOnly.join(', ')}\n` : '') +
      'CLAUDE.md and the rest of docs/ are in the worktree if you need more.',
  );
  return sections.filter(Boolean).join('\n\n---\n\n');
}

function implementerFallback(reason: string, question: string): ImplementerHandoff {
  return {
    status: 'BLOCKED',
    filesChanged: [],
    testResults: { format: 'not_run', lint: 'not_run', typecheck: 'not_run', unitTests: 'not_run' },
    commandsRun: [],
    summary: reason,
    openQuestions: [question],
  };
}

function reviewerFallback(findingsDocPath: string, question: string): ReviewerHandoff {
  return { status: 'BLOCKED', findingsDocPath, checks: [], openQuestions: [question] };
}

/** Per-run files outside the worktree (gitignored): quarantined files and handoff diagnostics. */
function runDir(requirementId: string, run: number): string {
  return path.join(__dirname, '..', 'runs', requirementId, `run-${run}`);
}

type HandoffRead<T> = { ok: true; value: T } | { ok: false; budgetExhausted: boolean; error: string };

/**
 * Reads an agent's handoff from the text of its last step. `out.object` is not used: in
 * @mastra/core 1.64, direct-mode structured output validates every step that has text and the
 * first result wins, so one sentence next to a tool call ("Let me look at the files.") turned a
 * valid final handoff into the fallback value. Mastra still gets the schema, for the providers
 * that constrain output to it. The final text and, on failure, the validation error are written
 * to `dir` as `<label>-final-text.txt` and `<label>-handoff-error.txt`.
 */
async function readHandoff<T>(
  label: string,
  out: { text: Promise<string>; steps: Promise<unknown[]> },
  schema: z.ZodType<T>,
  dir: string,
): Promise<HandoffRead<T>> {
  const text = await out.text;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${label}-final-text.txt`), text);
  const parsed = parseHandoff(schema, text);
  if (parsed.ok) return parsed;
  const budgetExhausted = (await out.steps).length >= MAX_STEPS;
  const errorFile = path.join(dir, `${label}-handoff-error.txt`);
  fs.writeFileSync(errorFile, `${parsed.error}\n`);
  log(`${label} handoff failed validation${budgetExhausted ? ` after ${MAX_STEPS} steps` : ''}; see ${errorFile}`);
  return { ok: false, budgetExhausted, error: parsed.error };
}

async function runImplementer(opts: {
  model: string;
  worktreePath: string;
  repoRoot: string;
  writablePaths: string[];
  environmentFacts: string;
  prompt: string;
  runDir: string;
}): Promise<ImplementerHandoff> {
  const agent = createImplementerAgent(opts);
  const out = await agent.stream(opts.prompt, {
    maxSteps: MAX_STEPS,
    structuredOutput: { schema: implementerHandoffSchema, errorStrategy: 'warn' },
  });
  await logAgentProgress('implementer', out);
  const handoff = await readHandoff('implementer', out, implementerHandoffSchema, opts.runDir);
  if (handoff.ok) return handoff.value;
  if (handoff.budgetExhausted) {
    return implementerFallback(
      `Implementer exhausted its ${MAX_STEPS}-step budget before producing a handoff.`,
      `The implementer ran out of its ${MAX_STEPS}-step budget before reporting. Check the log for redundant ` +
        'tool calls, then trim those or raise AGENT_MAX_STEPS.',
    );
  }
  return implementerFallback(
    "Implementer's final turn failed handoff schema validation.",
    `The implementer's final text does not match the handoff schema (${handoff.error}). The text and the ` +
      `error are in ${opts.runDir}. Whatever it wrote to disk was still scope-filtered and committed.`,
  );
}

/**
 * After an implementer turn: commit in-scope changes, move out-of-scope ones out of the worktree.
 * Returns what happened, for the run summary and the reviewer.
 */
function settleImplementerOutput(opts: {
  worktreePath: string;
  baseBranch: string;
  requirement: Requirement;
  writablePaths: string[];
  handoff: ImplementerHandoff;
  model: string;
  run: number;
}) {
  const { worktreePath, requirement, writablePaths, handoff, run } = opts;
  const { tracked, untracked } = getUncommittedFiles(worktreePath);
  const { inScope, outOfScope } = partitionByScope([...tracked, ...untracked], writablePaths);

  let quarantined: string[] = [];
  let quarantineDir = '';
  if (outOfScope.length) {
    quarantineDir = path.join(runDir(requirement.id, run), 'out-of-scope');
    quarantined = quarantineFiles(worktreePath, outOfScope, quarantineDir);
    log(`moved ${quarantined.length} out-of-scope file(s) to ${quarantineDir}: ${quarantined.join(', ')}`);
  }

  const message =
    `feat(${requirement.id}): implementer run ${run} (${handoff.status})\n\n` +
    `${handoff.summary.trim() || '(no summary)'}`.slice(0, 4000) +
    `\n\nAgent-Run: implementer\nAgent-Run-Number: ${run}\nAgent-Model: ${opts.model}\nAgent-Status: ${handoff.status}`;
  const committed = commitFiles(worktreePath, inScope, message);
  log(committed ? `committed ${inScope.length} in-scope file(s)` : 'no in-scope changes to commit this run');
  return { committed, inScope, quarantined, quarantineDir };
}

export async function runCoordinator(options: CoordinatorOptions): Promise<CoordinatorResult> {
  const config = loadConfig();
  const { writablePaths } = options;
  const requirement = findRequirement(config.repoRoot, options.requirementId);
  log(`requirement ${requirement.id} · ${requirement.title} [${requirement.executor}]`);
  log(`epic ${requirement.epicId} status: ${requirement.epicStatus}`);

  const worktree = ensureWorktree(config.repoRoot, requirement.id, branchSlug(requirement), config.baseBranch);
  const dirty = getUncommittedFiles(worktree.path);
  if (dirty.tracked.length || dirty.untracked.length) {
    throw new Error(
      `Worktree ${worktree.path} has uncommitted changes (${[...dirty.tracked, ...dirty.untracked].join(', ')}). ` +
        'Commit or remove them first, so this run starts from a known state.',
    );
  }
  log(`worktree ${worktree.path} on ${worktree.branch}; writable: ${writablePaths.join(', ')}`);

  const environmentFacts = formatEnvironmentFacts(probeEnvironment());
  const findingsDocPath = `docs/reviews/${requirement.id}.md`;
  const basePrompt = buildRequirementPrompt(worktree.path, requirement, writablePaths);

  let feedback: string | null = null;
  const priorFindings = readIfExists(path.join(worktree.path, findingsDocPath), MAX_FINDINGS_CHARS);
  if (priorFindings) {
    log(`found ${findingsDocPath} — seeding it into the prompt`);
    feedback =
      `## Review findings from the previous attempt (${findingsDocPath})\n\n` +
      'Fix everything this review asks for, and only that. It is the reviewer\'s verdict on the code ' +
      `already on this branch.\n\n${priorFindings}`;
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const priorRuns = readImplementerRuns(worktree.path);
    if (priorRuns >= MAX_IMPLEMENTER_RUNS && !options.force) {
      return {
        ok: false,
        summary:
          `${requirement.id}: ${priorRuns} implementer runs already (first attempt + ${MAX_FIX_CYCLES} fix cycles). ` +
          `Stopping: hand ${worktree.branch} and ${findingsDocPath} back to the human.`,
      };
    }
    const run = priorRuns + 1;
    recordImplementerRun(worktree.path, run);
    log(`implementer run ${run}/${MAX_IMPLEMENTER_RUNS}`);

    const prompt = feedback ? `${basePrompt}\n\n---\n\n${feedback}` : basePrompt;
    const handoff = await runImplementer({
      model: config.implementerModel,
      worktreePath: worktree.path,
      repoRoot: config.repoRoot,
      writablePaths,
      environmentFacts,
      prompt,
      runDir: runDir(requirement.id, run),
    });
    const settled = settleImplementerOutput({
      worktreePath: worktree.path,
      baseBranch: config.baseBranch,
      requirement,
      writablePaths,
      handoff,
      model: config.implementerModel,
      run,
    });

    const report = [
      `${requirement.id}: implementer run ${run} reported ${handoff.status}.`,
      `Branch: ${worktree.branch}`,
      `Worktree: ${worktree.path}`,
      `Committed: ${settled.committed ? settled.inScope.join(', ') : '(nothing)'}`,
      settled.quarantined.length
        ? `Out of scope, moved to ${settled.quarantineDir}: ${settled.quarantined.join(', ')}`
        : 'Out of scope: none',
      `Changed vs ${config.baseBranch}: ${getChangedFiles(worktree.path, config.baseBranch).length} file(s)`,
      `Handoff:\n${JSON.stringify(handoff, null, 2)}`,
    ].join('\n');

    if (!options.withReviewer) {
      return { ok: handoff.status === 'DONE', summary: `${report}\n\nNext: review it and write ${findingsDocPath}.` };
    }

    const reviewer = createReviewerAgent({
      model: config.reviewerModel(),
      worktreePath: worktree.path,
      repoRoot: config.repoRoot,
      baseBranch: config.baseBranch,
      findingsDocPath,
      environmentFacts,
    });
    const scopeNote = settled.quarantined.length
      ? `\n\nCOORDINATOR SCOPE CHECK: the implementer also changed these out-of-scope files; they were moved out ` +
        `of the worktree and are not on the branch: ${settled.quarantined.join(', ')}`
      : '';
    const reviewOut = await reviewer.stream(
      `Review requirement ${requirement.id} in ${worktree.path} on ${worktree.branch} (base ${config.baseBranch}). ` +
        `Write your findings to ${findingsDocPath}.\n\n${basePrompt}${scopeNote}`,
      {
        maxSteps: MAX_STEPS,
        structuredOutput: { schema: reviewerHandoffSchema, errorStrategy: 'warn' },
      },
    );
    await logAgentProgress('reviewer', reviewOut);
    const reviewRead = await readHandoff('reviewer', reviewOut, reviewerHandoffSchema, runDir(requirement.id, run));
    const review = reviewRead.ok
      ? reviewRead.value
      : reviewerFallback(
          findingsDocPath,
          reviewRead.budgetExhausted
            ? `The reviewer exhausted its ${MAX_STEPS}-step budget.`
            : `The reviewer's final text does not match the handoff schema (${reviewRead.error}).`,
        );

    const reviewChanges = getUncommittedFiles(worktree.path);
    const reviewFiles = [...reviewChanges.tracked, ...reviewChanges.untracked];
    const strays = reviewFiles.filter((f) => f !== findingsDocPath);
    if (strays.length) quarantineFiles(worktree.path, strays, path.join(__dirname, '..', 'runs', requirement.id, `review-${run}`));
    commitFiles(
      worktree.path,
      reviewFiles.filter((f) => f === findingsDocPath),
      `doc(${requirement.id}): review findings (${review.status})\n\nAgent-Run: reviewer`,
    );

    if (review.status === 'PASS') {
      return {
        ok: true,
        summary: `${report}\n\nMastra reviewer: PASS (${findingsDocPath}). Not pushed: the human-side review still applies.`,
      };
    }
    feedback =
      `## Reviewer found this BLOCKED last pass — address these:\n` +
      review.openQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n');
    log(`reviewer: BLOCKED`);
  }
}
