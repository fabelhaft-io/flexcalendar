// --- E03-R11: the in-memory store mirrors the value backstop -----------------
//
// `test/support/caldav-store.mjs` is what the API's unit suites drive, so a
// shape it accepts has to be a shape the live CalDAV service accepts too —
// otherwise a unit test passes an object `make test-api-caldav` would get a
// `403` for. E03-R11 is the rule the API's own create path is the canonical
// case of (`randomUUID()` under `<uid>.ics`), so the double carries the same
// checks as `server/caldav/src/PrivateSkeleton.php` and this file pins them:
// a non-UUID `UID`, a wrong object name and an `X-` rule part are refused, and
// a stock-app `UID` an object already holds is kept.
//
// The authority is the PHP class and `server/caldav/tests/`; this only holds
// the double in step with it.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { CalDavError } from '../src/caldav/adapter.mjs';
import {
  createMemoryCalDavStore,
  objectCreateViolation,
  objectUpdateViolation,
  objectUid,
  rulePartViolation,
  UID_V4,
} from './support/caldav-store.mjs';

/** A guard-accepted Private skeleton with the given `UID`. @param {string} uid */
const skeleton = (uid) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Calflex//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261009T080000Z',
    'DTSTART:20261012T100000Z',
    'DTEND:20261012T110000Z',
    `X-CALFLEX-ENVELOPE-SHA256:${'a'.repeat(64)}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');

/** The skeleton with one more content line inside the `VEVENT`. @param {string} ics @param {string} line */
const withLine = (ics, line) =>
  ics.replace('END:VEVENT', `${line}\r\nEND:VEVENT`);

test('the UID regex is the epic’s, anchored and lowercase', () => {
  const uid = randomUUID();
  assert.equal(UID_V4.test(uid), true);
  assert.equal(UID_V4.test(uid.toUpperCase()), false);
  assert.equal(UID_V4.test(`sabre-vobject-${uid}`), false);
  assert.equal(UID_V4.test(`${uid}\n`), false);
  // Version and variant nibbles are not `4`/`8|9|a|b` in either.
  assert.equal(UID_V4.test('adf46a78-3c92-3c1e-ab04-7f791296e61e'), false);
  assert.equal(UID_V4.test('adf46a78-3c92-4c1e-cb04-7f791296e61e'), false);
});

test('a create needs a lowercase UUIDv4 UID under <uid>.ics', () => {
  const uid = randomUUID();
  assert.equal(objectCreateViolation(`${uid}.ics`, skeleton(uid)), undefined);

  // A `UID` that names an event, the repaired value, a mixed object and one
  // with no `UID` at all: all `UID`, none of them a value.
  assert.equal(
    objectCreateViolation(`${uid}.ics`, skeleton('Chemo with Dr Smith')),
    'UID',
  );
  assert.equal(
    objectCreateViolation(
      `${uid}.ics`,
      skeleton(`sabre-vobject-${randomUUID()}`),
    ),
    'UID',
  );
  assert.equal(
    objectCreateViolation(
      `${uid}.ics`,
      skeleton(uid).replace(
        'END:VCALENDAR',
        `BEGIN:VEVENT\r\nUID:${randomUUID()}\r\nX-CALFLEX-ENVELOPE-SHA256:${'a'.repeat(64)}\r\nEND:VEVENT\r\nEND:VCALENDAR`,
      ),
    ),
    'UID',
  );
  assert.equal(
    objectCreateViolation(
      `${uid}.ics`,
      skeleton(uid).replace(`UID:${uid}\r\n`, ''),
    ),
    'UID',
  );
  // The object name is the other half of the create rule, and it names a fixed
  // token, never the value.
  assert.equal(
    objectCreateViolation(`${randomUUID()}.ics`, skeleton(uid)),
    'OBJECT-NAME',
  );
  assert.equal(objectCreateViolation(uid, skeleton(uid)), 'OBJECT-NAME');
  assert.equal(
    objectCreateViolation(`${uid}.ICS`, skeleton(uid)),
    'OBJECT-NAME',
  );
  // The E03-R09 allow-list still answers first, exactly as it does in PHP.
  assert.equal(
    objectCreateViolation(
      `${uid}.ics`,
      withLine(skeleton(uid), 'SUMMARY:CALFLEX_GUARD_MARKER'),
    ),
    'SUMMARY',
  );
});

test('a VALARM UID, when it carries one, is a UUIDv4 too', () => {
  const uid = randomUUID();
  /** @param {string} value */
  const alarm = (value) =>
    withLine(
      skeleton(uid),
      `BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT5M\r\nUID:${value}\r\nDESCRIPTION:Reminder\r\nEND:VALARM`,
    );
  assert.equal(objectCreateViolation(`${uid}.ics`, alarm(uid)), undefined);
  assert.equal(
    objectCreateViolation(`${uid}.ics`, alarm(uid.toUpperCase())),
    'UID',
  );
  // The API's own alarm carries no `UID`, and is accepted.
  assert.equal(
    objectCreateViolation(
      `${uid}.ics`,
      withLine(
        skeleton(uid),
        'BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT5M\r\nDESCRIPTION:Reminder\r\nEND:VALARM',
      ),
    ),
    undefined,
  );
});

test('an X- RRULE part is refused on create and on update', () => {
  const uid = randomUUID();
  const rule = withLine(skeleton(uid), 'RRULE:FREQ=DAILY;X-NOTE=anything');
  assert.equal(rulePartViolation(skeleton(uid)), undefined);
  assert.equal(rulePartViolation(rule), 'RRULE');
  assert.equal(objectCreateViolation(`${uid}.ics`, rule), 'RRULE');
  assert.equal(objectUpdateViolation(uid, rule), 'RRULE');
  // Other rule parts are not `X-` and stay allowed.
  assert.equal(
    rulePartViolation(withLine(skeleton(uid), 'RRULE:FREQ=DAILY;COUNT=3')),
    undefined,
  );
});

test('an update keeps the stored UID, whatever its shape', () => {
  const uid = randomUUID();
  assert.equal(objectUpdateViolation(uid, skeleton(uid)), undefined);
  // A stock-app `UID` written while the calendar was not Private (INV-03).
  const legacy = '1A2B3C4D-5E6F-4A0B-8C1D-2E3F4A5B6C7D';
  assert.equal(objectUpdateViolation(legacy, skeleton(legacy)), undefined);
  // Changing it, or dropping it, is `UID`; a stored row without one is refused
  // rather than treated as "anything goes".
  assert.equal(objectUpdateViolation(uid, skeleton(randomUUID())), 'UID');
  assert.equal(
    objectUpdateViolation(uid, skeleton(uid).replace(`UID:${uid}\r\n`, '')),
    'UID',
  );
  assert.equal(objectUpdateViolation(undefined, skeleton(uid)), 'UID');
  assert.equal(objectUid(skeleton(legacy)), legacy);
});

test('putObject refuses the shapes the service refuses, create and update', async () => {
  const store = createMemoryCalDavStore();
  const user = store.forUser(randomUUID());
  const calendar = randomUUID();
  const uid = randomUUID();

  // The accepted create the API's own path mints.
  const created = await user.putObject(calendar, `${uid}.ics`, skeleton(uid), {
    ifNoneMatch: '*',
  });
  assert.equal(created.status, 201);

  const ruled = randomUUID();
  for (const [name, ics, refusal] of [
    [`${randomUUID()}.ics`, skeleton(randomUUID()), 'OBJECT-NAME'],
    [uid, skeleton(uid), 'OBJECT-NAME'],
    [`${randomUUID()}.ics`, skeleton('not-a-uuid'), 'UID'],
    [`${randomUUID()}.ics`, skeleton(uid.toUpperCase()), 'UID'],
    [
      `${ruled}.ics`,
      withLine(skeleton(ruled), 'RRULE:FREQ=DAILY;X-NOTE=x'),
      'RRULE',
    ],
  ]) {
    await assert.rejects(
      () => user.putObject(calendar, name, ics, { ifNoneMatch: '*' }),
      (/** @type {CalDavError} */ error) => {
        assert.ok(error instanceof CalDavError);
        assert.equal(error.status, 403);
        assert.deepEqual(error.preconditions, [
          'cf:private-skeleton-only',
          refusal,
        ]);
        return true;
      },
    );
  }
  assert.deepEqual(store.refusals, [
    'OBJECT-NAME',
    'OBJECT-NAME',
    'UID',
    'UID',
    'RRULE',
  ]);

  // An update that keeps the `UID` is accepted; one that changes it is not.
  const kept = withLine(skeleton(uid), 'SEQUENCE:1');
  const updated = await user.putObject(calendar, `${uid}.ics`, kept, {
    ifMatch: created.etag,
  });
  assert.equal(updated.status, 204);
  await assert.rejects(
    () =>
      user.putObject(calendar, `${uid}.ics`, skeleton(randomUUID()), {
        ifMatch: updated.etag,
      }),
    (/** @type {CalDavError} */ error) => {
      assert.ok(error instanceof CalDavError);
      assert.equal(error.status, 403);
      return true;
    },
  );
});
