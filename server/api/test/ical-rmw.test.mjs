// --- E05-R04: the read-modify-write module -----------------------------------
//
// `src/ical-rmw.mjs` is the `roundTrip` the round-trip gate of E15-R01 was built
// to receive, so most of this suite is that gate: every fixture of
// `spec/ical-fixtures/` through `checkRoundTrip` with a no-op patch, and then
// field by field. A violation names a component, a property or a parameter and
// never a value, so a failure here can be re-run locally from its output.
//
// Two things make the field-by-field half more than a restatement of the no-op
// half: the comparison is **symmetric** (an added component, property or
// parameter fails as loudly as a lost one), and the expected difference set is
// written out per fixture. "A patch changes the field it names and nothing else"
// is therefore an assertion about a *known, complete* set of differences — not
// about an empty list, which a module that silently did nothing would also
// produce. The last test is the control for that: a deliberately lossy and a
// deliberately additive patch are both caught, with the property named.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkRoundTrip,
  fixtures,
  rawLines,
  readFixture,
} from './ical-roundtrip.mjs';
import {
  fixtureIds,
  readFixture as readRuleFixture,
} from './recurrence-corpus.mjs';
import {
  IcalError,
  assertOrder,
  build,
  describe,
  parse,
  patch,
  serialise,
} from '../src/ical-rmw.mjs';
import { resolves } from '../src/zones.mjs';

const corpus = fixtures();

/** A value that must never appear in a line of its own. */
const CANARY = 'CALFLEX_EVENT_CONTENT_CANARY';

/**
 * A round trip that parses, patches and writes back — the module's whole path.
 * @param {Record<string, unknown>} changes
 * @returns {(text: string) => string}
 */
const roundTripWith = (changes) => (/** @type {string} */ text) =>
  serialise(patch(parse(text), changes));

/**
 * One property's value in a text, unfolded, from the master `VEVENT`.
 * @param {string} text @param {string} name
 * @returns {string | undefined}
 */
const valueOf = (text, name) =>
  rawLines(text).find(
    (line) =>
      line.kind === 'property' &&
      line.path === 'VCALENDAR/VEVENT[0]' &&
      line.name === name,
  )?.value;

/**
 * One property's parameters, from the master `VEVENT`.
 * @param {string} text @param {string} name
 * @returns {string[]}
 */
const parametersOf = (text, name) =>
  rawLines(text).find(
    (line) =>
      line.kind === 'property' &&
      line.path === 'VCALENDAR/VEVENT[0]' &&
      line.name === name,
  )?.parameters ?? [];

/** Every content line of a component path, for comparing a kept component. */
const componentLines = (
  /** @type {string} */ text,
  /** @type {string} */ path,
) =>
  rawLines(text)
    .filter((line) => line.path === path || line.path.startsWith(`${path}/`))
    .map(
      (line) =>
        `${line.kind} ${line.name} ${line.parameters.join(';')} ${line.value ?? ''}`,
    );

/** A minimal skeleton the field tests can patch. */
const create = (/** @type {Record<string, unknown>} */ fields = {}) =>
  build({
    uid: '11111111-1111-4111-8111-111111111111',
    dtstamp: '20261014T080000Z',
    start: { utc: '20261014T090000Z' },
    end: { utc: '20261014T100000Z' },
    alarm: { trigger: '-PT15M' },
    envelopeSha256: 'a'.repeat(64),
    ...fields,
  });

test('the corpus: a no-op patch of every fixture loses nothing', () => {
  assert.ok(corpus.length > 0, 'the corpus is empty');
  for (const fixture of corpus) {
    const violations = checkRoundTrip({
      id: fixture.id,
      text: readFixture(fixture),
      roundTrip: roundTripWith({}),
    });
    assert.deepEqual(
      violations,
      [],
      `${fixture.id}: ${violations.join(' | ')}`,
    );
  }
});

