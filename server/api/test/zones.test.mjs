// --- E05-R09: the zone source and the `VTIMEZONE` it generates ---------------
//
// Three things are held here, against three different oracles:
//
//   * **`instantOf` against the DST table of E15-R02**
//     (`spec/ical-fixtures/dst/cases.json`). The table is read from the file,
//     never copied: every case of the kinds the requirement names is resolved
//     and compared with the instants the table carries, and the `daily-skipped`
//     family — `ruling: pending`, two readings, the owner's to settle — is
//     deliberately neither passed nor failed. The table is the contract of
//     RFC 5545 § 3.3.5 form 3, and `ical.js` is wrong on two of its families
//     (`spec/ical-fixtures/dst/README.md`), which is why the resolver is not
//     built on it.
//   * **the generated `VTIMEZONE` against `ical.js`**, which is what a client
//     without a zone database reads, and against the write guard's allow-list,
//     read out of `server/caldav/src/PrivateSkeleton.php` so the two cannot
//     drift.
//   * **the name table against ICU**: every IANA name in `src/iana-zones.mjs`
//     resolves, and a wrong-case spelling, a Windows name and an unknown one are
//     refused. ICU accepts `europe/berlin` and canonicalises it, so this is the
//     check that makes a zone name case-sensitive.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import ICAL from 'ical.js';

import { rawLines } from './ical-roundtrip.mjs';
import { IANA_ZONES } from '../src/iana-zones.mjs';
import {
  HORIZON,
  ZoneError,
  instantOf,
  isIanaZone,
  localOf,
  resolves,
  vtimezoneFor,
} from '../src/zones.mjs';

/**
 * One case of the DST table. Its values are checked where they are used rather
 * than trusted; the table is data, and the test's job is to disagree with it
 * when it is wrong.
 * @typedef {{[key: string]: any}} Case
 */

/** The DST table, read from the file every time. @type {{cases: Case[]}} */
const table = JSON.parse(
  readFileSync(
    new URL('../../../spec/ical-fixtures/dst/cases.json', import.meta.url),
    'utf8',
  ),
);

/**
 * The six zones the table covers, in its order, derived from the file rather
 * than restated: a zone dropped from the table has to fail here.
 */
const TABLE_ZONES = [...new Set(table.cases.map((entry) => entry.zone))].sort();

/** `YYYYMMDD` of an epoch instant. */
const dayOf = (/** @type {number} */ epochSeconds) =>
  new Date(epochSeconds * 1000).toISOString().slice(0, 10).replaceAll('-', '');

/** The epoch of a `YYYYMMDD` date at midnight UTC. */
const epochOfDate = (/** @type {string} */ date) =>
  Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
  ) / 1000;

/** The `YYYYMMDDTHHMMSSZ` an epoch instant names. */
const instantOfEpoch = (/** @type {number} */ epochSeconds) =>
  `${new Date(epochSeconds * 1000).toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '')}Z`;

/** The epoch of a `YYYYMMDDTHHMMSSZ` instant. */
const epochOfInstant = (/** @type {string} */ instant) =>
  Date.UTC(
    Number(instant.slice(0, 4)),
    Number(instant.slice(4, 6)) - 1,
    Number(instant.slice(6, 8)),
    Number(instant.slice(9, 11)),
    Number(instant.slice(11, 13)),
    Number(instant.slice(13, 15)),
  ) / 1000;

test('the table is read, not copied, and every kind it needs is covered', () => {
  assert.ok(table.cases.length > 0, 'the DST table is empty');
  /** @type {Record<string, number>} */
  const counts = {};
  for (const entry of table.cases) {
    counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  }
  assert.deepEqual(counts, {
    'all-day': 36,
    'daily-existing': 24,
    'daily-skipped': 8,
    'view-zone': 12,
    repeated: 8,
    skipped: 8,
    control: 8,
  });
  assert.deepEqual(TABLE_ZONES, [
    'America/New_York',
    'America/Sao_Paulo',
    'Asia/Kolkata',
    'Australia/Sydney',
    'Europe/Berlin',
    'Pacific/Chatham',
  ]);
});

