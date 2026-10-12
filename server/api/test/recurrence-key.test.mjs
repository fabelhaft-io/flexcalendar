import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ICAL from 'ical.js';
import { recurrenceKey } from '../src/recurrence-key.mjs';

/**
 * The frozen DST vectors of E12-R01, the contract for every canonical timing
 * field. The two `Europe/Berlin` cases are the ones `ical.js` gets wrong: a
 * skipped local time is read with the offset before the gap, a repeated one as
 * its first occurrence (spec/crypto.md §3.4).
 */
const TIMING = JSON.parse(
  readFileSync(
    new URL(
      '../../../spec/crypto-vectors/canonical-timing-v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

/**
 * The instant one vector pins for a `Europe/Berlin` wall clock.
 * @param {string} local
 * @returns {string}
 */
function vectorInstant(local) {
  const vector = /** @type {any[]} */ (TIMING.vectors).find(
    (/** @type {any} */ entry) =>
      /** @type {string[]} */ (entry.inputs.skeleton_properties).some(
        (/** @type {string} */ line) => line.endsWith(`Europe/Berlin:${local}`),
      ),
  );
  assert.ok(vector, `no vector pins ${local}`);
  return /** @type {string} */ (vector.expected.instants[0]);
}

/** @param {string} line */
function property(line) {
  const calendar = new ICAL.Component(
    ICAL.parse(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VTIMEZONE',
        'TZID:Europe/Berlin',
        'BEGIN:STANDARD',
        'DTSTART:19701025T030000',
        'TZOFFSETFROM:+0200',
        'TZOFFSETTO:+0100',
        'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
        'END:STANDARD',
        'BEGIN:DAYLIGHT',
        'DTSTART:19700329T020000',
        'TZOFFSETFROM:+0100',
        'TZOFFSETTO:+0200',
        'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
        'END:DAYLIGHT',
        'END:VTIMEZONE',
        'BEGIN:VEVENT',
        line,
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
    ),
  );
  const event = calendar.getFirstSubcomponent('vevent');
  assert.ok(event);
  const result = event.getFirstProperty();
  assert.ok(result);
  return result;
}

/**
 * The same property inside a document that carries **no** `VTIMEZONE`: the
 * shape a stock app leaves behind, which ical.js can only read as floating.
 * @param {string} line
 */
function bareProperty(line) {
  const calendar = new ICAL.Component(
    ICAL.parse(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        line,
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
    ),
  );
  const event = calendar.getFirstSubcomponent('vevent');
  assert.ok(event);
  const result = event.getFirstProperty();
  assert.ok(result);
  return result;
}

test('UTC and TZID spellings of one instant have the same recurrence key', () => {
  const utc = recurrenceKey(property('RECURRENCE-ID:20261012T080000Z'));
  const zoned = recurrenceKey(
    property('RECURRENCE-ID;TZID=Europe/Berlin:20261012T100000'),
  );
  assert.equal(utc, '20261012T080000Z');
  assert.equal(zoned, utc);
});

test('a TZID resolves through ICU even when the document defines no VTIMEZONE', () => {
  // The follow-up from E04-R04: `ical.js` reads this as floating without a
  // `VTIMEZONE`; the key is taken from the `TZID` parameter and ICU instead.
  assert.equal(
    recurrenceKey(
      bareProperty('RECURRENCE-ID;TZID=Europe/Berlin:20261012T100000'),
    ),
    '20261012T080000Z',
  );
  assert.equal(
    recurrenceKey(
      bareProperty('RECURRENCE-ID;TZID=Europe/Berlin:20260401T110000'),
    ),
    '20260401T090000Z',
  );
});

test('DATE stays a date, not a midnight instant', () => {
  assert.equal(
    recurrenceKey(property('RECURRENCE-ID;VALUE=DATE:20261012')),
    '20261012',
  );
});

test('floating DATE-TIME is rejected', () => {
  assert.throws(
    () => recurrenceKey(property('RECURRENCE-ID:20261012T100000')),
    /requires UTC or a resolved TZID/,
  );
});

test('unresolved TZID cannot silently become a UTC key', () => {
  assert.throws(
    () =>
      recurrenceKey(
        property('RECURRENCE-ID;TZID=Unknown/Zone:20261012T100000'),
      ),
    /requires UTC or a resolved TZID/,
  );
});

test('the skipped and the repeated Berlin reading take the offsets the vectors pin', () => {
  // `ical.js` with this document's own VTIMEZONE answers `20260329T003000Z` for
  // the first and `20261025T013000Z` for the second; the key must not.
  assert.equal(vectorInstant('20260329T023000'), '20260329T013000Z');
  assert.equal(vectorInstant('20261025T023000'), '20261025T003000Z');
  for (const local of ['20260329T023000', '20261025T023000']) {
    assert.equal(
      recurrenceKey(property(`RECURRENCE-ID;TZID=Europe/Berlin:${local}`)),
      vectorInstant(local),
    );
  }
});

test('another property is not a recurrence identity', () => {
  assert.throws(
    () => recurrenceKey(property('DTSTART:20261012T080000Z')),
    /Expected a RECURRENCE-ID property/,
  );
});
