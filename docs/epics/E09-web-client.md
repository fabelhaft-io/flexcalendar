# E09 — Web client

| | |
|---|---|
| Phase | 5 (ADR 0003) |
| Status | Blocked on E05 |
| Executor | `agent` |
| Depends on | E05, E06, E07, E12 (TS library), E13, E02-R07 (generated TS client) |
| Spec | `02` § Web client, `04` Phase 5 |

## Goal

The web app where most new users will start. After M3, someone can run their whole calendar from it. It includes Private mode through E13's web parts and the TS crypto library (E12). Keys arrive by device linking from a phone or by the recovery code (D-17).

## Requirements

### E09-R01 · Scaffold   `agent`
React + TypeScript + Vite in `apps/web`, TanStack Query for server state, the generated API client, and OIDC PKCE login against the D-03 IdP.
- Accept: `make verify-web` runs lint, type check, Vitest and Playwright smoke tests; the login/logout round trip passes against the local stack.

### E09-R02 · Calendar grid   `agent`
FullCalendar with month, week, day and list views, fed **only** from the occurrences endpoint (E05-R05). The FullCalendar rrule plugin MUST NOT be used as the authority (INV-05).
- Accept: Playwright tests render the E15 fixtures correctly, including all-day, multi-day, cross-DST and override instances.

### E09-R03 · Event editor   `agent`
Create, edit and delete events with title, time, all-day toggle, timezone picker (IANA), location, description, alarms and recurrence builder. The builder previews with client-side `rrule` and submits an RRULE string.
- Accept: editing a recurring instance asks "this / this and following / all" and sends an intent (E05-R06), never a hand-built `EXDATE`; the all-day toggle produces `VALUE=DATE`.

### E09-R04 · Live updates   `agent`
Subscribe to E07-R02. On `CalendarChanged`, invalidate the affected TanStack Query keys, and fetch deltas through E05-R08.
- Accept: a change from a second browser shows up within 5 s without a reload.

### E09-R05 · Conflict handling   `agent`
On 412, show the server version next to the user's edit and let the user choose which to keep. Nothing is overwritten silently.
- Accept: a Playwright test with two tabs editing one event.

### E09-R06 · Sharing UI   `agent`
Invite, accept, change roles, remove members, and show pending invites (E06-R01..R02).

### E09-R07 · Devices and onboarding   `agent`
A device credentials page (E06-R04), a `.mobileconfig` download (E06-R05) and the Android page (E06-R08).
- Accept: the credential is shown once with a copy button and never shown again.

### E09-R08 · Mode badge everywhere   `agent`
Every calendar shows its mode (Private, Shared or Published) wherever it's listed or selected (ADR 0001: "the app always tells you which is which").

### E09-R09 · Accessibility   `agent`
WCAG 2.2 AA: keyboard operation of the grid and editor, and screen-reader labels.
- Accept: `axe` in Playwright reports no serious or critical issues.
