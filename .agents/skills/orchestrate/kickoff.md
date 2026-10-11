# Kickoff: the unattended loop

The brief for a session that runs `/orchestrate` without the owner. Start it with:

```text
/loop Run /orchestrate unattended. Follow .agents/skills/orchestrate/kickoff.md.
```

This file holds **no state**. The state is git, `gh`, `docs/reviews/follow-ups.md` and `make next-ready`: check them before you act, and trust them over this file. Where [`SKILL.md`](SKILL.md) says "ask the owner", this file says what to do instead.

## The contract

- Take the queue end to end: pick, run the team, review, fix cycles, PR, merge. Ask the owner nothing and don't call a question tool: the owner reads your final report.
- You merge a PR yourself when the gate in `SKILL.md` § Merging holds, so the loop runs until the queue is empty, not until a cap. What the gate holds back (`agent+review` PRs, PRs that change the loop's own rules, a check you could not turn green) waits for the owner. The loop ends when nothing independent is left, when three PRs wait for the owner (the cap), or at another stop condition in `SKILL.md` § Running unattended. That is a normal end, not a failure: say what you merged, and which PRs the owner should merge, in which order.
- The limits are 3 reviewed PRs open at once, 2 implementers at once and 3 implementer runs per requirement. They are set here; don't change them on the fly. `make next-ready ARGS='--max-stack N --max-parallel N'` takes the first two.

## Start

1. Read `SKILL.md`, `review-checklist.md`, `environment.md`, `CLAUDE.md` and `docs/reviews/follow-ups.md`.
2. Check the state: `git fetch`, `git switch main && git pull --ff-only` (the main checkout stays clean), `gh pr list --state all --limit 10`, `git worktree list`. If `php`, `composer`, `flutter` or `dart` is missing from `PATH`, run `make host-tools`. Then `cd agent-team && npm install && npm run typecheck`, and `make next-ready`.
3. **Reconcile the docs first**, as one small `doc:` PR from `main`, one commit, CONTRIBUTING style. A requirement that has merged but still reads "passed review" or "Done once merged" in an epic Status cell or in the queue becomes Done. Remove the follow-ups its merge resolved. Add the follow-ups that live only in the "for later requirements" sections of recently merged `docs/reviews/<ID>.md`. Skip this when there is nothing to reconcile.

## Deciding without the owner

- **Park, don't stop.** For everything `SKILL.md` answers with "stop and ask the owner" (a `D-*` that isn't Pinned, an ambiguous spec, a spec that contradicts its doc, a decision that needs an ADR, a fourth implementer run), skip that requirement and go on with the next independent one. Keep a parked list in the scratchpad (`parked.txt`: ID, the exact question, what you checked), because every firing starts from the repo, not from memory. Parked questions go into your final report and under "Open with the owner" in `follow-ups.md` in the next PR you open.
- **The queue's prose beats the script.** `make next-ready` cannot read it. Read the queue item of every requirement before you start it, and its "queue also says" notes; an ordering note there (R03 only after R10) overrides `NEXT:`. Never start something listed under "Ready but not named in the queue": that is the owner's call, and goes in the final report.
- `agent+review` requirements run like any other. Their PR says that human approval is needed before merge, and the gate never merges it. They count toward the cap, and dependents may stack on them.
- `--paths`: the narrowest set the requirement plausibly needs. A file under `out-of-scope/` means it was too narrow: widen it and re-run, which uses one of the three runs.
- A command that the permission system or the auto-mode classifier blocks is not yours to work around. Park what depends on it, do what doesn't, and name the exact rule you need in the final report.

## What cost time before

- **Review with the whole gate set,** not only the touched component. CI's "Full make verify" runs every component, and a lint failure in another package was missed once. `make verify` stops at the first failing component; `make -k verify-tooling verify-server-api …` (one `verify-<path with - for />` target per directory under `server/`, `apps/` and `packages/`, plus `check-stack` and `verify-invariants`) shows every failure.
- **Read CI after every push,** CodeQL included. It is not a required check, but a high alert shows red on the PR: `gh api "repos/fabelhaft-io/flexcalendar/code-scanning/alerts?ref=refs/pull/<n>/merge"`.
- **Stacked runs:** stack only on a PR the gate holds back (usually an `agent+review` one); anything you merge yourself lands within minutes, so wait and cut from `main`. `BASE_BRANCH=<base>`, and the PR targets `<base>`. Main is merged forward into the stack after each merge with a `chore(<ID>): merge main (<ID>)` commit, never a force-push. Squash merges of a stack conflict where two PRs edit or append at the same spot: keep shared doc lines identical on every branch, move same-spot appends elsewhere, and simulate the squash merges in a throwaway worktree before you give the owner a merge order.
- **Waiting for CI:** `gh pr checks <n> --watch` with `run_in_background`, so the harness wakes you when it ends. CI takes about nine minutes (up to 30 on a full run), and the second implementer slot is free meanwhile: use it.
- **The local stack:** `make dev` does not rebuild images. Use `make dev-build`, then `make migrate` before `make token`. When compose or a Dockerfile changes, start fresh: `make dev-reset`, `make dev-build`, `make migrate`, `make seed`, `make token USER=alice`, then curl `/me` through Caddy (root certificate from the Caddy container, never `-k`): 503 before the seed and 200 after.
- **Lockfile:** the agent cannot write `pnpm-lock.yaml`. The coordinator quarantines it in `agent-team/runs/<ID>/run-<n>/out-of-scope/`. Check that the diff only adds, run `corepack pnpm install --frozen-lockfile`, and commit it yourself as `chore(<ID>): lockfile for …`.
- **Dirty worktrees:** Flutter leaves an untracked `apps/mobile/android/app/`, and the coordinator refuses a dirty worktree. Remove it before a run. A killed run leaves a dirty worktree and still counts against the three runs.
- **The Bash tool's shell does not word-split unquoted variables:** pass branch names as explicit arguments.
- **The project hook** rejects Bash command text that contains dotenv-style names. Use Edit or Write for such text. Never read `agent-team/.env` or print a secret.
- **Commits** are unsigned here. If `git commit` ever hangs on a signing agent, `git config --local commit.gpgsign` is not `false`: fix that, don't wait.

## When you stop

1. `make dev-down`: leave the default local stack stopped. Run the reconcile step (Start, 3) once more, so the Status cells of what you merged read Done. That PR goes through the gate like any other, or is reported as waiting if you stop first.
2. Write the final report: the PRs you merged (links, in order), the PRs you opened that the gate held back (links, and the order in which the owner should merge them, checked against squash conflicts), what is parked and why, what you need the owner to decide, what needs a permission, and the stale worktrees and branches you saw (leave their deletion to the owner).
3. If you have a push-notification tool, send one line with the reason you stopped.
4. End the loop (`ScheduleWakeup` with `stop: true`) instead of scheduling another firing.
