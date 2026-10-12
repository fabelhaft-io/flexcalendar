// --- E05-R05: the occurrence expansion, without a request --------------------
//
// `src/occurrences.mjs` on its own: no route, no CalDAV, no database, no clock.
// The two corpora E15-R02 and E15-R03 own are run by their own files
// (`test/occurrences-dst.test.mjs`, `test/occurrences-corpus.test.mjs`); this
// suite holds what the requirement's Accept names beside them — the window edges,
// the unbounded rules whose corpus files are a follow-up (`from-E15-R03.md`), the
// overrides, and the objects the expansion must refuse rather than guess at.
//
// Every assertion is about an instant, a date or a member of the answer, so a
// mutation of the module — the window end made inclusive, an all-day day placed
// by UTC midnights, an instant taken from `ical.js`, an override that leaves its
// master instance behind, an `EXDATE` ignored, a `BYWEEKNO` expanded, the bound
// removed — fails here.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import ICAL from 'ical.js';

import { IcalError } from '../src/ical-rmw.mjs';
import {
  KEEP_NONEXISTENT_INSTANCES,
  MAX_INSTANCES,
  expandOccurrences,
} from '../src/occurrences.mjs';
import { vtimezoneFor } from '../src/zones.mjs';

/** The Private skeleton of E15-R01: a weekly master with an EXDATE and an override. */
const OVERRIDE_FIXTURE = readFileSync(
  new URL(
    '../../../spec/ical-fixtures/ours/private-weekly-exdate-override.ics',
    import.meta.url,
  ),
  'utf8',
);

/** A value that must never reach the answer. */
const CANARY = 'CALFLEX_EVENT_CONTENT_CANARY';

