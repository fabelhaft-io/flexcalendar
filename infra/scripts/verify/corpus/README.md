# Corpus check registrations

Named `.json` files contain a nonempty array of command argument arrays. Commands
run from the repository root, in filename order, against the already running local
stack, and must exit nonzero on failure. `make verify-corpus` executes this
registry; `make verify` includes it after the package gates. Never log event
content, including fixture content, or envelope bytes.

## E15-R01

`E15-R01.json` runs `node --test server/api/test/ical-roundtrip.test.mjs`, the
iCalendar round-trip gate (INV-02). It reads every fixture in
`spec/ical-fixtures/ours/` and `spec/ical-fixtures/synthetic/` — the captured
directories of E15-R04 join the same walk — writes each one back through the
API's `ical.js` read-modify-write path (`ICAL.parse` → `toString()` today; E05-R04
passes its module in), and fails on a lost component, property, parameter or
value, on a `TZID` the object does not define, and on a fixture with no
`.source.md` note beside it. A violation names the fixture, the component path
and the property or parameter, and prints a value only as a byte length and a
short SHA-256, so no fixture content reaches the output. The suite carries its own
lossy round trips (a dropped `X-` parameter, property, `VALARM` and `VTIMEZONE`),
which is how the gate is shown to fail rather than only to pass.

It needs Node and `server/api`'s dependencies but no container runtime and no
local stack: `ical.js` is a library. The `ours/` half is also checked inside
`server/caldav`'s own gate, by `tests/Unit/PrivateSkeletonCorpusTest.php`, which
feeds every `ours/` fixture to `Calflex\PrivateSkeleton`; `make verify-server-api`
and `make verify-server-caldav` run these suites without the corpus registry.
`spec/ical-fixtures/README.md` documents the corpus, the source-note rule and how
to add a fixture.

## E15-R03

`E15-R03.json` runs `node infra/scripts/corpus-compare.mjs`, the differential
recurrence comparison. It expands every fixture in `spec/ical-fixtures/rrule/`
with both engines — `ical.js` from `server/api/test/recurrence-corpus.test.mjs`
and `sabre/vobject` from `server/caldav/tests/corpus-cli.php` — over one fixed
five-year window, diffs their normalised output per fixture, and fails on any
disagreement that `spec/ical-fixtures/RULINGS.md` does not record, on a ruling
that no longer matches a real disagreement, and on a runner that crashes or
returns no fixtures. It needs Node, PHP and a `composer install` in
`server/caldav`, but no container runtime and no local stack: the two engines
run inside their own component suites, so nothing here needs Postgres, Podman or
the network. `spec/ical-fixtures/rrule/README.md` documents the fixtures, the
window and the normalisation.

## E15-R02

`E15-R02.json` runs `node infra/scripts/dst-table.mjs`, the DST table's
validator and oracle. It reads `spec/ical-fixtures/dst/cases.json` — the E15-R02
table of one case per DST question, expected results as UTC instants, each citing
the RFC 5545 section it follows — checks its shape and its coverage, checks the
transition dates the table is built on against ICU, and re-derives every expected
instant from Node's own zone database applying the RFC rules by hand. It fails
with the case id and both instants on a disagreement, and it never imports an
engine: E15-R02 owns the table, not a runner. `node --test
infra/scripts/dst-table.test.mjs` is the gate's own suite (run by the tooling
package's `test` script), which carries the mutations — an instant an hour out in
every kind, a repeated time given its second occurrence, a counted skipped
instance, a dropped zone, year or kind, a stripped `rfc` — that prove it bites.
`spec/ical-fixtures/dst/README.md` documents the table, the two nonexistent-time
rules and the RFC's disagreement about them.

It needs Node and no local stack, container runtime or network:
`spec/ical-fixtures/dst/` holds data only.
