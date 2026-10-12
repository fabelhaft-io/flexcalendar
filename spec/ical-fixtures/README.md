# `spec/ical-fixtures/` — iCalendar round-trip corpus

**Owning epic:** [E15 — Interop and regression test program](../../docs/epics/E15-interop-regression.md),
R01 for the round-trip half, R02 for the DST table and R03 for the differential
recurrence corpus below.

- **One directory per source.** `ours/` holds hand-written objects shaped as the Private
  skeleton — `adr/0001` § Private calendars and the E03-R09 allow-list define it, and no writer
  produces one yet; these are what our own code will write, not an imitation of another client.
  `synthetic/` holds hand-written objects that imitate what stock apps are known to emit.
  `apple/`, `samsung/`, `google-davx5/`, `android-adapter/` and `thunderbird/` are for objects
  captured from real devices and arrive from Phase 4 with E15-R04; the harness already walks
  them, so a capture is gated the day it lands.
- **Fixtures are test data only:** no product code, no secrets and no real user data. Neutral
  text (`Fixture event`), no real names, addresses or places, every `UID` and identifier made up,
  every envelope hash a synthetic placeholder. Nothing in the corpus is written to a log.
- **Wire form.** A fixture is stored the way RFC 5545 § 3.1 prescribes and a device emits it:
  `CRLF` line endings, folded at 75 octets. Line endings, folding and property order are never
  semantic to anything here.

## The source-note rule

Every fixture has a sidecar, `<fixture>.source.md`, naming

1. the behaviour imitated,
2. the public document it comes from — an RFC section, a vendor's protocol document,
3. what is invented, and whether the fixture **imitates a documented format rather than a
   capture**. Captures arrive with E15-R04; until then a synthetic fixture says so instead of
   implying it came from a device.

RFC 5545 has no comment syntax and a stray line breaks parsers, so the note is a sidecar and
never a header comment inside the `.ics`. `ours/` fixtures carry one too, to record that nothing
is imitated and where the object comes from. **A fixture without a source note fails the gate** —
an unattributable object is not a corpus entry. `synthetic/` cites RFC 5545 for the standard
properties it uses and marks the vendor names (`X-APPLE-*`, `X-MICROSOFT-*`, `X-MOZ-*`) as
implementations' own, with the format imitated rather than captured.

## The round-trip gate (E15-R01)

```sh
make verify-corpus                                                   # registered: E15-R01.json
cd server/api && node --test test/ical-roundtrip.test.mjs            # the same suite, by hand
```

`infra/scripts/verify/corpus/E15-R01.json` runs
`node --test server/api/test/ical-roundtrip.test.mjs`. The suite reads every fixture in every
source directory and writes it back through a `roundTrip(text) => text` function — by default
`ICAL.parse` followed by `toString()`, the only read-modify-write path that exists today (E05-R04
builds the API's module and passes it in; the engine underneath stays covered here). Per fixture
it asserts:

- **semantic equality** of the normalised object. A `DATE-TIME` is compared as the instant it
  names, so the same moment spelled with a `TZID` and with `Z` is one value; an all-day `DATE`
  as its date; a floating time by its own spelling, because it names no instant. Line folding,
  `CRLF`, property order and a `VALUE` that merely names the property's own default are not
  semantic.
- **preservation** (INV-02): every component, property and parameter of the fixture is in the
  output, compared per component path, property name and parameter name — so one lost `X-`
  parameter fails even when the value is untouched. This is checked twice and independently:
  on the normalised model built with `ical.js`, and again on the raw content lines of the two
  texts, so a property or parameter the engine drops while parsing — and which would therefore
  be missing from both normalised sides — still fails. The raw pass names properties and
  parameters only; it never compares a value.
- **`TZID`s stand on their own**: a fixture registers exactly the `VTIMEZONE`s it defines
  (`ical.js` carries no zone database, so a `TZID` it does not define would silently become
  floating time), and the same check runs on the round trip's output, which is how a dropped
  `VTIMEZONE` fails.

A failure names the fixture, the component path, the property or the parameter, and the side that
lacks it. Values appear only as a byte length and the first 12 hex digits of their SHA-256, never
themselves. The suite also carries its own deliberately lossy round trips — a dropped `X-`
parameter, a dropped property, a dropped `VALARM`, a dropped `VTIMEZONE`, an added component, an
added property and an added parameter — each required to fail with that reason, so the gate is
shown to be able to fail and not only observed to pass. A further test over `ours/` checks INV-03
and INV-04 directly: every `UID` is a lowercase UUIDv4 and every event time carries a `TZID`, a
trailing `Z` or `VALUE=DATE`, never a floating time. This is test data of `spec/`; the fixtures
are never edited to make an engine pass.

`ours/` are Private skeletons, so the same files are checked again from the CalDAV side:
`server/caldav/tests/Unit/PrivateSkeletonCorpusTest.php` feeds each one to
`Calflex\PrivateSkeleton` (accepted), adds a `SUMMARY` in memory (rejected) and asserts each
`synthetic/` fixture is rejected. The `iCal4j` path of the Android adapter joins the same harness
in Phase 6 (E11).

None of this round-trip suite needs the local stack: `ical.js` is a library, and the CalDAV half
is a DB-free unit test. The stack is needed only for the end-to-end mutation the reviewer runs by
hand — PUT an `ours/` fixture into a Private calendar (accepted) and a `synthetic/` one
(refused with 403), by design.

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

## `dst/` — the DST table (E15-R02)

`dst/cases.json` is the other half of the recurrence story: one engine-neutral
table of DST cases — a skipped local time, a repeated local time, a daily
recurrence across each transition (once at a time that exists every day, once at
the skipped time), all-day events on the transition days, and events viewed from
another zone — for `Europe/Berlin`, `America/New_York`, `America/Sao_Paulo`,
`Australia/Sydney`, `Asia/Kolkata` and `Pacific/Chatham` on their 2026 and 2027
transition days. Expected results are UTC instants, every case cites the RFC 5545
section it follows, and the table carries no ICS, no engine name and no event
text. `make verify-corpus` runs `infra/scripts/dst-table.mjs` over it
(registered as `E15-R02.json`), which checks the table's shape and coverage and
re-derives every expected instant from ICU and the RFC rules. The
`daily-skipped` cases follow the owner's ruling on § 3.3.10, which says both
that the nonexistent instance is ignored and that it is read like an explicit
`DATE-TIME`: it is kept, counted, and read with the offset before the gap
(`docs/02` § Recurrence, 2026-10-12). Unlike `rrule/`, this
directory is not expanded by an engine here: the API's runner is E05-R05's and
each client runs the same table in E10-R04, E09-R02 and E11-R05, and all of
them must agree with its expected results. `dst/README.md` documents the fields,
the zones, the two nonexistent-time rules and which engines are known to miss
which case.

## Adding a fixture

1. Put `<name>.ics` in the directory of its source (`ours/` for something our code writes, the
   captured directory for a device object, `synthetic/` for an imitation).
2. Write `<name>.source.md` beside it, with the three points of the rule above. An imitation of
   a vendor behaviour says explicitly that it is not a capture.
3. Keep the content neutral: no real names, addresses or places, invented identifiers only.
4. Run `make verify-corpus`. For an `ours/` fixture, run
   `cd server/caldav && composer run-script test` as well — an `ours/` fixture that is not a
   Private skeleton fails the CalDAV gate.
