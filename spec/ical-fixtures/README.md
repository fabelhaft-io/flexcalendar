# `spec/ical-fixtures/` — iCalendar round-trip corpus

**Owning epic:** [E15 — Interop and regression test program](../../docs/epics/E15-interop-regression.md), R01.

- **What belongs here:** real `.ics` objects captured from each client, one
  directory per source — `apple/`, `samsung/`, `google-davx5/`,
  `android-adapter/`, `thunderbird/`, `ours/`, plus `synthetic/` for
  hand-written objects that imitate stock apps. The corpus starts from
  `ours/` and `synthetic/` (E15-R01); captured objects arrive from Phase 4.
- Every fixture is read and written back through the API's `ical.js` path and
  the adapter's `iCal4j` path; semantic equality and full property/parameter
  preservation are asserted (INV-02). Any engine disagreement is resolved by a
  written ruling in `RULINGS.md` citing the RFC section.
- Fixtures are test data only: no product code, no secrets and no real user
  data.

## `rrule/` — differential recurrence corpus (E15-R03)

`rrule/` is the recurrence half of this tree, and it is owned by E15-R03 rather
than E15-R01. It holds one `.ics` per hard `RRULE` and is expanded over one fixed
five-year window by both engines — `ical.js` in `server/api` and
`sabre/vobject` in `server/caldav` — so a disagreement between them is caught
and must be resolved by a ruling, never by dropping or weakening a fixture.
`rrule/README.md` documents the fixtures, their RFC sources, the window and the
normalisation; `make verify-corpus` runs the comparison.

`RULINGS.md` is the single source of truth for every accepted disagreement. Its
machine-readable block is read by both component suites and by
`infra/scripts/corpus-compare.mjs`: a disagreement without a ruling fails the
corpus gate, a ruling that no longer describes a real disagreement fails too,
and an engine that is *known* wrong is pinned to exactly that deviation (so
fixing it fails until the ruling is updated). A fixture here never carries real
user data, and never changes to make two engines agree.
