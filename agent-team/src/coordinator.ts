import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { findTicket, type Ticket } from './lib/tickets.js';
import { ensureWorktree, getChangedFiles, commitFiles, pushBranch, createPullRequest } from './lib/worktree.js';
import { logAgentProgress } from './lib/progress.js';
import { probeEnvironment, formatEnvironmentFacts } from './lib/environment.js';
import { createFrontendAgent } from './agents/frontend-agent.js';
import { createBackendAgent } from './agents/backend-agent.js';
import { createReviewerAgent } from './agents/reviewer-agent.js';
import {
  implementerHandoffSchema,
  reviewerHandoffSchema,
  findOutOfPillarFiles,
  filterCommittableImplementerFiles,
  filterCommittableReviewerFiles,
  type ImplementerHandoff,
  type ReviewerHandoff,
  type InvokedPillars,
} from './lib/handoff.js';

const MAX_FIX_CYCLES = 2;
const MAX_STEPS = 100;
const MAX_PRIOR_FINDINGS_CHARS = 6000;

export interface CoordinatorResult {
  ok: boolean;
  summary: string;
}

function log(message: string): void {
  console.log(`[coordinator] ${message}`);
}

/**
 * Best-effort heuristic, same as the Claude Code coordinator skill: when genuinely
 * unsure, run both implementers rather than guess wrong and silently skip a pillar.
 */
function detectPillars(ticket: Ticket): InvokedPillars {
  const text = `${ticket.heading}\n${ticket.body}`.toLowerCase();
  const mentionsFrontend = /bread-sheet-app|frontend|screen|ui\b|expo/.test(text);
  const mentionsBackend = /server\/|backend|endpoint|api\b|prisma|controller|service/.test(text);
  if (!mentionsFrontend && !mentionsBackend) return { frontend: true, backend: true };
  return { frontend: mentionsFrontend, backend: mentionsBackend };
}

function formatOpenQuestions(questions: string[]): string {
  return questions.length
    ? questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
    : '(reviewer marked BLOCKED without listing specific open questions)';
}

/**
 * A prior top-level `npm run dev-team` invocation may have already left a findings doc on
 * this ticket's branch (this is exactly what happened running P9-003 across several separate
 * process runs) — read it once so the first prompt of *this* run can hand it straight to the
 * implementer instead of leaving it to rediscover "what's blocking this" via a broad sweep.
 */
function readPriorFindings(worktreePath: string, ticketId: string): string | null {
  const findingsPath = path.join(worktreePath, 'docs', `${ticketId}-findings.md`);
  try {
    const content = fs.readFileSync(findingsPath, 'utf8');
    return content.length > MAX_PRIOR_FINDINGS_CHARS
      ? `${content.slice(0, MAX_PRIOR_FINDINGS_CHARS)}\n…(truncated)`
      : content;
  } catch {
    return null;
  }
}

function commitMessageFromHandoffs(ticketId: string, handoffs: ImplementerHandoff[]): string {
  const summaries = handoffs.map((h) => h.summary.trim()).filter(Boolean);
  return `${ticketId}: ${summaries.join(' ')}`.slice(0, 2000);
}

/**
 * Mastra's default `errorStrategy` for `structuredOutput` is `'strict'`: if the model's final
 * turn fails schema validation (seen live against `deepseek-v4-flash` — an empty/malformed
 * final message, not a budget issue), it calls `abort()` and `out.object` **rejects**, which
 * used to propagate uncaught past `runCoordinator` to the CLI's top-level `.catch` and kill the
 * whole run — including the reviewer's already-written findings doc/PR fields, discarded with
 * no commit. `errorStrategy: 'fallback'` + a schema-shaped `fallbackValue` makes Mastra emit
 * this handoff instead of aborting, so `out.object` resolves like any other cycle. These are
 * passed to every `structuredOutput` option below; see `resolveImplementerHandoff`/
 * `resolveReviewerHandoff` for the other (non-overlapping) failure mode this doesn't cover.
 */
function implementerSchemaFailureFallback(role: string): ImplementerHandoff {
  return {
    status: 'BLOCKED',
    filesChanged: [],
    testResults: { typecheck: 'not_run', lint: 'not_run', unitTests: 'not_run' },
    summary: `${role} implementer's final turn failed structured-output schema validation.`,
    openQuestions: [
      `The ${role} implementer's model (see AGENT_MODEL_${role.toUpperCase()}) returned a final ` +
        'turn Mastra could not validate against the handoff schema — a model/provider quirk, not ' +
        'a budget issue. Check the log\'s "Error in agent stream" line for the raw error. Whatever ' +
        'the implementer wrote to disk this cycle is still there uncommitted; re-run the cycle, or ' +
        'switch models if it recurs.',
    ],
  };
}

