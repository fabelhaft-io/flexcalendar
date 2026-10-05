# agent-team

A Mastra-based orchestrator that hands one calendar-flex requirement (`E<nn>-R<nn>` in
`docs/epics/`) to an implementer agent inside a sandboxed git worktree. By default it stops after
the implementer: a human-side reviewer runs the stack-dependent checks, writes
`docs/reviews/<ID>.md`, and decides whether the branch goes back for a fix or becomes a PR. It
never pushes, never opens PRs and never merges.

The rules the agents follow are in [`src/prompts/guardrails.md`](src/prompts/guardrails.md). The
spec is `docs/06-implementation-backlog.md` (working agreement, `D-*`, `INV-*`) and `docs/epics/`.

## Setup

```sh
cd agent-team
npm install
cp .env.example .env   # set AGENT_MODEL and the matching provider API key
```

- `AGENT_MODEL` (or `AGENT_MODEL_IMPLEMENTER` / `AGENT_MODEL_REVIEWER`): a Mastra model-router id,
  `<provider>/<model-id>`, e.g. `deepseek/deepseek-flash`. Use the id the provider lists today; a
  wrong model name within a valid provider only shows up as a live API error.
- The API key for that provider: `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
  Only the coordinator process reads it; agent shell commands run with a minimal environment.
- `REPO_ROOT` (default: `agent-team/..`) and `BASE_BRANCH` (default: `main`).

Requires Linux with `bwrap` for the sandbox. Elsewhere the harness warns and runs shell commands
unsandboxed.

## Run a requirement

```sh
npm run dev-team -- <REQUIREMENT-ID> --paths <prefix>[,<prefix>...] [--with-reviewer] [--force]
```

- `--paths` lists what the implementer may write, repo-relative. A trailing `/` grants a
  directory tree (`server/caldav/`), anything else exactly one file (`Makefile`). `.git`,
  `agent-team/`, `.claude/` and secrets files (`.env*` except `.env.example`, keys, certs) are
  refused whatever you pass.
- `--with-reviewer` additionally runs the Mastra reviewer agent, which may only write
  `docs/reviews/<ID>.md`, with up to two in-process fix cycles. Off by default.
- `--force` runs past the limit of the first attempt plus two fix cycles. Only a human decides
  to use it.

What a run does:

1. Finds `### <ID> · …` in `docs/epics/` and builds the prompt: the requirement, the writable
   paths, the epic's header table and Goal, the `06` working agreement and `INV-*` table, the
   rows of every `D-*` it cites, and the docs the epic's Spec row names.
2. Creates or reuses the worktree `../calendar-flex-agent-<ID>` on `feat/<ID>-<slug>`, cut from
   `BASE_BRANCH` and merged forward on reuse. It refuses a dirty worktree.
3. If `docs/reviews/<ID>.md` exists in the worktree, adds it to the prompt as the list of
   fixes to make.
4. Runs the implementer, then commits the changes inside `--paths` itself, with the agent's
   summary and `Agent-Run`/`Agent-Model` trailers. Changes outside `--paths` are moved to
   `agent-team/runs/<ID>/run-<n>/out-of-scope/` (gitignored), so nothing is lost if `--paths` was
   too narrow, and the worktree is restored.
5. Prints the typed handoff: status, the commands the agent ran with exit codes, and the open
   questions, including the stack-dependent checks the reviewer still has to run.

Run it in the background and follow the log:

```sh
npm run dev-team -- E02-R01 --paths server/,apps/,packages/,spec/,infra/ > /tmp/E02-R01.log 2>&1 &
tail -f /tmp/E02-R01.log
```

Lines are prefixed `[coordinator]`, `[implementer]` or `[reviewer]`.

## The sandbox

Agent shell commands run under bubblewrap (`src/lib/sandbox.ts`):

- The worktree is writable; the worktree's `.git` pointer and the main checkout's `.git` are
  read-only, so `git status`/`diff`/`log` work and `add`/`commit` fail. Writes anywhere else
  never reach the host disk.
- The environment holds only `PATH`, a private `HOME` and cache variables. No API keys.
- `~/.cache/calendar-flex-agent-team/` is the one host path bound read-write: the corepack, pnpm
  store, npm, Composer and Gradle caches, so pnpm (`corepack pnpm …`) isn't downloaded on every run.
- **PHP and Composer** are on the sandbox's `PATH`, because the host has none
  (`src/lib/toolchains.ts`). The coordinator downloads a static PHP 8.4 CLI from static-php-cli
  and the official `composer.phar` once, into `~/.cache/calendar-flex-agent-team-tools/`. It
  checks both against pinned SHA-256 hashes on every run and binds the directory read-only. If
  they can't be provisioned (offline, a hash mismatch), the run continues and the agent is told
  that PHP is unavailable. To bump a version, change the URL and both hashes together.
- **No Podman.** Rootless `podman` cannot start under bwrap ("Error determining cgroups mode"),
  and the user's Podman socket is deliberately not mounted, because socket access is a sandbox
  escape. `/run/user/<uid>` must never be bound read-write: a failed rootless attempt deleted the
  host's `pause.pid` through such a bind. Everything that needs the local stack (`make dev`,
  integration tests, `make verify`) is run by the reviewer outside the sandbox.
- The file tools are confined to the worktree, and their writes are checked against `--paths`.
- Each shell command is killed after 10 minutes, whatever `timeout` the model asks for. The
  harness enforces this itself (`enforceCommandTimeout` in `sandbox.ts`): `@mastra/core` 1.64
  ignores `LocalSandbox`'s own `timeout` option, so without it a command started without a
  timeout would never end.

## Fix cycles

Each requirement gets the first attempt plus two fix cycles. The coordinator counts implementer
runs in the worktree's git dir (which agents cannot write) and refuses a fourth run unless
`--force` is given. After that the branch and findings doc go back to the human.
