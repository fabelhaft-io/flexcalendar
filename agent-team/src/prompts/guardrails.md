# calendar-flex Agent Team — Rules

These rules bind every agent in both harnesses: the Mastra team in `agent-team/` and the Claude
Code `/dev-team` skill with its `.claude/agents/`. Where they enforce something differently (the
Mastra harness has a bwrap sandbox and a "Known environment" block; the Claude Code agents don't),
the agent's own definition says so. They are short on purpose: the requirement,
its epic, the `06` working agreement and the INV-* table are handed to you in the task prompt
verbatim, and those are the spec. `CLAUDE.md` and everything under `docs/` are readable from
your worktree. When this file and the docs disagree, the docs win; say so in `openQuestions`.

## Scope

- You work on exactly one requirement (`E<nn>-R<nn>`) from `docs/epics/`, inside a git worktree
  created for it. Implement only what that requirement's normative statement and `Accept`
  criteria ask for. Other bugs, missing tests, or good ideas go into `openQuestions` as
  follow-ups. Never implement them as part of this run.
- You may write only under the **writable paths** listed in your task prompt. The rest of the
  repo is read-only reference. Writes elsewhere are refused by the file tools, and anything a
  shell command writes outside them is not committed: the coordinator moves it out of the
  worktree after your turn.
- Never write `.env` files or secrets (signing certs, private keys, API keys, SMTP, Firebase or
  HSM credentials), whatever the writable paths say. Everything is read from the environment,
  and a new variable gets a line in the relevant `.env.example`.
- Never edit `agent-team/`, `.claude/` or git metadata.
- **Pick up only what the prompt gives you.** If the requirement depends on a decision (`D-*`)
  or another requirement that the docs don't show as settled, or if the acceptance criteria are
  ambiguous or contradict the docs, stop and report `BLOCKED` with the question. Don't guess:
  `CLAUDE.md` says the open questions change the architecture.

## Invariants and security

- The INV-* invariants in your prompt are hard gates. A change that breaks one is rejected,
  whatever else it passes. The ones agents break most easily: event content outside the sidecar
  (INV-01), non-UUIDv4 IDs (INV-03), times without `TZID`/`Z` or all-day as midnight date-times
  (INV-04), clients emitting `EXDATE`/`RECURRENCE-ID` (INV-05), content-crypto libraries under
  `server/**` (INV-07), anything deriving a key from the login password (INV-12).
- **No event content in logs**: no `SUMMARY`, `DESCRIPTION`, `LOCATION`, attendees or envelope
  bytes in any log line, error message or test snapshot that ends up in logs.
- Requirements tagged `agent+review` (auth, ACLs, crypto, escrow, anything touching the privacy
  claim) are approved by a human before merge. Be conservative: no clever shortcuts, and list
  every security-relevant choice you made in `summary` so the reviewer can check it.
- Use vetted libraries for recurrence and time (`ical.js`, `iCal4j`, `sabre/vobject`). Never hand-roll
  RRULE expansion or timezone maths.

## Environment

- Containers are **rootless Podman** (`podman compose`), never a Docker daemon. Compose files
  and scripts you write must work rootless, without `sudo` and without changing sysctls; the
  local stack serves HTTPS on port 8443.
- You cannot run Podman yourself (see "Known environment"). Write the container and stack
  files, run the checks that work in the sandbox, and list the stack-dependent commands the
  reviewer must run in `openQuestions`.
- **Never stop before writing because a check can't run in the sandbox** (the stack, Podman, a
  toolchain you can't get). Write the whole deliverable first, run what the sandbox can, and
  list the rest in `openQuestions` for the reviewer. You may still report `BLOCKED` when the
  deliverable itself couldn't be exercised, but only with everything written: a `BLOCKED`
  handoff that wrote nothing costs a fix cycle and tells the reviewer nothing.
- **Toolchains you download stay out of the worktree.** Files under your writable paths are
  committed by the coordinator, so an SDK unpacked there ends up in git. In the Mastra sandbox
  the one persistent, writable host path is `~/.cache/calendar-flex-agent-team/`: download and
  unpack there, and check the archive's SHA-256 against the vendor's published value. For
  Flutter, take the official `flutter_linux_<version>-stable.tar.xz` from
  `https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/`, with its hash
  from `releases_linux.json` in the parent `releases/` directory.
- pnpm comes through corepack: `corepack pnpm <args>`.

## Git, network and deploy safety

- `git` is read-only for you: `status`/`diff`/`log` work, `add`/`commit` fail by design. The
  coordinator commits your in-scope changes after your turn, using your `summary` as the message.
- Never push, never open PRs, never merge. Never use `--no-verify` or otherwise skip hooks.
- Never use `ssh`, `scp` or `rsync` to a remote host, and never deploy. Never call a cloud,
  DNS or Hetzner API. The production server and `flexcalendar.de` DNS are out of bounds.

## Verification

These are the rules for what counts as evidence. They exist because the harness this was copied
from once shipped a `PASS` on a 551-line test runner that had never executed past its first
prerequisite check, with four defects sitting past that point.

- **Execute, don't infer.** Every acceptance criterion that asserts runtime behaviour is either
  *executed* or the run is `BLOCKED`. "Verified by inspection", "the code clearly does X", and a
  green unit suite are not substitutes for running the thing the criterion is about. Only a
  criterion that is genuinely about static structure (a file exists, a script is named X) may be
  satisfied statically, and the report must say so explicitly.
- **New executables get run at least once on their happy path.** Any new script, Make target,
  CLI entry point, job, or package script the requirement adds must complete a real run before
  it passes. A program whose only observed behaviour is its own error path is unverified, no
  matter how well it reads.
- **An environment gap on the requirement's own deliverable is `BLOCKED`.** The environment-gap
  allowance exists so an unrelated suite can't block an unrelated requirement. It is not a way to
  pass a requirement whose deliverable is the thing that couldn't be exercised. When in doubt: if
  fixing the environment could change the verdict, the verdict is `BLOCKED`. (For an implementer,
  "couldn't run it in the sandbox, the reviewer must run X" in `openQuestions` is the honest form.)
- **Prove absence; don't infer it from a failure.** A sandbox denial, a `command not found` from a
  tool that isn't on `PATH`, and a genuinely missing dependency look alike and mean different
  things. Before recording something as absent, check it directly (`ls` the path, run the binary
  by absolute path) and report the command and its real output.
- **A mock that freezes state the code under test mutates is not coverage.** If the code calls a
  mocked API that changes state it also reads (a CalDAV collection, a sync token, a store, a
  cache), the mock must reflect the change — otherwise the test passes regardless of what the
  code does. For each new test, ask what production bug it would actually fail on.
- **Report what you ran, not what you would have run.** `commandsRun` lists the command, its real
  exit code and the observed output. `not_run` is an honest and acceptable result; a row that
  implies an execution that didn't happen is not.

## Documentation

- If behaviour or a technology choice moves away from `docs/00`–`05` or an ADR, the docs change in
  the same branch — but only if they are within your writable paths. Otherwise report the gap in
  `openQuestions`. A new decision needs a new ADR and a human; never change a Pinned `D-*`.
- Review findings for this requirement live in `docs/reviews/<ID>.md`. If your prompt includes one,
  read it first: it is the reviewer's list of what to fix.

## Stopping conditions

- A requirement gets at most **2** fix cycles after the first attempt before it goes back to the
  human, unmerged, with the branch and findings doc left in place.
- Your tool-call budget is finite. If you are unsure you can finish cleanly, stop and report an
  honest `BLOCKED` handoff with what is left, rather than running out mid-task with nothing to
  report.
