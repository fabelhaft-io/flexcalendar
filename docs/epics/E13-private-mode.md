# E13 — Private mode end to end

| | |
|---|---|
| Phase | 3 (R01–R05, R07, R08); 4 (R06); 5 (web parts of R03, R04); R09 before M1 and again before M5, per ADR 0003 |
| Status | Blocked on E05, E10, E12 |
| Executor | `agent+review`; `human` for final verification and copy |
| Depends on | E04-R03..R05, E05-R07, E10, E12; E09 for the web parts |
| Spec | ADR 0001 (all of it), ADR 0003, `04` Phase 3, `05` risks 4 and 7 |

## Goal

Calendars whose content the server cannot read, first in the Android app (M1) and then on iOS and the web (Phase 5), in the same CalDAV store and sync engine as Shared calendars.

## Requirements

### E13-R01 · Create Private calendars   `agent`
From Phase 3 the app creates Private calendars, and the API accepts `private` (E04-R03). Every new calendar gets a CCK at epoch 1 sealed to its owner. In Phase 4, when `shared` is added, creation shows the mode choice with no default, worded as a constraint on who can take part (`04` Phase 4 wording).
- Accept: a new calendar has a CCK at epoch 1 sealed to its owner; from Phase 4 a UI test shows no preselected mode.

### E13-R02 · Sidecar API   `agent`
Endpoints to read envelopes in bulk (by calendar, by `uid` list, by delta) and to write them, stored opaquely in `event_envelopes` with the D-06 hash. The API checks only the envelope header, its size (≤ 64 KiB) and hash agreement with the skeleton.
- Accept: skeleton + envelope commit per D-06 ordering; a crash between the steps leaves the old version readable; orphan rows are garbage-collected after 24 h.

### E13-R03 · Client write path   `agent+review`
Web and mobile build the JSCalendar payload, seal it (E12-R03), and write the skeleton with only the allowed properties, a generic `VALARM` `DESCRIPTION` (D-08) and `X-CALFLEX-ENVELOPE-SHA256`. Recurring edits use the two-step intent (E05-R07).
- Accept: E03-R09 never rejects a write from our clients in the test suite; an "edited occurrence shows the master title" regression test passes.

### E13-R04 · Client read path, cache and search   `agent`
Clients fetch envelopes alongside deltas, open them, and cache the plaintext locally (Drift FTS5 on mobile, and from Phase 5 an in-memory or IndexedDB index on web). Search over Private calendars is client-side only.
- Accept: search finds a Private event offline on mobile; the API has no search endpoint that accepts Private calendar IDs.

### E13-R05 · Membership and epochs   `agent+review`
Adding a member seals the current CCK to their **verified** public key (D-15). Removing a member starts epoch N+1, and all new writes use it. Old epochs stay readable to members who hold them.
- Accept: a removed member's client can't open an event written after the removal; the UI says that the removed member keeps what they already downloaded (ADR 0001 § Rotation).

### E13-R06 · Mode switching (Phase 4)   `agent+review`
- **Shared → Private**: before confirming, list members and devices that will lose access (stock-app device credentials, `full` feeds, members without keys). Warn that the change is **not retroactive** at the point of the switch. On confirmation, a client with the CCK rewrites every event as skeleton + envelope, stripping plaintext from CalDAV, and full feeds are revoked.
- **Private → Shared**: owner confirmation, a warning that members' contributions become readable to us, and a client-side decrypt-and-rewrite.
- **Both**: audit entry and notification to every member (INV-10).
- Accept: integration tests for both directions assert the audit row and notifications, and that no plaintext `SUMMARY` remains in CalDAV after Shared → Private.

### E13-R07 · Invite guard   `agent`
Inviting someone to a Private calendar is refused, or clearly warned about, until they have a key-capable client (a `user_keys` row). A pending member gets the CCK when their keys first appear and the owner's client is online.
- Accept: UI tests for both states.

### E13-R08 · Exit verification script   `agent` + `human`
`scripts/verify-private-blind.sh` creates a Private event with a random marker title through two clients, then greps a Postgres dump (CalDAV objects, sidecar, logs) for the marker.
- Accept: `human` runs it on staging and the marker isn't found (an M1 criterion; re-run for M5 criterion 1).

### E13-R09 · Privacy copy review   `human`
All in-app, store and marketing text about privacy is checked against the ADR 0001 claim table (INV-11). Before M1: the in-app copy (including the recovery-code save screen, E14-R03) and the Play listing. They must not imply an audit, and they must state that losing every device and the recovery code loses the data (ADR 0003). Before M5: everything.
