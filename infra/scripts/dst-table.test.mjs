// E15-R02: tests for the DST table and its oracle.
//
// The gate has one job: refuse a table that stopped saying what the RFC says.
// Every test below either runs the real table (the happy path) or mutates one
// copy of it and requires the named check to bite — a shape hole, a coverage
// hole, a stale transition fact, or an expected instant the RFC does not
// produce. `make verify-corpus` runs the real table through the same code.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONTROL_DATES,
  KINDS,
  TRANSITIONS,
  YEARS,
  ZONES,
  coverageProblems,
  factProblems,
  formatInstant,
  instantSeconds,
  loadTable,
  localSeconds,
  offsetOf,
  oracleProblems,
  problems,
  resolveLocal,
  shapeProblems,
  transitionsInYear,
} from './dst-table.mjs';

const cases = loadTable();

/**
 * @param {string | undefined} text
 * @returns {number} Epoch seconds of a local reading.
 */
function atLocal(text) {
  const value = localSeconds(text);
  if (value === null) throw new Error(`${text} is not a local time`);
  return value;
}

/**
 * @param {string | undefined} text
 * @returns {number} Epoch seconds of a UTC instant.
 */
function atInstant(text) {
  const value = instantSeconds(text);
  if (value === null) throw new Error(`${text} is not a UTC instant`);
  return value;
}

/**
 * @param {import('./dst-table.mjs').TableCase} item
 * @returns {string} The case's local start.
 */
function dtstart(item) {
  if (typeof item.input.dtstart !== 'string')
    throw new Error(`${item.id} has no local start`);
  return item.input.dtstart;
}

/** The oracle's wording when an expected instant is not the one the RFC gives. */
const DISAGREES = 'but ICU and the RFC give';

/**
 * A copy of one case, deep-cloned so a mutation cannot leak into another test.
 * @param {number} index
 * @returns {import('./dst-table.mjs').TableCase}
 */
function at(index) {
  return structuredClone(cases[index]);
}

/**
 * @param {object} [where]
 * @param {(item: import('./dst-table.mjs').TableCase) => boolean} [where.matches]
 * @returns {import('./dst-table.mjs').TableCase}
 */
function only({ matches = () => true } = {}) {
  const found = cases.find(matches);
  assert.ok(found, 'the table must carry the case under test');
  return structuredClone(found);
}

/** @param {string} kind */
function byKind(kind) {
  return only({ matches: (item) => item.kind === kind });
}

/**
 * @param {{id: string, zone: string, kind: string, input: object, expected: string[]}} shape
 * @returns {import('./dst-table.mjs').TableCase}
 */
function synthetic(shape) {
  return {
    ...shape,
    rfc: {
      section: 'RFC 5545 § 3.3.5',
      rule: 'A paraphrase long enough to look like a real citation.',
    },
  };
}

// --- the committed table -----------------------------------------------------