test('every instant the table pins is the one the resolver reads', () => {
  let checked = 0;
  let skipped = 0;
  for (const entry of table.cases) {
    const { zone, kind, input, expected } = entry;
    if (kind === 'daily-skipped') {
      // Contested: RFC 5545 § 3.3.10 says both things, so the case carries
      // `ruling: pending` and an `alternative` answer and no client may call it
      // green. It is neither passed nor failed here (E05-R05 owns the runner and
      // the owner owns the ruling).
      assert.equal(entry.ruling, 'pending');
      assert.ok(Array.isArray(entry.alternative));
      skipped += 1;
      continue;
    }
    if (kind === 'skipped' || kind === 'repeated' || kind === 'control') {
      assert.deepEqual([instantOf(input.dtstart, zone)], expected, entry.id);
      checked += 1;
      continue;
    }
    if (kind === 'view-zone') {
      assert.deepEqual([instantOf(input.dtstart, zone)], expected, entry.id);
      assert.equal(
        localOf(expected[0], input.viewZone),
        entry.expectedLocal,
        entry.id,
      );
      checked += 1;
      continue;
    }
    if (kind === 'all-day') {
      // A `DATE` day is the midnights of its viewing zone: start inclusive, end
      // exclusive (RFC 5545 § 3.8.2.2 with § 3.3.4).
      const next = dayOf(epochOfDate(input.date) + 86400);
      assert.deepEqual(
        [
          instantOf(`${input.date}T000000`, input.viewZone),
          instantOf(`${next}T000000`, input.viewZone),
        ],
        expected,
        entry.id,
      );
      checked += 1;
      continue;
    }
    if (kind === 'daily-existing') {
      // `FREQ=DAILY` keeps the local time of `DTSTART`, so each instance is the
      // same wall clock on the next local day (RFC 5545 § 3.8.5.3).
      const first = epochOfDate(input.dtstart.slice(0, 8));
      const time = input.dtstart.slice(9);
      const read = expected.map(
        (/** @type {string} */ _instant, /** @type {number} */ index) =>
          instantOf(`${dayOf(first + index * 86400)}T${time}`, zone),
      );
      assert.deepEqual(read, expected, entry.id);
      checked += 1;
      continue;
    }
    assert.fail(`${entry.id}: unknown kind ${kind}`);
  }
  assert.equal(checked, table.cases.length - skipped);
  assert.equal(skipped, 8);
});

test('the two families ical.js reads wrongly are the ones the resolver fixes', () => {
  // The control that this resolver is not a wrapper around the library: for the
  // skipped and the repeated single time of every zone, `ical.js` — through the
  // `VTIMEZONE` this module generates — answers something else, and the table's
  // reading is the resolver's. A resolver that leaned on `ical.js` would pass
  // its own tests and fail here (`spec/ical-fixtures/dst/README.md`).
  const window = { from: '2024-01-01', to: '2028-01-01' };
  let compared = 0;
  for (const entry of table.cases) {
    if (entry.kind !== 'skipped' && entry.kind !== 'repeated') continue;
    const zone = icalZone(vtimezoneFor(entry.zone, window), entry.zone);
    const local = entry.input.dtstart;
    const mine = instantOf(local, entry.zone);
    assert.equal(mine, entry.expected[0], entry.id);
    assert.notEqual(
      instantOfEpoch(icalEpoch(zone, local)),
      mine,
      `${entry.id}: ical.js agrees, so this case cannot show anything`,
    );
    compared += 1;
  }
  assert.equal(compared, 16);
});

test('every IANA name the table carries is accepted, and the resolver accepts nothing else', () => {
  const accepted = [
    'UTC',
    'Europe/Berlin',
    'America/New_York',
    'Pacific/Chatham',
    // IANA link names, exact spelling, which is what a client sends.
    'US/Eastern',
    'Asia/Kolkata',
    'Asia/Calcutta',
    'GB',
    'Japan',
    'Etc/GMT+5',
    'America/Argentina/Buenos_Aires',
  ];
  const refused = [
    // Case matters: ICU canonicalises these, so it cannot refuse them alone.
    'europe/berlin',
    'EUROPE/BERLIN',
    'us/eastern',
    'asia/kolkata',
    // Windows zone names, and what a client invents.
    'W. Europe Standard Time',
    'Eastern Standard Time',
    'Mars/Olympus',
    'Europe/Berlin ',
    ' Europe/Berlin',
    'Europe\\Berlin',
    '',
    'Berlin',
    '2026-10-14',
    'Europe/Berlin\r\nX-EVIL:1',
  ];
  for (const name of accepted) assert.equal(isIanaZone(name), true, name);
  for (const name of refused)
    assert.equal(isIanaZone(name), false, JSON.stringify(name));
  assert.equal(isIanaZone(/** @type {any} */ (5)), false);
  assert.equal(isIanaZone(undefined), false);
  // `resolves` is the read side: ICU reads a wrong-case spelling, and refuses
  // only what it cannot read at all.
  assert.equal(resolves('europe/berlin'), true);
  assert.equal(resolves('US/EASTERN'), true);
  assert.equal(resolves('W. Europe Standard Time'), false);
  assert.equal(resolves('Mars/Olympus'), false);
  assert.equal(resolves(''), false);
});