function reviewerSchemaFailureFallback(): ReviewerHandoff {
  return {
    status: 'BLOCKED',
    findingsDocPath: "(none — reviewer's structured handoff failed schema validation)",
    prTitle: '',
    prBody: '',
    testMatrix: {
      serverTypecheck: 'not_run',
      serverTests: 'not_run',
      appTypecheck: 'not_run',
      appLint: 'not_run',
      appTests: 'not_run',
      e2eTests: 'not_run',
    },
    openQuestions: [
      'The reviewer\'s model (see AGENT_MODEL_REVIEWER) returned a final turn Mastra could not ' +
        'validate against the handoff schema — a model/provider quirk, not a budget issue. Check ' +
        'the log\'s "Error in agent stream" line for the raw error. Whatever findings doc it wrote ' +
        'this cycle is still there uncommitted; re-run the cycle, or switch models if it recurs.',
    ],
  };
}

/**
 * Mastra resolves `out.object` to `undefined` — not a rejection — when the agent's turn ends
 * (e.g. `maxSteps` exhausted) without ever emitting the structured handoff. That used to reach
 * `commitMessageFromHandoffs` as a bare `undefined` array entry and crash the whole coordinator
 * process on `h.summary` with no indication of which role or why. Whatever the agent wrote to
 * disk this cycle is still there uncommitted regardless — this synthesizes a BLOCKED handoff so
 * the normal review → fix-cycle path (or a human reading the log) sees an honest, specific
 * reason instead of a bare TypeError.
 */
async function resolveImplementerHandoff(
  role: string,
  out: { object: Promise<ImplementerHandoff | undefined> },
): Promise<ImplementerHandoff> {
  const handoff = await out.object;
  if (handoff) return handoff;
  log(`${role} implementer finished without a structured handoff — likely exhausted the ${MAX_STEPS}-step budget before its final turn`);
  return {
    status: 'BLOCKED',
    filesChanged: [],
    testResults: { typecheck: 'not_run', lint: 'not_run', unitTests: 'not_run' },
    summary: `${role} implementer exhausted its ${MAX_STEPS}-step budget before producing a handoff.`,
    openQuestions: [
      `The ${role} implementer ran out of its ${MAX_STEPS}-step tool-call budget before finishing ` +
        'and reporting a structured handoff. Check the log for redundant tool calls (e.g. ' +
        're-probing environment facts already given in the prompt, or repeated retries of the ' +
        'same verification) that ate the budget, then either trim those or raise MAX_STEPS.',
    ],
  };
}

/** Same undefined-object failure mode as resolveImplementerHandoff, for the reviewer's turn. */
async function resolveReviewerHandoff(out: { object: Promise<ReviewerHandoff | undefined> }): Promise<ReviewerHandoff> {
  const review = await out.object;
  if (review) return review;
  log(`reviewer finished without a structured handoff — likely exhausted the ${MAX_STEPS}-step budget before its final turn`);
  return {
    status: 'BLOCKED',
    findingsDocPath: '(none — reviewer ran out of budget before writing one)',
    prTitle: '',
    prBody: '',
    testMatrix: {
      serverTypecheck: 'not_run',
      serverTests: 'not_run',
      appTypecheck: 'not_run',
      appLint: 'not_run',
      appTests: 'not_run',
      e2eTests: 'not_run',
    },
    openQuestions: [
      `The reviewer ran out of its ${MAX_STEPS}-step tool-call budget before finishing and ` +
        'reporting a structured handoff. Check the log for what test matrix it had gotten ' +
        'through, then either trim redundant steps or raise MAX_STEPS before retrying.',
    ],
  };
}

