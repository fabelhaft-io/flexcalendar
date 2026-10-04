# E15 — Interop and regression test program

| | |
|---|---|
| Phase | Cross-cutting: starts with E01 fixtures, grows each phase |
| Status | Ready (R01–R03 once E02 lands) |
| Executor | `agent` for harnesses; `human` for device capture and runs |
| Depends on | E02 |
| Spec | `05` risks 2, 3 and 10, CLAUDE.md § Risks |

## Goal

Recurrence and timezones are the #2 and #3 risks, and stock apps change between OS releases. Agents need a test oracle that is stronger than their own reading of RFC 5545.

## Requirements

### E15-R01 · Round-trip corpus   `agent`
`spec/ical-fixtures/{apple,samsung,google-davx5,android-adapter,thunderbird,ours}/` holds real objects captured from each client. A harness reads each fixture and writes it back through (a) the API's `ical.js` path and (b) the adapter's `iCal4j` path, then asserts semantic equality and that every property and parameter is preserved (INV-02).
- Accept: runs in `make verify`; any lost property fails with a diff.

### E15-R02 · DST matrix   `agent`
A table-driven suite over the zones Europe/Berlin, America/New_York, America/Sao_Paulo, Australia/Sydney, Asia/Kolkata and Pacific/Chatham, for this year's and next year's transition days. It covers: an event at a skipped local time (02:30 on spring-forward), an event at a repeated local time, a daily recurrence across both transitions, all-day events on transition days, and an event viewed from a different zone.
- Accept: the API (E05-R05), mobile (E10-R04), web (E09-R02) and adapter (E11-R05) all run the same table and agree.

### E15-R03 · Differential recurrence testing   `agent`
A corpus of hard `RRULE`s (`BYSETPOS`, ordinal `BYDAY`, `BYMONTHDAY=-1`, `UNTIL` in UTC against a zoned `DTSTART`, `COUNT` with `EXDATE`, the `05` "every second Tuesday except…" example, plus overrides) is expanded by `ical.js` and by `iCal4j` over a 5-year window, and the results are compared.
- Accept: any disagreement fails CI and must be resolved by a written ruling in `spec/ical-fixtures/RULINGS.md` citing the RFC section.

### E15-R04 · Fixture capture tool   `agent`
`scripts/capture-fixtures.sh <account> <calendar> <client-name>` pulls raw objects from staging and sanitises them (replacing emails and names, keeping structure).
- Accept: re-capturing is deterministic; sanitising never removes properties.

### E15-R05 · Device regression protocol   `human`
`docs/verification/device-protocol.md` (drafted by an agent from E01-R03) is run on an iPhone, a Samsung phone and a Pixel, the Android phones with both DAVx⁵ and our adapter once E11 ships. It extends the Phase 0 checklist with: `.mobileconfig` install, Apple "Add Person…", a recurring edit of each scope from each stock app, alarms, attendees and iMIP.
- Accept: run at every milestone and after every major iOS or Android release; results committed with the date, OS versions and app versions; new raw objects fed back into R01.