test('the name table is the IANA registry, sorted and resolvable', () => {
  const names = [...IANA_ZONES];
  assert.equal(names.length, 597);
  assert.deepEqual(names, [...names].sort(), 'the names are not sorted');
  assert.equal(new Set(names).size, names.length, 'a name appears twice');
  for (const name of names)
    assert.equal(resolves(name), true, `${name} is not resolvable`);
  // The tz database's `Factory` zone is the one ICU does not read, and it is not
  // in the list: an entry ICU cannot resolve would be a name that validates and
  // then has no offsets.
  assert.equal(IANA_ZONES.has('Factory'), false);
  for (const name of names)
    assert.match(name, /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/, name);
});

test('the instant a wall clock names, and the wall clock an instant names', () => {
  assert.equal(
    instantOf('20261014T100000', 'Europe/Berlin'),
    '20261014T080000Z',
  );
  assert.equal(localOf('20261014T080000Z', 'Europe/Berlin'), '20261014T100000');
  assert.equal(
    instantOf('20261014T100000', 'America/New_York'),
    '20261014T140000Z',
  );
  // A zone that never switches, and one with a half-hour offset.
  assert.equal(
    instantOf('20261014T100000', 'Asia/Kolkata'),
    '20261014T043000Z',
  );
  assert.equal(instantOf('20261014T100000', 'UTC'), '20261014T100000Z');
  assert.equal(
    localOf('20261014T100000Z', 'Pacific/Chatham'),
    '20261014T234500',
  );
  // The resolver has no horizon of its own: it reads any date the zone database
  // holds. Only a **write** is held to the window the embedded `VTIMEZONE`
  // covers (`src/ical-rmw.mjs`), so an object this API stores can never be one
  // whose own definition disagrees with the instant `parsed` reports.
  assert.equal(
    instantOf('19601014T100000', 'Europe/Berlin'),
    '19601014T090000Z',
  );
  assert.equal(
    instantOf('19300114T100000', 'Europe/Berlin'),
    '19300114T090000Z',
  );
  assert.equal(
    instantOf('21501014T100000', 'Europe/Berlin'),
    '21501014T080000Z',
  );
  for (const [local, tzid] of [
    ['2026-10-14T10:00:00', 'Europe/Berlin'],
    ['20261014T1000', 'Europe/Berlin'],
    ['20261014t100000', 'Europe/Berlin'],
    ['20260230T100000', 'Europe/Berlin'],
    ['20261014T250000', 'Europe/Berlin'],
    ['20261340T100000', 'Europe/Berlin'],
  ]) {
    assert.throws(
      () => instantOf(local, tzid),
      (/** @type {any} */ error) =>
        error instanceof ZoneError && error.kind === 'invalid-local',
      local,
    );
  }
  for (const [instant, tzid] of [
    ['2026-10-14T08:00:00Z', 'Europe/Berlin'],
    ['20261014T080000', 'Europe/Berlin'],
    ['20260230T080000Z', 'Europe/Berlin'],
  ]) {
    assert.throws(
      () => localOf(instant, tzid),
      (/** @type {any} */ error) =>
        error instanceof ZoneError && error.kind === 'invalid-instant',
      instant,
    );
  }
  assert.throws(
    () => instantOf('20261014T100000', 'W. Europe Standard Time'),
    (/** @type {any} */ error) =>
      error instanceof ZoneError && error.kind === 'unknown-zone',
  );
});

