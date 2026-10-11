# `spec/ical-fixtures/rrule/` — differential recurrence corpus (E15-R03)

The hard `RRULE`s of [E15-R03](../../../docs/epics/E15-interop-regression.md), one
`.ics` per case, each expanded over one fixed five-year window by **both**
engines. The point is to catch the #1 risk in `CLAUDE.md` (recurrence) with a
test oracle that is stronger than either engine's own reading of RFC 5545:
a disagreement between the engines is a finding, and a finding is resolved by a
written ruling, never by weakening a fixture.

- **One engine per runtime.** `ical.js` 2.2.1 in `server/api` is the API's
  recurrence authority; `sabre/vobject` 4.6.1 in `server/caldav` is what
  SabreDAV uses to answer `calendar-query` time-range filters and to compute
  each stored object's first and last occurrence (`docs/05` risk 2). A stock app
  querying by date range sees `vobject`'s expansion, not `ical.js`'s.
- **No forking.** Where `vobject` is wrong the fix is to correct the stored
  first and last occurrence or to patch it upstream. Where `ical.js` is wrong
  the fix is upstream too — recurrence expansion is never hand-rolled.
- **No real event content.** Every fixture's summary is the fixed neutral string
  `Recurrence case`, every `UID` is a random UUIDv4, and nothing is logged.

## Layout

- `<id>.ics` — one `VEVENT` master, plus `RECURRENCE-ID` overrides where the
  case is about overrides. `DTSTART` carries an IANA `TZID` (with the matching
  `VTIMEZONE` in the same file), `Z`, or `VALUE=DATE` (INV-04).
- `<id>.expected.json` — the golden expectation: the RFC's answer for that
  fixture, not an engine's output.
- [`../RULINGS.md`](../RULINGS.md) — one machine-readable entry per accepted
  engine disagreement, with the RFC 5545 section and the engine that is right.

## The window and the normalisation

Every fixture is expanded over exactly:

```
2026-01-01T00:00:00Z  <=  start  <  2031-01-01T00:00:00Z
```

Never `now`. An engine's output for one fixture is

```json
{ "fixture": "<id>", "occurrences": ["…"], "overrides": [{ "start": "…", "replaces": "…" }] }
```

- a timed occurrence is the **UTC instant of its start**, `YYYYMMDDTHHMMSSZ`;
- an all-day occurrence is its **date**, `YYYYMMDD`;
- an override (`RECURRENCE-ID` `VEVENT`) is reported in `overrides` with the
  start it moved to and the canonical key of the master occurrence it replaced;
  that key is removed from `occurrences`. An override counts when the key it
  replaces falls inside the window, and its own start may lie outside it;
- `occurrences` is sorted ascending, `overrides` by `replaces`;
- **dropped:** durations (`DTEND`/`DURATION`), `SEQUENCE`, `SUMMARY`, and every
  other property — including *which* instance an override replaced beyond its
  key, and any `VTIMEZONE` detail other than the instants it produces. An
  occurrence is only ever a start, never an end.

The normalisation is implemented once per engine —
`server/api/test/recurrence-corpus.mjs` (`icaljs`) and
`server/caldav/tests/RecurrenceCorpus.php` (`vobject`) — and neither reads the
wall clock. Both suites expand the corpus twice and require identical results.

## The fixtures and their sources

26 of the 34 fixtures are RFC 5545 § 3.8.5.3 examples (the RFC's own result
lists are the pattern for each golden); the rest come from § 3.8.5.1 / § 3.8.5.2
/ § 3.8.4.4 and from `docs/05`.

