# Corpus check registrations

Named `.json` files contain a nonempty array of command argument arrays. Commands
run from the repository root, in filename order, against the already running local
stack, and must exit nonzero on failure. `make verify-corpus` executes this
registry; `make verify` includes it after the package gates. Never log event
content, including fixture content, or envelope bytes.

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
