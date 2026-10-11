---
name: orchestrate
description: Run calendar-flex's implementation loop as orchestrator and reviewer — pick the next Ready requirement from the queue, hand it to the Mastra agent team in agent-team/, review the branch with runtime checks and negative controls, run fix cycles, and open the PR after a PASS. Use when the user says "/orchestrate", "continue Phase 1", "next requirement", or asks to run or review requirements with the Mastra team.
---

# /orchestrate — Claude Code

**Read and follow [`.agents/skills/orchestrate/SKILL.md`](../../../.agents/skills/orchestrate/SKILL.md) now.** It is the procedure, tool-neutral so that any orchestrating agent can use it, and it links the review checklist and the environment recipes. This file adds only what is specific to Claude Code. `/dev-team` is the alternative harness with Claude Code subagents; use it only when the user asks.

`args`: optional, a requirement ID (`E02-R09`). Empty means the next one in the queue.

## Claude Code specifics

- **Memory:** never write to auto-memory. Persistent notes go where the neutral skill says: `CLAUDE.md`, the skill, or `docs/reviews/follow-ups.md`, through a PR.
- **Background runs:** start the harness with `run_in_background` and wait for the task notification. Foreground `sleep` is blocked, and polling is wasted turns.
- **Scratch directory:** use the session's scratchpad for logs, shims and throwaway copies.
- **PR attribution:** end PR bodies and commit messages with the attribution lines from your system prompt.
- **The project's Bash hook** (`.claude/settings.json`) rejects any command text that names a dotenv file other than `.env.example`, even in a regex, a heredoc or `git check-ignore`. Write `[.]en[v]` in commands, and use the Edit or Write tool for text that mentions such files.
- **Safety checks:** `rm -rf` inside `bash -c` and scripts is blocked, and so, sometimes, is an inline script it can't parse. Use fresh directory names (`clean-$(date +%s)`) instead of deleting, and put Python or Node checks in a scratchpad file.
- **The auto-mode classifier** blocks `git branch -D`, and has blocked reading harness run logs and editing memory. Don't work around a denial: report it to the user and carry on with what doesn't depend on it.
- **Edit tools:** the Edit tool needs a Read of the file in this session first, including files in another worktree.
- **Permissions:** the owner's `.claude/settings.local.json` allows the routine loop commands (exact `make` targets, `git add`/`commit`, `git push -u origin`, `gh pr create`). `make next-ready` needs `Bash(make next-ready)` there, and `make next-ready ARGS=…` needs `Bash(make next-ready *)`. The auto-mode classifier blocks you from editing your own permissions: ask the owner for the lines you need.

## Running unattended with /loop

The brief for such a session is [`kickoff.md`](../../../.agents/skills/orchestrate/kickoff.md); start it with `/loop Run /orchestrate unattended. Follow .agents/skills/orchestrate/kickoff.md.` A `/loop` without an interval makes you pace yourself. One firing is one pass of the loop in the neutral skill: `make next-ready`, start what it says, review what has finished, open the PR, then schedule the next firing. Each firing starts from the repo, not from memory: `docs/reviews/follow-ups.md` and `make next-ready` are the state.

- Hand the same `/loop /orchestrate` prompt back to `ScheduleWakeup` each time, with `noop: true` on a firing where nothing changed.
- Don't schedule a short wake-up to poll a background run: the harness re-invokes you when it finishes. Set a fallback of 1200 s or more, so the loop survives a run that hangs.
- When a stop condition in *Running unattended* (neutral skill) holds, call `ScheduleWakeup` with `stop: true` and tell the owner why, instead of scheduling another firing.
