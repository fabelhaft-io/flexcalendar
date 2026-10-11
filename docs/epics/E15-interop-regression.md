# E15 — Interop and regression test program

| | |
|---|---|
| Phase | Cross-cutting. Phase 1: R01–R03, the corpus, the DST table and the API-side runners; each later client adds its runner; Phase 4: R04, R05 |
| Status | In progress: R03 ([PR #65](https://github.com/fabelhaft-io/flexcalendar/pull/65)) Done, 2026-10-11; R01 and R02 Ready; R04 and R05 wait for Phase 4 (Shared calendars on staging) |
| Executor | `agent` for harnesses; `human` for device capture and runs |
| Depends on | E02-R04 |
| Spec | `05` risks 2, 3 and 10, CLAUDE.md § Risks |

## Goal

Recurrence and timezones are the #2 and #3 risks, and stock apps change between OS releases. Agents need a test oracle that is stronger than their own reading of RFC 5545.

The Phase 0 spike left no fixtures (E01), so this epic writes its own. Hand-written fixtures come first, and objects captured from real devices are added from Phase 4.

## Requirements

### E15-R01 · Round-trip corpus   `agent`
`spec/ical-fixtures/` MUST hold the corpus, one directory per source:
- `ours/`: objects our own code writes;
- `synthetic/`: hand-written objects that reproduce what stock apps are known to emit. At least:
  - Apple's `X-APPLE-*` properties;
  - Microsoft zone names in `TZID`;
  - `X-` properties and parameters;
  - all-day events, a weekly `RRULE` with an `EXDATE`, overrides with `RECURRENCE-ID`, and a `VALARM`.

  Each fixture's header comment names the source of the behaviour it imitates.
- `apple/`, `samsung/`, `google-davx5/`, `android-adapter/`, `thunderbird/`: captured objects, added from Phase 4 by R04.

A harness reads each fixture and writes it back through the API's `ical.js` read-modify-write path (E05-R04). It asserts semantic equality, and that every property and parameter is preserved (INV-02). The `iCal4j` path of the Android adapter joins the same harness in Phase 6 (E11).
- Accept: the harness runs under `make verify-corpus` (E02-R04); any lost property fails with a diff; it fails on a deliberately lossy round-trip.
- Deps: E02-R04.

### E15-R02 · DST table   `agent`
`spec/ical-fixtures/dst/` MUST hold one table-driven case list with expected results as UTC instants. It covers the zones Europe/Berlin, America/New_York, America/Sao_Paulo, Australia/Sydney, Asia/Kolkata and Pacific/Chatham, on their 2026 and 2027 transition days. The cases are:
- an event at a skipped local time (02:30 on spring-forward);
- an event at a repeated local time;
- a daily recurrence across both transitions;
- all-day events on transition days;
- an event viewed from a different zone.
- Accept: the table and its expected results exist, each expected result cites the RFC 5545 rule it follows, and the API's runner (E05-R05) passes it.
- Notes: each client runs the same table in its own requirement: mobile in E10-R04, web in E09-R02, the adapter in E11-R05. They must all agree with the expected results, not only with each other.

### E15-R03 · Differential recurrence testing   `agent`
A corpus of hard `RRULE`s in `spec/ical-fixtures/rrule/` is expanded over a 5-year window by each engine, and the results are compared. The corpus contains:
- `BYSETPOS`;
- ordinal `BYDAY`;
- `BYMONTHDAY=-1`;
- `UNTIL` in UTC against a zoned `DTSTART`;
- `COUNT` with `EXDATE`;
- the `05` "every second Tuesday except…" example;
- overrides.

The engines:
- Phase 1: `ical.js` (the API) and `sabre/vobject` (the CalDAV service), each run from its own component's test suite.
- Phase 6: `iCal4j`, with the adapter (E11).
- Accept: any disagreement fails `make verify-corpus` and must be resolved by a written ruling in `spec/ical-fixtures/RULINGS.md` citing the RFC section.
- Deps: E02-R04.
- Notes: `vobject` is in the comparison because SabreDAV uses it to answer `calendar-query` time-range filters. Stock apps that query by date range see its expansion, not `ical.js`'s (`02` § CalDAV Server). Where `vobject` is wrong, the fix is to correct the stored first and last occurrence or patch it upstream. We never fork it.

### E15-R04 · Fixture capture tool (Phase 4)   `agent`
`infra/scripts/capture-fixtures.sh <account> <calendar> <client-name>` pulls raw objects from a Shared calendar on staging and sanitises them, replacing emails and names and keeping the structure. The output goes into the matching R01 directory.
- Accept: re-capturing is deterministic; sanitising never removes properties.
- Notes: it reads Shared calendars only; Private calendars hold no content to capture.

### E15-R05 · Device regression protocol (Phase 4)   `human`
An agent drafts `docs/verification/device-protocol.md` from `03` § Validate Early. Every step has an expected result and a blank for what was observed. It covers:
- adding the account, the discovery URL used, and the time of the first sync;
- create, edit and delete in each direction;
- a recurring edit of each scope from each stock app;
- an exception edit, an alarm firing, `X-` property survival, all-day rendering and TLS behaviour;
- `.mobileconfig` install, Apple "Add Person…", attendees and iMIP.

A human runs it against staging on an iPhone (Apple Calendar), a Samsung phone and a Pixel, from M2 on. The Android phones use DAVx⁵, and also our adapter once E11 ships.
- Accept: run at every milestone from M2 on (M1 has no stock-app path) and after every major Android or iOS release. Results are committed with the date, OS versions and app versions. New raw objects go back into R01 through R04. Quirks that affect a requirement are added as a note on it.
