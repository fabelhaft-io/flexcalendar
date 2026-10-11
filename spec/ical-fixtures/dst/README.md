# `spec/ical-fixtures/dst/` — the DST table (E15-R02)

The table-driven case list of [E15-R02](../../../docs/epics/E15-interop-regression.md): one
engine-neutral JSON file whose expected results are **UTC instants**, one citation of the
RFC 5545 rule behind each of them. It exists because recurrence and timezones are risks 2 and
3 in `docs/05`, and a client that gets a DST day wrong is wrong in a way no unit test of its
own would catch.

- `cases.json` — the table. No ICS, no engine name, no event text.
- `../../../infra/scripts/dst-table.mjs` — the validator and the independent oracle.
- `../../../infra/scripts/dst-table.test.mjs` — the gate's own tests.
- `../../../infra/scripts/verify/corpus/E15-R02.json` — the registration `make verify-corpus`
  reads.

**Runners are not here.** E15-R02 owns the table and its expected results; the API's runner is
E05-R05's, and the same table is run by the mobile app in E10-R04, the web app in E09-R02 and
the Android adapter in E11-R05. Every one of them must agree with `expected`, not merely with
the others.

## The table

One case is:

```json
{
  "id": "berlin-2026-spring-skipped",
  "zone": "Europe/Berlin",
  "kind": "skipped",
  "input": { "dtstart": "20260329T023000" },
  "expected": ["20260329T013000Z"],
  "rfc": { "section": "RFC 5545 § 3.3.5", "rule": "…one line…" }
}
```

- **`zone`** — the IANA zone of `DTSTART`/`DTEND`. A runner writes
  `DTSTART;TZID=<zone>:<dtstart>`; a timed case is never floating (INV-04). A test-data quirk
  worth knowing: this directory carries no `VTIMEZONE`, because the table is defined by IANA
  zone names and the expected instants, not by a particular zone definition. A runner that
  needs an inline `VTIMEZONE` (an engine without a zone database, like `ical.js`) generates it
  from the zone name; the table does not pin offsets in a form an engine can disagree with.
- **`input.dtstart`** — a local wall-clock reading, `YYYYMMDDTHHMMSS`.
- **`input.date`** — an all-day `DATE`, `YYYYMMDD`; its `DTEND` is the next day.
- **`input.rrule`** — `{"freq": "DAILY", "count": n}`, i.e. `RRULE:FREQ=DAILY;COUNT=n`. Nothing
  else is used: the hard `RRULE`s live in `../rrule/`.
- **`input.viewZone`** — present on `all-day` cases (the zone whose midnights define the
  instants) and on `view-zone` cases (the zone the event is viewed from).
- **`expected`** — UTC instants, `YYYYMMDDTHHMMSSZ`, the format the `rrule/` goldens use. A
  daily case lists the instances in order, the nonexistent one excluded (see below). An
  all-day case lists exactly `[start, exclusive end]`, the two instants the `DATE` day covers
  **in its viewing zone**.
- **`ruling` and `alternative`** — on every `daily-skipped` case, and on nothing else. `ruling`
  is always `"pending"`: that kind's value is contested (see below), and `alternative` lists the
  instants the other reading gives, one per `expected` instant. A runner takes `expected` **or**
  `alternative` for such a case, reports which one it matched, and accepts nothing else; a
  `daily-skipped` result is never called green until the project rules.
- **`expectedLocal`** — on every `view-zone` case, and on nothing else: the wall clock
  (`YYYYMMDDTHHMMSS`) the viewer in `input.viewZone` must show for the instant. A UTC instant
  alone cannot fail a viewer that renders the event in the wrong zone; this can.
- **`rfc`** — `section` is the RFC 5545 section the values follow, `rule` a one-line paraphrase
  of it. Both are part of the table: a client runner that disagrees with a value should be able
  to say which rule the table claims. A `daily-skipped` case's `rule` quotes both sentences of
  § 3.3.10, because the table's reading follows the first.

### The kinds

