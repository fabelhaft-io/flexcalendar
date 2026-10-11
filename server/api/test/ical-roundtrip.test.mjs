// E15-R01: the API component's own gate over the round-trip corpus.
//
// `spec/ical-fixtures/ours/` and `spec/ical-fixtures/synthetic/` are read with
// `ical.js` (the API's iCalendar engine) and written back through the default
// read-modify-write path, `ICAL.parse` -> `toString()`. The gate fails on a
// lost component, property, parameter or value, and on an output that no longer
// defines the `TZID`s it uses. E05-R04's module is what will replace the default
// path; its own unit test covers this same corpus, and this suite keeps
// covering the engine underneath it.
//
// The deliberately lossy round trips below are the evidence that the gate can
// fail: each drops exactly one thing and is required to be caught, named and
// reported without printing a value. Those tests are the difference between a
// suite that checks something and one that has only ever been seen to pass.

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import ICAL from 'ical.js';

import {
  checkRoundTrip,
  corpusRoot,
  defaultRoundTrip,
  describeValue,
  fixtures,
  readFixture,
  sourceNoteViolation,
} from './ical-roundtrip.mjs';

const corpus = fixtures();

/**
 * @param {string} id
 * @returns {string}
 */
function fixtureText(id) {
  const fixture = corpus.find((candidate) => candidate.id === id);
  assert.ok(fixture, `${id}: not a fixture of the corpus`);
  return readFixture(fixture);
}

/** @param {string} source @returns {string[]} the texts of one source's fixtures */
function sourceTexts(source) {
  return corpus
    .filter((fixture) => fixture.source === source)
    .map((fixture) => readFixture(fixture));
}

const APPLE = 'synthetic/apple-apple-properties';
const THUNDERBIRD = 'synthetic/x-properties-and-parameters';

/**
 * A round trip that runs `mutate` on the parsed fixture and serialises the
 * result. It is called while the fixture's own zones are registered, which is
 * what a real read-modify-write path would do too.
 * @param {(calendar: ICAL.Component) => void} mutate
 * @returns {(text: string) => string}
 */
function lossy(mutate) {
  return (text) => {
    const calendar = new ICAL.Component(ICAL.parse(text));
    mutate(calendar);
    return calendar.toString();
  };
}

/** @param {string} name @param {string} parameter */
const dropParameter = (name, parameter) =>
  lossy((calendar) => {
    const event = calendar.getFirstSubcomponent('vevent');
    assert.ok(event);
    for (const property of event.getAllProperties(name.toLowerCase()))
      property.removeParameter(parameter.toLowerCase());
  });

/** @param {string} name */
const dropProperty = (name) =>
  lossy((calendar) => {
    const event = calendar.getFirstSubcomponent('vevent');
    assert.ok(event);
    event.removeProperty(name.toLowerCase());
  });

/** @param {string} name */
const dropComponent = (name) =>
  lossy((calendar) => {
    const event = calendar.getFirstSubcomponent('vevent');
    assert.ok(event);
    const component = event.getFirstSubcomponent(name.toLowerCase());
    assert.ok(component);
    event.removeSubcomponent(component);
  });

const dropTimezone = lossy((calendar) => {
  const zone = calendar.getFirstSubcomponent('vtimezone');
  assert.ok(zone);
  calendar.removeSubcomponent(zone);
});

test('the corpus holds both Phase-1 sources and is not empty', () => {
  assert.ok(corpus.length > 0, 'the corpus has no fixtures');
  assert.ok(
    corpus.filter((fixture) => fixture.source === 'ours').length >= 5,
    'ours/ does not cover the Private skeleton',
  );
  assert.ok(
    corpus.filter((fixture) => fixture.source === 'synthetic').length >= 7,
    'synthetic/ does not cover the stock-app behaviours',
  );
  for (const fixture of corpus)
    assert.ok(fixture.id.startsWith(`${fixture.source}/`), fixture.id);
});

test('every fixture carries a source note beside it', () => {
  for (const fixture of corpus)
    assert.equal(sourceNoteViolation(fixture), '', fixture.id);
});