| Fixture | What it exercises | Source |
|---|---|---|
| `daily-count-10` | `FREQ=DAILY` with `COUNT` | RFC 5545 § 3.8.5.3, "Daily for 10 occurrences" |
| `daily-until-inclusive` | `UNTIL` is an inclusive bound | § 3.8.5.3, "Daily until December 24, 1997"; § 3.3.10 |
| `daily-interval-10-count-5` | `INTERVAL` on `DAILY` | § 3.8.5.3, "Every 10 days, 5 occurrences" |
| `hourly-interval-3-until` | sub-daily `FREQ` with `UNTIL` | § 3.8.5.3, "Every 3 hours from 9:00 AM to 5:00 PM on a specific day" |
| `minutely-interval-90-count-4` | `INTERVAL` larger than one unit | § 3.8.5.3, "Every hour and a half for 4 occurrences" — **ruled** |
| `weekly-count-10-tu-th` | `BYDAY` list with `WKST` | § 3.8.5.3, "Weekly on Tuesday and Thursday for five weeks" (`COUNT` form) |
| `weekly-interval-2-wkst-su-count-8` | `INTERVAL=2` weeks | § 3.8.5.3, "Every other week on Tuesday and Thursday, for 8 occurrences" |
| `weekly-interval-2-wkst-mo-count-4` | `WKST` changes the phase | § 3.8.5.3, "An example where the days generated makes a difference because of WKST" (`WKST=MO`) |
| `weekly-interval-2-wkst-su-count-4` | the same rule with `WKST=SU` | § 3.8.5.3, same example, "changing only WKST from MO to SU" |
| `monthly-first-friday-count-10` | ordinal `BYDAY` `1FR` | § 3.8.5.3, "Monthly on the first Friday for 10 occurrences" |
| `monthly-first-monday-count-6` | ordinal `BYDAY` `1MO` | § 3.8.5.3 pattern (epic: ordinal `BYDAY`) |
| `monthly-second-tuesday-count-8` | ordinal `BYDAY` `2TU` | § 3.8.5.3 pattern (epic: ordinal `BYDAY`) |
| `monthly-last-friday-count-6` | ordinal `BYDAY` `-1FR` | § 3.8.5.3 pattern (epic: ordinal `BYDAY`) |
| `monthly-second-to-last-weekday-count-6` | `BYSETPOS=-2` | § 3.8.5.3, "The second-to-last weekday of the month" |
| `monthly-third-tu-we-th-count-3` | `BYSETPOS=3` over a `BYDAY` list | § 3.8.5.3, "The third instance into the month of one of Tuesday, Wednesday, or Thursday" |
| `monthly-first-and-last-sunday-interval-2-count-10` | `BYSETPOS` `1,-1` with `INTERVAL=2` | § 3.8.5.3, "Every other month on the first and last Sunday of the month for 10 occurrences" |
| `monthly-bymonthday-minus-1-count-12` | `BYMONTHDAY=-1` | § 3.8.5.3 pattern (epic: `BYMONTHDAY=-1`) |
| `monthly-bymonthday-15-30-count-5` | an invalid date is skipped and not counted | § 3.8.5.3, "An example where an invalid date (i.e., February 30) is ignored" |
| `monthly-tuesday-every-other-month-count-10` | `BYDAY` with `INTERVAL=2` months | § 3.8.5.3, "Every Tuesday, every other month" |
| `monthly-first-saturday-after-first-sunday-count-6` | `BYDAY` + `BYMONTHDAY` filter | § 3.8.5.3, "The first Saturday that follows the first Sunday of the month" |
| `yearly-byweekno-20-monday-count-5` | `FREQ=YEARLY;BYWEEKNO` | § 3.8.5.3, "Monday of week number 20" — **ruled** |
| `yearly-election-day-count-2` | `INTERVAL=4` + `BYMONTH` + `BYDAY` + `BYMONTHDAY` | § 3.8.5.3, "Every 4 years, the first Tuesday after a Monday in November" |
| `yearly-byyearday-interval-3-count-6` | `BYYEARDAY` | § 3.8.5.3, "Every third year on the 1st, 100th, and 200th day" |
| `yearly-thursdays-in-march-count-10` | `BYMONTH` + `BYDAY` | § 3.8.5.3, "Every Thursday in March" |
| `yearly-leap-day-all-day` | 29 February in a non-leap year is skipped, all-day normalisation | § 3.8.5.3 note ("invalid date … MUST be ignored") — **ruled** |
| `all-day-monthly-last-day` | `VALUE=DATE` with `BYMONTHDAY=-1` | INV-04 / § 3.8.5.3 pattern |
| `until-utc-local-day-boundary` | `UNTIL` in UTC against a zoned `DTSTART`, on the `Europe/Berlin` local day boundary | § 3.3.10 / § 3.8.5.3 (epic) |
| `until-utc-across-dst` | the same, across the 2026-03-29 `Europe/Berlin` DST change | § 3.3.10 / § 3.8.5.3 (epic) |
| `count-with-exdate` | `COUNT` counts the `EXDATE`d instance | § 3.8.5.1 / § 3.3.10 (epic) |
| `overrides-moved-recurrence-id` | an override that moves an instance | § 3.8.4.4 (epic: overrides) |
| `overrides-exdate-and-moved` | a cancelled instance and a moved instance in one master | § 3.8.4.4 / § 3.8.5.1 (epic: overrides) |
| `docs-05-second-tuesday-except-fifth-wednesday` | the "every second Tuesday except…" example | `docs/05` § High risk 2 |
| `weekly-with-rdate` | `RDATE` and `RRULE` define the union | § 3.8.5.2 — **ruled** |
| `weekly-count-10-tu-th-new-york` | the same weekly rule in the RFC's own zone, resolved through an inline `VTIMEZONE` | § 3.8.5.3, "Weekly on Tuesday and Thursday for five weeks" |