/** A UUIDv4-shaped id per object, so an answer is easy to tell apart. */
const id = (/** @type {number} */ n) =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-${String(n).padStart(12, '0')}`;

/**
 * One stored object: a `VCALENDAR` around one or more `VEVENT`s that share a
 * `UID`, `CRLF`-separated, exactly as a collection holds one.
 * @param {string} uid @param {string[][]} events
 */
function objectOf(uid, events) {
  return {
    href: `/calendars/00000000-0000-4000-8000-000000000000/${uid}.ics`,
    ical: [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//flexcalendar//E05-R05 test//EN',
      ...events.flatMap((lines) => [
        'BEGIN:VEVENT',
        `UID:${uid}`,
        'DTSTAMP:20260101T000000Z',
        ...lines,
        'END:VEVENT',
      ]),
      'END:VCALENDAR',
      '',
    ].join('\r\n'),
  };
}

/** One object with a single `VEVENT`. @param {string} uid @param {string[]} lines */
const single = (uid, lines) => objectOf(uid, [lines]);

/** @param {number} n @param {string[]} lines */
const numbered = (n, lines) => single(id(n), lines);

/** The start of every occurrence, as its instant (or its date for an all-day one). */
const starts = (/** @type {{occurrences: any[]}} */ result) =>
  result.occurrences.map(
    (occurrence) => occurrence.start.utc ?? occurrence.start.date,
  );

/** The window the suites share: the whole of 2026, a year of margin either side. */
const YEAR = { from: '20260101T000000Z', to: '20270101T000000Z' };

test('a timed event that does not recur answers once, and its recurrenceId is null', () => {
  const result = expandOccurrences(
    [numbered(1, ['DTSTART:20260115T090000Z', 'DTEND:20260115T100000Z'])],
    { ...YEAR, tz: 'Europe/Berlin' },
  );
  assert.deepEqual(result.unsupported, []);
  assert.equal(result.occurrences.length, 1);
  assert.deepEqual(result.occurrences[0], {
    uid: id(1),
    recurrenceId: null,
    override: false,
    start: {
      utc: '20260115T090000Z',
      local: '20260115T100000',
      tzid: 'Europe/Berlin',
    },
    end: {
      utc: '20260115T100000Z',
      local: '20260115T110000',
      tzid: 'Europe/Berlin',
    },
    allDay: false,
    envelopeSha256: null,
  });
});

test('an event outside the window answers nothing', () => {
  const result = expandOccurrences(
    [numbered(1, ['DTSTART:20270101T090000Z', 'DTEND:20270101T100000Z'])],
    { ...YEAR, tz: 'UTC' },
  );
  assert.deepEqual(result.occurrences, []);
});

test('the window is half-open: `from` is in, `to` is out, and a second either way decides', () => {
  const objects = [
    numbered(1, ['DTSTART:20260310T090000Z', 'DTEND:20260310T093000Z']),
    // A zero-length instance: RFC 5545 § 3.8.2.2 leaves `DTEND` out, and a
    // zero-length interval is in when `from <= start < to`.
    numbered(2, ['DTSTART:20260310T110000Z']),
  ];
  const window = { tz: 'UTC' };
  /** @param {string} from @param {string} to */
  const within = (from, to) =>
    expandOccurrences(objects, { ...window, from, to }).occurrences.map(
      (occurrence) => occurrence.start.utc,
    );

  // The instance starts exactly on `from`: in.
  assert.deepEqual(within('20260310T090000Z', '20260310T100000Z'), [
    '20260310T090000Z',
  ]);
  // An instance that starts *before* `from` and ends after it is in: the window
  // is an overlap, not a bucket.
  assert.deepEqual(within('20260310T090001Z', '20260310T100000Z'), [
    '20260310T090000Z',
  ]);
  // The instance starts exactly on `to`: out.
  assert.deepEqual(within('20260310T080000Z', '20260310T090000Z'), []);
  // …and a second later `to` includes it.
  assert.deepEqual(within('20260310T080000Z', '20260310T090001Z'), [
    '20260310T090000Z',
  ]);
  // One second either side of `to` again, from the other end of the window.
  assert.deepEqual(within('20260310T085959Z', '20260310T100000Z'), [
    '20260310T090000Z',
  ]);
  // An instance that ends exactly on `to` is in: it overlaps `[from, to)`.
  assert.deepEqual(within('20260310T090000Z', '20260310T093000Z'), [
    '20260310T090000Z',
  ]);
  // The zero-length instance: at `from` in, at `to` out, and one second in.
  assert.deepEqual(within('20260310T110000Z', '20260310T120000Z'), [
    '20260310T110000Z',
  ]);
  assert.deepEqual(within('20260310T100000Z', '20260310T110000Z'), []);
  assert.deepEqual(within('20260310T110001Z', '20260310T120000Z'), []);
});

test('an all-day event is a date, placed by the requested zone midnights', () => {
  const objects = [
    numbered(1, ['DTSTART;VALUE=DATE:20260301', 'DTEND;VALUE=DATE:20260302']),
    numbered(2, ['DTSTART;VALUE=DATE:20260228', 'DTEND;VALUE=DATE:20260301']),
    numbered(3, [
      'DTSTART;VALUE=DATE:20260301',
      'DTEND;VALUE=DATE:20260302',
      'X-CALFLEX-ENVELOPE-SHA256:' + 'a'.repeat(64),
    ]),
  ];
  // A zone ahead of UTC: 1 March starts at 2026-02-28T18:30Z, so the day
  // containing `from` is in and the day before it ends before `from`.
  const ahead = expandOccurrences(objects, {
    from: '20260301T000000Z',
    to: '20260302T000000Z',
    tz: 'Asia/Kolkata',
  });
  assert.deepEqual(starts(ahead), ['2026-03-01', '2026-03-01']);
  assert.deepEqual(ahead.occurrences[0].end, { date: '2026-03-02' });
  assert.equal(ahead.occurrences[0].allDay, true);
  assert.equal(ahead.occurrences[0].recurrenceId, null);

  // A zone behind UTC: 1 March starts at 2026-03-01T08:00Z, so a window from
  // noon keeps the day and drops the one before it.
  const behind = expandOccurrences(objects, {
    from: '20260301T120000Z',
    to: '20260302T120000Z',
    tz: 'America/Los_Angeles',
  });
  assert.deepEqual(starts(behind), ['2026-03-01', '2026-03-01']);
});

test('an all-day day on a transition day is 23 hours long', () => {
  const objects = [
    numbered(1, ['DTSTART;VALUE=DATE:20260329', 'DTEND;VALUE=DATE:20260330']),
  ];
  const at = (/** @type {string} */ from, /** @type {string} */ to) =>
    expandOccurrences(objects, { from, to, tz: 'Europe/Berlin' }).occurrences;
  // 29 March 2026 is Berlin's spring transition: the day covers exactly the two
  // midnights the table's `all-day` case names.
  assert.equal(at('20260328T230000Z', '20260329T220000Z').length, 1);
  assert.equal(at('20260328T220000Z', '20260328T230000Z').length, 0);
  assert.equal(at('20260329T220000Z', '20260329T230000Z').length, 0);
  assert.equal(at('20260328T225959Z', '20260329T220001Z').length, 1);
});

test('an unbounded weekly rule stops at the window, not at the bound', () => {
  const objects = [
    numbered(1, [
      'DTSTART:20260107T090000Z',
      'DTEND:20260107T100000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=WE',
    ]),
  ];
  const january = expandOccurrences(objects, {
    from: '20260101T000000Z',
    to: '20260201T000000Z',
    tz: 'UTC',
  });
  assert.deepEqual(starts(january), [
    '20260107T090000Z',
    '20260114T090000Z',
    '20260121T090000Z',
    '20260128T090000Z',
  ]);
  // A second window, years later, is expanded the same way: nothing stateful is
  // left behind by the first call.
  const later = expandOccurrences(objects, {
    from: '20280101T000000Z',
    to: '20280201T000000Z',
    tz: 'UTC',
  });
  assert.deepEqual(starts(later), [
    '20280105T090000Z',
    '20280112T090000Z',
    '20280119T090000Z',
    '20280126T090000Z',
  ]);
});

test('an unbounded monthly last-day rule and an unbounded all-day rule expand', () => {
  const monthly = expandOccurrences(
    [
      numbered(1, [
        'DTSTART:20260131T090000Z',
        'DTEND:20260131T100000Z',
        'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1',
      ]),
    ],
    { ...YEAR, tz: 'UTC' },
  );
  assert.deepEqual(starts(monthly), [
    '20260131T090000Z',
    '20260228T090000Z',
    '20260331T090000Z',
    '20260430T090000Z',
    '20260531T090000Z',
    '20260630T090000Z',
    '20260731T090000Z',
    '20260831T090000Z',
    '20260930T090000Z',
    '20261031T090000Z',
    '20261130T090000Z',
    '20261231T090000Z',
  ]);

  const allDay = expandOccurrences(
    [
      numbered(2, [
        'DTSTART;VALUE=DATE:20260301',
        'DTEND;VALUE=DATE:20260302',
        'RRULE:FREQ=WEEKLY',
      ]),
    ],
    { from: '20260301T000000Z', to: '20260401T000000Z', tz: 'Europe/Berlin' },
  );
  assert.deepEqual(starts(allDay), [
    '2026-03-01',
    '2026-03-08',
    '2026-03-15',
    '2026-03-22',
    '2026-03-29',
  ]);
});

test('a DTSTART years before the window is expanded up to the window', () => {
  const weekly = expandOccurrences(
    [
      numbered(1, [
        'DTSTART:20200101T090000Z',
        'DTEND:20200101T100000Z',
        'RRULE:FREQ=WEEKLY',
      ]),
    ],
    { from: '20260101T000000Z', to: '20260201T000000Z', tz: 'UTC' },
  );
  assert.deepEqual(starts(weekly), [
    '20260107T090000Z',
    '20260114T090000Z',
    '20260121T090000Z',
    '20260128T090000Z',
  ]);
});

test('a multi-day event that starts before the window is reported by its own times', () => {
  const result = expandOccurrences(
    [numbered(1, ['DTSTART;VALUE=DATE:20260227', 'DTEND;VALUE=DATE:20260302'])],
    { from: '20260301T000000Z', to: '20260302T000000Z', tz: 'UTC' },
  );
  assert.equal(result.occurrences.length, 1);
  assert.deepEqual(result.occurrences[0].start, { date: '2026-02-27' });
  assert.deepEqual(result.occurrences[0].end, { date: '2026-03-02' });
});

test('EXDATE removes an instance and RDATE adds one', () => {
  const result = expandOccurrences(
    [
      numbered(1, [
        'DTSTART:20260105T090000Z',
        'DTEND:20260105T100000Z',
        'RRULE:FREQ=DAILY;COUNT=3',
        'EXDATE:20260106T090000Z',
        'RDATE:20260120T090000Z',
      ]),
    ],
    { ...YEAR, tz: 'UTC' },
  );
  assert.deepEqual(starts(result), [
    '20260105T090000Z',
    '20260107T090000Z',
    '20260120T090000Z',
  ]);
  // Both the `RDATE` instance and a rule instance carry the original start, so
  // E05-R06/R07 can address either.
  assert.deepEqual(result.occurrences[2].recurrenceId, {
    utc: '20260120T090000Z',
  });
});

test('the E15-R01 skeleton: a weekly master, its EXDATE and its override', () => {
  const result = expandOccurrences(
    [{ href: '/calendars/c/uid.ics', ical: OVERRIDE_FIXTURE }],
    { from: '20261001T000000Z', to: '20261201T000000Z', tz: 'Europe/Berlin' },
  );
  assert.deepEqual(result.unsupported, []);
  assert.deepEqual(starts(result), [
    '20261014T080000Z',
    '20261021T080000Z',
    '20261104T110000Z',
    '20261111T090000Z',
    '20261118T090000Z',
  ]);
  // 28 October is the `EXDATE`: the master's own instance is gone.
  assert.ok(!starts(result).includes('20261028T080000Z'));

  const [first, , moved] = result.occurrences;
  assert.equal(first.uid, '5d6c7b8a-9012-4ef3-8abc-0123456789ab');
  assert.equal(first.override, false);
  assert.deepEqual(first.recurrenceId, {
    tzid: 'Europe/Berlin',
    local: '20261014T100000',
    utc: '20261014T080000Z',
  });
  assert.deepEqual(moved.recurrenceId, {
    tzid: 'Europe/Berlin',
    local: '20261104T100000',
    utc: '20261104T090000Z',
  });
  assert.equal(moved.override, true);
  assert.deepEqual(moved.start, {
    utc: '20261104T110000Z',
    local: '20261104T120000',
    tzid: 'Europe/Berlin',
  });
  // The envelope hash is the one of the VEVENT that defines the instance: the
  // master's for a derived one, the override's own otherwise.
  assert.equal(
    first.envelopeSha256,
    '97e86ef15fa12220149413f447a63323a722b71e16de171a5edcfcb4245832a0',
  );
  assert.equal(
    moved.envelopeSha256,
    '42f330661f36ef711a25411ce01bf9b0dd2b8d23e816ac1d22979a3cf2f1e8d8',
  );
});

test('an override moved out of the window is out, and its master instance stays gone', () => {
  const objects = [
    objectOf(id(1), [
      [
        'DTSTART:20260601T090000Z',
        'DTEND:20260601T100000Z',
        'RRULE:FREQ=DAILY;COUNT=3',
      ],
      [
        'RECURRENCE-ID:20260602T090000Z',
        'DTSTART:20270101T090000Z',
        'DTEND:20270101T100000Z',
      ],
    ]),
  ];
  const day = expandOccurrences(objects, {
    from: '20260602T000000Z',
    to: '20260603T000000Z',
    tz: 'UTC',
  });
  assert.deepEqual(day.occurrences, []);
  assert.deepEqual(day.unsupported, []);
  // The window that covers the override reports it by its own times.
  const moved = expandOccurrences(objects, {
    from: '20270101T000000Z',
    to: '20270102T000000Z',
    tz: 'UTC',
  });
  assert.deepEqual(starts(moved), ['20270101T090000Z']);
  assert.equal(moved.occurrences[0].override, true);
});

test('an override moved into the window is in, by its own times', () => {
  const objects = [
    objectOf(id(1), [
      [
        'DTSTART:20260601T090000Z',
        'DTEND:20260601T100000Z',
        'RRULE:FREQ=DAILY;COUNT=3',
      ],
      [
        'RECURRENCE-ID:20260602T090000Z',
        'DTSTART:20260620T090000Z',
        'DTEND:20260620T100000Z',
      ],
    ]),
  ];
  const result = expandOccurrences(objects, {
    from: '20260620T000000Z',
    to: '20260621T000000Z',
    tz: 'UTC',
  });
  assert.deepEqual(starts(result), ['20260620T090000Z']);
  assert.deepEqual(result.occurrences[0].recurrenceId, {
    utc: '20260602T090000Z',
  });
  assert.equal(result.occurrences[0].override, true);
});

test('an override whose RECURRENCE-ID names no instance is still reported', () => {
  const objects = [
    objectOf(id(1), [
      [
        'DTSTART:20260601T090000Z',
        'DTEND:20260601T100000Z',
        'RRULE:FREQ=DAILY;COUNT=2',
      ],
      [
        'RECURRENCE-ID:20260630T090000Z',
        'DTSTART:20260602T140000Z',
        'DTEND:20260602T150000Z',
      ],
    ]),
  ];
  const result = expandOccurrences(objects, {
    from: '20260602T000000Z',
    to: '20260603T000000Z',
    tz: 'UTC',
  });
  // The master's own 2 June instance is nobody's to remove, and the override is
  // an occurrence of its own.
  assert.deepEqual(starts(result), ['20260602T090000Z', '20260602T140000Z']);
  assert.deepEqual(
    result.occurrences.map((occurrence) => occurrence.override),
    [false, true],
  );
});

test('an object whose stored TZID is not a zone this resolver reads is left out', () => {
  const objects = [
    numbered(1, [
      'DTSTART;TZID=W. Europe Standard Time:20260115T090000',
      'DTEND;TZID=W. Europe Standard Time:20260115T100000',
      'RRULE:FREQ=WEEKLY',
      `SUMMARY:${CANARY}`,
    ]),
    numbered(2, ['DTSTART:20260115T090000Z', 'DTEND:20260115T100000Z']),
  ];
  const result = expandOccurrences(objects, { ...YEAR, tz: 'UTC' });
  assert.deepEqual(result.unsupported, [
    {
      uid: id(1),
      reason: 'unknown-zone',
    },
  ]);
  // The rest of the collection is still answered.
  assert.deepEqual(starts(result), ['20260115T090000Z']);
  assert.ok(!JSON.stringify(result).includes(CANARY));
});

test('the two rule families ical.js expands wrongly are left out, not guessed at', () => {
  const objects = [
    numbered(1, [
      'DTSTART:20260511T090000Z',
      'DTEND:20260511T100000Z',
      'RRULE:FREQ=YEARLY;COUNT=5;BYWEEKNO=20;BYDAY=MO',
    ]),
    numbered(2, [
      'DTSTART;VALUE=DATE:20240229',
      'DTEND;VALUE=DATE:20240301',
      'RRULE:FREQ=YEARLY;COUNT=3',
    ]),
  ];
  const result = expandOccurrences(objects, { ...YEAR, tz: 'UTC' });
  assert.deepEqual(result.occurrences, []);
  assert.deepEqual(
    result.unsupported.map((entry) => entry.reason),
    ['rrule-not-expanded', 'rrule-not-expanded'],
  );
});

test('an expansion that does not stop inside the bound is unsupported, not an answer', () => {
  const result = expandOccurrences(
    [
      numbered(1, [
        'DTSTART:20200101T000000Z',
        'DTEND:20200101T000100Z',
        'RRULE:FREQ=MINUTELY',
      ]),
    ],
    { from: '20260101T000000Z', to: '20260102T000000Z', tz: 'UTC' },
  );
  assert.deepEqual(result.occurrences, []);
  assert.deepEqual(result.unsupported, [
    {
      uid: id(1),
      reason: 'too-many-instances',
    },
  ]);
  assert.ok(MAX_INSTANCES > 0);
});

test('the ruling: an instance at a local time that does not exist is kept', () => {
  // Berlin's spring gap, 2026-03-29, daily 02:30. `KEEP_NONEXISTENT_INSTANCES`
  // is the one switch, and this suite pins the reading the owner ruled on
  // 2026-10-12 (`docs/02` § Recurrence): the DST table's `expected`, which
  // `sabre/vobject` shares.
  assert.equal(KEEP_NONEXISTENT_INSTANCES, true);
  const result = expandOccurrences(
    [
      numbered(1, [
        'DTSTART;TZID=Europe/Berlin:20260327T023000',
        'DTEND;TZID=Europe/Berlin:20260327T033000',
        'RRULE:FREQ=DAILY;COUNT=5',
      ]),
    ],
    { from: '20260320T000000Z', to: '20260410T000000Z', tz: 'Europe/Berlin' },
  );
  assert.deepEqual(starts(result), [
    '20260327T013000Z',
    '20260328T013000Z',
    '20260329T013000Z',
    '20260330T003000Z',
    '20260331T003000Z',
  ]);
});

test('the answer is sorted by start instant, then uid, then recurrenceId', () => {
  const result = expandOccurrences(
    [
      numbered(2, ['DTSTART:20260310T110000Z', 'DTEND:20260310T120000Z']),
      numbered(1, ['DTSTART:20260310T090000Z', 'DTEND:20260310T100000Z']),
      numbered(3, ['DTSTART;VALUE=DATE:20260310', 'DTEND;VALUE=DATE:20260311']),
    ],
    { from: '20260310T000000Z', to: '20260311T000000Z', tz: 'UTC' },
  );
  assert.deepEqual(
    result.occurrences.map((occurrence) => occurrence.uid),
    [id(3), id(1), id(2)],
  );
});

test('the expansion is deterministic and registers no zone globally', () => {
  const objects = [
    numbered(1, [
      'DTSTART;TZID=Europe/Berlin:20260115T090000',
      'DTEND;TZID=Europe/Berlin:20260115T100000',
      'RRULE:FREQ=WEEKLY;COUNT=4',
    ]),
  ];
  const first = expandOccurrences(objects, { ...YEAR, tz: 'America/New_York' });
  const second = expandOccurrences(objects, {
    ...YEAR,
    tz: 'America/New_York',
  });
  assert.deepEqual(second, first);
  // `ical.js` resolves a `TZID` through its global `TimezoneService`; registering
  // one would let a client redefine a zone for every other request in the
  // process (E04-R04). Nothing here may have — `UTC` is the library's own and
  // stays.
  for (const tzid of ['Europe/Berlin', 'America/New_York'])
    assert.equal(ICAL.TimezoneService.has(tzid), false, tzid);
});

test('an object this API cannot read is an IcalError, never a guess', () => {
  assert.throws(
    () =>
      expandOccurrences([{ href: '/x.ics', ical: 'not a calendar' }], {
        ...YEAR,
        tz: 'UTC',
      }),
    IcalError,
  );
  // A VEVENT without a start names no instance at all (RFC 5545 § 3.8.6.3).
  assert.throws(
    () =>
      expandOccurrences([numbered(1, ['DTSTAMP:20260101T000000Z'])], {
        ...YEAR,
        tz: 'UTC',
      }),
    IcalError,
  );
});

test('an occurrence carries exactly the seven members the contract declares', () => {
  const result = expandOccurrences(
    [
      numbered(1, [
        'DTSTART:20260115T090000Z',
        'DTEND:20260115T100000Z',
        'RRULE:FREQ=DAILY;COUNT=2',
        `SUMMARY:${CANARY}`,
        `DESCRIPTION:${CANARY}`,
        `LOCATION:${CANARY}`,
        `ATTENDEE:mailto:${CANARY}@example.test`,
      ]),
    ],
    { ...YEAR, tz: 'UTC' },
  );
  assert.equal(result.occurrences.length, 2);
  for (const occurrence of result.occurrences) {
    assert.deepEqual(Object.keys(occurrence).sort(), [
      'allDay',
      'end',
      'envelopeSha256',
      'override',
      'recurrenceId',
      'start',
      'uid',
    ]);
  }
  // No content, no envelope bytes and no object text leaves here (INV-01,
  // INV-07): the answer is names and times.
  assert.ok(!JSON.stringify(result).includes(CANARY));
});

/**
 * One object with the zone's own generated `VTIMEZONE` in front of its
 * `VEVENT`s when `tzid` is given — every object this API writes carries one, and
 * the expansion has to read an object with an embedded definition exactly like
 * one without.
 * @param {string} uid @param {string[][]} events @param {string} [tzid]
 */
function withZone(uid, events, tzid) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//flexcalendar//E05-R05 test//EN',
  ];
  if (tzid !== undefined) {
    lines.push(
      ...vtimezoneFor(tzid, { from: '2026-01-01', to: '2028-01-01' })
        .trimEnd()
        .split('\r\n'),
    );
  }
  for (const event of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      'DTSTAMP:20260101T000000Z',
      ...event,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR', '');
  return {
    href: `/calendars/00000000-0000-4000-8000-000000000000/${uid}.ics`,
    ical: lines.join('\r\n'),
  };
}

/** One instant moved by whole seconds, `YYYYMMDDTHHMMSSZ` in and out. @param {string} instant @param {number} seconds */
function shifted(instant, seconds) {
  const at = new Date(
    Date.UTC(
      Number(instant.slice(0, 4)),
      Number(instant.slice(4, 6)) - 1,
      Number(instant.slice(6, 8)),
      Number(instant.slice(9, 11)),
      Number(instant.slice(11, 13)),
      Number(instant.slice(13, 15)) + seconds,
    ),
  );
  const pad = (/** @type {number} */ value) => String(value).padStart(2, '0');
  return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(
    at.getUTCDate(),
  )}T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(
    at.getUTCSeconds(),
  )}Z`;
}