export async function runCoordinator(ticketId: string): Promise<CoordinatorResult> {
  const config = loadConfig();
  const ticket = findTicket(config.repoRoot, ticketId);
  const worktree = ensureWorktree(config.repoRoot, ticketId, config.baseBranch);
  const environmentFacts = formatEnvironmentFacts(probeEnvironment());

  const pillars = detectPillars(ticket);
  log(`ticket ${ticket.id}, pillars=${JSON.stringify(pillars)}, worktree=${worktree.path}`);

  const ticketPrompt = `Ticket: ${ticket.heading}\n\n${ticket.body}`;
  const priorFindings = readPriorFindings(worktree.path, ticketId);
  if (priorFindings) log('found a findings doc from a prior run — seeding it into the first prompt');

  let fixCycles = 0;
  let lastOpenQuestions = '';

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const implementerHandoffs: ImplementerHandoff[] = [];
    const implementerRuns: Promise<void>[] = [];
    const prompt =
      fixCycles === 0
        ? priorFindings
          ? `${ticketPrompt}\n\nThis worktree already has a findings doc from an earlier run — ` +
            `read it before doing any broad exploration, it likely already answers "what's ` +
            `blocking this":\n\n${priorFindings}`
          : ticketPrompt
        : `${ticketPrompt}\n\nReviewer found this BLOCKED last pass — address these open questions:\n${lastOpenQuestions}`;

    if (pillars.frontend) {
      const frontend = createFrontendAgent({
        model: config.frontendModel,
        worktreePath: worktree.path,
        repoRoot: config.repoRoot,
        environmentFacts,
      });
      implementerRuns.push(
        frontend
          .stream(prompt, {
            maxSteps: MAX_STEPS,
            structuredOutput: {
              schema: implementerHandoffSchema,
              errorStrategy: 'fallback',
              fallbackValue: implementerSchemaFailureFallback('frontend'),
            },
          })
          .then(async (out) => {
            await logAgentProgress('frontend', out);
            implementerHandoffs.push(await resolveImplementerHandoff('frontend', out));
          }),
      );
    }
    if (pillars.backend) {
      const backend = createBackendAgent({
        model: config.backendModel,
        worktreePath: worktree.path,
        repoRoot: config.repoRoot,
        environmentFacts,
      });
      implementerRuns.push(
        backend
          .stream(prompt, {
            maxSteps: MAX_STEPS,
            structuredOutput: {
              schema: implementerHandoffSchema,
              errorStrategy: 'fallback',
              fallbackValue: implementerSchemaFailureFallback('backend'),
            },
          })
          .then(async (out) => {
            await logAgentProgress('backend', out);
            implementerHandoffs.push(await resolveImplementerHandoff('backend', out));
          }),
      );
    }

    await Promise.all(implementerRuns);

    // Objective cross-check against the model's own self-reported filesChanged — see
    // findOutOfPillarFiles's doc comment for why this doesn't just trust the handoff.
    const changedAfterImplementers = getChangedFiles(worktree.path, config.baseBranch);
    const outOfPillar = findOutOfPillarFiles(changedAfterImplementers, pillars);
    if (outOfPillar.length) log(`scope check flagged out-of-pillar files (will not be committed): ${outOfPillar.join(', ')}`);
    const scopeWarning = outOfPillar.length
      ? `\n\nCOORDINATOR SCOPE CHECK: these changed files fall outside every pillar invoked for ` +
        `this ticket (${JSON.stringify(pillars)}) — confirm they're actually in scope before ` +
        `passing this review: ${outOfPillar.join(', ')}`
      : '';

    // The coordinator, not the agent, owns every commit — see filterCommittableImplementerFiles's
    // doc comment for why this (not just OS sandboxing) is what actually closes the
    // out-of-scope-write gap. Agents have no git write access at all now (see sandbox.ts).
    const committable = filterCommittableImplementerFiles(changedAfterImplementers, pillars);
    const committed = commitFiles(worktree.path, committable, commitMessageFromHandoffs(ticket.id, implementerHandoffs));
    log(committed ? `committed implementer changes: ${committable.join(', ')}` : 'no committable implementer changes this cycle');

    const reviewer = createReviewerAgent({
      model: config.reviewerModel,
      worktreePath: worktree.path,
      repoRoot: config.repoRoot,
      baseBranch: config.baseBranch,
      environmentFacts,
    });
    const reviewOutput = await reviewer.stream(
      `Review ticket ${ticket.id} in worktree ${worktree.path} on branch ${worktree.branch} ` +
        `(base branch: ${config.baseBranch}).\n\n${ticketPrompt}${scopeWarning}`,
      {
        maxSteps: MAX_STEPS,
        structuredOutput: {
          schema: reviewerHandoffSchema,
          errorStrategy: 'fallback',
          fallbackValue: reviewerSchemaFailureFallback(),
        },
      },
    );
    await logAgentProgress('reviewer', reviewOutput);
    const review: ReviewerHandoff = await resolveReviewerHandoff(reviewOutput);

    // Same principle for the reviewer's own writes (findings doc, FEATURES.md checkboxes) —
    // it can produce them via its file tools (still hook-restricted to docs/+FEATURES.md), but
    // the coordinator is what turns them into a real commit.
    const changedAfterReview = getChangedFiles(worktree.path, config.baseBranch);
    const reviewCommittable = filterCommittableReviewerFiles(changedAfterReview);
    const reviewMessage = `${ticket.id}: record review findings (${review.status})`;
    const reviewCommitted = commitFiles(worktree.path, reviewCommittable, reviewMessage);
    log(reviewCommitted ? `committed reviewer changes: ${reviewCommittable.join(', ')}` : 'no committable reviewer changes this cycle');

    if (review.status === 'PASS') {
      log(`review passed — pushing ${worktree.branch} and opening a PR against ${config.baseBranch}`);
      pushBranch(worktree.path, worktree.branch);
      const prUrl = createPullRequest(worktree.path, {
        base: config.baseBranch,
        head: worktree.branch,
        title: review.prTitle,
        body: review.prBody,
      });
      log(`PR opened: ${prUrl}`);
      return {
        ok: true,
        summary: `Ticket ${ticket.id}: reviewer passed.\nFindings: ${review.findingsDocPath}\nPR: ${prUrl}`,
      };
    }

    lastOpenQuestions = formatOpenQuestions(review.openQuestions);
    fixCycles += 1;
    if (fixCycles > MAX_FIX_CYCLES) {
      return {
        ok: false,
        summary:
          `Ticket ${ticket.id}: still BLOCKED after ${MAX_FIX_CYCLES} fix cycles. Branch ` +
          `${worktree.branch} and its findings doc (${review.findingsDocPath}) are left in ` +
          `place for manual pickup.\n\nOpen questions:\n${lastOpenQuestions}`,
      };
    }
    log(`BLOCKED — starting fix cycle ${fixCycles}/${MAX_FIX_CYCLES}`);
  }
}
