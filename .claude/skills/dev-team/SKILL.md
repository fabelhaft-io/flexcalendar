---
name: dev-team
description: Run flexcalendar's agent team on one requirement (E<nn>-R<nn> from docs/epics/) with the Claude Code harness — implement, review, fix cycles, and a PR after a PASS. Use when the user says "/dev-team <ID>", "work E03-R01", or asks to hand a backlog requirement to the dev team.
---

# /dev-team — Claude Code harness coordinator

You (the invoking session) are the **coordinator**. Take one requirement from `docs/epics/` to
a PR, or to a documented blocker, by orchestrating the `dev-implementer` and `dev-reviewer`
agents (`.claude/agents/`). This is the Claude Code twin of the Mastra harness in `agent-team/`;
both follow `agent-team/src/prompts/guardrails.md`, so read it now. The spec is
`docs/06-implementation-backlog.md` (working agreement, `D-*`, `INV-*`) and `docs/epics/`.

`args`: `<ID> [--paths <prefix>,...]`, e.g. `E03-R01 --paths server/caldav/,infra/dev/`. If the
ID is missing, ask which Ready requirement to run. If `--paths` is missing, propose the narrowest
set the requirement needs and confirm it with the user once.

## Steps

1. **Look up the requirement.** Find `### <ID> · …` in `docs/epics/E<nn>-*.md`. If it doesn't
   exist, stop and say so; don't guess which one was meant.
2. **Check it is Ready.** Every `Deps` entry is Done (epic Status tables), and every `D-*` it or
   its epic cites is `Pinned` in `06`. If not, or if anything is ambiguous, stop and ask the
   user. Never guess: open questions change the architecture.
3. **Create or reuse the worktree** from the repo root:
   ```
   git worktree add ../flexcalendar-agent-<ID> -b feat/<ID>-<slug> main
   ```
   `<slug>` is the requirement title in lowercase kebab-case. When reusing, first
   `git -C ../flexcalendar-agent-<ID> merge --no-edit main`. On a conflict, `git merge --abort`,
   stop, and hand it to the user. Refuse to start on a dirty worktree.
4. **Spawn `dev-implementer`** (`subagent_type: "dev-implementer"`). Give it:
   - the requirement text verbatim;
   - the absolute worktree path;
   - the writable paths;
   - on a fix cycle, the path of `docs/reviews/<ID>.md`.
5. **Settle its output yourself.** The agent doesn't commit. Run
   `git -C <worktree> status --porcelain --untracked-files=all`:
   - Commit only files under the writable paths, never secrets, `.env*` (except `.env.example`),
     `agent-team/` or `.claude/`. Message: `feat(<ID>): implementer run <n> (<status>)`, the agent's
     summary in the body, trailer `Agent-Run: implementer`.
   - Anything else: move a copy to `agent-team/runs/<ID>/run-<n>/out-of-scope/`, then restore or
     remove it in the worktree, and tell the reviewer.
6. **Spawn `dev-reviewer`** against the same worktree, with the base branch and the writable
   paths. It runs the stack-dependent checks and writes `docs/reviews/<ID>.md`. Read the doc
   yourself before acting on the verdict. A PASS on a runtime criterion that wasn't executed is
   a BLOCKED. Commit the doc on the branch as `doc(<ID>): review <n> (<VERDICT>)`.
7. **On BLOCKED:** re-spawn `dev-implementer` with the findings doc, then re-review. At most
   **2** fix cycles after the first attempt. After that, stop and hand the branch and findings
   doc to the user. Don't fix product code yourself.
8. **On PASS:**
   - set the requirement's progress in its epic's Status cell, on the same branch;
   - push the branch and open the PR (`gh pr create --base main`). Title is
     `<type>(<ID>): <summary>` with type `feat`, `doc`, `fix`, `chore` or `infra`: PRs are
     squash-merged, so it becomes the commit subject on `main` (`CONTRIBUTING.md`). The body links `docs/reviews/<ID>.md` and ends with the attribution line your system
     prompt specifies;
   - for `agent+review` requirements, say in the PR body that a human must approve it before
     merge;
   - never merge, force-push or skip hooks.
9. Tell the user one short line: started, review verdict, then the PR link or the blocker.

## Scope discipline

Don't expand the requirement, don't fix unrelated things you notice, and never change a Pinned
`D-*` (that needs the user and an ADR). Nothing outward-facing beyond the push and PR in step 8,
with one exception: acceptance criteria that need real infrastructure, which you run against
**staging only** (D-20 in `06`): `make staging-up`/`staging-down`, `make deploy ENV=staging`,
backup checks against the real buckets, external graders. Record the results in
`docs/reviews/<ID>.md`. Never production, never DNS, and never on the agents' behalf.