test('every source note belongs to a fixture', () => {
  for (const source of new Set(corpus.map((fixture) => fixture.source))) {
    const directory = join(corpusRoot, source);
    const notes = readdirSync(directory)
      .filter((file) => file.endsWith('.source.md'))
      .map((file) => file.slice(0, -'.source.md'.length))
      .sort();
    const ids = corpus
      .filter((fixture) => fixture.source === source)
      .map((fixture) => fixture.id.slice(source.length + 1))
      .sort();
    assert.deepEqual(notes, ids, `${source}: a source note has no fixture`);
  }
});

test('the corpus covers the behaviours E15-R01 names', () => {
  const ours = sourceTexts('ours');
  const synthetic = sourceTexts('synthetic');
  /** @param {string[]} texts @param {RegExp} pattern */
  const some = (texts, pattern) => texts.some((text) => pattern.test(text));
  // `ours/`: what our own writer emits today, per the Private skeleton.
  assert.ok(
    ours.some(
      (text) =>
        /DTSTART;TZID=[A-Za-z]+\/[A-Za-z_+-]+:/.test(text) &&
        /BEGIN:VTIMEZONE/.test(text),
    ),
    'ours/: no timed event with an IANA TZID and its VTIMEZONE',
  );
  assert.ok(
    ours.some((text) => /DTSTART:\d{8}T\d{6}Z/.test(text)),
    'ours/: no UTC event',
  );
  assert.ok(
    ours.some((text) => /DTSTART;VALUE=DATE:/.test(text)),
    'ours/: no all-day event',
  );
  assert.ok(
    ours.some(
      (text) =>
        /RRULE:FREQ=WEEKLY/.test(text) &&
        /EXDATE/.test(text) &&
        /RECURRENCE-ID/.test(text),
    ),
    'ours/: no weekly master with an EXDATE and an override',
  );
  assert.ok(
    ours.some((text) => /BEGIN:VALARM/.test(text)),
    'ours/: no VALARM',
  );
  for (const text of ours) {
    const events = text.match(/BEGIN:VEVENT/g) ?? [];
    const hashes = text.match(/X-CALFLEX-ENVELOPE-SHA256:/g) ?? [];
    assert.equal(
      hashes.length,
      events.length,
      'ours/: every VEVENT carries exactly one envelope hash',
    );
  }

  // `synthetic/`: what stock apps emit, per the epic.
  assert.ok(
    some(synthetic, /X-APPLE-/),
    'synthetic/: nothing imitates an Apple X-APPLE-* property',
  );
  assert.ok(
    synthetic.some((text) => /TZID:[^\r\n]* [^\r\n]*\r?\n/.test(text)),
    'synthetic/: no Windows zone name in TZID',
  );
  assert.ok(
    synthetic.some((text) => /\r?\n[A-Z0-9-]+;[Xx]-[A-Za-z0-9-]+=/.test(text)),
    'synthetic/: no X- parameter',
  );
  assert.ok(
    some(synthetic, /DTSTART;VALUE=DATE:/),
    'synthetic/: no all-day event',
  );
  assert.ok(
    synthetic.some(
      (text) => /RRULE:FREQ=WEEKLY/.test(text) && /EXDATE/.test(text),
    ),
    'synthetic/: no weekly RRULE with an EXDATE',
  );
  assert.ok(
    some(synthetic, /RECURRENCE-ID/),
    'synthetic/: no override with a RECURRENCE-ID',
  );
  assert.ok(some(synthetic, /BEGIN:VALARM/), 'synthetic/: no VALARM');
});

test('every fixture round-trips without a lost component, property or parameter', () => {
  for (const fixture of corpus) {
    const violations = checkRoundTrip({
      id: fixture.id,
      text: readFixture(fixture),
    });
    assert.deepEqual(violations, [], fixture.id);
  }
});

test('a second round trip over the output loses nothing either', () => {
  for (const fixture of corpus) {
    const violations = checkRoundTrip({
      id: fixture.id,
      text: readFixture(fixture),
      roundTrip: (text) => defaultRoundTrip(defaultRoundTrip(text)),
    });
    assert.deepEqual(violations, [], fixture.id);
  }
});

