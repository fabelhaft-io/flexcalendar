// --- E05-R05: the API's runner for the E15-R02 DST table ---------------------
//
// E15-R02 owns `spec/ical-fixtures/dst/cases.json` and its expected results;
// this suite is the API's runner for it, and it reads the table **from the
// file**, never from a copy here. Every case is built into the iCalendar object
// the case describes — the zone's own `VTIMEZONE` included, so nothing is
// resolved through `ical.js` — expanded with `expandOccurrences`, and compared
// with `expected` in order. E10-R04 (Flutter), E09-R02 (web) and E11-R05
// (Android) run the same table, and every one of them has to agree with the
// table, not merely with the others.
//
// What each kind asserts:
//
//   * `skipped`, `repeated`, `control`, `daily-existing` — the instants of the
//     occurrences equal `expected`, in order;
//   * `view-zone` — the instant equals `expected` **and** the wall clock the
//     viewer in `input.viewZone` is shown equals `expectedLocal`, which a UTC
//     instant alone cannot fail a viewer on;
//   * `all-day` — the occurrence is in a window of exactly
//     `[expected[0], expected[1])` and out of the windows one day before and
//     after it, which is the only form in which a `DATE` has instants;
//   * `daily-skipped` — the occurrences equal `expected`, the owner's ruling on
//     RFC 5545 § 3.3.10 (`docs/02` § Recurrence, 2026-10-12): the instance at a
//     local time that does not exist is kept, counted, and read with the offset
//     before the gap — the reading `sabre/vobject` shares, so a stock app and
//     our own app show the same instance. The module's switch is
//     `KEEP_NONEXISTENT_INSTANCES` in `src/occurrences.mjs`.
//
// A table this suite cannot read — an unknown kind, a duplicate id, a case
// without its RFC citation, a kind that vanished — fails the shape test below,
// so a case can never be skipped silently.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { expandOccurrences } from '../src/occurrences.mjs';
import { vtimezoneFor } from '../src/zones.mjs';

const TABLE = JSON.parse(
  readFileSync(
    new URL('../../../spec/ical-fixtures/dst/cases.json', import.meta.url),
    'utf8',
  ),
);

/** The kinds E15-R02 defines; a runner that does not know one must say so. */
const KINDS = [
  'skipped',
  'repeated',
  'daily-existing',
  'daily-skipped',
  'all-day',
  'view-zone',
  'control',
];

/** The coverage of the embedded `VTIMEZONE`: every transition of the cases. */
const VTIMEZONE_WINDOW = { from: '2026-01-01', to: '2028-01-01' };

/** A UUIDv4-shaped id, so an answer reads like one the API could have written. */
const UID = '11111111-1111-4111-8111-111111111111';

/**
 * An instant moved by whole days, `YYYYMMDDTHHMMSSZ` in and out. The table's own
 * format, so a window edge is never mistaken for a wall clock.
 * @param {string} instant @param {number} days
 */
function shift(instant, days) {
  const [, year, month, day, hour, minute, second] =
    /** @type {RegExpExecArray} */ (
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(instant)
    );
  const at = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day) + days,
      Number(hour),
      Number(minute),
      Number(second),
    ),
  );
  const pad = (/** @type {number} */ value) => String(value).padStart(2, '0');
  return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(
    at.getUTCDate(),
  )}T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(
    at.getUTCSeconds(),
  )}Z`;
}

/** A `DTSTART`/`DTEND` pair one hour apart, at the case's wall clock. */
function hourLater(/** @type {string} */ wall) {
  const at = new Date(
    Date.UTC(
      Number(wall.slice(0, 4)),
      Number(wall.slice(4, 6)) - 1,
      Number(wall.slice(6, 8)),
      Number(wall.slice(9, 11)) + 1,
      Number(wall.slice(11, 13)),
      Number(wall.slice(13, 15)),
    ),
  );
  const pad = (/** @type {number} */ value) => String(value).padStart(2, '0');
  return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(
    at.getUTCDate(),
  )}T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(
    at.getUTCSeconds(),
  )}`;
}

/**
 * The iCalendar text one case describes: the zone's generated `VTIMEZONE` (a
 * runner for an engine without a zone database generates it from the name), the
 * `DTSTART`/`DTEND` its kind needs, and the rule when it has one.
 * @param {any} c
 */