/**
 * The three instants of a weekly 10:00 local series that starts 2026-10-10, per
 * zone: before every one of the five autumn changes and after Chatham's own
 * spring one, so the offset is the same for all three.
 */
const UNTIL_SERIES = [
  [
    'America/New_York',
    '20261010T140000Z',
    '20261017T140000Z',
    '20261024T140000Z',
  ],
  [
    'America/Sao_Paulo',
    '20261010T130000Z',
    '20261017T130000Z',
    '20261024T130000Z',
  ],
  ['Asia/Kolkata', '20261010T043000Z', '20261017T043000Z', '20261024T043000Z'],
  [
    'Pacific/Chatham',
    '20261009T201500Z',
    '20261016T201500Z',
    '20261023T201500Z',
  ],
  ['Europe/Berlin', '20261010T080000Z', '20261017T080000Z', '20261024T080000Z'],
];

for (const [tzid, first, second, third] of UNTIL_SERIES) {
  for (const embedded of [false, true]) {
    test(`\`UNTIL\` is an instant, not a wall clock, in ${tzid}${embedded ? ' with its VTIMEZONE' : ''}`, () => {
      /** @param {string} until */
      const expand = (until) => {
        const result = expandOccurrences(
          [
            withZone(
              id(1),
              [
                [
                  `DTSTART;TZID=${tzid}:20261010T100000`,
                  `DTEND;TZID=${tzid}:20261010T110000`,
                  `RRULE:FREQ=WEEKLY;UNTIL=${until}`,
                ],
              ],
              embedded ? tzid : undefined,
            ),
          ],
          { ...YEAR, tz: tzid },
        );
        assert.deepEqual(result.unsupported, []);
        return starts(result);
      };
      // One second before the third instance: the rule ends at the second.
      assert.deepEqual(expand(shifted(third, -1)), [first, second]);
      // At the instant: in, which is `UNTIL`'s inclusive boundary — the
      // instance a zone behind UTC loses when the library compares a floating
      // `UNTIL` against a zoned start.
      assert.deepEqual(expand(third), [first, second, third]);
      // One second after: still three.
      assert.deepEqual(expand(shifted(third, 1)), [first, second, third]);
    });
  }
}

