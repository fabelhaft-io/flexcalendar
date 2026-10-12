# Implementation loop — queue and follow-ups

The state of the orchestrator loop (`.agents/skills/orchestrate/`): what runs next, the review findings that belong to a later requirement, and the questions waiting for the owner. Update it on the requirement branch whenever a review changes it. The epic Status cells and the PR list stay the source of truth for what is Done.

## Queue

As of 2026-10-12: the owner's planning toward M1 (ADR 0003: the Android app with Private calendars only). **Requirements are built on top of each other** (owner's decision of 2026-10-10: assume every PR merges). A branch is cut from the branch it depends on, its PR targets that branch, and main is merged forward into the stack (a `chore(<ID>): merge main (<ID>)` commit, never a force-push) after each merge. A requirement still starts only once every `Deps` entry is Done or has a branch in the stack. `make next-ready` applies that rule to the IDs named in this queue and stops the loop when three reviewed PRs are waiting for the owner's merge; it cannot read the prose of the items below, so read them.

**Merging (owner's decision of 2026-10-11):** the orchestrator merges its own PR when the gate in `SKILL.md` § Merging holds; `agent+review` PRs and PRs that change the loop's own rules wait for the owner. This amends the stacking above: stack only on a PR the gate holds back, and cut everything else from `main` once its dependency has merged.

**Done before this queue:** the Phase 1 requirements of E02, E03 (R01, R02, R08, R09, R10), E04 (R01–R06) and E05 (R01–R05, R08–R10, the last two on 2026-10-12, PRs #79 and #81), and E15-R01, R02 and R03 (PRs #71, #72 and #65). The PRs are in each epic's Status cell.

**Not queued (the owner's planning of 2026-10-12):** everything of Phase 4 and later. That is E03's stock-app work, E05's Shared intents, E06's Phase 4 requirements, E07, E10's iOS and DAVx⁵ onboarding, E12's Shamir split, E13's mode switching, and the E15 fixture capture tool and device protocol, which `make next-ready` would otherwise start because it cannot read a phase. Their IDs stay out of the numbered items below on purpose.

The two server fixes in item 1 have no requirement ID: the orchestrator runs each as a follow-up PR (`from-E15-R02.md`, `from-E05-R05.md`), and `make next-ready` does not list them.

1. **Server fixes, ready now:** E03-R12 (the recurrence bound; Private writes of a long daily series fail today), the DST table's § 3.3.10 data change (`follow-ups/from-E15-R02.md`), a `fix(E05-R05)` PR that drops `unsupported[].href` (`follow-ups/from-E05-R05.md`), and E03-R11 (`agent+review`, the `UID` backstop; before E13-R02).
2. **E12**, the start of the critical path: R02 (library check) → R01 (the wire spec, `agent+review`; its review is the longest wait, so start R02 first) → R03 and R04 → R05. R06 follows with E10 (item 5).
3. **E08**: R10 (Zitadel's database role: the evaluation, an ADR the owner accepts, which R02 depends on) → R11 (its implementation) → R02 → R03 → R04 and R05 → R07 and R08. Staging checks by the coordinator (D-20). The owner's own part of the path is E08-R01: the staging Primary IP and its DNS records, and the two backup buckets.
4. **E10** (Android only; iOS waits for Phase 5): R01 → R02 → R04 and R03 → R05 and R07.
5. **Private mode end to end:** E13-R02 → E05-R07 → E13-R01, E13-R03, E13-R04, E06-R02, E06-R09 and E12-R06 → E13-R05 and E13-R07 → E10-R06 and E10-R10 → E14-R03, E14-R08, E14-R09 and E14-R06 → E13-R08 on staging → E10-R11 and E13-R09 (`human`, M1).

## Follow-ups waiting for their requirement

One file per source in [`follow-ups/`](follow-ups/): `from-<ID>.md` holds what that requirement's review found for later ones, `epic-<E>.md` and the topic files the rest. A requirement's PASS adds its own file on its branch, a new path that conflicts with nothing. **Only the reconcile `doc:` PR edits an existing line**: it removes what a merge resolved and deletes a file once it is empty. `make next-ready` counts the lines in all of them that name a requirement.

- **Done 2026-10-11:** the ruleset "my main my rules" (2026-10-06) no longer existed. Its replacement, "main: PR with one required check", requires a PR and **"Verify required"** (E02-R06; GitHub Actions app only), allows squash merges only, blocks force-push and deletion, and asks for no approval: GitHub does not let the owner approve their own PR, and the PRs are opened with the owner's login. The repository admin role may bypass on a PR. Auto-merge and "Update branch" are on; the orchestrator merges its own `agent` PRs through the gate in `SKILL.md` § Merging, and the owner merges or arms auto-merge on the rest, an `agent+review` PR only after reviewing it (a label-gated "Human approval" check was tried on the same day and dropped). Commits are unsigned.

## Open with the owner

Nothing is open as of 2026-10-12. That day the owner ruled on RFC 5545 § 3.3.10 (`docs/02` § Recurrence) and on free-text values on Private calendars (ADR 0001, amended; E03-R11).
