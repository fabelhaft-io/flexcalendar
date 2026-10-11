---
name: orchestrate
description: Run flexcalendar's implementation loop as orchestrator and reviewer, with any capable coding agent — pick the next Ready requirement from the queue, hand it to the Mastra agent team in agent-team/, review the branch with runtime checks and negative controls, run fix cycles, and open the PR after a PASS. Use when asked to continue the implementation phases, run the next requirement, or review a requirement branch.
---

# Orchestrate — the Mastra-team loop

This is the tool-neutral version of the orchestrator procedure. Any coding agent that can run shell commands in this repo can follow it. Tool-specific additions live next to the tool's own configuration: Claude Code's are in `.claude/skills/orchestrate/SKILL.md`. Where this file and the docs disagree, the docs win; fix this file in a PR.

You are the **orchestrator and reviewer**. The Mastra team in `agent-team/` implements; you run it, review its output and decide what goes back for fixing. **You don't write product code.** If the team can't do a requirement, escalate to the owner.

Input: optionally a requirement ID (`E02-R09`). Without one, take the next entry in the queue.

## What you need

- A shell on the dev host, with the toolchains and the local stack described in [`environment.md`](environment.md).
- Git push access and the GitHub CLI (`gh`) for pushing branches and opening PRs.
- The ability to start a long command in the background and come back to it when it finishes. An implementer run takes minutes to an hour.
- A scratch directory outside the repo for logs, shims and throwaway copies.
- **No private memory.** Anything worth keeping across sessions goes into the repo: general facts in `CLAUDE.md` (it applies to every agent, whatever its name), the procedure in this skill, and the loop's state in `docs/reviews/follow-ups.md`.

## Read first

1. `docs/reviews/follow-ups.md`: the **queue**, the follow-ups waiting for their requirement, and the questions open with the owner. This is the loop's state. Update it on the requirement branch whenever a review changes it.
2. `CLAUDE.md`: the project's working notes for any coding agent.
3. `docs/06-implementation-backlog.md` (working agreement, `D-*`, `INV-*`) and `CONTRIBUTING.md`.
4. The epic of the requirement you run, and the doc its Spec row cites.
5. `agent-team/README.md` and `agent-team/src/prompts/guardrails.md`: the implementer's rules.
6. [`review-checklist.md`](review-checklist.md) and [`environment.md`](environment.md), before the first review of the session.

Then check the state: `git fetch`, `gh pr list --state all --limit 10`, `git switch main && git pull`, `git status` (clean apart from ignored files), `git worktree list`, then `cd agent-team && npm install && npm run typecheck`. If `php`, `composer`, `flutter` or `dart` is missing from `PATH`, run `make host-tools` once ([`environment.md`](environment.md)). If the repo disagrees with `follow-ups.md` (a PR merged, a requirement changed), trust the repo and fix the file.

## Hard rules

