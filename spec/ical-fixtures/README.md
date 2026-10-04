# `spec/ical-fixtures/` — iCalendar round-trip corpus

**Owning epic:** [E15 — Interop and regression test program](../../docs/epics/E15-interop-regression.md), R01.

- **What belongs here:** real `.ics` objects captured from each client, one
  directory per source — `apple/`, `samsung/`, `google-davx5/`,
  `android-adapter/`, `thunderbird/`, `ours/`. The E01 spike seed
  ([`infra/spike/`](../../infra/README.md)) starts this corpus.
- Every fixture is read and written back through the API's `ical.js` path and
  the adapter's `iCal4j` path; semantic equality and full property/parameter
  preservation are asserted (INV-02). Any engine disagreement is resolved by a
  written ruling in `RULINGS.md` citing the RFC section.
- Fixtures are test data only: no product code, no secrets and no real user
  data.