test('a `Z` `RDATE` and a `Z` `EXDATE` on a zoned master name instants', () => {
  for (const embedded of [false, true]) {
    const result = expandOccurrences(
      [
        withZone(
          id(1),
          [
            [
              'DTSTART;TZID=Europe/Berlin:20261010T100000',
              'DTEND;TZID=Europe/Berlin:20261010T110000',
              'RRULE:FREQ=WEEKLY;COUNT=3',
              // 10:00 Berlin on 17 October 2026 (CEST, +2): the instance is
              // removed only when the `Z` value is read as the instant it is.
              'EXDATE:20261017T080000Z',
              // 10:00 Berlin on 1 November 2026 (CET, +1) — read as a wall
              // clock it would land an hour earlier.
              'RDATE:20261101T090000Z',
            ],
          ],
          embedded ? 'Europe/Berlin' : undefined,
        ),
      ],
      { ...YEAR, tz: 'Europe/Berlin' },
    );
    assert.deepEqual(result.unsupported, []);
    assert.deepEqual(starts(result), [
      '20261010T080000Z',
      '20261024T080000Z',
      '20261101T090000Z',
    ]);
  }
});

test('an `RDATE` that repeats a rule instance is one occurrence, not two', () => {
  const result = expandOccurrences(
    [
      numbered(1, [
        'DTSTART:20260105T090000Z',
        'DTEND:20260105T100000Z',
        'RRULE:FREQ=DAILY;COUNT=3',
        'RDATE:20260106T090000Z',
        'RDATE:20260106T090000Z',
      ]),
    ],
    { ...YEAR, tz: 'UTC' },
  );
  assert.deepEqual(starts(result), [
    '20260105T090000Z',
    '20260106T090000Z',
    '20260107T090000Z',
  ]);
});