test('the harness leaves no timezone registered', () => {
  for (const tzid of ['Europe/Berlin', 'W. Europe Standard Time'])
    assert.equal(
      ICAL.TimezoneService.has(tzid),
      false,
      `${tzid} was left registered globally`,
    );
});

test('a dropped X- parameter fails with the parameter named', () => {
  const violations = checkRoundTrip({
    id: 'case',
    text: fixtureText(APPLE),
    roundTrip: dropParameter('X-APPLE-STRUCTURED-LOCATION', 'X-APPLE-RADIUS'),
  });
  assert.equal(violations.length, 1, violations.join('\n'));
  assert.match(violations[0] ?? '', /X-APPLE-STRUCTURED-LOCATION\[0\]/);
  assert.match(
    violations[0] ?? '',
    /parameter X-APPLE-RADIUS is in the fixture/,
  );
});

test('a dropped property fails with the property named', () => {
  const violations = checkRoundTrip({
    id: 'case',
    text: fixtureText(APPLE),
    roundTrip: dropProperty('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR'),
  });
  assert.equal(violations.length, 1, violations.join('\n'));
  assert.match(
    violations[0] ?? '',
    /X-APPLE-TRAVEL-ADVISORY-BEHAVIOR\[0\]: the property is in the fixture/,
  );
});

test('a dropped VALARM fails with the component path named', () => {
  const violations = checkRoundTrip({
    id: 'case',
    text: fixtureText(APPLE),
    roundTrip: dropComponent('valarm'),
  });
  assert.equal(violations.length, 1, violations.join('\n'));
  assert.match(
    violations[0] ?? '',
    /VCALENDAR\/VEVENT\[0\]\/VALARM\[0\]: the component is in the fixture/,
  );
});

test('a dropped VTIMEZONE fails because the output no longer defines the TZID', () => {
  const violations = checkRoundTrip({
    id: 'case',
    text: fixtureText(APPLE),
    roundTrip: dropTimezone,
  });
  assert.equal(violations.length, 1, violations.join('\n'));
  assert.match(violations[0] ?? '', /TZID=Europe\/Berlin/);
  assert.match(violations[0] ?? '', /does not define/);
});

test('a changed value fails with both sides hashed', () => {
  const violations = checkRoundTrip({
    id: 'case',
    text: fixtureText(THUNDERBIRD),
    roundTrip: lossy((calendar) => {
      const event = calendar.getFirstSubcomponent('vevent');
      assert.ok(event);
      event.updatePropertyWithValue(
        'uid',
        'c0ffee00-1111-4222-8333-444455556666',
      );
    }),
  });
  assert.equal(violations.length, 1, violations.join('\n'));
  assert.match(violations[0] ?? '', /UID\[0\]: value 0 differs/);
  assert.match(violations[0] ?? '', /fixture sha256:/);
  assert.match(violations[0] ?? '', /output sha256:/);
});