test('every fixture: patching the stamp changes the stamp and nothing else', () => {
  for (const fixture of corpus) {
    const violations = checkRoundTrip({
      id: fixture.id,
      text: readFixture(fixture),
      roundTrip: roundTripWith({ dtstamp: '20300601T120000Z' }),
    });
    // `DTSTAMP` is a value-only change, so the symmetric comparison reports
    // exactly one difference: the value, on the master VEVENT.
    assert.equal(
      violations.length,
      1,
      `${fixture.id}: ${violations.join(' | ')}`,
    );
    assert.match(
      violations[0] ?? '',
      /: VCALENDAR\/VEVENT\[0\]: DTSTAMP\[0\]: value 0 differs \(/,
    );
  }
});

test('every fixture: patching the start changes the start and nothing else', () => {
  for (const fixture of corpus) {
    const text = readFixture(fixture);
    const before = describe(parse(text));
    // Patch with the kind the fixture already carries, so the *only* difference
    // a `TZID` fixture can show is the zone parameter the new instant does not
    // name. A fixture whose stored zone the resolver cannot read (the Microsoft
    // one) is the exception: E05-R09 refuses a patch that touches a time field
    // of such an object unless it replaces *both*, so this one moves both.
    const zoned = before.start.tzid !== undefined;
    const unreadable = zoned && !resolves(before.start.tzid);
    const changes = unreadable
      ? { start: { utc: '20300601T120000Z' }, end: { utc: '20300601T130000Z' } }
      : zoned
        ? { start: { utc: '20300601T120000Z' } }
        : before.start.date !== undefined
          ? { start: { date: '2030-06-01' } }
          : { start: { utc: '20300601T120000Z' } };
    const produced = roundTripWith(changes)(text);
    const violations = checkRoundTrip({
      id: fixture.id,
      text,
      roundTrip: roundTripWith(changes),
    });
    const expected = unreadable ? 4 : zoned ? 2 : 1;
    assert.equal(
      violations.length,
      expected,
      `${fixture.id}: ${violations.join(' | ')}`,
    );
    for (const violation of violations) {
      assert.match(
        violation,
        /^[^:]+: VCALENDAR\/VEVENT\[0\]: DT(?:START|END)\[0\]: (value 0 differs|parameter TZID)/,
        violation,
      );
    }
    // The field really moved, so "nothing else" is not the nothing of a patch
    // that never applied.
    const after = describe(parse(produced));
    assert.notDeepEqual(after.start, before.start);
    if (!unreadable) assert.deepEqual(after.end, before.end ?? null);
  }
});

test('a text field, a location and an attendee are written, escaped and kept', () => {
  const text = readFixture(
    /** @type {any} */ (
      corpus.find((f) => f.id === 'synthetic/x-properties-and-parameters')
    ),
  );
  const changes = {
    summary: 'Standup; and, a comma',
    description: 'first line\nsecond line',
    location: 'Room 1 \\ 2',
    attendees: ['mailto:alice@example.test', 'mailto:bob@example.test'],
  };
  const produced = roundTripWith(changes)(text);
  const violations = checkRoundTrip({
    id: 'synthetic/x-properties-and-parameters',
    text,
    roundTrip: roundTripWith(changes),
  });
  // Four values were replaced and two properties added, each reported once and
  // only for the property it belongs to.
  const named = new Set(
    violations.map((line) => line.replace(/^[^:]+: [^:]+: /, '').split('[')[0]),
  );
  assert.deepEqual([...named].sort(), [
    'ATTENDEE',
    'DESCRIPTION',
    'LOCATION',
    'SUMMARY',
  ]);

  // What was written is what comes back — `ical.js` escapes a text value on the
  // way out and unescapes it on the way in, so a newline never becomes a line.
  const calendar = parse(produced);
  const event = calendar.getFirstSubcomponent('vevent');
  assert.equal(
    event?.getFirstPropertyValue('summary'),
    'Standup; and, a comma',
  );
  assert.equal(
    event?.getFirstPropertyValue('description'),
    'first line\nsecond line',
  );
  assert.equal(event?.getFirstPropertyValue('location'), 'Room 1 \\ 2');
  assert.deepEqual(
    event?.getAllProperties('attendee').map((p) => p.getFirstValue()),
    ['mailto:alice@example.test', 'mailto:bob@example.test'],
  );
});

test('a value cannot become a second content line', () => {
  // A line feed is a legal part of a text value: `ical.js` escapes it as `\n`
  // and the value round-trips, so an injected line never appears.
  const text = serialise(
    patch(create(), {
      summary: `title\nX-EVIL:${CANARY}`,
      location: `here\nX-EVIL:${CANARY}`,
    }),
  );
  assert.deepEqual(
    rawLines(text).filter((line) => line.name.includes('X-EVIL')),
    [],
  );
  for (const name of ['SUMMARY', 'LOCATION']) {
    const value = valueOf(text, name) ?? '';
    assert.ok(!/[\r\n]/.test(value), `${name} holds a line break`);
    assert.ok(value.includes(CANARY), `${name} lost its value`);
  }
  assert.equal(
    rawLines(text).filter(
      (line) => line.kind === 'begin' && line.name === 'VEVENT',
    ).length,
    1,
  );

  // Every other control character is refused, a carriage return above all: it
  // ends a content line, and `ical.js` writes it through unescaped.
  for (const bad of [
    'x\r\ny',
    'x\ry',
    `x${String.fromCharCode(0)}y`,
    'x\ty',
    `x${String.fromCharCode(0x7f)}y`,
  ]) {
    assert.throws(
      () => patch(create(), { summary: bad }),
      (/** @type {any} */ error) =>
        error instanceof IcalError && error.kind === 'invalid-summary',
      JSON.stringify(bad),
    );
  }
});

test('a rule that is not a rule is refused, and a good one is written as the engine reads it', () => {
  for (const rrule of [
    'every day',
    'FREQ=FORTNIGHTLY',
    'RRULE:FREQ=DAILY',
    'FREQ=DAILY\r\nX-EVIL:1',
    'FREQ=DAILY;X=1\r\nX-EVIL:1',
    '',
    5,
  ]) {
    assert.throws(
      () => patch(create(), { rrule: /** @type {any} */ (rrule) }),
      (/** @type {any} */ error) =>
        error instanceof IcalError && error.kind === 'invalid-rrule',
      `accepted ${JSON.stringify(rrule)}`,
    );
  }
  const written = serialise(
    patch(create(), { rrule: 'FREQ=WEEKLY;BYDAY=WE;COUNT=6' }),
  );
  assert.equal(valueOf(written, 'RRULE'), 'FREQ=WEEKLY;COUNT=6;BYDAY=WE');
  // `null` removes the property, and so does an absent member not being sent.
  assert.equal(
    valueOf(serialise(patch(parse(written), { rrule: null })), 'RRULE'),
    undefined,
  );
});

test('every field the module cannot write is refused by kind', () => {
  /** @type {[Record<string, unknown>, string][]} */
  const cases = [
    [{ start: null }, 'invalid-start'],
    [{ start: '20261014T090000Z' }, 'invalid-start'],
    [{ start: {} }, 'invalid-start'],
    [
      { start: { date: '2026-10-12', utc: '20261014T090000Z' } },
      'invalid-start',
    ],
    [{ start: { date: '2026-02-30' } }, 'invalid-start'],
    [{ start: { date: '2026-10-1' } }, 'invalid-start'],
    [{ start: { utc: '20261014T090000' } }, 'invalid-start'],
    [{ start: { utc: '2026-10-14T09:00:00Z' } }, 'invalid-start'],
    [{ start: { utc: '20261340T090000Z' } }, 'invalid-start'],
    // The zone a write may name is an IANA zone, in its exact spelling, that the
    // resolver reads (E05-R09, INV-04).
    [{ start: { local: '20261014T100000' } }, 'invalid-start'],
    [
      { start: { tzid: 'europe/berlin', local: '20261014T100000' } },
      'invalid-start',
    ],
    [
      { start: { tzid: 'EUROPE/BERLIN', local: '20261014T100000' } },
      'invalid-start',
    ],
    [
      { start: { tzid: 'US/EASTERN', local: '20261014T100000' } },
      'invalid-start',
    ],
    [
      { start: { tzid: 'W. Europe Standard Time', local: '20261014T100000' } },
      'invalid-start',
    ],
    [
      { start: { tzid: 'Mars/Olympus', local: '20261014T100000' } },
      'invalid-start',
    ],
    [{ start: { tzid: '', local: '20261014T100000' } }, 'invalid-start'],
    [{ start: { tzid: 5, local: '20261014T100000' } }, 'invalid-start'],
    [
      {
        start: {
          tzid: 'Europe/Berlin',
          local: '20261014T100000',
          utc: '20261014T090000Z',
        },
      },
      'invalid-start',
    ],
    [
      { start: { tzid: 'Europe/Berlin', utc: '20261014T090000Z' } },
      'invalid-start',
    ],
    [{ start: { tzid: 'Europe/Berlin', date: '2026-10-14' } }, 'invalid-start'],
    [
      { start: { tzid: 'Europe/Berlin', local: '2026-10-14T10:00:00' } },
      'invalid-start',
    ],
    [
      { start: { tzid: 'Europe/Berlin', local: '20261014t100000' } },
      'invalid-start',
    ],
    [
      { start: { tzid: 'Europe/Berlin', local: '20260230T100000' } },
      'invalid-start',
    ],
    [
      { start: { tzid: 'Europe/Berlin', local: '20261014T250000' } },
      'invalid-start',
    ],
    [
      { start: { tzid: 'Europe/Berlin', local: '20261014T1000' } },
      'invalid-start',
    ],
    [{ start: { tzid: 'Europe/Berlin', local: 5 } }, 'invalid-start'],
    // The embedded `VTIMEZONE` covers 1970–2100 (`HORIZON`): a reading outside
    // it would be an object whose own definition disagrees with `parsed`.
    [
      { start: { tzid: 'Europe/Berlin', local: '19691014T100000' } },
      'invalid-start',
    ],
    [
      { start: { tzid: 'Europe/Berlin', local: '19700101T100000' } },
      'invalid-start',
    ],
    [
      { start: { tzid: 'Europe/Berlin', local: '21020101T100000' } },
      'invalid-start',
    ],
    [{ end: '20261014T100000Z' }, 'invalid-end'],
    [{ dtstamp: '2026-10-14T08:00:00Z' }, 'invalid-dtstamp'],
    [{ dtstamp: '20261014T090000' }, 'invalid-dtstamp'],
    [{ envelopeSha256: 'a'.repeat(63) }, 'invalid-envelope'],
    [{ envelopeSha256: 'A'.repeat(64) }, 'invalid-envelope'],
    [{ envelopeSha256: 5 }, 'invalid-envelope'],
    [{ summary: 5 }, 'invalid-summary'],
    [{ description: 5 }, 'invalid-description'],
    [{ location: 5 }, 'invalid-location'],
    [{ attendees: 'mailto:a@example.test' }, 'invalid-attendees'],
    [{ attendees: ['nope'] }, 'invalid-attendees'],
    [{ attendees: ['mailto:a@example.test;b'] }, 'invalid-attendees'],
    [{ attendees: ['mailto:a@example.test\r\nX-EVIL:1'] }, 'invalid-attendees'],
    [{ sequence: -1 }, 'invalid-sequence'],
    [{ sequence: 1.5 }, 'invalid-sequence'],
    [{ alarm: '-PT15M' }, 'invalid-alarm'],
    [{ alarm: {} }, 'invalid-alarm'],
    [{ alarm: { trigger: 'fifteen minutes' } }, 'invalid-alarm'],
    [{ alarm: { trigger: 5 } }, 'invalid-alarm'],
  ];
  for (const [changes, kind] of cases) {
    assert.throws(
      () => patch(create(), changes),
      (/** @type {any} */ error) =>
        error instanceof IcalError && error.kind === kind,
      `${JSON.stringify(changes)}: expected ${kind}`,
    );
  }
});

test('an object the module cannot read is refused by kind and echoes nothing', () => {
  /** @type {[unknown, string][]} */
  const cases = [
    ['', 'unparsable'],
    ['   ', 'unparsable'],
    ['not an iCalendar object', 'unparsable'],
    ['BEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT', 'not-calendar'],
  ];
  for (const [text, kind] of cases) {
    const value = /** @type {string} */ (text);
    assert.throws(
      () => parse(value),
      (/** @type {any} */ error) =>
        error instanceof IcalError &&
        error.kind === kind &&
        (value.trim() === '' || !error.message.includes(value)),
      JSON.stringify(value),
    );
  }
  // A `VCALENDAR` with no `VEVENT`, and one whose `VEVENT` has no `UID`: both are
  // objects this API cannot describe, and neither is a parse failure.
  for (const [text, kind] of [
    ['BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR', 'no-event'],
    [
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR',
      'no-uid',
    ],
  ]) {
    assert.throws(
      () => describe(parse(/** @type {string} */ (text))),
      (/** @type {any} */ error) =>
        error instanceof IcalError && error.kind === kind,
      text,
    );
  }
});

test('an invalid time pair is refused on the merged object, and the corpus states stay valid', () => {
  // A valid pair passes, and so does the same object after an edit that keeps it
  // valid.
  assert.doesNotThrow(() => assertOrder(create()));
  assert.doesNotThrow(() =>
    assertOrder(patch(create(), { start: { utc: '20261014T093000Z' } })),
  );

  /** @type {[Record<string, unknown>, string][]} */
  const refused = [
    // The two value types are never mixed (§ 3.8.2.2): an all-day start with an
    // instant end, and the reverse.
    [{ start: { date: '2026-10-12' } }, 'instant end, date start'],
    [{ end: { date: '2026-10-13' } }, 'instant start, date end'],
    // An end at or before its start is not a span.
    [{ end: { utc: '20261014T090000Z' } }, 'end equal to the start'],
    [{ end: { utc: '20261014T083000Z' } }, 'end before the start'],
    [{ start: { utc: '20261014T110000Z' } }, 'start after the stored end'],
  ];
  for (const [changes, what] of refused) {
    assert.throws(
      () => assertOrder(patch(create(), changes)),
      (/** @type {any} */ error) =>
        error instanceof IcalError && error.kind === 'invalid-times',
      what,
    );
  }

  // An all-day object is checked the same way.
  const allDay = create({
    start: { date: '2026-10-12' },
    end: { date: '2026-10-13' },
  });
  assert.doesNotThrow(() => assertOrder(allDay));
  assert.throws(
    () => assertOrder(patch(allDay, { end: { date: '2026-10-12' } })),
    (/** @type {any} */ error) => error.kind === 'invalid-times',
  );

  // Every stored fixture is a valid pair — the corpus is what a read-modify-write
  // has to keep working, and a `TZID` pair in one zone compares as wall clocks.
  for (const fixture of corpus) {
    assert.doesNotThrow(
      () => assertOrder(parse(readFixture(fixture))),
      fixture.id,
    );
  }

  // A `Z` instant beside a `TZID` wall clock is compared through the zone now:
  // `20261014T100000` in `Europe/Berlin` is `20261014T080000Z`, so a `Z` start
  // after it is the same 422 as any other inverted pair, and one before it is
  // the same 200.
  const zoned = /** @type {any} */ (
    corpus.find((entry) => entry.id === 'ours/private-timed-tzid')
  );
  const zonedText = readFixture(zoned);
  assert.throws(
    () =>
      assertOrder(
        patch(parse(zonedText), { start: { utc: '20300601T120000Z' } }),
      ),
    (/** @type {any} */ error) =>
      error instanceof IcalError && error.kind === 'invalid-times',
    'a Z start after the stored TZID end',
  );
  assert.doesNotThrow(() =>
    assertOrder(
      patch(parse(zonedText), { start: { utc: '20261014T070000Z' } }),
    ),
  );

  // A `TZID` pair whose zone the resolver cannot read is left alone (the
  // Microsoft fixture of the corpus), and so is a floating pair — neither names
  // an instant this API can compute (INV-02).
  const windows = /** @type {any} */ (
    corpus.find((entry) => entry.id === 'synthetic/microsoft-windows-zone-name')
  );
  assert.doesNotThrow(() => assertOrder(parse(readFixture(windows))));
});

test('a TZID write carries its zone as a parameter and embeds one VTIMEZONE', () => {
  const calendar = () =>
    build({
      uid: '22222222-2222-4222-8222-222222222222',
      dtstamp: '20261014T080000Z',
      start: { local: '20261014T100000', tzid: 'Europe/Berlin' },
      end: { local: '20261014T110000', tzid: 'Europe/Berlin' },
      envelopeSha256: 'a'.repeat(64),
    });
  const text = serialise(calendar());
  assert.equal(valueOf(text, 'DTSTART'), '20261014T100000');
  assert.deepEqual(parametersOf(text, 'DTSTART'), ['TZID=Europe/Berlin']);
  assert.deepEqual(parametersOf(text, 'DTEND'), ['TZID=Europe/Berlin']);
  // One definition, in front of the events, and it is the generated one.
  const begins = rawLines(text).filter(
    (line) => line.kind === 'begin' && line.name === 'VTIMEZONE',
  );
  assert.equal(begins.length, 1);
  assert.ok(
    text.indexOf('BEGIN:VTIMEZONE') < text.indexOf('BEGIN:VEVENT'),
    'the VTIMEZONE comes after the events',
  );
  assert.match(text, /^TZID:Europe\/Berlin$/m);
  assert.match(text, /^X-LIC-LOCATION:Europe\/Berlin$/m);
  // The reading comes back as the wall clock the object spells, with the
  // instant a client should show for it (E05-R09).
  assert.deepEqual(describe(parse(text)).start, {
    tzid: 'Europe/Berlin',
    local: '20261014T100000',
    utc: '20261014T080000Z',
  });

  // A second write of the same zone adds no second definition, and the one that
  // is there comes back byte for byte (INV-02).
  const again = serialise(
    patch(parse(text), {
      start: { local: '20261014T120000', tzid: 'Europe/Berlin' },
    }),
  );
  assert.equal(
    again.match(/BEGIN:VTIMEZONE/g)?.length,
    1,
    'a second VTIMEZONE was embedded',
  );
  assert.deepEqual(
    componentLines(again, 'VCALENDAR/VTIMEZONE[0]'),
    componentLines(text, 'VCALENDAR/VTIMEZONE[0]'),
  );

  // A write into another zone embeds that zone too, in front of the events.
  const other = serialise(
    patch(parse(text), {
      end: { local: '20261014T110000', tzid: 'America/New_York' },
    }),
  );
  assert.equal(other.match(/BEGIN:VTIMEZONE/g)?.length, 2);
  assert.match(other, /^TZID:America\/New_York$/m);
  assert.ok(
    other.indexOf('TZID:America/New_York') < other.indexOf('BEGIN:VEVENT'),
  );
  assert.deepEqual(describe(parse(other)).end, {
    tzid: 'America/New_York',
    local: '20261014T110000',
    utc: '20261014T150000Z',
  });

  // A fixture that already defines its zone keeps that definition: only the
  // value the patch named differs over the whole object.
  const fixture = /** @type {any} */ (
    corpus.find((entry) => entry.id === 'ours/private-timed-tzid')
  );
  const fixtureText = readFixture(fixture);
  const changes = {
    start: { local: '20261101T090000', tzid: 'Europe/Berlin' },
  };
  const violations = checkRoundTrip({
    id: fixture.id,
    text: fixtureText,
    roundTrip: roundTripWith(changes),
  });
  assert.equal(violations.length, 1, violations.join(' | '));
  assert.match(violations[0] ?? '', /DTSTART\[0\]: value 0 differs/);
});

test('a patch of an object whose stored TZID cannot be read keeps it or replaces both', () => {
  const fixture = /** @type {any} */ (
    corpus.find((entry) => entry.id === 'synthetic/microsoft-windows-zone-name')
  );
  const text = readFixture(fixture);
  // A read reports the wall clock and the name it cannot resolve, and no instant.
  const before = describe(parse(text));
  assert.equal(before.start.tzid, 'W. Europe Standard Time');
  assert.equal(before.start.local, '20261014T100000');
  assert.equal(before.start.utc, undefined);

  // A patch that does not name a time leaves the object as it is, the stored
  // zone and its own VTIMEZONE included (INV-02).
  const kept = roundTripWith({ summary: 'a later title' })(text);
  assert.deepEqual(
    componentLines(kept, 'VCALENDAR/VTIMEZONE[0]'),
    componentLines(text, 'VCALENDAR/VTIMEZONE[0]'),
  );
  assert.deepEqual(parametersOf(kept, 'DTSTART'), [
    'TZID=W. Europe Standard Time',
  ]);

  // Touching one time field is the fixed 422 ...
  for (const changes of [
    { start: { utc: '20300601T120000Z' } },
    { end: { utc: '20300601T130000Z' } },
    { start: { local: '20261014T120000', tzid: 'Europe/Berlin' } },
  ]) {
    assert.throws(
      () => patch(parse(text), changes),
      (/** @type {any} */ error) =>
        error instanceof IcalError && error.kind === 'invalid-timezone',
      JSON.stringify(changes),
    );
  }

  // ... and replacing both is written, with the zone the object still defines
  // left exactly where it was.
  const replaced = serialise(
    patch(parse(text), {
      start: { utc: '20300601T120000Z' },
      end: { utc: '20300601T130000Z' },
    }),
  );
  assert.match(replaced, /^DTSTART:20300601T120000Z$/m);
  assert.match(replaced, /^DTEND:20300601T130000Z$/m);
  assert.match(replaced, /^TZID:W\. Europe Standard Time$/m);
});

test('a TZID write inside the horizon is written, and one outside it is not', () => {
  // The ends of the window the embedded definition covers: the last instant of
  // 2100 and the first days of 1970. A reading at the very start of the window
  // is refused, because the definition's first change sits there.
  const zoned = (/** @type {string} */ local) =>
    describe(
      parse(
        serialise(
          build({
            uid: '55555555-5555-4555-8555-555555555555',
            dtstamp: '20261014T080000Z',
            start: { local, tzid: 'Europe/Berlin' },
            envelopeSha256: 'a'.repeat(64),
          }),
        ),
      ),
    ).start;
  assert.deepEqual(zoned('19700102T100000'), {
    tzid: 'Europe/Berlin',
    local: '19700102T100000',
    utc: '19700102T090000Z',
  });
  assert.deepEqual(zoned('21001231T100000'), {
    tzid: 'Europe/Berlin',
    local: '21001231T100000',
    utc: '21001231T090000Z',
  });
  // A `Z` time names its own instant and needs no definition, so it is written
  // whatever the date.
  const instant = serialise(
    build({
      uid: '66666666-6666-4666-8666-666666666666',
      dtstamp: '20261014T080000Z',
      start: { utc: '19600101T100000Z' },
      envelopeSha256: 'a'.repeat(64),
    }),
  );
  assert.equal(valueOf(instant, 'DTSTART'), '19600101T100000Z');
  assert.deepEqual(describe(parse(instant)).start, {
    utc: '19600101T100000Z',
  });
});

test('driving the transition across the gap and back again', () => {
  // The three write forms side by side, at the two transitions `Europe/Berlin`
  // has in 2026: a local time is written as the wall clock the caller sent, and
  // the instant it names is the RFC 5545 § 3.3.5 form 3 reading of it.
  const zoned = (/** @type {string} */ local) =>
    describe(
      parse(
        serialise(
          build({
            uid: '33333333-3333-4333-8333-333333333333',
            dtstamp: '20261014T080000Z',
            start: { local, tzid: 'Europe/Berlin' },
            envelopeSha256: 'a'.repeat(64),
          }),
        ),
      ),
    ).start;
  // The hour that does not exist is read with the offset before the gap ...
  assert.deepEqual(zoned('20260329T023000'), {
    tzid: 'Europe/Berlin',
    local: '20260329T023000',
    utc: '20260329T013000Z',
  });
  // ... and the hour that happens twice is its first occurrence.
  assert.deepEqual(zoned('20261025T023000'), {
    tzid: 'Europe/Berlin',
    local: '20261025T023000',
    utc: '20261025T003000Z',
  });
});

test('an UNTIL beside a TZID start is a UTC instant, and is refused otherwise', () => {
  const zoned = () =>
    build({
      uid: '44444444-4444-4444-8444-444444444444',
      dtstamp: '20261014T080000Z',
      start: { local: '20261014T100000', tzid: 'Europe/Berlin' },
      end: { local: '20261014T110000', tzid: 'Europe/Berlin' },
      envelopeSha256: 'a'.repeat(64),
    });
  for (const rrule of [
    'FREQ=DAILY;UNTIL=20261015',
    'FREQ=DAILY;UNTIL=20261015T090000',
  ]) {
    assert.throws(
      () => patch(zoned(), { rrule }),
      (/** @type {any} */ error) =>
        error instanceof IcalError && error.kind === 'invalid-rrule',
      rrule,
    );
  }
  const written = serialise(
    patch(zoned(), { rrule: 'FREQ=DAILY;UNTIL=20261015T090000Z' }),
  );
  assert.equal(valueOf(written, 'RRULE'), 'FREQ=DAILY;UNTIL=20261015T090000Z');
  assert.doesNotThrow(() => assertOrder(parse(written)));
});

test('only the rule parts RFC 5545 names are written, and none ical.js mis-expands', () => {
  const allDay = () =>
    create({ start: { date: '2026-10-12' }, end: { date: '2026-10-13' } });
  /** @type {[any, string, string][]} */
  const refused = [
    [create(), 'FREQ=DAILY;EXDATE=20261015', 'a part the RFC does not name'],
    [create(), 'FREQ=DAILY;BYEASTER=1', 'a part the RFC does not name'],
    [create(), 'FREQ=DAILY;COUNT=3;COUNT=4', 'a part twice'],
    [create(), 'FREQ=DAILY;UNTIL=20261015T090000Z;COUNT=3', 'UNTIL with COUNT'],
    [create(), 'UNTIL=20261015T090000Z;FREQ=DAILY', 'FREQ not first'],
    [create(), 'COUNT=3', 'FREQ absent'],
    [create(), 'FREQ=DAILY;FREQ=WEEKLY', 'FREQ twice'],
    // `ical.js` 2.2.1 expands these wrongly (`spec/ical-fixtures/RULINGS.md`):
    // `BYWEEKNO` counts the ISO week, and a yearly rule on a 29 February anchor
    // rolls the invalid date forward instead of skipping it.
    [create(), 'FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO;COUNT=5', 'BYWEEKNO'],
    [create(), 'FREQ=YEARLY;BYWEEKNO=20', 'BYWEEKNO without BYDAY'],
    [
      create({ start: { utc: '20240229T090000Z' }, end: null }),
      'FREQ=YEARLY',
      'a yearly rule on a 29 February start',
    ],
    [
      create({ start: { date: '2024-02-29' }, end: null }),
      'FREQ=YEARLY',
      'a yearly rule on an all-day 29 February start',
    ],
    // `UNTIL` carries the value type of the start: a `DATE` for an all-day rule,
    // a UTC `DATE-TIME` for a timed one.
    [
      allDay(),
      'FREQ=DAILY;UNTIL=20261015T090000Z',
      'an instant UNTIL on a date start',
    ],
    [create(), 'FREQ=DAILY;UNTIL=20261015', 'a date UNTIL on a timed start'],
    [create(), 'FREQ=DAILY;UNTIL=20261015T090000', 'a floating UNTIL'],
  ];
  for (const [calendar, rrule, what] of refused) {
    assert.throws(
      () => patch(calendar, { rrule }),
      (/** @type {any} */ error) =>
        error instanceof IcalError && error.kind === 'invalid-rrule',
      `${what}: ${rrule}`,
    );
  }

  // The rules a client may write, written as the engine reads them: `UNTIL` of
  // either value type, the parts `ical.js` expands correctly, and a yearly rule
  // on a 29 February that is not the anchor.
  /** @type {[any, string, string][]} */
  const written = [
    [allDay(), 'FREQ=DAILY;UNTIL=20261015', 'FREQ=DAILY;UNTIL=20261015'],
    [
      create(),
      'FREQ=DAILY;UNTIL=20261015T090000Z',
      'FREQ=DAILY;UNTIL=20261015T090000Z',
    ],
    [
      create(),
      'FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3',
      'FREQ=MONTHLY;COUNT=3;BYMONTHDAY=-1',
    ],
    [allDay(), 'FREQ=YEARLY;COUNT=2', 'FREQ=YEARLY;COUNT=2'],
  ];
  for (const [calendar, rrule, expected] of written) {
    assert.equal(
      valueOf(serialise(patch(calendar, { rrule })), 'RRULE'),
      expected,
      rrule,
    );
  }
  // A yearly rule on a 29 February is the anchor, and a yearly one on 1 March is
  // not: only the first is refused.
  assert.doesNotThrow(() =>
    patch(create({ start: { utc: '20240301T090000Z' }, end: null }), {
      rrule: 'FREQ=YEARLY;COUNT=2',
    }),
  );
});

test('every rule the recurrence corpus carries is accepted, except the two the rulings refuse', () => {
  // `spec/ical-fixtures/RULINGS.md` records that `ical.js` 2.2.1 expands two
  // families of rule wrongly: `BYWEEKNO` counts ISO weeks and the library reads
  // the value as a weekday ordinal, and a yearly rule anchored on 29 February
  // rolls the invalid date forward to 1 March and counts it. The API refuses a
  // write of both instead of handing its clients an expanded rule it knows is
  // wrong — and accepts every other rule the corpus carries, which is what makes
  // the refusal a decision rather than an accident.
  const refused = [
    'yearly-byweekno-20-monday-count-5',
    'yearly-leap-day-all-day',
  ];
  /** @type {string[]} */
  const rejected = [];
  let seen = 0;
  for (const id of fixtureIds()) {
    const lines = rawLines(readRuleFixture(id));
    const paths = [
      ...new Set(
        lines
          .map((line) => line.path)
          .filter((path) => /^VCALENDAR\/VEVENT\[\d+\]$/.test(path ?? '')),
      ),
    ];
    const master = paths.find(
      (path) =>
        !lines.some(
          (line) => line.path === path && line.name === 'RECURRENCE-ID',
        ),
    );
    const properties = lines.filter(
      (line) => line.path === master && line.kind === 'property',
    );
    const rrule = properties.find((line) => line.name === 'RRULE');
    const dtstart = properties.find((line) => line.name === 'DTSTART');
    if (rrule === undefined || dtstart === undefined) continue;
    seen += 1;
    // The corpus carries `TZID` starts, which a write cannot send until E05-R09;
    // the value's type is what the rule's `UNTIL` is checked against, and the
    // wall clock is enough for that.
    const start = dtstart.parameters.includes('VALUE=DATE')
      ? { date: dtstart.value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') }
      : { utc: /Z$/.test(dtstart.value) ? dtstart.value : `${dtstart.value}Z` };
    try {
      build({
        uid: '11111111-1111-4111-8111-111111111111',
        dtstamp: '20261014T080000Z',
        start,
        end: null,
        rrule: rrule.value,
        envelopeSha256: 'a'.repeat(64),
        alarm: null,
      });
    } catch (error) {
      assert.ok(
        error instanceof IcalError && error.kind === 'invalid-rrule',
        `${id}: ${rrule.value}`,
      );
      rejected.push(id);
    }
  }
  assert.equal(seen, fixtureIds().length, 'a fixture carried no rule to check');
  assert.deepEqual(rejected, refused);
});

test('build writes the skeleton, and describe reads back what it wrote', () => {
  const calendar = create({
    rrule: 'FREQ=WEEKLY;BYDAY=WE;COUNT=6',
    sequence: 3,
  });
  const text = serialise(calendar);
  const parsed = describe(parse(text));
  assert.deepEqual(parsed, {
    uid: '11111111-1111-4111-8111-111111111111',
    start: { utc: '20261014T090000Z' },
    end: { utc: '20261014T100000Z' },
    rrule: 'FREQ=WEEKLY;COUNT=6;BYDAY=WE',
    alarm: { trigger: '-PT15M' },
    sequence: 3,
    envelopeSha256: 'a'.repeat(64),
  });
  assert.match(text, /^PRODID:-\/\/flexcalendar\/\/Private skeleton\/\/EN$/m);
  assert.match(text, /^VERSION:2\.0$/m);

  // An all-day event: `VALUE=DATE`, and `end: null` is no `DTEND` at all.
  const allDay = serialise(
    create({ start: { date: '2026-10-12' }, end: null, alarm: null }),
  );
  assert.equal(valueOf(allDay, 'DTSTART'), '20261012');
  assert.deepEqual(
    rawLines(allDay).find(
      (line) => line.kind === 'property' && line.name === 'DTSTART',
    )?.parameters,
    ['VALUE=DATE'],
  );
  assert.equal(valueOf(allDay, 'DTEND'), undefined);
  assert.deepEqual(describe(parse(allDay)).start, { date: '2026-10-12' });
  assert.deepEqual(describe(parse(allDay)).end, null);

  assert.throws(
    () =>
      build({
        uid: '',
        start: { utc: '20261014T090000Z' },
        dtstamp: '20261014T080000Z',
      }),
    (/** @type {any} */ error) => error.kind === 'invalid-uid',
  );
});

test('a patch of a master leaves the override component untouched', () => {
  const fixture = /** @type {any} */ (
    corpus.find((entry) => entry.id === 'ours/private-weekly-exdate-override')
  );
  const text = readFixture(fixture);
  const produced = roundTripWith({ start: { utc: '20300601T120000Z' } })(text);
  /** @param {string} value */
  const override = (value) =>
    rawLines(value)
      .filter((line) => line.path === 'VCALENDAR/VEVENT[1]')
      .map(
        (line) =>
          `${line.kind} ${line.name} ${line.parameters.join(';')} ${line.value}`,
      );
  assert.ok(override(text).length > 0, 'the fixture has no override');
  assert.deepEqual(override(produced), override(text));
  // …and the master is the component that moved.
  assert.equal(valueOf(produced, 'DTSTART'), '20300601T120000Z');
  assert.equal(valueOf(text, 'DTSTART'), '20261014T100000');
});

test('the corpus gate catches a patch that drops or adds a property', () => {
  // The control for the two field-by-field tests above: a lossy patch and an
  // additive one are both caught, and the property is named.
  const id = 'ours/private-allday';
  const fixture = /** @type {any} */ (corpus.find((entry) => entry.id === id));
  const text = readFixture(fixture);
  const lossy = checkRoundTrip({
    id,
    text,
    roundTrip: (/** @type {string} */ source) => {
      const calendar = parse(source);
      calendar
        .getFirstSubcomponent('vevent')
        ?.removeAllProperties('x-calflex-envelope-sha256');
      return serialise(calendar);
    },
  });
  assert.equal(lossy.length, 1, lossy.join(' | '));
  assert.match(
    lossy[0] ?? '',
    /X-CALFLEX-ENVELOPE-SHA256\[0\]: the property is in the fixture but not in the output/,
  );

  const additive = checkRoundTrip({
    id,
    text,
    roundTrip: roundTripWith({ summary: 'added' }),
  });
  assert.equal(additive.length, 1, additive.join(' | '));
  assert.match(
    additive[0] ?? '',
    /SUMMARY\[0\]: the property is in the output but not in the fixture/,
  );
});
