---
name: dev-team
description: Run the agentic dev team on one FEATURES.md ticket end-to-end (implement, test, document, PR) with the Claude Code harness. Use when the user says "/dev-team <TICKET-ID>", "work ticket P?-???", or asks to hand a backlog ticket to the dev team.
---

# /dev-team — Claude Code harness coordinator

You (the invoking session) are the **coordinator**. This skill's job is to take one ticket from
`FEATURES.md` all the way to a PR (or a documented blocker) by orchestrating the `dev-frontend`,
`dev-backend`, and `dev-reviewer` agents (`.claude/agents/dev-*.md`) — without stopping for
step-by-step approval. Read `agent-team/src/prompts/guardrails.md` now; it is the shared
contract this skill and both implementer/reviewer agents follow, and this skill enforces the
parts of it that are the coordinator's job specifically (worktree isolation, scope, retry
bound, who's allowed to open the PR).

`args` is the ticket ID, e.g. `P6-007`. If not given, ask the user which open ticket to run (list
a few unchecked ones from `FEATURES.md` as options) — this is the one point where it's fine to
ask, since everything after this is meant to run unattended.

## Steps

1. **Look up the ticket.** Grep `FEATURES.md` for `[TICKET-<args>]`. If it doesn't exist, stop
   and tell the user — do not guess which ticket they meant.
2. **Create the worktree.** From the repo root:
   ```
   git worktree add ../bread-sheet-agent-<TICKET-ID> -b agent/<TICKET-ID> main
   ```
   If the branch or worktree already exists (a previous run), reuse it rather than erroring —
   this is what makes a `BLOCKED` retry resume cleanly. **When reusing, first bring the branch
   up to date with `main`** (`git -C ../bread-sheet-agent-<TICKET-ID> merge --no-edit main`).
   Agents read `agent-team/src/prompts/guardrails.md` from the worktree by relative path, so a
   branch cut before a contract change has them following a superseded contract — and guardrail
   changes tend to land right after a bad run, i.e. exactly when a `BLOCKED` branch is waiting
   to be re-run. If that merge conflicts, `git merge --abort`, stop, and hand it back to the
   user: resolving it is theirs to do, not an agent's.
3. **Decide pillar(s).** Read the ticket's goal/implementation notes. If it mentions both an API
   surface and a screen/UI, it's both; if only one pillar's files are implicated, spawn only that
   implementer. When genuinely unsure, spawn both.
4. **Spawn implementer(s).** Use the `Agent` tool with `subagent_type: "dev-frontend"` and/or
   `"dev-backend"` (parallel tool calls in one message if both apply). Give each the full ticket
   text, its acceptance criteria, and the absolute worktree path — the agent's own definition
   already knows to `cd` there and follow the guardrails doc.
5. **Spawn the reviewer.** Once implementer(s) report done, spawn `subagent_type: "dev-reviewer"`
   against the same worktree path.
6. **Handle the outcome.**
   - PR opened → done. Report the PR URL to the user.
   - `BLOCKED` → re-spawn the implicated implementer with the reviewer's findings doc as input,
     then re-run the reviewer. Allow at most **2** such fix cycles total for this ticket; if
     still blocked after that, stop and report the findings doc path and its open questions —
     do not keep looping, and do not open a PR yourself.
7. Never run `gh pr create`, `git push`, or edit ticket boxes yourself in this skill — those are
   the reviewer's actions, kept in the reviewer agent so the "who's allowed to declare success"
   boundary stays in one place.

## Scope discipline

Don't expand the ticket, don't "helpfully" fix unrelated things you notice in the worktree, and
don't merge the PR. If the user wants the next ticket, they run `/dev-team` again.
