# Contributing

This file records the conventions every change in this repo follows: branch
naming ([Branch naming](#branch-naming)), commit style ([Commit
style](#commit-style)), the agent working agreement from
[`docs/06-implementation-backlog.md`](docs/06-implementation-backlog.md) ([The
`06` agent working agreement](#the-06-agent-working-agreement)), and how to
add an architecture decision record ([Adding an ADR](#adding-an-adr)).

**The docs are the spec.** Read [`docs/00-overview.md`](docs/00-overview.md)
through
[`docs/05-risks-and-open-questions.md`](docs/05-risks-and-open-questions.md)
and the records in [`docs/adr/`](docs/adr/) before a non-trivial change.
Implementation work is driven by
[`docs/06-implementation-backlog.md`](docs/06-implementation-backlog.md)
(working agreement, `D-*` decisions, `INV-*` invariants) and the epics in
[`docs/epics/`](docs/epics/). Where this file and the docs disagree, the docs
win — fix this file.

## Branch naming

Each epic in [`docs/epics/`](docs/epics/) is split into requirements named
`E<nn>-R<nn>` (for example `E02-R08`); an epic holds several of them.

- **One requirement per branch.** Cut it from `main`:

  ```text
  feat/E05-R03-event-crud
  ```

  i.e. `feat/<REQUIREMENT-ID>-<slug>`, where `<slug>` is a short kebab-case
  description. The example is the one in `docs/06` § Agent working agreement,
  rule 2.
- **PRs target `main`** and name the requirement ID in the title, for example
  `E05-R03: Event CRUD with ETag preconditions`. Keep one requirement per PR
  where practical (rule 2 again); a PR that quietly fixes a second thing is
  not one.
- **Fix runs stay on the same branch.** The agent harness creates the branch
  in a worktree at `../calendar-flex-agent-<ID>` and reuses it, merged forward
  from `main`, for every later run of that requirement — review findings are
  not moved to a `fix/...` branch. The harness never pushes, opens a PR or
  merges; see [`agent-team/README.md`](agent-team/README.md).
- **Who opens and merges a PR.** The reviewer records the findings in
  [`docs/reviews/<ID>.md`](docs/reviews/) on the branch. A `BLOCKED` verdict
  goes back to the implementer on that same branch, for at most two fix
  cycles; after a `PASS` the reviewer pushes the branch and opens the PR.
  **Only a human merges**, and an `agent+review` PR additionally needs human
  approval (rule 7).

## Commit style

```text
E05-R03: apply recurring-event intents with ical.js

The API now applies "this occurrence", "this and following" and "all"
intents to the iCalendar object instead of letting the client rewrite
RRULE/EXDATE, per docs/02 § Recurrence: one engine, on the server, and
D-07 for Private calendars.

Verified: corepack pnpm -C server/api test and lint both exit 0;
12 tests pass.

Agent-Run: implementer
Agent-Run-Number: 1
Agent-Model: <provider>/<model-id>
Agent-Status: DONE
```

- **Subject**: `E<nn>-R<nn>: <summary>` — the requirement ID first, so
  `git log --oneline` is greppable by requirement (`E02-R01: repository
  layout` is an existing example). Lowercase unless the summary starts with a
  proper noun, imperative, no trailing period, 72 characters or fewer.
- **Changes that belong to no requirement** (repo-wide chores, doc-only edits)
  take a short lowercase type prefix instead of an ID: `docs:`, `chore:`,
  `build:`, `ci:`. Existing example:
  `docs: the project licence is Apache-2.0`.
- **Body**: wrapped at 72 columns, saying what changed and why, which spec
  docs, `D-*` or `INV-*` the change follows, and what was actually verified
  (with the commands and their results). Keep it honest: a check you did not
  run is not claimed. A one-line commit is fine for an obvious change; the
  body is required when the reason is not self-evident.
- **Footers**: after a blank line, `Key: value` — `Closes: #<pr-or-issue>`,
  `Co-Authored-By: Name <email>` when someone else co-authored. Signed-off-by
  is not required. Never write event content (`SUMMARY`, `DESCRIPTION`,
  `LOCATION`, attendees, envelope bytes) into a commit message: commit
  messages end up in logs and in review tooling. This is the "no event content
  in logs" rule in
  [`agent-team/src/prompts/guardrails.md`](agent-team/src/prompts/guardrails.md),
  made checkable for the API by [E05-R10](docs/epics/E05-api-core.md).
- **Agent turns** are committed by the harness, never by the agent: an agent's
  shell cannot `git commit`. The harness takes the implementer's summary
  verbatim as the body and appends `Agent-Run`, `Agent-Run-Number`,
  `Agent-Model` and `Agent-Status` trailers, with a subject of
  `E<nn>-R<nn>: implementer run <n> (<STATUS>)`. A commit made after a review
  reads like `E<nn>-R<nn>: review <n> (<VERDICT>)`, for example
  `E02-R02: review 1 (BLOCKED)`.
- **Never bypass the checks**: no `--no-verify` (or `-n`), no skipped or
  amended-out hooks, no `git push --force` to a shared branch. If a hook
  fails, fix the cause.

## The `06` agent working agreement

These eight rules are
[`docs/06-implementation-backlog.md`](docs/06-implementation-backlog.md) §
Agent working agreement, and they bind human contributors and agents alike.
The list is quoted; the notes in italics say how it applies in this repo.

1. **Pick up only `Ready` work.** A requirement is Ready when every `Deps`
   entry is Done and every decision it cites under `D-*` is `Pinned`. When
   something you need is not Pinned, stop and escalate. Don't guess: CLAUDE.md
   says the open questions change the architecture. *The `D-*` table with its
   statuses is at the top of `docs/06`. A Pinned decision is never edited
   silently — changing one takes a human, and, where it touches an ADR, a new
   ADR or an amendment.*
2. **One requirement per PR** where practical. Branch
   `feat/E05-R03-event-crud`, and name the requirement ID in the PR title.
   *See [Branch naming](#branch-naming).*
3. **Every acceptance criterion needs a test** or a recorded manual check.
   `human` checks go into `docs/verification/` as dated notes with
   screenshots. *A requirement tagged `human` in `docs/epics/` is never marked
   Done by an agent; the agent may prepare the material.*
4. **`make verify` must pass** (defined in E02-R04). It runs lint, type
   checks, unit tests, the invariant checks and the iCalendar round-trip
   corpus. *The round-trip and invariant parts need the local stack (`make
   dev`), so those run outside the agent sandbox and are listed as open
   questions for the reviewer when anything has to be deferred.*
5. **Invariants (below) are hard gates.** A PR that breaks one is rejected,
   whatever it passes. *The `INV-*` table is in `docs/06`; E02-R05 turns the
   automatable ones into CI checks.*
6. **Update the docs in the same PR** when behaviour or a technology choice
   moves away from `00`–`05` or an ADR. A new decision gets a new ADR, using
   `adr/0000-template.md`. *See [Adding an ADR](#adding-an-adr).*
7. **Security-sensitive work is `agent+review`.** Never merge it yourself. *A
   requirement tagged `agent+review` in `docs/epics/` — auth, ACLs, crypto,
   escrow, anything touching the privacy claim — is approved by a human before
   merge. Report every security-relevant choice you made so the reviewer can
   check it.*
8. **Never commit secrets**: signing certs, APNs keys, HSM credentials, SMTP
   credentials, Firebase service accounts. Everything is read from the
   environment, and `.env.example` documents the variable names. *`.env` files
   and key material are refused by the harness and by review; a new
   environment variable gets a line in the relevant `.env.example`.*

## Adding an ADR

An ADR records a decision *and the alternatives it rejected*. The numbered
docs (`docs/00`–`05`) describe the system that results; when a decision
changes the system, both change in the same PR (rule 6).

1. **Check it is not already decided.** Look in [`docs/adr/`](docs/adr/) and
   at the `D-*` table in `docs/06-implementation-backlog.md`. If a Pinned
   decision already answers it, there is nothing to add. Changing a Pinned
   `D-*` is a human call, and where it touches an ADR it needs an amendment to
   that ADR or a new ADR that supersedes it.
2. **Copy the template**
   [`docs/adr/0000-template.md`](docs/adr/0000-template.md) to
   `docs/adr/NNNN-kebab-title.md`, with the next free number in `docs/adr/`
   and a short kebab-case title. ADR numbers are separate from the
   `docs/NN-topic.md` sequence.
3. **Fill it in** — `Status` (`Proposed`; a human sets `Accepted`, or a later
   ADR supersedes it), `Date`, `Relates to`, then `Context` (the requirement,
   the constraints, what is hard and what is negotiable, and how it touches
   the CalDAV-is-source-of-truth rule or stock-app round-tripping),
   `Decision`, `Consequences` (what becomes easier or harder, what we now
   have to build, test or disclose, and the effect on the phases, the Phase 0
   spike and the risks in `docs/05`), and `Alternatives considered` — one
   line per rejected option saying why. Delete the template's HTML comment
   and any optional section you don't need.
4. **Index it.** Add a one-line entry under "Decision Records" in
   [`docs/00-overview.md`](docs/00-overview.md), with the same one-line
   summary and its status.
5. **Update the docs it affects** (`docs/00`–`05`) in the same PR, and say in
   the PR which ones changed.
6. **Supersede, don't rewrite.** To change an accepted decision, write the new
   ADR and set the old one's status to the template's `Superseded by` form,
   pointing at the new record — an accepted ADR's own text is never edited in
   place.