test('an `RDATE` past `UNTIL` stays: `UNTIL` bounds the rule only', () => {
  for (const embedded of [false, true]) {
    const result = expandOccurrences(
      [
        withZone(
          id(1),
          [
            [
              'DTSTART;TZID=Europe/Berlin:20261020T100000',
              'DTEND;TZID=Europe/Berlin:20261020T110000',
              'RRULE:FREQ=DAILY;UNTIL=20261024T080000Z',
              // Berlin's clocks go back on 25 October: 20 November is CET (+1),
              // so 10:00 wall is 09:00Z — and the rule's own `UNTIL` is days
              // behind it.
              'RDATE:20261120T090000Z',
            ],
          ],
          embedded ? 'Europe/Berlin' : undefined,
        ),
      ],
      { ...YEAR, tz: 'Europe/Berlin' },
    );
    assert.deepEqual(result.unsupported, []);
    assert.deepEqual(starts(result), [
      '20261020T080000Z',
      '20261021T080000Z',
      '20261022T080000Z',
      '20261023T080000Z',
      '20261024T080000Z',
      '20261120T090000Z',
    ]);
  }
});

test('a floating master and its override match on the wall clock, not an instant', () => {
  const objects = [
    objectOf(id(1), [
      [
        'DTSTART:20260601T090000',
        'DTEND:20260601T100000',
        'RRULE:FREQ=DAILY;COUNT=3',
      ],
      [
        'RECURRENCE-ID:20260602T090000',
        'DTSTART:20260620T090000',
        'DTEND:20260620T100000',
      ],
    ]),
  ];
  // A floating reading is read in the requested zone, and the `RECURRENCE-ID`
  // spells the same wall clock: the override removes 2 June and is reported by
  // its own times, which no instant comparison does outside `UTC`.
  const day = expandOccurrences(objects, {
    from: '20260601T000000Z',
    to: '20260604T000000Z',
    tz: 'America/New_York',
  });
  assert.deepEqual(starts(day), ['20260601T130000Z', '20260603T130000Z']);

  const moved = expandOccurrences(objects, {
    from: '20260620T000000Z',
    to: '20260621T000000Z',
    tz: 'America/New_York',
  });
  assert.deepEqual(starts(moved), ['20260620T130000Z']);
  assert.equal(moved.occurrences[0].override, true);
  assert.deepEqual(moved.occurrences[0].recurrenceId, {
    local: '20260602T090000',
  });

  // A `Z` `RECURRENCE-ID` names the same instant, and the key is still the wall
  // clock the requested zone reads for it.
  const zoned = expandOccurrences(
    [
      objectOf(id(1), [
        [
          'DTSTART:20260601T090000',
          'DTEND:20260601T100000',
          'RRULE:FREQ=DAILY;COUNT=3',
        ],
        [
          'RECURRENCE-ID:20260602T130000Z',
          'DTSTART:20260620T090000',
          'DTEND:20260620T100000',
        ],
      ]),
    ],
    {
      from: '20260601T000000Z',
      to: '20260604T000000Z',
      tz: 'America/New_York',
    },
  );
  assert.deepEqual(starts(zoned), ['20260601T130000Z', '20260603T130000Z']);
});

