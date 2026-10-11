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
  IcalError,
  build,
  describe,
  parse,
  patch,
  serialise,
} from '../src/ical-rmw.mjs';

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
    // name — a `TZID` write is a 422 until E05-R09 lands, and a read-modify-write
    // never invents one.
    const zoned = before.start.tzid !== undefined;
    const changes = zoned
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
    const expected = zoned ? 2 : 1;
    assert.equal(
      violations.length,
      expected,
      `${fixture.id}: ${violations.join(' | ')}`,
    );
    for (const violation of violations) {
      assert.match(
        violation,
        /^[^:]+: VCALENDAR\/VEVENT\[0\]: DTSTART\[0\]: (value 0 differs|parameter TZID)/,
        violation,
      );
    }
    // The field really moved, so "nothing else" is not the nothing of a patch
    // that never applied.
    const after = describe(parse(produced));
    assert.notDeepEqual(after.start, before.start);
    assert.deepEqual(after.end, before.end ?? null);
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
    [
      { start: { tzid: 'Europe/Berlin', local: '20261014T100000' } },
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