test('a non-standard property is never forgiven', () => {
  const canary = 'CALFLEX_ROUNDTRIP_CANARY_VALUE';
  const text = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Fixture//EN',
    'BEGIN:VEVENT',
    'UID:c0ffee00-1111-4222-8333-444455556666',
    'DTSTAMP:20260101T000000Z',
    'DTSTART:20261014T100000Z',
    'DTEND:20261014T110000Z',
    'SUMMARY:Fixture event',
    `X-CANARY;X-CANARY-LABEL=${canary}:${canary}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');

  const dropped = checkRoundTrip({
    id: 'case',
    text,
    roundTrip: dropParameter('X-CANARY', 'X-CANARY-LABEL'),
  });
  assert.equal(dropped.length, 1, dropped.join('\n'));
  assert.match(dropped[0] ?? '', /parameter X-CANARY-LABEL is in the fixture/);
  assert.match(dropped[0] ?? '', /sha256:/);
  for (const violation of dropped) assert.ok(!violation.includes(canary));

  const changed = checkRoundTrip({
    id: 'case',
    text,
    roundTrip: lossy((calendar) => {
      const event = calendar.getFirstSubcomponent('vevent');
      assert.ok(event);
      event.updatePropertyWithValue('x-canary', 'Fixture value');
    }),
  });
  assert.equal(changed.length, 1, changed.join('\n'));
  assert.match(changed[0] ?? '', /X-CANARY\[0\]: value 0 differs/);
  for (const violation of changed) assert.ok(!violation.includes(canary));
});

test('a violation prints no fixture content', () => {
  const summary = 'CALFLEX_ROUNDTRIP_CANARY_SUMMARY';
  const text = fixtureText(APPLE).replace(
    /^SUMMARY:.*$/m,
    `SUMMARY:${summary}`,
  );
  const violations = checkRoundTrip({
    id: 'case',
    text,
    roundTrip: dropComponent('valarm'),
  });
  assert.ok(violations.length > 0);
  for (const violation of violations) {
    assert.ok(!violation.includes(summary), violation);
    assert.ok(!violation.includes('Fixture'), violation);
    assert.ok(!violation.includes('geo:'), violation);
  }
});

test('a fixture without a source note is refused', () => {
  const directory = mkdtempSync(join(tmpdir(), 'calflex-roundtrip-'));
  try {
    mkdirSync(join(directory, 'synthetic'));
    writeFileSync(
      join(directory, 'synthetic', 'captured.ics'),
      fixtureText(APPLE),
    );
    const [fixture] = fixtures(directory);
    assert.ok(fixture, 'the temporary corpus has no fixture');
    assert.match(sourceNoteViolation(fixture), /no \.source\.md beside/);
    writeFileSync(
      fixture.notePath,
      '# Source\n\nImitates a fixture-shaped object.\n',
    );
    assert.equal(sourceNoteViolation(fixture), '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a fixture that uses a TZID it does not define is refused', () => {
  const text = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Fixture//EN',
    'BEGIN:VEVENT',
    'UID:c0ffee00-1111-4222-8333-444455556666',
    'DTSTAMP:20260101T000000Z',
    'DTSTART;TZID=Europe/Berlin:20261014T100000',
    'DTEND;TZID=Europe/Berlin:20261014T110000',
    'SUMMARY:Fixture event',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
  const violations = checkRoundTrip({ id: 'case', text });
  assert.equal(violations.length, 1, violations.join('\n'));
  assert.match(violations[0] ?? '', /TZID=Europe\/Berlin/);
  assert.match(violations[0] ?? '', /does not define/);
});

test('a VALUE naming the property default is not semantic, an all-day DATE is', () => {
  /** @param {string[]} lines */
  const event = (lines) =>
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Fixture//EN',
      'BEGIN:VEVENT',
      'UID:c0ffee00-1111-4222-8333-444455556666',
      'DTSTAMP:20260101T000000Z',
      ...lines,
      'SUMMARY:Fixture event',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');

  const explicit = event([
    'DTSTART;VALUE=DATE-TIME:20261014T100000Z',
    'DTEND;VALUE=DATE-TIME:20261014T110000Z',
  ]);
  const implicit = event([
    'DTSTART:20261014T100000Z',
    'DTEND:20261014T110000Z',
  ]);
  assert.deepEqual(
    checkRoundTrip({ id: 'case', text: explicit, roundTrip: () => implicit }),
    [],
  );
  assert.deepEqual(
    checkRoundTrip({ id: 'case', text: implicit, roundTrip: () => explicit }),
    [],
  );

  const allDay = event([
    'DTSTART;VALUE=DATE:20261014',
    'DTEND;VALUE=DATE:20261015',
  ]);
  const midnight = event([
    'DTSTART:20261014T000000Z',
    'DTEND:20261015T000000Z',
  ]);
  const violations = checkRoundTrip({
    id: 'case',
    text: allDay,
    roundTrip: () => midnight,
  });
  assert.ok(violations.length > 0);
  assert.ok(
    violations.some((violation) =>
      /value type|value 0 differs/.test(violation),
    ),
    violations.join('\n'),
  );
});

test('a value is described by its length and a short hash', () => {
  assert.match(
    describeValue('Fixture event'),
    /^sha256:[0-9a-f]{12} \(13 bytes\)$/,
  );
  assert.equal(describeValue('Fixture event'), describeValue('Fixture event'));
  assert.notEqual(
    describeValue('Fixture event'),
    describeValue('Fixture even'),
  );
  assert.ok(!describeValue('Fixture event').includes('Fixture'));
});