test('an instance in a spring gap is bounded by `UNTIL` by its instant', () => {
  // Berlin's spring gap is 2026-03-29: 02:30 does not exist there, and the
  // owner's ruling reads it with the offset before it, 01:30Z.
  /** @param {string} until */
  const expand = (until) => {
    const result = expandOccurrences(
      [
        numbered(1, [
          'DTSTART;TZID=Europe/Berlin:20260327T023000',
          'DTEND;TZID=Europe/Berlin:20260327T033000',
          `RRULE:FREQ=DAILY;UNTIL=${until}`,
        ]),
      ],
      { from: '20260320T000000Z', to: '20260410T000000Z', tz: 'Europe/Berlin' },
    );
    assert.deepEqual(result.unsupported, []);
    return starts(result);
  };
  // One second before the gap instance's own instant: the rule ends at the
  // second, even though the wall clock the library compares sits an hour later.
  assert.deepEqual(expand('20260329T012959Z'), [
    '20260327T013000Z',
    '20260328T013000Z',
  ]);
  assert.deepEqual(expand('20260329T013000Z'), [
    '20260327T013000Z',
    '20260328T013000Z',
    '20260329T013000Z',
  ]);
});

test('an all-day event is the requested zone’s midnight, not UTC’s', () => {
  /** @param {string} tz @param {string} from @param {string} to */
  const dates = (tz, from, to) =>
    expandOccurrences(
      [
        numbered(1, [
          'DTSTART;VALUE=DATE:20260310',
          'DTEND;VALUE=DATE:20260311',
        ]),
      ],
      { from, to, tz },
    ).occurrences.map((occurrence) => occurrence.start.date);

  // Kiritimati is UTC+14: 10 March starts 2026-03-09T10:00Z, a window that
  // holds it and an hour of the day after it that does not.
  assert.deepEqual(
    dates('Pacific/Kiritimati', '20260309T100000Z', '20260309T110000Z'),
    ['2026-03-10'],
  );
  assert.deepEqual(
    dates('Pacific/Kiritimati', '20260310T100000Z', '20260310T110000Z'),
    [],
  );
  // Pago Pago is UTC-11: the day runs past its UTC midnight by eleven hours.
  assert.deepEqual(
    dates('Pacific/Pago_Pago', '20260311T000000Z', '20260311T010000Z'),
    ['2026-03-10'],
  );
  assert.deepEqual(
    dates('Pacific/Pago_Pago', '20260310T000000Z', '20260310T010000Z'),
    [],
  );
});

