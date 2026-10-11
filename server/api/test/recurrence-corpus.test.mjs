// E15-R03: the API-side runner for the differential recurrence corpus.
//
// This suite is the API component's own gate over `spec/ical-fixtures/rrule/`:
// it expands every fixture with `ical.js` (the API's recurrence authority) and
// asserts the result against the golden expectation written beside it. A
// dependency bump in `server/api` that changes recurrence expansion fails here,
// in this component, before the cross-engine comparison runs.
//
// A fixture an engine is known to get wrong is not skipped: it keeps its
// RFC-derived golden, `spec/ical-fixtures/RULINGS.md` records the exact
// deviation and names the engine that is right, and this suite pins that
// deviation instead — so a fixed (or regressed) engine fails the suite.
//
// When `CALFLEX_CORPUS_OUT` is set, the same normalised expansion is written as
// `<id>.json` under that directory for `infra/scripts/corpus-compare.mjs`.

import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import ICAL from 'ical.js';

import {
  corpusDirectory,
  ENGINE,
  expandFixture,
  fixtureIds,
  goldenViolation,
  inWindow,
  parseRulings,
  readExpected,
  readRulings,
  writeCorpusOutput,
} from './recurrence-corpus.mjs';

const ids = fixtureIds();
const rulings = readRulings();

test('the corpus holds 25 to 40 fixtures', () => {
  assert.ok(ids.length >= 25, `expected 25-40 fixtures, found ${ids.length}`);
  assert.ok(ids.length <= 40, `expected 25-40 fixtures, found ${ids.length}`);
});

test('every fixture matches its golden expectation, or its recorded ruling', () => {
  for (const id of ids) {
    const expected = readExpected(id);
    assert.ok(expected, `${id}: no golden expectation beside the fixture`);
    assert.equal(expected.fixture, id);
    const violation = goldenViolation({
      id,
      actual: expandFixture(id),
      expected,
      ruling: rulings.get(id) ?? null,
      engine: ENGINE,
    });
    assert.equal(violation, '', violation);
  }
});

test('every ruling names a fixture of the corpus', () => {
  for (const fixture of rulings.keys())
    assert.ok(ids.includes(fixture), `${fixture}: unknown fixture`);
});

test('every fixture has a golden expectation and every golden a fixture', () => {
  const goldens = readdirSync(corpusDirectory)
    .filter((file) => file.endsWith('.expected.json'))
    .map((file) => file.slice(0, -'.expected.json'.length))
    .sort();
  assert.deepEqual(goldens, ids);
});

test('every golden is sorted, unique and inside the window', () => {
  for (const id of ids) {
    const expected = readExpected(id);
    assert.ok(expected, `${id}: no golden expectation beside the fixture`);
    for (const [index, occurrence] of expected.occurrences.entries()) {
      assert.match(
        occurrence,
        /^\d{8}(T\d{6}Z)?$/,
        `${id}: golden occurrence ${index} is not a date or UTC instant`,
      );
      assert.ok(
        inWindow(occurrence),
        `${id}: golden occurrence ${index} (${occurrence}) is outside the window`,
      );
      if (index > 0)
        assert.ok(
          expected.occurrences[index - 1] < occurrence,
          `${id}: golden occurrence ${index} is not sorted or not unique`,
        );
    }
  }
});

test('expansions are sorted and inside the window', () => {
  for (const id of ids) {
    const { occurrences } = expandFixture(id);
    for (const [index, occurrence] of occurrences.entries()) {
      assert.match(
        occurrence,
        /^\d{8}(T\d{6}Z)?$/,
        `${id}: occurrence ${index} is not a date or UTC instant`,
      );
      assert.ok(
        inWindow(occurrence),
        `${id}: occurrence ${index} (${occurrence}) is outside the window`,
      );
      if (index > 0)
        // A duplicate is an engine bug a ruling pins, not a normalisation error.
        assert.ok(
          occurrences[index - 1] <= occurrence,
          `${id}: occurrence ${index} is not sorted`,
        );
    }
  }
});