| `kind` | What the case is | The rule it follows |
|---|---|---|
| `skipped` | `DTSTART` at a local time that does not exist on the spring-forward day | § 3.3.5 form 3: read with the UTC offset **before** the gap |
| `repeated` | `DTSTART` at a local time that occurs twice on the fall-back day | § 3.3.5 form 3: the **first** occurrence |
| `daily-existing` | `FREQ=DAILY` at a time that exists every day, across a transition | § 3.8.5.3: every instance keeps the local time of `DTSTART`, so the UTC instants shift with the offset |
| `daily-skipped` | `FREQ=DAILY` at the skipped local time, across the spring transition | § 3.3.10: the nonexistent instance is ignored and does **not** spend one of `COUNT` — **contested**, so the case carries `ruling: pending` and the other reading in `alternative` |
| `all-day` | a `DATE` day on a transition day, in a viewing zone | § 3.8.2.2 with § 3.3.4: one calendar day, exclusive end, instants only in the viewing zone |
| `view-zone` | a `TZID`-timed event on a day **one** of the two zones switches | § 3.3.5 form 3: the instant belongs to `zone` and does not move with the viewer — `expected` is the instant, `expectedLocal` the wall clock the viewer must show |
| `control` | a zone that never transitions, on a date a client might wrongly shift it | § 3.3.5 form 3: one offset all year, one instant |

`all-day` cases appear twice per transition day where it matters: once in the zone's own view
and once `-viewed` from a second zone, because an all-day event's instants are the viewing
zone's midnights (that is the whole "23, 24 or 25 hours" point, and the reason `docs/05` and
INV-04 insist an all-day event is not a midnight-to-midnight date-time).

## The zones, the years and the transition days

`Europe/Berlin`, `America/New_York`, `America/Sao_Paulo`, `Australia/Sydney`, `Asia/Kolkata` and
`Pacific/Chatham`, on their 2026 and 2027 transition days. The dates were read from the IANA
time zone database with

```sh
zdump -v -c 2026,2029 Europe/Berlin   # one command per zone
```

and are declared in `infra/scripts/dst-table.mjs` (`TRANSITIONS`), which rescans the same years
through ICU on every run and fails if a declared date no longer matches the zone database.

| Zone | Offset | 2026 spring / fall | 2027 spring / fall | Local transition |
|---|---|---|---|---|
| `Europe/Berlin` | +01:00 / +02:00 | 29 Mar / 25 Oct | 28 Mar / 31 Oct | 02:00 → 03:00, 03:00 → 02:00 |
| `America/New_York` | −05:00 / −04:00 | 8 Mar / 1 Nov | 14 Mar / 7 Nov | 02:00 → 03:00, 02:00 → 01:00 |
| `Australia/Sydney` | +10:00 / +11:00 | 4 Oct / 5 Apr | 3 Oct / 4 Apr | 02:00 → 03:00, 03:00 → 02:00 |
| `Pacific/Chatham` | +12:45 / +13:45 | 27 Sep / 5 Apr | 26 Sep / 4 Apr | 02:45 → 03:45, 03:45 → 02:45 |
| `America/Sao_Paulo` | −03:00 all year | none | none | — (no DST since 2019) |
| `Asia/Kolkata` | +05:30 all year | none | none | — (a fixed half-hour offset) |

- **`spring` is the gap, `fall` the repeated hour**, whatever the calendar month: the southern
  zones' spring-forward is in October and their fall-back in April. Chatham's half-hour offsets
  (+12:45 / +13:45) are kept: a client that rounds to the hour fails here.
- **The skipped and repeated local times** are inside those windows: 02:30 for Berlin's and
  Sydney's gap, 02:30 for New York's gap but **01:30** for its repeated hour (its clocks go
  back at 02:00, so the repeated hour is 01:00–01:59), and 03:15 for Chatham. Each is checked
  to be a gap or an ambiguous reading, so a wrong time of day fails rather than quietly
  testing nothing.