test('the generated VTIMEZONE resolves every instant of 2026 and 2027 like fresh offsets', () => {
  const window = { from: '2024-01-01', to: '2028-01-01' };
  for (const zone of TABLE_ZONES) {
    const definition = vtimezoneFor(zone, window);
    const parsed = icalZone(definition, zone);
    // Every day of 2026 and 2027 at noon, which crosses every transition twice.
    for (
      let day = epochOfDate('20260101');
      day < epochOfDate('20280101');
      day += 86400
    ) {
      const instant = `${dayOf(day)}T120000Z`;
      assertReading(zone, parsed, instant);
    }
    // And either side of every transition the table names for that zone, three
    // hours away from it — an unambiguous wall clock on both sides, so the two
    // single-time families `ical.js` reads wrongly are not what is compared.
    const days = new Set(
      table.cases
        .filter(
          (entry) =>
            entry.zone === zone &&
            (entry.kind === 'skipped' || entry.kind === 'repeated'),
        )
        .map((entry) => entry.expected[0]),
    );
    // `America/Sao_Paulo` and `Asia/Kolkata` have no transition in the table at
    // all — their cases are controls — and the noon sweep above is their whole
    // comparison.
    if (days.size === 0) {
      assert.ok(
        ['America/Sao_Paulo', 'Asia/Kolkata'].includes(zone),
        `${zone}: the table names no transition`,
      );
      continue;
    }
    for (const near of days) {
      const epoch = epochOfInstant(near);
      for (const shift of [-10800, 10800]) {
        assertReading(zone, parsed, instantOfEpoch(epoch + shift));
      }
    }
  }
});

/**
 * One instant read three ways: the wall clock the zone shows for it, the instant
 * that wall clock names (`instantOf`), and the instant `ical.js` reads out of the
 * generated `VTIMEZONE`. The first two must be the instant, and the third must
 * agree with them.
 * @param {string} zone @param {ICAL.Timezone} parsed @param {string} instant
 */
function assertReading(zone, parsed, instant) {
  const local = localOf(instant, zone);
  assert.equal(instantOf(local, zone), instant, `${zone} ${instant} ${local}`);
  assert.equal(
    instantOfEpoch(icalEpoch(parsed, local)),
    instant,
    `${zone} ${instant} ${local}`,
  );
}

/** The generated definition of one zone, as an `ical.js` timezone. */
function icalZone(/** @type {string} */ text, /** @type {string} */ tzid) {
  return new ICAL.Timezone({
    component: new ICAL.Component(ICAL.parse(text)),
    tzid,
  });
}

/** The epoch instant `ical.js` reads a local wall clock as, in a zone. */
function icalEpoch(
  /** @type {ICAL.Timezone} */ zone,
  /** @type {string} */ local,
) {
  const time = ICAL.Time.fromData({
    year: Number(local.slice(0, 4)),
    month: Number(local.slice(4, 6)),
    day: Number(local.slice(6, 8)),
    hour: Number(local.slice(9, 11)),
    minute: Number(local.slice(11, 13)),
    second: Number(local.slice(13, 15)),
  });
  time.zone = zone;
  return time.toUnixTime();
}

test('the window the API writes covers every instant an event can have', () => {
  // The write path embeds `HORIZON`, not a window around one event, so the same
  // definition serves an event moved years later and a daily rule with no end.
  // These probes are the ends of that claim: the start of the window, both ends
  // of 2100, and a spread in between.
  for (const zone of TABLE_ZONES) {
    const parsed = icalZone(vtimezoneFor(zone, HORIZON), zone);
    for (const instant of [
      '19700101T120000Z',
      '19700701T120000Z',
      '19800115T120000Z',
      '20000615T120000Z',
      '20260329T120000Z',
      '20261025T120000Z',
      '20500701T120000Z',
      '21000630T120000Z',
      '21001231T120000Z',
    ]) {
      assertReading(zone, parsed, instant);
    }
  }
});

