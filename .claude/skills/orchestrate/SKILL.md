---
name: orchestrate
description: Run calendar-flex's implementation loop as orchestrator and reviewer — pick the next Ready requirement from the queue, hand it to the Mastra agent team in agent-team/, review the branch with runtime checks and negative controls, run fix cycles, and open the PR after a PASS. Use when the user says "/orchestrate", "continue Phase 1", "next requirement", or asks to run or review requirements with the Mastra team.
---

# /orchestrate — the Mastra-team loop

You are the **orchestrator and reviewer**. The Mastra team in `agent-team/` implements; you run it, review its output and decide what goes back for fixing. **You don't write product code.** If the team can't do a requirement, escalate to the user. (`/dev-team` is the alternative harness with Claude Code subagents; use it only when the user asks.)

`args`: optional. A requirement ID (`E02-R09`) runs that one; empty means the next one in the queue.

## Read first

1. `docs/reviews/follow-ups.md`: the **queue**, follow-ups waiting for their requirement, and questions open with the user. This is the loop's state. Keep it current: update it on the requirement branch whenever a review changes it.
2. `docs/06-implementation-backlog.md` (working agreement, `D-*`, `INV-*`) and `CONTRIBUTING.md`.
3. The epic of the requirement you run, and the doc its Spec row cites.
4. `agent-team/README.md` and `agent-team/src/prompts/guardrails.md`.
5. [`review-checklist.md`](review-checklist.md) and [`environment.md`](environment.md) in this directory, before the first review of the session.

Then check the state: `git fetch`, `gh pr list --state all --limit 10`, `git switch main && git pull`, `git status` (clean apart from ignored files), `git worktree list`, then `cd agent-team && npm install && npm run typecheck`. If what you find disagrees with `follow-ups.md` (a PR merged, a requirement changed), trust the repo and fix the file.

## Hard rules

- Never merge, force-push, skip hooks or commit to `main`. Only the user merges.
- Never change a Pinned `D-*`. That needs the user and an ADR.
- Nothing outward-facing beyond pushing branches and opening PRs. Staging checks follow D-20. The production server is off-limits until the user has installed an SSH key, then only with their approval for each action, and you never ask for or use its password.
- Don't stack branches: a requirement that needs another one's code waits until that PR is merged. Requirements that edit the same files (the root `Makefile`) wait too.
- Persistent notes go into `CLAUDE.md`, this skill or `follow-ups.md`, never into auto-memory.
- Keep the user posted with one short line per requirement: started, the review verdict, then the PR link or the blocker.

## The loop

1. **Pick** the next queue entry that is **Ready**: every `Deps` entry is Done (the epic Status cells), every cited `D-*` is Pinned, and no open PR it depends on is still unmerged. If something isn't Pinned, or the requirement is ambiguous or contradicts its spec doc, stop and ask the user. Never guess.
2. **Run** it in the background, and tell the user it started:

   ```sh
   cd agent-team && npm run dev-team -- <ID> --paths <p1>,<p2> > <scratchpad>/<ID>.run<n>.log 2>&1
   ```

   - `--paths`: a trailing `/` grants a tree; anything else exactly one file. Root files are listed one by one (`Makefile`, `package.json`, `pnpm-lock.yaml`, `.gitignore`, …). Grant the narrowest set the requirement plausibly needs. `.git`, `agent-team/`, `.claude/` and secrets are always refused.
   - The coordinator creates `feat/<ID>-<slug>` in `../calendar-flex-agent-<ID>`, cut from `main` and merged forward on reuse. It commits in-scope files only. Out-of-scope edits land in `agent-team/runs/<ID>/run-<n>/out-of-scope/`, which is the sign of a too-narrow `--paths`.
   - A BLOCKED exit (code 1) can mean a failed handoff schema, not a real blocker. Read the run commit (`git -C <worktree> log -1 --format=%B`) and review the branch anyway.
3. **Review** it in its worktree, by [`review-checklist.md`](review-checklist.md). Write `docs/reviews/<ID>.md`:
   - the verdict, the review number and the reviewed commit;
   - each criterion with its command and observed output;
   - your own checks and negative controls; scope and invariants; versions checked upstream;
   - numbered fix requests ending with "Change nothing else.";
   - follow-ups that belong to other requirements, also added to `follow-ups.md`.

   `docs/reviews/E02-R03.md` and `E02-R04.md` show the expected depth.
4. **BLOCKED:** commit the doc on the branch as `doc(<ID>): review <n> (BLOCKED)`, because the coordinator refuses a dirty worktree. Re-run the same command; the coordinator feeds the doc to the implementer. At most three implementer runs: the first plus two fix cycles. After that, hand the branch and findings to the user. `--force` only with their OK. An **owner change request** after a PASS takes the same path: add a section to the doc, commit it, re-run and review again.
5. **PASS:**
   - add the new review section on top of the doc. Set the epic's Status cell on the branch: this requirement "passed review (link), Done once merged", and anything merged since marked Done. Two open branches that edit the same Status line get **identical** text; check with `git merge-tree --write-tree`;
   - update `follow-ups.md` on the branch: remove what this requirement resolved, add what its review found, and move the queue on;
   - commit as `doc(<ID>): review <n> (PASS)`. Every commit you make follows the `CONTRIBUTING.md` style, because GitHub squashes a single-commit PR with that commit's own message;
   - push and open the PR. Title `<type>(<ID>): <summary>`, with the type fitting the work (`feat`, `doc`, `fix`, `chore`, `infra`). The body summarises the change, links the findings with an **absolute** GitHub URL on the branch, lists the follow-ups, and ends with the attribution line from your system prompt. For `agent+review` requirements, state that human approval is required before merge;
   - tell the user: the verdict and the PR link.
6. **While a merge is pending**, pick an independent Ready requirement or a queued chore, or tell the user what is waiting on which merge. Leave the default local stack stopped (`make dev-down`) when you're done.

## Things you may do yourself

- Generate lockfiles or other artefacts that the sandbox can't produce, in a separate commit on the branch (`chore(<ID>): …`), saying so in the review and the PR.
- Harness and tooling fixes outside any requirement (`agent-team/`, `.claude/`), as their own `chore: …` PR, when the user asked for them. The queue in `follow-ups.md` lists the ones agreed.
- Doc fixes for a requirement the user wants changed: their own `doc(<ID>): …` PR, merged before the requirement runs, because the coordinator builds its prompt from `main`.