### How the goldens were derived

- The RFC's examples are anchored in 1997–1999 and the window is fixed at
  2026–2031, so no example's result list can be copied verbatim. Each fixture is
  re-anchored into the window with a `DTSTART` that satisfies its own rule, the
  RFC's `COUNT`/`UNTIL` bound is kept wherever it kept one, and the golden lists
  the in-window instances of the RFC's stated pattern.
- Calendar facts (which weekday a date is, which weeks have five Wednesdays,
  which Monday is ISO week 20) were checked with `date(1)`, independent of both
  engines. Goldens were written before the engines were run, and no golden was
  changed to match an engine: where they disagreed, the fixture and the golden
  stayed and a ruling was written.
- `docs-05-second-tuesday-except-fifth-wednesday` reads "every second Tuesday
  except in months with a fifth Wednesday" as `FREQ=MONTHLY;BYDAY=2TU` with an
  `EXDATE` for the second Tuesday of every month that has five Wednesdays (RFC
  5545 has no "except" mechanism, and `EXDATE` is what it provides). The
  occurrence is bounded with `UNTIL=20280101T000000Z` to keep the list
  reviewable; the exception months were enumerated with `date(1)`.
- Two cases were tried and dropped rather than weakened. `FREQ=YEARLY;BYDAY=20MO`
  (RFC 5545 § 3.8.5.3, "Every 20th Monday of the year") is rejected outright by
  `sabre/vobject` 4.6.1 (`InvalidDataException: Invalid part in BYDAY clause:
  20MO`) and mis-expanded by `ical.js`, so one engine cannot produce an output
  to compare at all; `FREQ=YEARLY;BYWEEKNO=20` without `BYDAY` is unsupported by
  `ical.js`. They are reported as follow-ups, not silently normalised.
- DST boundary times (`20260329T023000`, `20261025T023000` in `Europe/Berlin`)
  belong to E15-R02: no fixture `DTSTART` sits on a skipped or repeated local
  time.

## Running it

```sh
cd server/api    && node --test test/recurrence-corpus.test.mjs   # ical.js
cd server/caldav && php tests/corpus-cli.php [<directory>]        # sabre/vobject
make verify-corpus                                                # diffs both, applies RULINGS.md
```

`CALFLEX_CORPUS_OUT=<directory>` makes either component suite write its
normalised output as `<id>.json`; that is how `corpus-compare.mjs` collects the
two sides. `make verify-server-api` and `make verify-server-caldav` run the
golden checks inside each component's own gate, so a dependency bump in either
engine fails there first.