test('an all-day override is placed by the requested zone’s midnights too', () => {
  const objects = [
    objectOf(id(1), [
      [
        'DTSTART;VALUE=DATE:20260301',
        'DTEND;VALUE=DATE:20260302',
        'RRULE:FREQ=DAILY;COUNT=20',
      ],
      [
        'RECURRENCE-ID;VALUE=DATE:20260310',
        'DTSTART;VALUE=DATE:20260401',
        'DTEND;VALUE=DATE:20260402',
      ],
    ]),
  ];
  /** @param {string} tz @param {string} from @param {string} to */
  const dates = (tz, from, to) =>
    expandOccurrences(objects, { from, to, tz }).occurrences.map(
      (occurrence) => occurrence.start.date,
    );

  assert.deepEqual(
    dates('Pacific/Kiritimati', '20260331T100000Z', '20260331T110000Z'),
    ['2026-04-01'],
  );
  assert.deepEqual(
    dates('Pacific/Kiritimati', '20260401T100000Z', '20260401T110000Z'),
    [],
  );
  assert.deepEqual(
    dates('Pacific/Pago_Pago', '20260401T110000Z', '20260401T120000Z'),
    ['2026-04-01'],
  );
  assert.deepEqual(
    dates('Pacific/Pago_Pago', '20260401T000000Z', '20260401T010000Z'),
    [],
  );
});

test('an instance far before the window costs no zone work', () => {
  // A daily Berlin series from 1971 puts ~20,000 instances before a 2026
  // window; each one the expansion reads costs several ICU calls, and the guard
  // skips them by wall clock. The bound is generous — with the guard the whole
  // expansion makes a few hundred calls — and the count, not a wall-clock
  // timing, is what the test holds.
  const original = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  Intl.DateTimeFormat.prototype.formatToParts = function (...args) {
    calls += 1;
    return original.apply(this, args);
  };
  try {
    const result = expandOccurrences(
      [
        numbered(1, [
          'DTSTART;TZID=Europe/Berlin:19710101T090000',
          'DTEND;TZID=Europe/Berlin:19710101T100000',
          'RRULE:FREQ=DAILY',
        ]),
      ],
      { from: '20260201T000000Z', to: '20260301T000000Z', tz: 'Europe/Berlin' },
    );
    assert.equal(result.occurrences.length, 28);
    assert.deepEqual(result.unsupported, []);
    assert.ok(calls < 5_000, `zone calls: ${calls}`);
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = original;
  }
});