test('expansion is deterministic and registers no zone globally', () => {
  for (const id of ids) {
    const first = expandFixture(id);
    const second = expandFixture(id);
    assert.deepEqual(second, first, `${id}: two expansions disagree`);
  }
  // A fixture may only resolve a TZID through its own VTIMEZONE; nothing may
  // stay registered for the next fixture.
  for (const tzid of ['Europe/Berlin', 'America/New_York'])
    assert.equal(
      ICAL.TimezoneService.has(tzid),
      false,
      `${tzid} was left registered globally`,
    );
});

test('a golden violation is accepted only when a ruling pins it', () => {
  const golden = {
    fixture: 'case',
    occurrences: ['A', 'B', 'C'],
    overrides: [],
  };
  const equal = {
    fixture: 'case',
    occurrences: ['A', 'B', 'C'],
    overrides: [],
  };
  const deviating = {
    fixture: 'case',
    occurrences: ['A', 'Z', 'C'],
    overrides: [],
  };
  /** @type {import('./recurrence-corpus.mjs').Ruling} */
  const ruling = {
    fixture: 'case',
    type: 'occurrences',
    index: 1,
    icaljs: 'Z',
    vobject: 'B',
    rfc: 'RFC 5545 § 3.8.5.3',
    correct: 'vobject',
    note: '',
  };
  const check = (
    /** @type {import('./recurrence-corpus.mjs').FixtureExpansion} */ actual,
    /** @type {import('./recurrence-corpus.mjs').Ruling | null} */ recorded,
  ) =>
    goldenViolation({
      id: 'case',
      actual,
      expected: golden,
      ruling: recorded,
      engine: ENGINE,
    });

  assert.equal(check(equal, null), '');
  assert.match(check(deviating, null), /RULINGS.md has no ruling/);
  assert.equal(check(deviating, ruling), '');
  assert.match(check(equal, ruling), /no longer produces/);
  assert.match(
    check(deviating, { ...ruling, correct: 'icaljs' }),
    /names icaljs as right/,
  );
  assert.match(
    check(deviating, { ...ruling, index: 2 }),
    /records occurrences 2/,
  );
  assert.match(
    check(deviating, { ...ruling, icaljs: 'Y' }),
    /records icaljs at Y/,
  );
  assert.match(
    check(deviating, { ...ruling, vobject: 'Y' }),
    /records vobject at Y/,
  );
  const shorter = { fixture: 'case', occurrences: ['A', 'B'], overrides: [] };
  assert.match(check(shorter, null), /occurrences 2: icaljs gives \(absent\)/);
});

test('a malformed ruling block is rejected', () => {
  assert.throws(
    () => parseRulings('# no block here\n'),
    /no fenced json ruling block/,
  );
  assert.throws(
    () => parseRulings('```json\n{"rulings": {}}\n```\n'),
    /must be an array/,
  );
  assert.throws(
    () => parseRulings('```json\n{"rulings": [{"fixture": "x"}]}\n```\n'),
    /firstDifference/,
  );
  assert.throws(
    () =>
      parseRulings(
        '```json\n{"rulings": [{"fixture":"x","firstDifference":{"type":"occurrences","index":0,"icaljs":null,"vobject":null},"rfc":"RFC 5545 § 3.8.5.3","correct":"neither"}]}\n```\n',
      ),
    /correct is not icaljs or vobject/,
  );
});

test('writes normalised output when CALFLEX_CORPUS_OUT is set', () => {
  const directory = process.env.CALFLEX_CORPUS_OUT;
  if (!directory) return;
  const written = writeCorpusOutput(directory);
  assert.equal(written.length, ids.length);
  for (const path of written)
    assert.ok(existsSync(path), `${path} was not written`);
});
