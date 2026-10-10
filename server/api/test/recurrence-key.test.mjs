import assert from 'node:assert/strict';
import { test } from 'node:test';
import ICAL from 'ical.js';
import { recurrenceKey } from '../src/recurrence-key.mjs';

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

test('UTC and TZID spellings of one instant have the same recurrence key', () => {
  const utc = recurrenceKey(property('RECURRENCE-ID:20261012T080000Z'));
  const zoned = recurrenceKey(
    property('RECURRENCE-ID;TZID=Europe/Berlin:20261012T100000'),
  );
  assert.equal(utc, '20261012T080000Z');
  assert.equal(zoned, utc);
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

test('another property is not a recurrence identity', () => {
  assert.throws(
    () => recurrenceKey(property('DTSTART:20261012T080000Z')),
    /Expected a RECURRENCE-ID property/,
  );
});
