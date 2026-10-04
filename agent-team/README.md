# agent-team

Standalone Mastra-based orchestrator for BreadSheet's agentic dev team (Harness B). It runs
outside any Claude Code session and implements the same frontend/backend/reviewer contract as
the Claude Code harness (`/dev-team <TICKET-ID>`).

This README covers setup and day-to-day running. For the shared contract, the architecture
(sandboxing, coordinator-owned git, typed handoff), and how this harness compares to Harness A,
see [`docs/architecture/agent-dev-team.md`](../docs/architecture/agent-dev-team.md).

## Setup

```sh
cd agent-team
npm install
cp .env.example .env   # fill in AGENT_MODEL + the matching provider API key
```

`.env.example` documents each variable, but at minimum you need:

- `AGENT_MODEL` (or the per-role `AGENT_MODEL_FRONTEND`/`_BACKEND`/`_REVIEWER` overrides) — a
  Mastra model-router id, `<provider>/<model-id>` (e.g. `anthropic/claude-sonnet-5`).
- The API key matching that provider prefix — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
  `DEEPSEEK_API_KEY`.

There are no defaults for any of these — `src/config.ts` fails fast at startup if a role's
model or the matching provider key isn't set (same "fail fast, no inline env defaults"
convention as `server/.env`).

Two more variables you generally won't need to touch:

- `REPO_ROOT` — path to the bread-sheet checkout this orchestrator operates on. Defaults to the
  parent of this directory (`agent-team/..`).
- `BASE_BRANCH` — defaults to `main`. Override for a dry run against a branch that hasn't
  merged to `main` yet (the worktree needs `agent-team/` and the target ticket to actually
  exist on whatever it's branched from).

## Run a ticket

```sh
npm run dev-team -- <TICKET-ID>
```

`<TICKET-ID>` must exist as a `### [TICKET-...]` heading in `FEATURES.md`. This creates an
isolated git worktree, runs the relevant implementer(s), then the reviewer, and on a `PASS`
pushes the branch and opens a PR against `main`.

## Running in the background + tailing the log

A run typically takes several minutes (multiple agent turns across implementer(s) and
reviewer), so it's usually more convenient to launch it in the background and tail the log
rather than keep the shell attached:

```sh
cd agent-team
npm run dev-team -- <TICKET-ID> > /tmp/<TICKET-ID>.log 2>&1 &
tail -f /tmp/<TICKET-ID>.log
```

Every line is prefixed by which part of the system wrote it — `[coordinator]` for
coordinator-side actions (worktree creation, commits, PR creation), `[frontend]`/`[backend]`/
`[reviewer]` for each agent's own tool calls — so `tail -f` is enough to watch progress.
`Ctrl+C` only stops the `tail`, not the background run. Check on or stop the run itself with
the usual job-control tools (`jobs`, `wait %1`, `kill %1`) or `pgrep -f dev-team`.

## Switching model / provider

Moving the whole team to a different provider is changing `AGENT_MODEL` (or the three per-role
variables) and adding the matching API key — no code change. `P9-003` has reached a genuine
`PASS` on DeepSeek, and separately confirmed working end-to-end on Anthropic.

Mind the exact model-ID string each provider expects — e.g. DeepSeek wants lowercase
hyphenated names like `deepseek-v4-flash`, not `DeepSeek-V4-Flash`. `config.ts`'s fail-fast
only catches a bad provider *prefix*; a bad model name within a valid provider surfaces as a
live API error instead.
