// --- E05-R05: the API's runner for the E15-R03 recurrence corpus -------------
//
// The API expands every fixture of `spec/ical-fixtures/rrule/` through
// `expandOccurrences` — the route's own module, over `ical.js` — and compares the
// result with the golden written beside the fixture, using E15-R03's own helpers
// (`goldenViolation`, `firstDifference`, `readRulings`). `server/caldav` runs the
// mirror image over `sabre/vobject`; the two engines have to agree with the same
// goldens, and a disagreement is acceptable only where `RULINGS.md` records
// exactly it and names the engine that is right.
//
// **The normalisation lives here, as E15-R03 requires.** The corpus window is
// `20260101T000000Z <= start < 20310101T000000Z`, half-open; the module is asked
// for a wider window (an override can move an instance, and an occurrence that
// starts before the window may end inside it), and this post-process keeps what
// the golden keeps:
//
//   * an occurrence whose **own start** is in the corpus window;
//   * an override whose **`recurrenceId`** is in it — its own start may be
//     outside;
//   * an all-day occurrence is its date, a timed one its UTC instant.
//
// **The two rules `ical.js` expands wrongly are not bent.** A fixture the module
// reports in `unsupported` with `rrule-not-expanded` is one of the families
// `RULINGS.md` names and `E05-R04` refuses on write: `BYWEEKNO`, and a yearly
// rule anchored on 29 February. This suite then asserts that the ruling for
// exactly that fixture exists and names `vobject` as the correct engine — it
// never edits a golden, never edits a ruling and never weakens the module to
// make the numbers match. Anything else that differs from a golden fails the
// suite and belongs in the handoff (`from-E15-R03.md`).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { expandOccurrences } from '../src/occurrences.mjs';
import {
  ENGINE,
  fixtureIds,
  goldenViolation,
  inWindow,
  readExpected,
  readFixture,
  readRulings,
} from './recurrence-corpus.mjs';

/** The window the module is asked for: wider than the corpus window, both ways. */
const PADDED_FROM = '19000101T000000Z';
const PADDED_TO = '20320101T000000Z';

const ids = fixtureIds();
const rulings = readRulings();

/** `YYYY-MM-DD` -> `YYYYMMDD`; the golden's all-day form. @param {string} value */
const compact = (value) => value.replaceAll('-', '');

/**
 * A stored time as the golden spells one: a date for an all-day value, the UTC
 * instant otherwise.
 * @param {any} shape
 * @returns {string}
 */
function canonical(shape) {
  if (typeof shape?.date === 'string') return compact(shape.date);
  return /** @type {string} */ (shape?.utc);
}

/**
 * Expand one fixture over the padded window and normalise it to the golden form.
 * @param {string} id
 */
function expansion(id) {
  const result = expandOccurrences(
    [{ href: `/calendars/c/${id}.ics`, ical: readFixture(id) }],
    { from: PADDED_FROM, to: PADDED_TO, tz: 'UTC' },
  );
  /** @type {{fixture: string, occurrences: string[], overrides: {start: string, replaces: string}[]}} */
  const normalised = { fixture: id, occurrences: [], overrides: [] };
  for (const occurrence of result.occurrences) {
    const start = canonical(occurrence.start);
    if (occurrence.override) {
      const replaces = canonical(occurrence.recurrenceId);
      if (inWindow(replaces)) normalised.overrides.push({ start, replaces });
    } else if (inWindow(start)) {
      normalised.occurrences.push(start);
    }
  }
  normalised.occurrences.sort();
  normalised.overrides.sort((left, right) =>
    left.replaces < right.replaces ? -1 : 1,
  );
  return { normalised, unsupported: result.unsupported };
}

test('the corpus is the one E15-R03 owns, with a golden and at most one ruling per fixture', () => {
  assert.ok(ids.length >= 25, `expected 25-40 fixtures, found ${ids.length}`);
  assert.ok(ids.length <= 40, `expected 25-40 fixtures, found ${ids.length}`);
  for (const id of ids) {
    assert.ok(readExpected(id), `${id}: no golden beside the fixture`);
    // A ruling for a fixture outside the corpus is E15-R03's own check; this
    // runner only needs the ones it may accept a deviation for.
    const ruling = rulings.get(id);
    if (ruling) assert.equal(ruling.fixture, id);
  }
});

for (const id of ids) {
  test(`corpus ${id}`, () => {
    const { normalised, unsupported } = expansion(id);
    const golden = readExpected(id);
    assert.ok(golden, `${id}: no golden expectation beside the fixture`);
    assert.equal(golden.fixture, id);

    if (unsupported.length > 0) {
      // The module refuses a rule rather than expanding it wrongly. That is
      // acceptable only for a fixture `RULINGS.md` names as one `icaljs` gets
      // wrong — never for one the ruling names `icaljs` as right about.
      assert.equal(unsupported.length, 1, JSON.stringify(unsupported));
      assert.equal(unsupported[0].reason, 'rrule-not-expanded');
      const ruling = rulings.get(id);
      assert.ok(ruling, `${id}: left out, and RULINGS.md has no ruling for it`);
      assert.equal(
        ruling.correct,
        'vobject',
        `${id}: left out, but the ruling names icaljs as right`,
      );
      assert.deepEqual(normalised, {
        fixture: id,
        occurrences: [],
        overrides: [],
      });
      return;
    }

    const violation = goldenViolation({
      id,
      actual: normalised,
      expected: golden,
      ruling: rulings.get(id) ?? null,
      engine: ENGINE,
    });
    assert.equal(violation, '', violation);
  });
}