- **Sao Paulo and Kolkata have no transition**, so their cases are controls that nothing may
  shift. `Australia/Sydney` and `Pacific/Chatham` both end DST on the same date in 2026 and
  2027, so their cross-zone cases are viewed from a northern zone instead.
- **The control dates are notional, not real.** Sao Paulo's are the rule Brazil used before
  2019 — DST from the first Sunday of November to the third Sunday of February — i.e. the dates
  the old rule would have switched on and the clock no longer moves; its control time is 00:30,
  the midnight hour the old rule skipped or repeated. Kolkata's notional dates are
  `Europe/Berlin`'s, the northern-hemisphere rule a client would wrongly apply to a fixed
  offset, with the same 02:30 its cases use. `dst-table.mjs` re-derives both and fails if they
  drift.

## The two nonexistent-time rules, and why they differ

This is the subtle part of the table, and it is deliberate:

- A **single `DTSTART`** written at a local time that does not exist is **not** an error; RFC
  5545 § 3.3.5 form 3 says to interpret it with the UTC offset before the gap. So
  `TZID=Europe/Berlin:20260329T023000` is `20260329T013000Z` (`02:30` CET, the offset in force
  before the gap), exactly as the RFC's own `America/New_York:20070311T023000` example is
  `3:30 EDT`. The table's `skipped` cases follow this, and `dst-table.mjs` reproduces both RFC
  examples in its own test suite.
- A **recurrence instance** whose computed local time does not exist is *ignored*: RFC 5545
  § 3.3.10 says such instances "MUST be ignored and MUST NOT be counted as part of the
  recurrence set". A daily 02:30 series across 29 March 2026 therefore has no instance that
  day, and `COUNT=5` reaches 1 April rather than stopping on 31 March. The `daily-skipped`
  cases follow this, as does E15-R03's ruling for the invalid-date case (29 February in a
  non-leap year).

**The RFC contradicts itself here, and the table takes a side.** Four paragraphs after that
note, § 3.3.10 also says: "If the computed local start time of a recurrence instance does not
exist, or occurs more than once, for the specified time zone, the time of the recurrence
instance is interpreted in the same manner as an explicit DATE-TIME value describing that date
and time, as specified in Section 3.3.5" — which would *create* the instance instead of
ignoring it. Both readings are in the same section, so no engine can be called wrong from the
text alone. The table follows the note, because (a) it is the sentence this project's own
`RULINGS.md` follows for the invalid-date sibling, which is worded identically, and (b) a
client that invents an instant for a time that never existed shows the user an event at a time
that never happened.