test('the generated VTIMEZONE carries only what the write guard allows', () => {
  // The allow-list is read out of the guard itself, so a `VTIMEZONE` this module
  // generates can never be the one a Private calendar refuses (E03-R09).
  const guard = readFileSync(
    new URL('../../caldav/src/PrivateSkeleton.php', import.meta.url),
    'utf8',
  );
  const body = /private const PROPERTIES = \[(.*?)\];/s.exec(guard)?.[1];
  assert.ok(body, 'the guard no longer declares PROPERTIES');
  /** @type {Set<string>} */
  const allowed = new Set();
  for (const name of body.matchAll(/'([A-Z0-9-]+)'/g)) allowed.add(name[1]);
  assert.ok(allowed.has('TZID') && allowed.has('RDATE'));

  for (const zone of TABLE_ZONES) {
    const text = vtimezoneFor(zone, HORIZON);
    for (const line of rawLines(text)) {
      if (line.kind === 'begin' || line.kind === 'end') {
        assert.ok(
          ['VTIMEZONE', 'STANDARD', 'DAYLIGHT'].includes(line.name),
          `${zone}: ${line.name}`,
        );
        continue;
      }
      assert.ok(allowed.has(line.name), `${zone}: ${line.name} is not allowed`);
      for (const parameter of line.parameters) {
        const name = parameter.split('=')[0];
        assert.ok(
          ['TZID', 'VALUE'].includes(name ?? ''),
          `${zone}: ${line.name} carries ${name}`,
        );
      }
      if (line.name === 'TZOFFSETFROM' || line.name === 'TZOFFSETTO') {
        assert.match(
          line.value ?? '',
          /^[+-]\d{4}(\d{2})?$/,
          `${zone}: ${line.value}`,
        );
      }
    }
  }
});

test('the generated VTIMEZONE is a bounded size, and refuses what it cannot read', () => {
  // The price of spelling out ICU's transitions as `RDATE`s: one value line per
  // transition. `Europe/Berlin` over the API's horizon is 246 of them, 5.9 KB in
  // all (`README.md` records the numbers); the bound is here so a runaway — a
  // `RDATE` per day, say — fails rather than bloats every object a client writes.
  for (const zone of TABLE_ZONES) {
    const definition = vtimezoneFor(zone, HORIZON);
    const values = rawLines(definition).filter(
      (line) => line.name === 'DTSTART' || line.name === 'RDATE',
    ).length;
    assert.ok(values >= 2, `${zone}: no transitions at all`);
    assert.ok(values <= 400, `${zone}: ${values} transition lines`);
    assert.ok(
      definition.length <= 10_000,
      `${zone}: ${definition.length} bytes`,
    );
  }
  const berlin = vtimezoneFor('Europe/Berlin', HORIZON);
  assert.equal(
    rawLines(berlin).filter(
      (line) => line.name === 'RDATE' || line.name === 'DTSTART',
    ).length,
    246,
  );

  /** @type {[string, {from: string, to: string}][]} */
  const refusedZones = [
    ['W. Europe Standard Time', HORIZON],
    ['europe/berlin', HORIZON],
    ['Mars/Olympus', HORIZON],
  ];
  for (const [tzid, window] of refusedZones) {
    assert.throws(
      () => vtimezoneFor(tzid, window),
      (/** @type {any} */ error) =>
        error instanceof ZoneError && error.kind === 'unknown-zone',
      tzid,
    );
  }
  for (const window of [
    { from: '2028-01-01', to: '2026-01-01' },
    { from: '2026-01-01', to: '2026-01-01' },
    { from: '2026-13-01', to: '2027-01-01' },
    { from: 'not a date', to: '2027-01-01' },
    { from: undefined, to: undefined },
  ]) {
    assert.throws(
      () => vtimezoneFor('Europe/Berlin', /** @type {any} */ (window)),
      (/** @type {any} */ error) =>
        error instanceof ZoneError && error.kind === 'invalid-window',
      JSON.stringify(window),
    );
  }
});

test('nothing this module does registers a zone in ical.js globally', () => {
  // One client redefining `Europe/Berlin` for the whole process is exactly what
  // E04-R04's note forbids, so the resolver and the generator stay outside the
  // library's global `TimezoneService` (`src/zones.mjs` never calls `register`).
  assert.equal(ICAL.TimezoneService.get('Europe/Berlin'), undefined);
  instantOf('20261014T100000', 'Europe/Berlin');
  localOf('20261014T080000Z', 'Europe/Berlin');
  vtimezoneFor('Europe/Berlin', HORIZON);
  icalZone(vtimezoneFor('Europe/Berlin', HORIZON), 'Europe/Berlin');
  assert.equal(ICAL.TimezoneService.get('Europe/Berlin'), undefined);
  assert.equal(ICAL.TimezoneService.has('Europe/Berlin'), false);
});
