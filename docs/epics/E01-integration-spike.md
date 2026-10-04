# E01 — Phase 0 integration spike

| | |
|---|---|
| Phase | 0, in parallel with Phases 1–3. Must reach M0 before Phase 4 starts (ADR 0003) |
| Status | Ready |
| Executor | `human` (agents prepare scripts and checklists) |
| Depends on | — |
| Spec | `03-native-calendar-integration.md` § Validate Early, `04` Phase 0, ADR 0001 (validates Shared mode) |

## Goal

Prove that a plain CalDAV server round-trips events through Apple Calendar and, via DAVx⁵, through Samsung and Google Calendar, before any product code depends on that working. CLAUDE.md: *do not skip*.

## Out of scope

Our own apps, auth beyond Radicale's htpasswd, Private mode.

## Requirements

### E01-R01 · Spike infrastructure as code   `agent`
The repo MUST have `infra/spike/`, which deploys Radicale behind Caddy with automatic Let's Encrypt on a public hostname with one command.
- Accept: `docker compose -f infra/spike/compose.yaml up` on a fresh VPS serves `https://<host>/.well-known/caldav` → 301/308 to the principal, with a valid public certificate. README lists the DNS and firewall steps (443 open).
- Notes: Radicale's `rights` set to `owner_only`, plus one extra `shared` collection readable and writable by two users, to try out sharing.

### E01-R02 · Seed script   `agent`
`infra/spike/seed.sh` MUST create two users and a calendar, and `PUT` four fixture events with `curl`: a timed event, an all-day event, a weekly `RRULE` with one `EXDATE`, and an event with a `VALARM` and an `X-CALFLEX-TEST` property.
- Accept: re-running is idempotent; fixtures live in `spec/ical-fixtures/spike/` and become the seed of the E15 corpus.

### E01-R03 · Device verification protocol   `agent`
`docs/verification/phase0-checklist.md` MUST list every manual step and observation: account add, discovery URL used, first-sync time, create/edit/delete in each direction, recurrence exception edit, alarm fired, `X-` property survival, all-day rendering, TLS behaviour.
- Accept: each step has an expected result and a blank for what was observed.

### E01-R04 · Execute on iPhone   `human`
Add the account through Settings → Calendar → Accounts on a real iPhone (current iOS), and run the checklist.

### E01-R05 · Execute on Android via DAVx⁵   `human`
The same checklist on a Samsung device (Samsung Calendar) and a Pixel (Google Calendar), both with DAVx⁵.

### E01-R06 · Quirks log and go/no-go   `human`
Commit `docs/verification/phase0-<date>.md` with screenshots, observed quirks and a go/no-go decision. Record every quirk that affects a later epic as a note on that requirement.
- Accept: screenshots show the same event in Apple Calendar, in Samsung or Google Calendar, and in the Radicale file (M0).