**Because the prose cannot settle it, no `daily-skipped` case is silent about it.** Each one
carries `"ruling": "pending"` and `alternative` — the instants the other reading gives (the gap
instance kept, at the offset before the gap, and counted, so the same `COUNT` reaches one day
less) — and its `rfc.rule` quotes both sentences. The validator re-derives both readings from
ICU, refuses a case whose two readings agree, and refuses one that is missing either field. A
runner reads the field, not this file: for a `daily-skipped` case it accepts `expected` **or**
`alternative`, reports which one it matched, and accepts nothing else (the contract below). It
is reported as an open question with this requirement, for E05-R05 (the API's runner) and
E12-R01 (the wire spec, which must pin the Dart answer); when the project rules, one reviewed
commit deletes the field and the losing list, and every client re-runs the same table against
the surviving one.

## What the engines do (looked at 2026-10-11, not part of the gate)

`ical.js` 2.2.1 and `sabre/vobject` 4.6.1 were run by hand over the Berlin cases, and `ical.js`
over two New York ones, through a scratch script — not a runner, and not committed. The values
below are what the engines print; they are **not** how the table was written, and the table was
not changed to match any of them.

| Case | Table (RFC) | `ical.js` 2.2.1 | `sabre/vobject` 4.6.1 |
|---|---|---|---|
| Berlin 2026-03-29 `02:30`, single | `20260329T013000Z` | `20260329T003000Z` (offset *after* the gap) | `20260329T013000Z` ✔ |
| Berlin 2026-10-25 `02:30`, single | `20261025T003000Z` (first) | `20261025T013000Z` (second) | `20261025T013000Z` (second) |
| Berlin 2026-03-27 `09:00`, daily ×5 | local time kept ✔ | ✔ | ✔ |
| Berlin 2026-03-27 `02:30`, daily ×5 | gap instance dropped, `COUNT` reaches 1 Apr | gap instance **counted**, at `20260329T003000Z` | gap instance **counted**, at `20260329T013000Z` |
| New York 2026-03-08 `02:30`, single | `20260308T073000Z` | `20260308T063000Z` | — |
| New York 2026-11-01 `01:30`, single | `20261101T053000Z` (first) | `20261101T063000Z` (second) | — |

The `sabre/vobject` column is the Berlin probes; the New York ones were run through `ical.js`
only, and show the same two bugs. A full sweep of both engines belongs to E05-R05 and E15-R03,
which own the runner and the rulings.

So the cases an engine is **known** to miss today are the `repeated` single time and the
`daily-skipped` recurrence (both engines), and the `skipped` single time (`ical.js`; `vobject`
reads that one the RFC's way). The `daily-existing` and `all-day` cases are where both engines
already agree, which is what makes them useful as a cross-engine regression. E04-R04's review reported the same two single-time
`ical.js` misses; this table records them, and the wire spec E12-R01 must pin the same answers
for Dart's `timezone` package. **A client must never "fix" the table to match its engine.**

## Running it

```sh
make verify-corpus                                    # registered: E15-R02.json
node infra/scripts/dst-table.mjs                      # the validator and the oracle, by hand
node --test infra/scripts/dst-table.test.mjs          # the gate's own tests
```

None of it needs the local stack, Postgres, Podman or the network: the oracle is Node's own
ICU, and the table is a file. What it does:

1. **shape** — one case list, unique ids, real local times and real UTC instants, a known zone
   and kind, the input its kind needs and nothing else, a `rfc.section` on every case, a
   `pending` ruling and an `alternative` on every `daily-skipped` case, an `expectedLocal` on
   every `view-zone` case, and neither field on any other kind;
2. **coverage** — every zone, year, kind, transition day and cross-zone case the requirement
   names, derived from the transition facts (not from the table, so deleting a case fails);
3. **facts** — every declared transition date and control date against ICU and against how it
   is derived;
4. **the oracle** — every expected instant re-derived from ICU's offsets and the RFC rules,
   with the case id and both instants in the failure; the `alternative` of every
   `daily-skipped` case re-derived the same way (and refused when the two readings agree); the
   `expectedLocal` of every `view-zone` case re-read from the view zone; plus a per-kind check
   that the case is what its `kind` says (a "skipped" time that exists, a "control" zone that
   transitions, a cross-zone case where neither zone switches — each fails).

The table was **authored** from the tz database (Python's `zoneinfo`) and the RFC; the oracle
re-derives it from a different implementation (Node's ICU). The test suite carries the
mutations that prove the gate bites: an instant an hour out in every kind, a repeated time given
its second occurrence, a counted skipped instance, a wrong `alternative`, a viewer's wall clock
an hour out, a dropped zone, year or kind, a stripped `rfc`, and a stale transition fact.

A client runner (E10-R04, E09-R02, E11-R05) reads `cases.json`, builds the object its own way,
resolves the `zone` — never the device zone, except where `input.viewZone` says otherwise — and
compares its instants to `expected` in order. For a `view-zone` case it also compares the wall
clock it would show the viewer in `input.viewZone` to `expectedLocal`. On a `daily-skipped`
case it may match `expected` or `alternative`, and must say which; matching neither, or calling
that kind green while `ruling` is `pending`, is a failure. On a mismatch it reports the case
`id`, both instants and the `rfc` the table cites. Like the rest of this tree, the fixtures are
test data: no real event, no real person, nothing here is logged.