function objectFor(c) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//flexcalendar//E05-R05 DST runner//EN',
    ...vtimezoneFor(c.zone, VTIMEZONE_WINDOW).trimEnd().split('\r\n'),
    'BEGIN:VEVENT',
    `UID:${UID}`,
    'DTSTAMP:20260101T000000Z',
  ];
  if (c.input.date) {
    lines.push(
      `DTSTART;VALUE=DATE:${c.input.date}`,
      `DTEND;VALUE=DATE:${shift(`${c.input.date}T000000Z`, 1).slice(0, 8)}`,
    );
  } else {
    lines.push(
      `DTSTART;TZID=${c.zone}:${c.input.dtstart}`,
      `DTEND;TZID=${c.zone}:${hourLater(c.input.dtstart)}`,
    );
  }
  if (c.input.rrule)
    lines.push(`RRULE:FREQ=${c.input.rrule.freq};COUNT=${c.input.rrule.count}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

/** `YYYYMMDD` -> `YYYY-MM-DD`. @param {string} compact */
function dashed(compact) {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

/** @param {any} c */
const objectsFor = (c) => [
  { href: `/calendars/c/${c.id}.ics`, ical: objectFor(c) },
];

/** Every instant the case expects, which is the window that has to hold them. */
function span(/** @type {any} */ c) {
  const sorted = [...c.expected].sort();
  return { min: sorted[0], max: sorted[sorted.length - 1] };
}

test('the table is the one E15-R02 owns and every case is one this runner reads', () => {
  assert.ok(Array.isArray(TABLE.cases) && TABLE.cases.length > 0);
  /** @type {Set<string>} */
  const ids = new Set();
  for (const c of TABLE.cases) {
    assert.ok(!ids.has(c.id), `duplicate case ${c.id}`);
    ids.add(c.id);
    assert.ok(KINDS.includes(c.kind), `${c.id}: unknown kind ${c.kind}`);
    assert.equal(typeof c.zone, 'string', `${c.id}: no zone`);
    assert.equal(typeof c.rfc?.section, 'string', `${c.id}: no rfc.section`);
    assert.equal(typeof c.rfc?.rule, 'string', `${c.id}: no rfc.rule`);
    // The ruling settled § 3.3.10, so no case carries a second reading.
    assert.ok(!('alternative' in c), `${c.id}: a leftover alternative`);
  }
  for (const kind of KINDS)
    assert.ok(
      TABLE.cases.some((/** @type {any} */ c) => c.kind === kind),
      `the table has no ${kind} case`,
    );
});

for (const c of TABLE.cases) {
  test(`dst ${c.id}`, () => {
    const objects = objectsFor(c);

    if (c.kind === 'all-day') {
      // A `DATE` has no instant of its own: the day is the window
      // `[start, exclusive end)` in the viewing zone, and nothing else is in it.
      const [start, end] = c.expected;
      const day = dashed(c.input.date);
      const nextDay = dashed(shift(`${c.input.date}T000000Z`, 1).slice(0, 8));
      const inside = expandOccurrences(objects, {
        from: start,
        to: end,
        tz: c.input.viewZone,
      });
      assert.deepEqual(
        inside.occurrences.map((/** @type {any} */ o) => o.start.date),
        [day],
      );
      // The end is the exclusive next date, which is *not* the UTC date of the
      // end instant once the viewer's zone is not UTC.
      assert.equal(inside.occurrences[0].end.date, nextDay);
      assert.equal(inside.occurrences[0].allDay, true);
      for (const [from, to] of [
        [shift(start, -1), start],
        [end, shift(end, 1)],
      ]) {
        const out = expandOccurrences(objects, {
          from,
          to,
          tz: c.input.viewZone,
        });
        assert.deepEqual(out.occurrences, [], `${from}..${to}`);
      }
      return;
    }

    const { min, max } = span(c);
    const result = expandOccurrences(objects, {
      // Two days of margin at the front and three at the back: the window is
      // not what is under test here, the instants are.
      from: shift(min, -2),
      to: shift(max, 3),
      // Where the case is viewed from is what `view-zone` pins; everywhere else
      // only the instant is asserted, so the viewer's zone is the neutral one.
      tz: c.kind === 'view-zone' ? c.input.viewZone : 'UTC',
    });
    assert.deepEqual(result.unsupported, []);
    const got = result.occurrences.map((/** @type {any} */ o) => o.start.utc);

    if (c.kind === 'view-zone') {
      assert.deepEqual(got, c.expected);
      assert.equal(result.occurrences[0].start.local, c.expectedLocal);
      assert.equal(result.occurrences[0].start.tzid, c.input.viewZone);
      return;
    }

    assert.deepEqual(got, c.expected);
  });
}
