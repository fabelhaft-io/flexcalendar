# Implementation loop — queue and follow-ups

The state of the orchestrator loop (`.agents/skills/orchestrate/`): what runs next, the review findings that belong to a later requirement, and the questions waiting for the owner. Update it on the requirement branch whenever a review changes it. The epic Status cells and the PR list stay the source of truth for what is Done.

## Queue

As of 2026-10-11. **Requirements are built on top of each other** (owner's decision of 2026-10-10: assume every PR merges). A branch is cut from the branch it depends on, its PR targets that branch, and main is merged forward into the stack (a `chore(<ID>): merge main (<ID>)` commit, never a force-push) after each merge. A requirement still starts only once every `Deps` entry is Done or has a branch in the stack. `make next-ready` applies that rule to the IDs named in this queue and stops the loop when three reviewed PRs are waiting for the owner's merge; it cannot read the prose of the items below, so read them.

**Merging (owner's decision of 2026-10-11):** the orchestrator merges its own PR when the gate in `SKILL.md` § Merging holds; `agent+review` PRs and PRs that change the loop's own rules wait for the owner. This amends the stacking above: stack only on a PR the gate holds back, and cut everything else from `main` once its dependency has merged.

1. **E04 and E03** Phase 1 requirements, alternating as their Deps allow: E04-R01 and E04-R02 (Done, PRs #38 and #41, 2026-10-09), E04-R03 (Done, PR #44, 2026-10-09), E04-R04 (Done, PR #46, 2026-10-10), E03-R01 (Done, PR #45, 2026-10-10), E03-R09 (Done, PR #47, 2026-10-10), E04-R05 (Done, PR #48, 2026-10-10), E04-R06 (Done, PR #49, 2026-10-11), E03-R10 (Done, PR #50, 2026-10-11), E05-R01 (`agent+review`, Done, PR #51, 2026-10-11), E05-R02 (Done, PR #53, 2026-10-11), E03-R02 (Done, PR #52, 2026-10-11) and E03-R08 (`agent+review`, Done, PR #54, 2026-10-11). The Phase 1 requirements of E03 and E04 are all Done.
2. **E05**: R01 (`agent+review`), R02, R10 (the error model, PR #66), R03 (the calendars API, PR #73), R04 (event CRUD, PR #75) and R08 (the delta endpoint, PR #77) are Done, 2026-10-11, R09 (time zones, PR #79) and R05 (occurrences, PR #81) are Done, 2026-10-12. Nothing of E05 is left in Phase 1: R07 waits for E13-R02 (Phase 3) and R06 for R07 (Phase 4). The DST table (E15-R02, PR #72) and the differential recurrence tests (E15-R03, PR #65) are Done and run through the API's expander (`test/occurrences-dst.test.mjs`, `test/occurrences-corpus.test.mjs`), and the owner ruled on RFC 5545 § 3.3.10 on 2026-10-12 (`docs/02` § Recurrence: kept, counted, at the offset before the gap); the table's eight `daily-skipped` cases stay `todo` until the data change in `follow-ups/from-E15-R02.md` lands; unbounded rules and window edges are covered by the expander's own tests, and new shared-corpus files for them remain a follow-up (`from-E15-R03.md`).
3. **E08**: R02, R03, R04, R05, R07, R08, and R10 (Zitadel's database role: not urgent, but its step 1, an ADR the owner accepts, comes before R02). Staging checks by the coordinator (D-20).
4. **E15**: R03 (PR #65), R01 (round-trip corpus, PR #71) and R02 (DST table, PR #72) are Done, 2026-10-11. R04 and R05 wait for Phase 4.

## Follow-ups waiting for their requirement

One file per source in [`follow-ups/`](follow-ups/): `from-<ID>.md` holds what that requirement's review found for later ones, `epic-<E>.md` and the topic files the rest. A requirement's PASS adds its own file on its branch, a new path that conflicts with nothing. **Only the reconcile `doc:` PR edits an existing line**: it removes what a merge resolved and deletes a file once it is empty. `make next-ready` counts the lines in all of them that name a requirement.

- **Done 2026-10-11:** the ruleset "my main my rules" (2026-10-06) no longer existed. Its replacement, "main: PR with one required check", requires a PR and **"Verify required"** (E02-R06; GitHub Actions app only), allows squash merges only, blocks force-push and deletion, and asks for no approval: GitHub does not let the owner approve their own PR, and the PRs are opened with the owner's login. The repository admin role may bypass on a PR. Auto-merge and "Update branch" are on; the orchestrator merges its own `agent` PRs through the gate in `SKILL.md` § Merging, and the owner merges or arms auto-merge on the rest, an `agent+review` PR only after reviewing it (a label-gated "Human approval" check was tried on the same day and dropped). Commits are unsigned.

## Open with the owner

Nothing is open as of 2026-10-12. That day the owner ruled on RFC 5545 § 3.3.10 (`docs/02` § Recurrence) and on free-text values on Private calendars (ADR 0001, amended; E03-R11).