- Never force-push, skip hooks, commit to `main`, arm auto-merge or bypass the ruleset (`gh pr merge --admin`). You merge a PR yourself only through the gate in *Merging* below (the owner's decision of 2026-10-11); every other merge is the owner's. `main` takes only PRs with the "Verify required" check green (`CONTRIBUTING.md` § Branch naming).
- Commits are not signed in this repo. The owner set `commit.gpgsign=false` in the repository's local git config, which every linked worktree shares, so no commit waits on the 1Password agent. On a fresh clone run `git config --local commit.gpgsign false`. Build throwaway fixtures in a separate scratch repository (`git archive` into a directory, then `git init` there), not as a commit on a branch of this repo.
- Never change a Pinned `D-*`. That needs the owner and an ADR.
- Nothing outward-facing beyond pushing branches, opening PRs and merging through the gate. Staging checks follow D-20 in `06`. The production server is off-limits until the owner has installed an SSH key, then only with their approval for each action, and you never ask for or use its password.
- Never read or print secrets: `agent-team/.env`, tokens in container volumes, the password manager.
- Stacking is allowed (the owner's decision of 2026-10-10, `follow-ups.md` § Queue): a requirement may start when each dependency is Done or has a branch whose review passed, and it is cut from that branch. **At most three reviewed PRs may be open at once.** `make next-ready` counts them and stops you at the cap. Stack only on a branch whose PR the gate holds back for the owner (an `agent+review` PR, say): the owner merges at their own pace, and a rejection at the bottom of a tall stack invalidates everything above it. A PR you will merge yourself lands within minutes, so wait for it and cut from `main` (squash merges of a stack conflict), even where `make next-ready` says to stack. Requirements that edit the same files (the root `Makefile`) wait for each other's merge.
- Keep the owner posted with one short line per requirement: started, the review verdict, then the PR link or the blocker.

## The loop

1. **Pick** with `make next-ready`. It ranks the requirements the queue names whose `Deps` are Done (or reviewed and waiting for a merge, so you can stack on them) and whose `D-*` are Pinned. Its last line, `NEXT:`, says to `start` some of them, to `wait` (the stack cap, or every implementer slot taken) or that `none` is ready. It reads git, not the working tree: Done means a PASS review doc on `origin/main`, and "waiting for a merge" means a `feat/<ID>-*` branch whose review doc says PASS. **It is advisory.** It cannot read the queue's prose or an epic's free-text dependencies, so read the queue item of what it picked and its "queue also says" notes (E08-R02, for one, waits for an ADR the script cannot see), and look at "Needs judgment". `--explain <ID>` shows one requirement's reasons. If something isn't Pinned, or the requirement is ambiguous or contradicts its spec doc, stop and ask the owner. Never guess.
2. **Run** it in the background, logging to the scratch directory, and tell the owner it started:

   ```sh
   cd agent-team && BASE_BRANCH=<base> npm run dev-team -- <ID> --paths <p1>,<p2> > <scratch>/<ID>.run<n>.log 2>&1
   ```

   - `<base>` is `main` (leave `BASE_BRANCH` out) unless the requirement stacks: then it is the branch `make next-ready` shows after "stack on". The coordinator cuts `feat/<ID>-<slug>` from it and merges it forward on reuse. The PR of a stacked requirement targets that branch (`gh pr create --base <base>`), and `main` is merged forward into the stack after each merge (`follow-ups.md` § Queue).
   - `--paths`: a trailing `/` grants a tree; anything else exactly one file. Root files are listed one by one (`Makefile`, `package.json`, `pnpm-lock.yaml`, `.gitignore`, …). Grant the narrowest set the requirement plausibly needs. The coordinator always refuses `.git`, `agent-team/`, `.claude/`, `.agents/` (this skill) and secrets files.
   - The coordinator creates `feat/<ID>-<slug>` in `../flexcalendar-agent-<ID>`, cut from `BASE_BRANCH` (default `main`) and merged forward on reuse. It commits in-scope files only. Out-of-scope edits land in `agent-team/runs/<ID>/run-<n>/out-of-scope/`, which is the sign of a too-narrow `--paths`.
   - When `NEXT:` names two requirements, start both: each has its own worktree and run directory. Cut a stacked one from the branch `make next-ready` shows after "stack on". The `follow-ups: N` count on a row is the number of lines in `follow-ups.md` that name it: those are what the brief below must carry.
   - A BLOCKED exit (code 1) can mean a failed handoff schema, not a real blocker. The reason is in `agent-team/runs/<ID>/run-<n>/implementer-handoff-error.txt`, next to the agent's final text. Review the branch anyway.
   - **Brief before run 1.** Follow-ups that belong to the requirement reach the implementer only through `docs/reviews/<ID>.md` on its branch, which the coordinator feeds into the prompt. So create the branch and worktree yourself (`git worktree add ../flexcalendar-agent-<ID> -b feat/<ID>-<slug> <base>`; the slug is the coordinator's: the requirement title lower-cased, runs of non-alphanumerics as `-`, at most 40 characters), commit the brief there as `doc(<ID>): brief before run 1`, and then run. Put in it: the follow-ups from `follow-ups.md`, facts you checked upstream (versions, peer ranges, whether a generator runs on the pinned toolchain), the design constraints you want, what the sandbox can't run and what to do about it (write everything, list the rest). The coordinator truncates the file at 12,000 characters (`MAX_FINDINGS_CHARS`), so keep the newest review and its fix requests at the top and older sections below.
3. **Review** it in its worktree, by [`review-checklist.md`](review-checklist.md). Write `docs/reviews/<ID>.md`:
   - the verdict, the review number and the reviewed commit;
   - each criterion with its command and observed output;
   - your own checks and negative controls; scope and invariants; versions checked upstream;
   - numbered fix requests ending with "Change nothing else.";
   - follow-ups that belong to other requirements, also added to `follow-ups.md`.

   `docs/reviews/E02-R03.md` and `E02-R04.md` show the expected depth.
4. **BLOCKED:** commit the doc on the branch as `doc(<ID>): review <n> (BLOCKED)`, because the coordinator refuses a dirty worktree. Re-run the same command; the coordinator feeds the doc to the implementer. At most three implementer runs: the first plus two fix cycles. After that, hand the branch and findings to the owner. A fourth run needs the owner's explicit OK (`--force`). Read the handoff's `openQuestions` before you count a BLOCKED as a blocker:
   - Only checks the sandbox can't run (Podman, the stack, a missing SDK) is a review request, not a blocker: review the branch as usual, and run those checks yourself.
   - Nothing written because such a check couldn't run: answer with a review that tells it to write the deliverable, run what the sandbox can, and list the stack checks for the reviewer. `guardrails.md` says this too, but the review should repeat it.
   - Before every re-run, `git status` in the worktree. Review commands leave artefacts the coordinator refuses as a dirty worktree (`flutter pub get` writes an untracked `apps/mobile/android/app/…`). Remove them.

   An **owner change request** after a PASS takes the same path: add a section to the doc, commit it, re-run and review again.
5. **PASS:**
   - add the new review section on top of the doc. Set the epic's Status cell on the branch: this requirement "passed review (link), Done once merged", and anything merged since marked Done. Two open branches that edit the same Status line get **identical** text; check with `git merge-tree --write-tree`;
   - update `follow-ups.md` on the branch: remove what this requirement resolved, add what its review found, and move the queue on;
   - commit as `doc(<ID>): review <n> (PASS)`. Every commit you make follows the `CONTRIBUTING.md` style, because GitHub squashes a single-commit PR with that commit's own message;
   - push and open the PR. Title `<type>(<ID>): <summary>`, with the type fitting the work (`feat`, `doc`, `fix`, `chore`, `infra`). The body summarises the change, links the findings with an **absolute** GitHub URL on the branch, and lists the follow-ups. Add whatever attribution line your tool requires. For `agent+review` requirements, state that human approval is required before merge: the gate holds the PR back, and the owner reviews it before merging or arming auto-merge;
   - tell the owner: the verdict and the PR link, then go on to *Merging*.
6. **Pipeline, don't wait.** The implementer run is the long part, and reviews are serial anyway (one local stack, fixed host ports). So start the next implementer before you review the one that just finished: while a run is going in the background, run `make next-ready` again, and if it says `start`, launch that requirement too. At most two implementers run at once (`--max-parallel`). Review in the order the runs finish. When a PR is open and nothing is ready, wait for its CI and merge it (*Merging*), or tell the owner what is waiting on which merge. Leave the default local stack stopped (`make dev-down`) when you're done. Nobody has run two coordinators at once yet: the first time two overlap, watch for contention on the shared caches in `~/.cache/flexcalendar-agent-team/`, and fall back to one at a time if a run fails for a reason that looks like it.

## Merging

The owner's decision of 2026-10-11: a verified PR merges without waiting for them. "Verified" is the list below, and **you check every item right before the merge command**, not from memory of an earlier pass. If one fails, the PR stays open for the owner and the final report names the item. Never loosen an item to get a PR through.

1. **The executor is `agent`.** Read the requirement's row in its epic. `agent+review` (`CONTRIBUTING.md` rule 7) and `human` are never merged by you. No label or check marks them, so this is the only guard. A PR that belongs to no requirement (the `doc:` reconcile PR) passes this item when it changes only epic Status cells, the queue and `docs/reviews/`.
2. **The diff leaves the loop's own rules alone.** `gh pr diff <n> --name-only` shows nothing under `.claude/`, `.agents/`, `agent-team/`, `.github/` or `docs/adr/`, and none of `CONTRIBUTING.md`, `CLAUDE.md` or `docs/06-implementation-backlog.md`. An agent does not approve a change to its own rules, its permissions or the CI that gates it.
3. **Your PASS is on this head.** `docs/reviews/<ID>.md` says PASS for the commit you reviewed, and every commit since is a doc, lockfile or merge-forward commit you looked at. Anything else gets a new review first.
4. **CI is green on this head.** `gh pr checks <n>` shows "Verify required" *succeeded* on the head SHA (pending, absent or skipped is not green), and the CodeQL query in `kickoff.md` shows no high alert. Run `gh pr checks <n> --watch` in the background while a check is pending. A red check is a finding: it goes back through the BLOCKED path and counts toward the three implementer runs.
5. **Open, targets `main`, mergeable and current.** Not a draft: the owner stops a merge by converting the PR to a draft or closing it. `gh pr view <n> --json state,isDraft,baseRefName,mergeable` says `OPEN`, `false`, `main`, `MERGEABLE`. After `git fetch`, `git merge-base --is-ancestor origin/main origin/<branch>` succeeds. The ruleset does not ask for that, but it is what stops two PRs that are green alone from breaking `main` together. If `main` has moved, merge it forward (`chore(<ID>): merge main (<ID>)`) and wait for CI again.
6. **`main` is green.** The last finished run of `Verify` on `main` (`gh run list --branch main --workflow Verify --limit 3`) succeeded. If it failed, merge nothing, work out which merge did it, and stop: you don't revert it yourself.

Merge one PR at a time, with `gh pr merge <n> --squash`, the only method the ruleset allows. Never `--admin`, and never `--auto`: auto-merge lands a PR on the required check alone, after a push that skipped your items. Then confirm with `gh pr view <n> --json state,mergeCommit` (`MERGED`), `git switch main && git pull --ff-only` in the main checkout, and say so in one line. A requirement stacked on a held-back branch gets `main` merged forward when its base merges. The Status cells of what you merged still read "Done once merged": the reconcile step in `kickoff.md` turns them to Done.

## Running unattended

When the owner asks for the loop to run on its own ("keep going", "run the queue"), follow [`kickoff.md`](kickoff.md): it is the brief for that session, and it says what to do where this skill says "ask the owner". Repeat the loop until a stop condition holds, and say which one stopped you. Stop and tell the owner when:

- `make next-ready` says `wait` because of the stack cap, **and** every PR that counts toward it is one the gate holds back (`agent+review`, a change to the loop's own rules, a check you could not turn green). Report which PRs wait for the owner's merge, then stop; don't keep polling for it. A PR that only waits for CI is not a stop: wait for it, merge it, go on.
- It says `none`, or only "Needs judgment" entries are left.
- A `D-*` the requirement cites is not Pinned, the spec is ambiguous or contradicts its doc, or the answer is the owner's to give.
- A requirement has used its three implementer runs.
- A step would need the production server, a secret, a merge the gate holds back or a force-push (Hard rules).
- The last `Verify` run on `main` failed (*Merging*, item 6).
- The environment is broken in a way you can't fix: the toolchain (`make host-tools`), the stack, or authentication.

An `agent+review` PR is not a stop. Open it, say that human approval is needed, and carry on with something independent; the gate never merges it, and it counts toward the cap.

## Things you may do yourself

- Generate lockfiles or other artefacts that the sandbox can't produce, in a separate commit on the branch (`chore(<ID>): …`), saying so in the review and the PR. Examples: `pnpm-lock.yaml`, or a generated Dart client (E02-R07), regenerated from an empty output directory with the pinned Flutter, as the requirement's own `make gen` would.
- Harness and tooling fixes outside any requirement (`agent-team/`, `.claude/`, `.agents/`), as their own `chore: …` PR, when the owner asked for them. The queue in `follow-ups.md` lists the ones agreed.
- Doc fixes for a requirement the owner wants changed: their own `doc(<ID>): …` PR, merged before the requirement runs, because the coordinator builds its prompt from `main`.