test('the committed table passes shape, coverage, facts and the oracle', () => {
  const failures = problems(cases);
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('the oracle reproduces the two DATE-TIME examples of RFC 5545 § 3.3.5', () => {
  const springForward = resolveLocal(
    'America/New_York',
    atLocal('20070311T023000'),
  );
  assert.equal(springForward.kind, 'gap');
  assert.equal(formatInstant(springForward.instant), '20070311T073000Z');

  const fallBack = resolveLocal('America/New_York', atLocal('20071104T013000'));
  assert.equal(fallBack.kind, 'ambiguous');
  assert.equal(fallBack.candidates.length, 2);
  assert.equal(formatInstant(fallBack.instant), '20071104T053000Z');
});

test('every declared transition matches ICU, and controls have none', () => {
  for (const zone of ZONES)
    for (const year of YEARS) {
      const scanned = transitionsInYear(zone, Number(year));
      const declared = TRANSITIONS[zone]?.[year];
      if (declared) {
        assert.equal(scanned.spring, declared.spring, `${zone} ${year} spring`);
        assert.equal(scanned.fall, declared.fall, `${zone} ${year} fall`);
      } else {
        assert.equal(
          scanned.spring,
          null,
          `${zone} ${year} must not transition`,
        );
        assert.equal(scanned.fall, null, `${zone} ${year} must not transition`);
      }
    }
  assert.deepEqual(factProblems(), []);
});

test('the daily-skipped cases follow the ruling: one answer, the gap instance counted', () => {
  const skipped = cases.filter((item) => item.kind === 'daily-skipped');
  assert.equal(
    skipped.length,
    8,
    'the table must carry the daily-skipped kind',
  );
  for (const item of skipped) {
    // The owner ruled on 2026-10-12 (docs/02 § Recurrence), so no case is
    // contested any more: one list, and COUNT spends the gap instance.
    assert.ok(!('ruling' in item) && !('alternative' in item), item.id);
    assert.equal(item.expected.length, item.input.rrule?.count, item.id);
    assert.match(item.rfc.rule, /3\.3\.5/, item.id);
    assert.match(item.rfc.rule, /docs\/02/, item.id);
  }
});

test('every view-zone case pins the wall clock its viewer shows', () => {
  const viewed = cases.filter((item) => item.kind === 'view-zone');
  assert.ok(viewed.length > 0, 'the table must carry the cross-zone kind');
  for (const item of viewed) {
    assert.match(item.expectedLocal ?? '', /^\d{8}T\d{6}$/, item.id);
    // The viewer's reading is a fact of its own zone, never a copy of DTSTART.
    assert.notEqual(item.expectedLocal, item.input.dtstart, item.id);
  }
  for (const item of cases)
    if (item.kind !== 'view-zone')
      assert.equal(item.expectedLocal, undefined, item.id);
});

// --- shape -------------------------------------------------------------------

test('shape: a duplicate id fails', () => {
  const mutated = [...cases, at(0)];
  const failures = shapeProblems(mutated);
  assert.ok(
    failures.some((line) => line.includes('duplicate id')),
    failures.join('\n'),
  );
});

test('shape: a malformed or impossible instant fails', () => {
  const malformed = at(0);
  malformed.expected = ['20260329T01300Z'];
  const impossible = at(0);
  impossible.expected = ['20260230T013000Z'];
  assert.ok(
    shapeProblems([malformed]).some((line) =>
      line.includes('not a real UTC instant'),
    ),
  );
  assert.ok(
    shapeProblems([impossible]).some((line) =>
      line.includes('not a real UTC instant'),
    ),
  );
});

test('shape: a removed rfc citation fails', () => {
  const stripped = at(0);
  // @ts-expect-error deliberately breaking the shape
  delete stripped.rfc;
  const failures = shapeProblems([stripped]);
  assert.ok(
    failures.some((line) => line.includes('must cite')),
    failures.join('\n'),
  );

  const unnamed = at(0);
  unnamed.rfc.section = 'the RFC somewhere';
  assert.ok(
    shapeProblems([unnamed]).some((line) =>
      line.includes('must name an RFC 5545 section'),
    ),
  );
});

test('shape: an unknown kind, zone, key or input fails', () => {
  const unknownKind = at(0);
  unknownKind.kind = 'guessed';
  const unknownZone = at(0);
  unknownZone.zone = 'Mars/Olympus';
  const unknownKey = { ...at(0), summary: 'not allowed' };
  const unknownLocal = at(0);
  unknownLocal.input.dtstart = '20260329T0230';
  /** @type {Array<[string, import('./dst-table.mjs').TableCase, string]>} */
  const mutations = [
    ['kind', unknownKind, 'unknown kind'],
    ['zone', unknownZone, 'unknown zone'],
    ['key', unknownKey, 'unknown key'],
    ['input', unknownLocal, 'must be a real local time'],
  ];
  for (const [label, item, expected] of mutations) {
    const failures = shapeProblems([item]);
    assert.ok(
      failures.some((line) => line.includes(expected)),
      `${label}: ${failures.join('\n')}`,
    );
  }
});

test('shape: a leftover ruling or alternative, or a rule without the ruling, fails', () => {
  const stale = /** @type {any} */ (byKind('daily-skipped'));
  stale.ruling = 'pending';
  stale.alternative = [...stale.expected];
  const problems = shapeProblems([stale]);
  assert.ok(
    problems.some((line) => line.includes('unknown key ruling')),
    problems.join('\n'),
  );
  assert.ok(
    problems.some((line) => line.includes('unknown key alternative')),
    problems.join('\n'),
  );

  const uncited = byKind('daily-skipped');
  uncited.rfc = {
    section: 'RFC 5545 § 3.3.10',
    rule: 'RFC 5545 § 3.3.10: such recurrence instances MUST be ignored and MUST NOT be counted.',
  };
  assert.ok(
    shapeProblems([uncited]).some((line) =>
      line.includes("the owner's ruling in docs/02"),
    ),
    shapeProblems([uncited]).join('\n'),
  );
});

test('shape: a view-zone case without expectedLocal fails', () => {
  const unlocal = byKind('view-zone');
  delete unlocal.expectedLocal;
  assert.ok(
    shapeProblems([unlocal]).some((line) =>
      line.includes('must carry expectedLocal'),
    ),
    shapeProblems([unlocal]).join('\n'),
  );

  const malformed = byKind('view-zone');
  malformed.expectedLocal = '20260329 030000';
  assert.ok(
    shapeProblems([malformed]).some((line) =>
      line.includes('must carry expectedLocal'),
    ),
  );

  const onAnotherKind = byKind('skipped');
  onAnotherKind.expectedLocal = '20260329T030000';
  assert.ok(
    shapeProblems([onAnotherKind]).some((line) =>
      line.includes('only a view-zone case'),
    ),
  );
});

// --- coverage ----------------------------------------------------------------

test('coverage: dropping a zone fails', () => {
  const failures = coverageProblems(
    cases.filter((item) => item.zone !== 'Europe/Berlin'),
  );
  assert.ok(
    failures.some((line) => line.startsWith('Europe/Berlin|2026:')),
    failures.join('\n'),
  );
});

test('coverage: dropping a year fails', () => {
  const failures = coverageProblems(
    cases.filter((item) => !item.id.includes('2027')),
  );
  assert.ok(
    failures.some((line) => line.startsWith('Europe/Berlin|2027:')),
    failures.join('\n'),
  );
});

test('coverage: dropping a kind fails', () => {
  const noSkipped = coverageProblems(
    cases.filter((item) => item.kind !== 'skipped'),
  );
  assert.ok(
    noSkipped.some((line) => line.includes('no skipped case')),
    noSkipped.join('\n'),
  );
  const noAllDay = coverageProblems(
    cases.filter(
      (item) => !(item.kind === 'all-day' && item.input.viewZone === item.zone),
    ),
  );
  assert.ok(
    noAllDay.some((line) => line.includes('no all-day case')),
    noAllDay.join('\n'),
  );
  const noViewZone = coverageProblems(
    cases.filter((item) => item.kind !== 'view-zone'),
  );
  assert.ok(
    noViewZone.some((line) =>
      line.includes('no case viewed from another zone'),
    ),
    noViewZone.join('\n'),
  );
});

test('coverage: a zone-year without declared facts fails', () => {
  const failures = coverageProblems(cases, {
    transitions: {},
    controlDates: {},
  });
  assert.ok(
    failures.some((line) =>
      line.includes('no transition facts and no control dates'),
    ),
    failures.join('\n'),
  );
});

// --- the declared facts ------------------------------------------------------

test('facts: a stale transition date fails', () => {
  const shifted = structuredClone(TRANSITIONS);
  shifted['Europe/Berlin']['2026'].spring = '20260401';
  const failures = factProblems({ transitions: shifted });
  assert.ok(
    failures.some((line) => line.includes('declared spring 20260401')),
    failures.join('\n'),
  );
});

test('facts: a control zone that secretly transitions fails', () => {
  const wrong = structuredClone(TRANSITIONS);
  wrong['America/Sao_Paulo'] = {
    2026: { spring: '20261101', fall: '20260215' },
    2027: { spring: '20271107', fall: '20270221' },
  };
  const failures = factProblems({ transitions: wrong });
  assert.ok(
    failures.some(
      (line) => line.includes('declared') && line.includes('America/Sao_Paulo'),
    ),
    failures.join('\n'),
  );
  assert.ok(factProblems({ controlDates: {} }).length > 0);
});

// --- the oracle --------------------------------------------------------------

test('oracle: an instant off by an hour fails in every kind', () => {
  for (const kind of KINDS) {
    const mutated = byKind(kind);
    const instant = atInstant(mutated.expected[0]);
    mutated.expected = [formatInstant(instant + 3600)];
    const failures = oracleProblems([mutated]);
    assert.ok(
      failures.some(
        (line) => line.startsWith(`${mutated.id}:`) && line.includes(DISAGREES),
      ),
      `${kind}: ${failures.join('\n')}`,
    );
  }
});

test('oracle: a repeated local time given its second occurrence fails', () => {
  const mutated = byKind('repeated');
  const resolved = resolveLocal(mutated.zone, atLocal(dtstart(mutated)));
  assert.equal(resolved.kind, 'ambiguous');
  assert.equal(resolved.candidates.length, 2);
  assert.equal(formatInstant(resolved.instant), mutated.expected[0]);
  mutated.expected = [formatInstant(resolved.candidates[1])];
  const failures = oracleProblems([mutated]);
  assert.ok(
    failures.some(
      (line) => line.startsWith(`${mutated.id}:`) && line.includes(DISAGREES),
    ),
    failures.join('\n'),
  );
});

test('oracle: the reading the ruling set aside fails', () => {
  const original = byKind('daily-skipped');
  const mutated = structuredClone(original);
  // RFC 5545 § 3.3.10's first paragraph: no gap instance, and COUNT reaches
  // one day further. The owner ruled the other way (docs/02 § Recurrence).
  const last = atInstant(original.expected[original.expected.length - 1]);
  mutated.expected = [
    ...original.expected.slice(0, 2),
    ...original.expected.slice(3),
    formatInstant(last + 86400),
  ];
  assert.equal(mutated.expected.length, original.expected.length);
  const failures = oracleProblems([mutated]);
  assert.ok(
    failures.some(
      (line) => line.startsWith(`${mutated.id}:`) && line.includes(DISAGREES),
    ),
    failures.join('\n'),
  );
});

test('oracle: the gap instance read with the offset after the gap fails', () => {
  const original = byKind('daily-skipped');
  const mutated = structuredClone(original);
  const local = atLocal(dtstart(mutated));
  // The gap instance (two days after DTSTART), read with the offset after the
  // gap: what `ical.js` answers, an hour earlier than the ruling.
  const gapDay = local + 2 * 86400;
  mutated.expected[2] = formatInstant(gapDay - offsetOf(mutated.zone, gapDay));
  assert.notEqual(mutated.expected[2], original.expected[2]);
  const failures = oracleProblems([mutated]);
  assert.ok(
    failures.some(
      (line) => line.startsWith(`${mutated.id}:`) && line.includes(DISAGREES),
    ),
    failures.join('\n'),
  );
});

test('oracle: a daily-skipped case with no gap to skip fails', () => {
  const flat = byKind('daily-skipped');
  flat.zone = 'Asia/Kolkata';
  flat.input = {
    dtstart: '20260327T023000',
    rrule: { freq: 'DAILY', count: 3 },
  };
  flat.expected = ['20260326T210000Z', '20260327T210000Z', '20260328T210000Z'];
  assert.ok(
    oracleProblems([flat]).some((line) =>
      line.includes('give the same instants'),
    ),
    oracleProblems([flat]).join('\n'),
  );
});

test('oracle: an expectedLocal an hour out in the view zone fails', () => {
  const mutated = byKind('view-zone');
  const local = localSeconds(mutated.expectedLocal);
  assert.ok(local !== null, mutated.id);
  mutated.expectedLocal = new Date((local + 3600) * 1000)
    .toISOString()
    .replace(/[-:]/g, '')
    .slice(0, 15);
  const failures = oracleProblems([mutated]);
  assert.ok(
    failures.some(
      (line) =>
        line.startsWith(`${mutated.id}:`) && line.includes('expectedLocal'),
    ),
    failures.join('\n'),
  );
});

test('oracle: kinds the zone contradicts fail', () => {
  const existing = synthetic({
    id: 'berlin-2026-spring-skipped',
    zone: 'Europe/Berlin',
    kind: 'skipped',
    input: { dtstart: '20260329T043000' },
    expected: [
      formatInstant(
        resolveLocal('Europe/Berlin', atLocal('20260329T043000')).instant,
      ),
    ],
  });
  assert.ok(
    oracleProblems([existing]).some((line) => line.includes('not gap')),
    oracleProblems([existing]).join('\n'),
  );

  const controlOnTransition = synthetic({
    id: 'berlin-2026-spring-control',
    zone: 'Europe/Berlin',
    kind: 'control',
    input: { dtstart: '20260329T023000' },
    expected: [
      formatInstant(
        resolveLocal('Europe/Berlin', atLocal('20260329T023000')).instant,
      ),
    ],
  });
  assert.ok(
    oracleProblems([controlOnTransition]).some((line) =>
      line.includes('so it is no control'),
    ),
    oracleProblems([controlOnTransition]).join('\n'),
  );
});

test('oracle: an all-day case on an unknown viewing zone is a shape error, not a guess', () => {
  const unknown = byKind('all-day');
  unknown.input.viewZone = 'Mars/Olympus';
  assert.ok(
    shapeProblems([unknown]).some((line) =>
      line.includes('must be an IANA zone'),
    ),
  );
});

test('oracle: a cross-zone case is refused when both or neither zone switches', () => {
  const neither = synthetic({
    id: 'berlin-2026-summer-view-zone',
    zone: 'Europe/Berlin',
    kind: 'view-zone',
    input: { dtstart: '20261101T090000', viewZone: 'America/Sao_Paulo' },
    expected: ['20261101T080000Z'],
  });
  const both = synthetic({
    id: 'sydney-2026-fall-view-zone',
    zone: 'Australia/Sydney',
    kind: 'view-zone',
    input: { dtstart: '20260405T090000', viewZone: 'Pacific/Chatham' },
    expected: ['20260404T220000Z'],
  });
  assert.ok(
    oracleProblems([neither]).some((line) => line.includes('neither')),
    oracleProblems([neither]).join('\n'),
  );
  assert.ok(
    oracleProblems([both]).some((line) => line.includes('both')),
    oracleProblems([both]).join('\n'),
  );
});

// --- the reader --------------------------------------------------------------

test('loadTable refuses a missing or malformed table', () => {
  assert.throws(() => loadTable('/nonexistent/dst/cases.json'), /cannot read/);
});

test('every case names its zone, its year and its RFC rule', () => {
  for (const item of cases) {
    assert.ok(ZONES.includes(item.zone), item.id);
    assert.ok(item.expected.length > 0, item.id);
    assert.match(item.rfc.section, /^RFC 5545 § /);
    assert.ok(item.rfc.rule.length > 40, item.id);
  }
  assert.ok(CONTROL_DATES['Asia/Kolkata'], 'the control dates stay declared');
});
