// --- E05-R04: the events API, without a database -----------------------------
//
// Every route of E05-R04 through the real `buildApp`: the real hooks, the real
// validation, the real problem documents, against the in-memory calendar store
// of E05-R03 and the in-memory CalDAV collection of `test/support/caldav-store.mjs`.
// Both are mutable state the API changes, so "the object is gone" or "the
// sequence moved" is an assertion about what the routes did — not about a stub
// that always says yes.
//
// The CalDAV double runs the **Private write guard** of E03-R09 on every PUT, so
// a create that answers 201 is also the claim that the object this API builds is
// a skeleton the guard accepts. Its refusals are the same `403` with the
// `cf:private-skeleton-only` precondition and the offending property name that
// the real service answers with, which is the error the 403 problem is mapped
// from — and the reason that mapping is exercised here with the adapter's own
// error shape: no request this API accepts can reach the guard, because the
// fields that would (the content fields) are refused with a 422 first. That the
// guard itself refuses a content write is E03-R09's suite, and the stack suite
// `test/integration/events.test.mjs` shows it once more against the real service.
//
// What is under test, in the order the requirement states it:
//
//   * create mints a UUIDv4 `UID` (INV-03), writes a skeleton with
//     `If-None-Match: *` and answers 201 with `Location` and `ETag`;
//   * every refusal is one 422 with a fixed body, and none of them reaches
//     CalDAV;
//   * `owner` and `editor` write, `viewer` reads, a stranger gets the 404 an
//     unknown calendar gets, and an id or a `uid` outside the canonical shape is
//     that same 404 before CalDAV is asked (E03-R01, E03-R10);
//   * `PATCH` needs `If-Match` (428) and forwards it verbatim, bumps `SEQUENCE`
//     and `DTSTAMP`, and leaves the overrides and every property it was not
//     asked about untouched (INV-02);
//   * a stale `If-Match` is a 412 whose `current` member is the stored
//     representation — and the rejected request is nowhere in the body;
//   * `DELETE` needs `If-Match`, answers 204, and 404s for an object that is not
//     there;
//   * no event content, envelope hash or object text reaches a body or a log
//     line, whatever the store throws.

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { test } from 'node:test';

import { buildApp } from '../src/app.mjs';
import { CalDavError, parsePreconditions } from '../src/caldav/adapter.mjs';
import { readConfig } from '../src/config.mjs';
import { rawLines } from './ical-roundtrip.mjs';
import { createMemoryCalDavStore } from './support/caldav-store.mjs';
import { createMemoryCalendarStore } from './support/calendar-store.mjs';
import { createMemoryEnvelopeStore } from './support/envelope-store.mjs';
import { assertProblem } from './support/problem.mjs';

const ISSUER = 'https://auth.example.test';
const AUDIENCE = 'project-id';
const OWNER = {
  id: '11111111-1111-4111-8111-111111111111',
  handle: 'alice',
  email: 'alice@example.test',
};
const EDITOR = {
  id: '22222222-2222-4222-8222-222222222222',
  handle: 'bob',
  email: 'bob@example.test',
};
const VIEWER = {
  id: '33333333-3333-4333-8333-333333333333',
  handle: 'carol',
  email: 'carol@example.test',
};
const STRANGER = {
  id: '44444444-4444-4444-8444-444444444444',
  handle: 'dave',
  email: 'dave@example.test',
};
const USERS = {
  owner: OWNER,
  editor: EDITOR,
  viewer: VIEWER,
  stranger: STRANGER,
};

/** A value that must never reach a body or a log line. */
const CANARY = 'CALFLEX_EVENT_CONTENT_CANARY';
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/**
 * The sealed envelope a Private create commits beside its skeleton (E13-R02):
 * version `0x01`, the epoch, and opaque bytes. Its only job here is to be a
 * well-formed envelope whose SHA-256 the skeleton can carry, since the API
 * checks the header, the size and the hash and never opens the bytes (INV-07).
 */
const ENVELOPE = (() => {
  const bytes = Buffer.alloc(60, 0x11);
  bytes[0] = 1;
  bytes.writeUInt32BE(1, 1);
  return bytes;
})();
/** The SHA-256 of the default envelope, which the skeleton carries. */
const HASH = createHash('sha256').update(ENVELOPE).digest('hex');
/**
 * The hash of a **re-sealed** envelope: what a patch that moves `DTSTART` or
 * the end has to carry, because both are bound into the envelope's AAD
 * (`spec/crypto.md` §2.2). The stored object's hash stays `HASH` until then.
 */
const RESEALED_HASH = 'b'.repeat(64);
const STAMP = '20261014T090000Z';
/** The stored object whose master has an override beside it (E15-R01 corpus). */
const OVERRIDE_UID = '5d6c7b8a-9012-4ef3-8abc-0123456789ab';
const OVERRIDE_FIXTURE = readFileSync(
  new URL(
    '../../../spec/ical-fixtures/ours/private-weekly-exdate-override.ics',
    import.meta.url,
  ),
  'utf8',
);

/** A three-segment token whose middle segment is the subject. */
const token = (/** @type {string} */ subject) => `a.${subject}.c`;

/** The stub IdP: a verified token per subject, no userinfo. */
const oidc = {
  /** @param {string} value */
  async verify(value) {
    const subject = String(value).split('.')[1];
    if (!Object.hasOwn(USERS, subject)) throw new Error('unknown token');
    return { sub: subject };
  },
  async userinfo() {
    throw new Error('userinfo is not part of these tests');
  },
};

/** The `users` store: every subject already has a row. */
const usersStore = {
  /** @param {string} subject */
  async findBySubject(subject) {
    return /** @type {Record<string, any>} */ (USERS)[subject];
  },
  async createFirstSight() {
    throw new Error('first sight is not part of these tests');
  },
};

const audience = {
  async current() {
    return AUDIENCE;
  },
  async refresh() {
    return false;
  },
};

/** A writable that keeps every log line. */
function captureLog() {
  /** @type {string[]} */
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

/**
 * The app, both in-memory stores, the CalDAV double, a captured log and one
 * Private calendar with an owner, an editor and a viewer.
 */
async function setup() {
  const capture = captureLog();
  /** @type {Record<string, unknown>[]} */
  const events = [];
  const calendars = createMemoryCalendarStore({ events });
  const caldav = createMemoryCalDavStore({ events });
  const envelopes = createMemoryEnvelopeStore({ events });
  const app = buildApp({
    config: readConfig({
      CALFLEX_OIDC_ISSUER: ISSUER,
      CALFLEX_OIDC_BASE_URL: ISSUER,
      CALFLEX_OIDC_AUDIENCE: AUDIENCE,
    }),
    oidc,
    audience,
    store: usersStore,
    calendars,
    caldav,
    envelopes,
    logger: { stream: capture.stream },
  });
  const calendarId = randomUUID();
  await calendars.createPrivate({
    id: calendarId,
    ownerId: OWNER.id,
    href: `/calendars/${OWNER.id}/${calendarId}/`,
    metaEnvelope: Buffer.alloc(45, 1),
    metaEpoch: 1,
  });
  calendars.addMember(calendarId, EDITOR.id, 'editor');
  calendars.addMember(calendarId, VIEWER.id, 'viewer');
  return { app, capture, calendars, caldav, envelopes, events, calendarId };
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{url?: string, method?: string, subject?: string, headers?: Record<string, string>, payload?: unknown}} [options]
 */
async function call(
  app,
  { url, method = 'GET', subject, headers = {}, payload } = {},
) {
  return /** @type {any} */ (
    await app.inject(
      /** @type {any} */ ({
        method,
        url,
        headers:
          subject === undefined
            ? headers
            : { authorization: `Bearer ${token(subject)}`, ...headers },
        payload,
      }),
    )
  );
}

/**
 * A create body with the fields a Private create requires: the client-chosen
 * `UID` (the envelope's AAD binds it, D-14), the skeleton's times, and the
 * sealed envelope the one request commits in D-06 order (E13-R02). Every call
 * mints a fresh `UID`, so two creates never collide.
 */
const createBody = (/** @type {Record<string, unknown>} */ over = {}) => ({
  uid: randomUUID(),
  start: { utc: STAMP },
  end: { utc: '20261014T100000Z' },
  alarm: { trigger: '-PT15M' },
  epoch: 1,
  envelope: ENVELOPE.toString('base64'),
  envelopeSha256: HASH,
  ...over,
});

/**
 * Creates one event through the API and returns its body.
 * @param {import('fastify').FastifyInstance} app
 * @param {string} calendarId
 * @param {Record<string, unknown>} [body]
 * @param {string} [subject]
 */
async function created(
  app,
  calendarId,
  body = createBody(),
  subject = 'owner',
) {
  const response = await call(app, {
    method: 'POST',
    url: `/calendars/${calendarId}/events`,
    subject,
    payload: body,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

/** @param {Record<string, unknown>[]} events */
const opsOf = (events) => events.map((entry) => String(entry.op));

/**
 * One property's value in a text, unfolded, from the master `VEVENT`.
 * @param {string} text @param {string} name
 */
const valueOf = (text, name) =>
  rawLines(text).find(
    (line) =>
      line.kind === 'property' &&
      line.path === 'VCALENDAR/VEVENT[0]' &&
      line.name === name,
  )?.value;

/**
 * One component's content lines of a text, by path, for asserting that a
 * component nobody touched came back unchanged.
 * @param {string} text @param {string} path
 */
const linesOf = (text, path) =>
  rawLines(text)
    .filter((line) => line.path === path)
    .map(
      (line) =>
        `${line.kind} ${line.name} ${line.parameters.join(';')} ${line.value}`,
    );

test('a Private create writes the client uid and commits the envelope in D-06 order', async () => {
  const { app, caldav, envelopes, calendarId } = await setup();
  try {
    const uid = randomUUID();
    const response = await call(app, {
      method: 'POST',
      url: `/calendars/${calendarId}/events`,
      subject: 'editor',
      payload: createBody({ uid }),
    });
    assert.equal(response.statusCode, 201, response.body);
    const body = response.json();

    // INV-03: the `UID` is a lowercase UUIDv4 the client named, and the object
    // is addressed by it.
    assert.equal(body.uid, uid);
    assert.match(body.uid, UUID_V4);
    assert.equal(body.parsed.uid, body.uid);
    assert.equal(
      response.headers.location,
      `/calendars/${calendarId}/events/${body.uid}`,
    );
    assert.equal(response.headers.etag, body.etag);
    assert.match(body.etag, /^".+"$/);

    // The object: the API writes the skeleton, and the guard accepts it.
    assert.deepEqual(caldav.refusals, []);
    const stored = caldav.stored(calendarId, `${body.uid}.ics`);
    assert.ok(stored, 'the object was not written');
    assert.equal(body.ical, stored.ics);
    assert.equal(stored.etag, body.etag);
    assert.match(body.ical, new RegExp(`^UID:${body.uid}$`, 'm'));
    assert.match(
      body.ical,
      /^PRODID:-\/\/flexcalendar\/\/Private skeleton\/\/EN$/m,
    );
    // A 64-character value folds across two content lines; the harness's own
    // unfolding is what says it is one property with one value.
    assert.equal(valueOf(body.ical, 'X-CALFLEX-ENVELOPE-SHA256'), HASH);
    assert.match(body.ical, /^BEGIN:VALARM$/m);
    assert.match(body.ical, /^TRIGGER:-PT15M$/m);
    assert.match(body.ical, /^DESCRIPTION:Reminder$/m);

    // D-06: the sidecar row is committed **before** the skeleton is written.
    const ops = opsOf(caldav.events);
    const insertIndex = ops.indexOf('envelopeInsert');
    const putIndex = ops.findIndex((op) => op === 'putObject');
    assert.ok(insertIndex !== -1, 'the envelope row was never inserted');
    assert.ok(putIndex !== -1, 'the skeleton was never written');
    assert.ok(
      insertIndex < putIndex,
      'the envelope row must be inserted before the skeleton PUT (D-06)',
    );
    // The skeleton names the bytes the row holds, and the row holds exactly
    // what the client sealed.
    const rows = envelopes.rows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].uid, uid);
    assert.equal(rows[0].envelopeSha256, HASH);
    assert.equal(rows[0].envelope, ENVELOPE.toString('base64'));

    // The parsed view: the master VEVENT, nothing else, no content.
    assert.deepEqual(body.parsed, {
      uid: body.uid,
      start: { utc: STAMP },
      end: { utc: '20261014T100000Z' },
      rrule: null,
      alarm: { trigger: '-PT15M' },
      sequence: 0,
      envelopeSha256: HASH,
    });

    // The write was create-only, and the correlation ID went to CalDAV.
    const put = caldav.events.find((entry) => entry.op === 'putObject');
    assert.ok(put);
    assert.equal(put.ifNoneMatch, '*');
    assert.equal(put.ifMatch, undefined);
    assert.equal(caldav.calls.length, 1);
    assert.equal(caldav.calls[0].userId, EDITOR.id);
    assert.match(String(response.headers['x-request-id']), UUID_V4);
  } finally {
    await app.close();
  }
});

test('a create with a rule and an all-day time writes exactly what was asked', async () => {
  const { app, calendarId } = await setup();
  try {
    const body = await created(
      app,
      calendarId,
      createBody({
        start: { date: '2026-10-12' },
        end: { date: '2026-10-13' },
        rrule: 'FREQ=DAILY;COUNT=3',
        alarm: null,
      }),
    );
    assert.match(body.ical, /^DTSTART;VALUE=DATE:20261012$/m);
    assert.match(body.ical, /^DTEND;VALUE=DATE:20261013$/m);
    assert.match(body.ical, /^RRULE:FREQ=DAILY;COUNT=3$/m);
    assert.equal(body.parsed.start.date, '2026-10-12');
    assert.equal(body.parsed.rrule, 'FREQ=DAILY;COUNT=3');
    assert.equal(body.parsed.alarm, null);

    // An `end` the caller left out is no `DTEND` at all, not a guessed one.
    const open = await created(
      app,
      calendarId,
      createBody({ start: { utc: STAMP }, end: undefined, alarm: null }),
    );
    assert.ok(!/^DTEND/m.test(open.ical));
    assert.equal(open.parsed.end, null);
  } finally {
    await app.close();
  }
});

test('a TZID event carries its VTIMEZONE through create, read and patch', async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    const collection = `/calendars/${calendarId}/events`;
    const body = await created(
      app,
      calendarId,
      createBody({
        start: { local: '20261014T100000', tzid: 'Europe/Berlin' },
        end: { local: '20261014T110000', tzid: 'Europe/Berlin' },
      }),
    );
    assert.match(body.ical, /^DTSTART;TZID=Europe\/Berlin:20261014T100000$/m);
    assert.match(body.ical, /^DTEND;TZID=Europe\/Berlin:20261014T110000$/m);
    assert.equal((body.ical.match(/BEGIN:VTIMEZONE/g) ?? []).length, 1);
    assert.ok(
      body.ical.indexOf('BEGIN:VTIMEZONE') < body.ical.indexOf('BEGIN:VEVENT'),
      'the VTIMEZONE does not precede the event',
    );
    // The reading a client shows: the wall clock the object spells and the
    // instant it names (E05-R09).
    assert.deepEqual(body.parsed.start, {
      tzid: 'Europe/Berlin',
      local: '20261014T100000',
      utc: '20261014T080000Z',
    });
    assert.deepEqual(body.parsed.end, {
      tzid: 'Europe/Berlin',
      local: '20261014T110000',
      utc: '20261014T090000Z',
    });

    const read = await call(app, {
      url: `${collection}/${body.uid}`,
      subject: 'owner',
    });
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(
      read.json().ical,
      body.ical,
      'the read is not the stored bytes',
    );

    // A patch that moves the end into another zone embeds that zone, and the
    // definition the object already carried comes back untouched (INV-02).
    const stored = caldav.stored(calendarId, `${body.uid}.ics`);
    assert.ok(stored);
    const patched = await call(app, {
      method: 'PATCH',
      url: `${collection}/${body.uid}`,
      subject: 'owner',
      headers: { 'if-match': stored.etag },
      payload: {
        end: { local: '20261014T060000', tzid: 'America/New_York' },
        // The end is bound into the envelope's AAD, so moving it needs a
        // re-sealed envelope's hash (E13-R02).
        envelopeSha256: RESEALED_HASH,
      },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    const updated = patched.json();
    assert.match(
      updated.ical,
      /^DTSTART;TZID=Europe\/Berlin:20261014T100000$/m,
    );
    assert.match(
      updated.ical,
      /^DTEND;TZID=America\/New_York:20261014T060000$/m,
    );
    assert.equal((updated.ical.match(/BEGIN:VTIMEZONE/g) ?? []).length, 2);
    assert.match(updated.ical, /^TZID:America\/New_York$/m);
    assert.equal(
      (updated.ical.match(/^X-LIC-LOCATION:Europe\/Berlin$/gm) ?? []).length,
      1,
    );
    assert.deepEqual(updated.parsed.end, {
      tzid: 'America/New_York',
      local: '20261014T060000',
      utc: '20261014T100000Z',
    });
  } finally {
    await app.close();
  }
});

test('a stored zone the resolver cannot read survives a patch that leaves the times alone', async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    // The corpus' Microsoft object, trimmed to the skeleton a Private calendar
    // stores (E03-R09). What this test is about is its own `VTIMEZONE` and the
    // `TZID` times that name it; the content lines are a Shared calendar's and
    // the guard would refuse them, so they are dropped rather than rewritten.
    const uid = 'c1f2a3b4-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    const seeded = readFileSync(
      new URL(
        '../../../spec/ical-fixtures/synthetic/microsoft-windows-zone-name.ics',
        import.meta.url,
      ),
      'utf8',
    )
      .replace(/^UID:.*$/m, `UID:${uid}`)
      .split(/\r?\n/)
      .filter((line) => !/^(SUMMARY|LOCATION|X-MICROSOFT-)/.test(line))
      .flatMap((line) =>
        line.startsWith('DTEND')
          ? [line, `X-CALFLEX-ENVELOPE-SHA256:${HASH}`]
          : [line],
      )
      .join('\r\n');
    const etag = caldav.seed(calendarId, `${uid}.ics`, seeded);
    const url = `/calendars/${calendarId}/events/${uid}`;

    // The read reports the wall clock and the name, and no instant, because the
    // zone is not one the resolver knows (INV-02).
    const read = await call(app, { url, subject: 'owner' });
    assert.equal(read.statusCode, 200, read.body);
    assert.deepEqual(read.json().parsed.start, {
      tzid: 'W. Europe Standard Time',
      local: '20261014T100000',
    });

    // A patch that names no time leaves the object, its zone and its own
    // VTIMEZONE exactly as they are.
    const kept = await call(app, {
      method: 'PATCH',
      url,
      subject: 'owner',
      headers: { 'if-match': etag },
      payload: { alarm: { trigger: '-PT30M' } },
    });
    assert.equal(kept.statusCode, 200, kept.body);
    assert.match(
      kept.json().ical,
      /^DTSTART;TZID=W\. Europe Standard Time:20261014T100000$/m,
    );
    assert.match(kept.json().ical, /^BEGIN:VTIMEZONE$/m);
    assert.match(kept.json().ical, /^DTSTART:16010325T020000$/m);

    // Touching one time field is the fixed 422 ...
    const stored = caldav.stored(calendarId, `${uid}.ics`);
    assert.ok(stored);
    const refused = await call(app, {
      method: 'PATCH',
      url,
      subject: 'owner',
      headers: { 'if-match': stored.etag },
      payload: {
        start: { utc: '20300601T120000Z' },
        envelopeSha256: RESEALED_HASH,
      },
    });
    assert.equal(refused.statusCode, 422, refused.body);
    assertProblem(refused.json(), 'invalid-input');
    assert.equal(
      caldav.stored(calendarId, `${uid}.ics`)?.ics,
      stored.ics,
      'a refused patch moved the revision',
    );

    // ... and replacing both is written.
    const replaced = await call(app, {
      method: 'PATCH',
      url,
      subject: 'owner',
      headers: { 'if-match': stored.etag },
      payload: {
        start: { utc: '20300601T120000Z' },
        end: { utc: '20300601T130000Z' },
        envelopeSha256: RESEALED_HASH,
      },
    });
    assert.equal(replaced.statusCode, 200, replaced.body);
    assert.match(replaced.json().ical, /^DTSTART:20300601T120000Z$/m);
    assert.deepEqual(replaced.json().parsed.start, {
      utc: '20300601T120000Z',
    });
  } finally {
    await app.close();
  }
});

test('every create refusal is one 422 with a fixed body, and none of them reaches CalDAV', async () => {
  const { app, capture, caldav, envelopes, calendarId } = await setup();
  try {
    /** @type {[string, unknown][]} */
    const cases = [
      ['no body at all', undefined],
      ['an array body', []],
      ['no start', { envelopeSha256: HASH }],
      ['start null', createBody({ start: null })],
      ['start not an object', createBody({ start: '20261014T090000Z' })],
      ['start with no member', createBody({ start: {} })],
      [
        'start with both members',
        createBody({ start: { date: '2026-10-12', utc: STAMP } }),
      ],
      [
        'start with a floating time',
        createBody({ start: { local: '20261014T100000' } }),
      ],
      // A `TZID` is an IANA zone in its exact spelling, and ICU has to read it
      // (E05-R09, INV-04).
      [
        'start with a zone in the wrong case',
        createBody({
          start: { tzid: 'europe/berlin', local: '20261014T100000' },
        }),
      ],
      [
        'start with a Windows zone',
        createBody({
          start: {
            tzid: 'W. Europe Standard Time',
            local: '20261014T100000',
          },
        }),
      ],
      [
        'start with an unknown zone',
        createBody({
          start: { tzid: 'Mars/Olympus', local: '20261014T100000' },
        }),
      ],
      [
        'start with a tzid beside an instant',
        createBody({
          start: { tzid: 'Europe/Berlin', utc: STAMP },
        }),
      ],
      [
        'start with a tzid and no wall clock',
        createBody({ start: { tzid: 'Europe/Berlin' } }),
      ],
      [
        'start with an impossible wall clock',
        createBody({
          start: { tzid: 'Europe/Berlin', local: '20260230T100000' },
        }),
      ],
      [
        'a date that is not a date',
        createBody({ start: { date: '2026-10-1' } }),
      ],
      [
        'a date that does not exist',
        createBody({ start: { date: '2026-02-30' } }),
      ],
      [
        'an instant that is not the iCalendar form',
        createBody({ start: { utc: '2026-10-14T09:00:00Z' } }),
      ],
      [
        'an instant with no zone',
        createBody({ start: { utc: '20261014T090000' } }),
      ],
      [
        'an instant that does not exist',
        createBody({ start: { utc: '20261340T090000Z' } }),
      ],
      ['an instant that is not a string', createBody({ start: { utc: 5 } })],
      ['a rule the engine cannot read', createBody({ rrule: 'every day' })],
      [
        'a rule with a name that is not a frequency',
        createBody({ rrule: 'FREQ=FORTNIGHTLY' }),
      ],
      ['a rule that is not a string', createBody({ rrule: 5 })],
      ['an alarm that is not an object', createBody({ alarm: '-PT15M' })],
      ['an alarm with no trigger', createBody({ alarm: {} })],
      [
        'an alarm with an unknown member',
        createBody({ alarm: { trigger: '-PT15M', repeat: 1 } }),
      ],
      [
        'a trigger that is not a duration',
        createBody({ alarm: { trigger: 'fifteen minutes' } }),
      ],
      ['an envelope that is missing', { start: { utc: STAMP } }],
      ['a create with no uid', createBody({ uid: undefined })],
      ['a create with no envelope', createBody({ envelope: undefined })],
      ['a create with no epoch', createBody({ epoch: undefined })],
      [
        'an envelope that is not base64',
        createBody({ envelope: 'not base64 !' }),
      ],
      [
        'an envelope shorter than the fixed fields',
        createBody({ envelope: Buffer.alloc(44, 1).toString('base64') }),
      ],
      [
        'an envelope with the wrong version byte',
        createBody({
          envelope: Buffer.concat([
            Buffer.from([0x02]),
            ENVELOPE.subarray(1),
          ]).toString('base64'),
        }),
      ],
      ['an epoch that is not the header epoch', createBody({ epoch: 2 })],
      ['an epoch above the column range', createBody({ epoch: 2147483648 })],
      [
        'an envelope over the 64 KiB ceiling',
        createBody({
          envelope: (() => {
            const bytes = Buffer.alloc(65_537, 7);
            bytes[0] = 1;
            bytes.writeUInt32BE(1, 1);
            return bytes.toString('base64');
          })(),
        }),
      ],
      [
        'a hash that is not the hash of the bytes',
        createBody({ envelopeSha256: 'a'.repeat(64) }),
      ],
      [
        'an envelope that is not hex',
        createBody({ envelopeSha256: 'not a hash' }),
      ],
      [
        'an envelope in the wrong case',
        createBody({ envelopeSha256: HASH.toUpperCase() }),
      ],
      [
        'an envelope that is short',
        createBody({ envelopeSha256: 'a'.repeat(63) }),
      ],
      // A Private calendar stores skeletons: the content fields are Phase 4 and
      // are refused rather than written into the sidecar's place.
      ['a summary on a Private calendar', createBody({ summary: CANARY })],
      [
        'a description on a Private calendar',
        createBody({ description: CANARY }),
      ],
      ['a location on a Private calendar', createBody({ location: CANARY })],
      [
        'attendees on a Private calendar',
        createBody({ attendees: ['mailto:a@example.test'] }),
      ],
      // A Private create may name its `UID` (the envelope's AAD binds it, D-14),
      // but only as the lowercase UUIDv4 the API itself writes (INV-03).
      ['a uid that is not a uuidv4', createBody({ uid: 'Not-A-Uuid' })],
      ['a uid of another shape', createBody({ uid: CANARY })],
      // The recurrence itself never comes from a client (INV-05).
      ['an exdate', createBody({ exdate: '20261021T090000Z' })],
      ['a recurrenceId', createBody({ recurrenceId: '20261021T090000Z' })],
      ['a mode', createBody({ mode: 'private' })],
    ];
    for (const [what, payload] of cases) {
      const response = await call(app, {
        method: 'POST',
        url: `/calendars/${calendarId}/events`,
        subject: 'owner',
        payload,
      });
      assert.equal(response.statusCode, 422, `${what}: ${response.body}`);
      assertProblem(response.json(), 'invalid-input');
      assert.ok(!response.body.includes(CANARY), what);
    }
    // Nothing was written, and CalDAV was never asked to write either.
    assert.equal(caldav.objects.size, 0);
    for (const op of ['putObject', 'getObject', 'deleteObject']) {
      assert.equal(
        opsOf(caldav.events).filter((entry) => entry === op).length,
        0,
        op,
      );
    }
    // No envelope was committed either: every refusal happened before the row.
    assert.equal(envelopes.rows().length, 0);
    assert.ok(!capture.text().includes(CANARY), capture.text());

    // A body that is not JSON at all never reaches a handler: the route takes
    // `application/json` and Fastify answers 415 for anything else.
    const wrongType = await call(app, {
      method: 'POST',
      url: `/calendars/${calendarId}/events`,
      subject: 'owner',
      headers: { 'content-type': 'application/xml' },
      payload: '<event/>',
    });
    assert.equal(wrongType.statusCode, 415, wrongType.body);
    assertProblem(wrongType.json(), 'unsupported-media-type');
  } finally {
    await app.close();
  }
});

test('an owner and an editor write, a viewer is refused, and a stranger gets the 404 an unknown calendar gets', async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    const byEditor = await call(app, {
      method: 'POST',
      url: `/calendars/${calendarId}/events`,
      subject: 'editor',
      payload: createBody(),
    });
    assert.equal(byEditor.statusCode, 201, byEditor.body);

    const refused = await call(app, {
      method: 'POST',
      url: `/calendars/${calendarId}/events`,
      subject: 'viewer',
      payload: createBody(),
    });
    assert.equal(refused.statusCode, 403, refused.body);
    assertProblem(refused.json(), 'forbidden');
    assert.equal(caldav.objects.size, 1);

    for (const subject of ['stranger', undefined]) {
      const response = await call(app, {
        method: 'POST',
        url: `/calendars/${calendarId}/events`,
        subject,
        payload: createBody(),
      });
      assert.equal(
        response.statusCode,
        subject === undefined ? 401 : 404,
        response.body,
      );
    }
    // An id that cannot name a row is the same 404, decided before the store:
    // the memory store raises Postgres' `22P02` for it, which would be a 500.
    // It never reaches CalDAV either (E11).
    const reached = caldav.events.length;
    const malformed = await call(app, {
      method: 'POST',
      url: '/calendars/not-a-uuid/events',
      subject: 'owner',
      payload: createBody(),
    });
    assert.equal(malformed.statusCode, 404, malformed.body);
    assertProblem(malformed.json(), 'not-found');
    assert.equal(caldav.events.length, reached);

    // A calendar whose id is a UUID but names no row, likewise.
    const unknown = await call(app, {
      method: 'POST',
      url: `/calendars/${randomUUID()}/events`,
      subject: 'owner',
      payload: createBody(),
    });
    assert.equal(unknown.statusCode, 404, unknown.body);

    // A viewer may read what the editor wrote.
    const uid = byEditor.json().uid;
    const read = await call(app, {
      url: `/calendars/${calendarId}/events/${uid}`,
      subject: 'viewer',
    });
    assert.equal(read.statusCode, 200, read.body);
  } finally {
    await app.close();
  }
});

test('a reader gets the stored bytes back byte for byte, and an unknown uid is a 404', async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    const body = await created(app, calendarId);
    const response = await call(app, {
      url: `/calendars/${calendarId}/events/${body.uid}`,
      subject: 'viewer',
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().ical, body.ical);
    assert.equal(response.json().etag, body.etag);
    assert.equal(response.headers.etag, body.etag);
    assert.deepEqual(response.json().parsed, body.parsed);

    const missing = await call(app, {
      url: `/calendars/${calendarId}/events/${randomUUID()}`,
      subject: 'owner',
    });
    assert.equal(missing.statusCode, 404, missing.body);
    assertProblem(missing.json(), 'not-found');

    // A `uid` that is not a UUIDv4 this API could have minted never reaches
    // CalDAV: `calendarobjects.uid` is VARCHAR(200), and only a UUIDv4 can name
    // an object here (E03-R10). The call log is what says the refusal is the
    // shape check and not a lookup that happened to miss.
    const reached = caldav.events.length;
    for (const uid of [
      'not-a-uid',
      'a'.repeat(200),
      `${randomUUID()}x`,
      body.uid.toUpperCase(),
    ]) {
      const response = await call(app, {
        url: `/calendars/${calendarId}/events/${encodeURIComponent(uid)}`,
        subject: 'owner',
      });
      assert.equal(response.statusCode, 404, `${uid}: ${response.body}`);
      assertProblem(response.json(), 'not-found');
    }
    assert.equal(
      caldav.events.length,
      reached,
      `a refused uid reached CalDAV: ${JSON.stringify(caldav.events.slice(reached))}`,
    );
  } finally {
    await app.close();
  }
});

test('a patch needs If-Match, forwards it, and changes only what it was asked to', async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    const body = await created(app, calendarId);
    const url = `/calendars/${calendarId}/events/${body.uid}`;
    const stored = caldav.stored(calendarId, `${body.uid}.ics`);
    assert.ok(stored);

    // No `If-Match`: a read-modify-write with nothing to be optimistic against.
    const unconditional = await call(app, {
      method: 'PATCH',
      url,
      subject: 'owner',
      payload: { start: { utc: '20261014T110000Z' } },
    });
    assert.equal(unconditional.statusCode, 428, unconditional.body);
    assertProblem(unconditional.json(), 'precondition-required');

    // The recurrence and the identity never come from a client (INV-05).
    for (const refused of ['rrule', 'uid', 'exdate', 'recurrenceId']) {
      const response = await call(app, {
        method: 'PATCH',
        url,
        subject: 'owner',
        headers: { 'if-match': stored.etag },
        payload: { [refused]: 'FREQ=DAILY' },
      });
      assert.equal(response.statusCode, 422, `${refused}: ${response.body}`);
      assertProblem(response.json(), 'invalid-input');
    }

    const patched = await call(app, {
      method: 'PATCH',
      url,
      subject: 'owner',
      headers: { 'if-match': stored.etag },
      payload: {
        start: { utc: '20261014T110000Z' },
        end: { utc: '20261014T113000Z' },
        alarm: null,
        // Moving a bound time needs a re-sealed envelope's hash (E13-R02).
        envelopeSha256: RESEALED_HASH,
      },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    const after = patched.json();
    assert.match(after.ical, /^DTSTART:20261014T110000Z$/m);
    assert.match(after.ical, /^DTEND:20261014T113000Z$/m);
    assert.ok(!/^BEGIN:VALARM$/m.test(after.ical), 'the alarm was not removed');
    assert.equal(
      valueOf(after.ical, 'X-CALFLEX-ENVELOPE-SHA256'),
      RESEALED_HASH,
    );
    // The revision moved, so `SEQUENCE` and `DTSTAMP` did too.
    assert.match(after.ical, /^SEQUENCE:1$/m);
    assert.equal(after.parsed.sequence, 1);
    assert.notEqual(after.ical, body.ical);
    assert.equal(after.parsed.alarm, null);
    assert.deepEqual(after.parsed.start, { utc: '20261014T110000Z' });
    assert.deepEqual(after.parsed.end, { utc: '20261014T113000Z' });

    // The caller's own validator went on to CalDAV, unchanged.
    const put = caldav.events
      .filter((entry) => entry.op === 'putObject')
      .at(-1);
    assert.ok(put);
    assert.equal(put.ifMatch, stored.etag);
    assert.equal(put.ifNoneMatch, undefined);
  } finally {
    await app.close();
  }
});

test('a patch of a master leaves the overrides and every other property untouched', async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    const etag = caldav.seed(
      calendarId,
      `${OVERRIDE_UID}.ics`,
      OVERRIDE_FIXTURE,
    );
    const url = `/calendars/${calendarId}/events/${OVERRIDE_UID}`;
    const before = linesOf(OVERRIDE_FIXTURE, 'VCALENDAR/VEVENT[1]');
    assert.ok(before.length > 0, 'the fixture has no override to preserve');

    const response = await call(app, {
      method: 'PATCH',
      url,
      subject: 'owner',
      headers: { 'if-match': etag },
      // Both members move: with the zone maths of E05-R09 the stored `TZID` end
      // is now comparable, and a start after it is the fixed 422.
      payload: {
        start: { utc: '20261021T100000Z' },
        end: { utc: '20261021T110000Z' },
        envelopeSha256: RESEALED_HASH,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const after = response.json();
    assert.match(after.ical, /^DTSTART:20261021T100000Z$/m);
    assert.match(after.ical, /^DTEND:20261021T110000Z$/m);
    // INV-02: the override component and the `VTIMEZONE` it needs came back
    // exactly as they went in.
    assert.deepEqual(linesOf(after.ical, 'VCALENDAR/VEVENT[1]'), before);
    assert.match(after.ical, /^BEGIN:VTIMEZONE$/m);
    assert.match(after.ical, /^TZID:Europe\/Berlin$/m);
    assert.match(after.ical, /^X-LIC-LOCATION:Europe\/Berlin$/m);
    assert.match(after.ical, /^EXDATE;TZID=Europe\/Berlin:20261028T100000$/m);
    // The master is the one that moved, and it kept its own hash.
    assert.deepEqual(after.parsed.start, { utc: '20261021T100000Z' });
    assert.equal(after.parsed.sequence, 1);
  } finally {
    await app.close();
  }
});

test('a stale If-Match is a 412 carrying the current representation and nothing of the request', async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    const body = await created(app, calendarId);
    const url = `/calendars/${calendarId}/events/${body.uid}`;
    const stored = caldav.stored(calendarId, `${body.uid}.ics`);
    assert.ok(stored);

    const response = await call(app, {
      method: 'PATCH',
      url,
      subject: 'owner',
      headers: { 'if-match': '"stale"' },
      payload: {
        start: { utc: '20301231T235900Z' },
        end: { utc: '20301231T235959Z' },
        envelopeSha256: RESEALED_HASH,
      },
    });
    assert.equal(response.statusCode, 412, response.body);
    const problem = assertProblem(response.json(), 'precondition-failed');
    // The current representation: what the collection holds now, which is what
    // the client re-reads and reapplies against.
    assert.equal(problem.current.ical, stored.ics);
    assert.equal(problem.current.etag, stored.etag);
    assert.equal(problem.current.uid, body.uid);
    assert.equal(problem.current.parsed.sequence, 0);
    // …and nothing of the request that lost the race.
    assert.ok(!response.body.includes('20301231T235900Z'), response.body);
    // Nothing was written.
    const unchanged = caldav.stored(calendarId, `${body.uid}.ics`);
    assert.ok(unchanged);
    assert.equal(unchanged.ics, stored.ics);

    // An object that is not there at all is a 404 before any precondition is
    // looked at: there is nothing to patch.
    const absent = await call(app, {
      method: 'PATCH',
      url: `/calendars/${calendarId}/events/${randomUUID()}`,
      subject: 'owner',
      headers: { 'if-match': '"stale"' },
      payload: { start: { utc: '20301231T235900Z' } },
    });
    assert.equal(absent.statusCode, 404, absent.body);
    assertProblem(absent.json(), 'not-found');

    // SabreDAV answers 412 to a conditional write on an object that is not
    // there (RFC 9110 § 13.1.1), so a 412 can mean "gone" as well as "stale".
    // The re-read is what tells them apart: when it finds nothing, the answer is
    // the 404 an unknown `uid` gets, not a 412 without a representation.
    caldav.failOnce('getObject', new CalDavError('not-found', 404));
    const vanished = await call(app, {
      method: 'DELETE',
      url,
      subject: 'owner',
      headers: { 'if-match': '"stale"' },
    });
    assert.equal(vanished.statusCode, 404, vanished.body);
    assertProblem(vanished.json(), 'not-found');

    // The same race on a patch: the object was there for the read, the write
    // loses, and the second look at the object finds nothing.
    caldav.failOnce('getObject', new CalDavError('not-found', 404), {
      after: 1,
    });
    const raced = await call(app, {
      method: 'PATCH',
      url,
      subject: 'owner',
      headers: { 'if-match': '"stale"' },
      payload: {
        start: { utc: '20301231T235900Z' },
        end: { utc: '20301231T235959Z' },
        envelopeSha256: RESEALED_HASH,
      },
    });
    assert.equal(raced.statusCode, 404, raced.body);
    assertProblem(raced.json(), 'not-found');
  } finally {
    await app.close();
  }
});

test('delete needs If-Match, answers 204, and 404s for an object that is not there', async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    const body = await created(app, calendarId);
    const url = `/calendars/${calendarId}/events/${body.uid}`;
    const stored = caldav.stored(calendarId, `${body.uid}.ics`);
    assert.ok(stored);

    const unconditional = await call(app, {
      method: 'DELETE',
      url,
      subject: 'owner',
    });
    assert.equal(unconditional.statusCode, 428, unconditional.body);
    assertProblem(unconditional.json(), 'precondition-required');

    const stale = await call(app, {
      method: 'DELETE',
      url,
      subject: 'owner',
      headers: { 'if-match': '"stale"' },
    });
    assert.equal(stale.statusCode, 412, stale.body);
    const problem = assertProblem(stale.json(), 'precondition-failed');
    assert.equal(problem.current.ical, stored.ics);

    const refused = await call(app, {
      method: 'DELETE',
      url,
      subject: 'viewer',
      headers: { 'if-match': stored.etag },
    });
    assert.equal(refused.statusCode, 403, refused.body);

    // An object that is not there at all: SabreDAV answers `412` to the
    // conditional delete (RFC 9110 § 13.1.1, through its `getNodeForPath`), and
    // the API's re-read is what turns that into the `404` an unknown `uid` gets.
    // The recorded calls are what says which of the two answered.
    const absent = randomUUID();
    const gone = await call(app, {
      method: 'DELETE',
      url: `/calendars/${calendarId}/events/${absent}`,
      subject: 'owner',
      headers: { 'if-match': '"1"' },
    });
    assert.equal(gone.statusCode, 404, gone.body);
    assertProblem(gone.json(), 'not-found');
    assert.deepEqual(
      caldav.events
        .filter((entry) => entry.name === `${absent}.ics`)
        .map((entry) => entry.op),
      ['deleteObject', 'getObject'],
    );

    const deleted = await call(app, {
      method: 'DELETE',
      url,
      subject: 'editor',
      headers: { 'if-match': stored.etag },
    });
    assert.equal(deleted.statusCode, 204, deleted.body);
    assert.equal(deleted.body, '');
    assert.equal(caldav.stored(calendarId, `${body.uid}.ics`), undefined);
    const read = await call(app, { url, subject: 'owner' });
    assert.equal(read.statusCode, 404, read.body);
  } finally {
    await app.close();
  }
});

test('a store failure and a CalDAV failure are fixed problems that echo nothing of the value', async () => {
  const { app, capture, calendars, caldav, calendarId } = await setup();
  try {
    // The error shape the adapter raises for a real `cf:private-skeleton-only`
    // refusal (E03-R09, mapped by `sendCalDavProblem`).
    caldav.fail(
      'putObject',
      new CalDavError('forbidden', 403, [
        'cf:private-skeleton-only',
        'SUMMARY',
      ]),
    );
    const refused = await call(app, {
      method: 'POST',
      url: `/calendars/${calendarId}/events`,
      subject: 'owner',
      payload: createBody(),
    });
    assert.equal(refused.statusCode, 403, refused.body);
    const problem = assertProblem(refused.json(), 'private-skeleton-only');
    assert.equal(problem.property, 'SUMMARY');
    assert.ok(!Object.hasOwn(problem, 'current'), refused.body);
    assert.ok(!refused.body.includes(CANARY), refused.body);

    // A hostile exception from the store is the fixed 500, and a hostile one
    // from the adapter the fixed 502 — neither carries the canary, in the body
    // or in a log line.
    caldav.heal('putObject');
    const uid = (await created(app, calendarId)).uid;
    calendars.fail('findMembership', new Error(CANARY));
    const storeFailure = await call(app, {
      url: `/calendars/${calendarId}/events/${uid}`,
      subject: 'owner',
    });
    assert.equal(storeFailure.statusCode, 500, storeFailure.body);
    assertProblem(storeFailure.json(), 'internal-error');
    assert.ok(!storeFailure.body.includes(CANARY), storeFailure.body);
    calendars.heal('findMembership');

    caldav.fail('getObject', new Error(CANARY));
    const adapterFailure = await call(app, {
      url: `/calendars/${calendarId}/events/${uid}`,
      subject: 'owner',
    });
    assert.equal(adapterFailure.statusCode, 502, adapterFailure.body);
    assertProblem(adapterFailure.json(), 'bad-gateway');
    assert.ok(!adapterFailure.body.includes(CANARY), adapterFailure.body);

    // A CalDAV `401` is never the caller's `401`: the bearer token was verified
    // before the route ran, so a refusal from the listener is our delegation
    // failing, and it is a 502 like every other unreadable upstream answer. A
    // timeout is the one upstream failure with a kind of its own.
    /** @type {[Error, number, string][]} */
    const upstream = [
      [new CalDavError('unauthorized', 401), 502, 'bad-gateway'],
      [new CalDavError('timeout'), 504, 'upstream-timeout'],
    ];
    for (const [error, status, kind] of upstream) {
      caldav.heal('getObject');
      caldav.fail('getObject', error);
      const refusal = await call(app, {
        url: `/calendars/${calendarId}/events/${uid}`,
        subject: 'owner',
      });
      assert.equal(refusal.statusCode, status, refusal.body);
      assertProblem(refusal.json(), kind);
    }

    assert.ok(!capture.text().includes(CANARY), capture.text());
    assert.ok(capture.text().includes('"type":"Error"'));
  } finally {
    await app.close();
  }
});

test('a series over the recurrence bound is the `too-many-instances` 422 on create and on update', async () => {
  const { app, capture, caldav, calendarId } = await setup();
  try {
    // The refusal the live service answers with, built the way the adapter
    // builds one: a `403` whose `DAV:error` body carries RFC 4791's
    // `<C:max-instances/>` beside a hostile canary the parser must not let out.
    const hostile = Buffer.from(
      '<d:error xmlns:d="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
        `<C:max-instances attr="${CANARY}">${CANARY}</C:max-instances>` +
        '</d:error>',
    );
    const refusal = new CalDavError(
      'forbidden',
      403,
      parsePreconditions(hostile),
    );
    assert.deepEqual(refusal.preconditions, ['C:max-instances']);

    caldav.fail('putObject', refusal);
    const create = await call(app, {
      method: 'POST',
      url: `/calendars/${calendarId}/events`,
      subject: 'owner',
      payload: createBody({ rrule: 'FREQ=MINUTELY;COUNT=60000' }),
    });
    assert.equal(create.statusCode, 422, create.body);
    const refused = assertProblem(create.json(), 'too-many-instances');
    assert.equal(
      refused.type,
      'https://flexcalendar.de/problems/too-many-instances',
    );
    assert.ok(!Object.hasOwn(refused, 'property'), create.body);
    assert.ok(!create.body.includes(CANARY), create.body);
    assert.ok(!capture.text().includes(CANARY), capture.text());

    // The same bound on a rewrite: the object is read, patched and refused, and
    // the stored revision is left where it was.
    caldav.heal('putObject');
    const stored = await created(app, calendarId);
    caldav.fail(
      'putObject',
      new CalDavError('forbidden', 403, ['C:max-instances']),
    );
    const update = await call(app, {
      method: 'PATCH',
      url: `/calendars/${calendarId}/events/${stored.uid}`,
      subject: 'owner',
      headers: { 'if-match': stored.etag },
      payload: { alarm: { trigger: '-PT30M' } },
    });
    assert.equal(update.statusCode, 422, update.body);
    assertProblem(update.json(), 'too-many-instances');
    assert.equal(
      caldav.stored(calendarId, `${stored.uid}.ics`)?.ics,
      stored.ical,
      'a refused update moved the revision',
    );
    assert.ok(!capture.text().includes(CANARY), capture.text());
  } finally {
    await app.close();
  }
});

test('an object the API cannot describe is a 502, and nothing of it is echoed', async () => {
  const { app, capture, caldav, calendarId } = await setup();
  try {
    const uid = randomUUID();
    caldav.seed(
      calendarId,
      `${uid}.ics`,
      `BEGIN:VCALENDAR\r\nX-PAYLOAD:${CANARY}\r\nEND:VCALENDAR\r\n`,
    );
    const response = await call(app, {
      url: `/calendars/${calendarId}/events/${uid}`,
      subject: 'owner',
    });
    assert.equal(response.statusCode, 502, response.body);
    assertProblem(response.json(), 'bad-gateway');
    assert.ok(!response.body.includes(CANARY), response.body);
    assert.ok(!capture.text().includes(CANARY), capture.text());

    // The same for a patch: the object cannot be read, so it cannot be patched.
    const patch = await call(app, {
      method: 'PATCH',
      url: `/calendars/${calendarId}/events/${uid}`,
      subject: 'owner',
      headers: { 'if-match': '"1"' },
      payload: { start: { utc: STAMP } },
    });
    assert.equal(patch.statusCode, 502, patch.body);
    assertProblem(patch.json(), 'bad-gateway');
    assert.ok(!patch.body.includes(CANARY), patch.body);
  } finally {
    await app.close();
  }
});

test('a canary in a write never reaches a body or a log line', async () => {
  const { app, capture, calendarId } = await setup();
  try {
    const body = await created(app, calendarId);
    const url = `/calendars/${calendarId}/events/${body.uid}`;
    /** @type {[string, Record<string, unknown>][]} */
    const cases = [
      ['an envelope that is not an envelope', { envelopeSha256: CANARY }],
      ['a summary on a Private calendar', { summary: CANARY }],
      ['a description on a Private calendar', { description: CANARY }],
      ['a location on a Private calendar', { location: CANARY }],
      ['a rule that cannot be read', { rrule: `FREQ=${CANARY}` }],
    ];
    for (const [what, payload] of cases) {
      const post = await call(app, {
        method: 'POST',
        url: `/calendars/${calendarId}/events`,
        subject: 'owner',
        payload: { ...createBody(), ...payload },
      });
      assert.equal(post.statusCode, 422, `${what}: ${post.body}`);
      assert.ok(!post.body.includes(CANARY), what);
      const patch = await call(app, {
        method: 'PATCH',
        url,
        subject: 'owner',
        headers: { 'if-match': '"1"' },
        payload,
      });
      assert.equal(patch.statusCode, 422, `${what}: ${patch.body}`);
      assert.ok(!patch.body.includes(CANARY), what);
    }
    assert.ok(!capture.text().includes(CANARY), capture.text());
  } finally {
    await app.close();
  }
});

test('only a valid start/end pair is written, on a create and against the stored object', async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    const collection = `/calendars/${calendarId}/events`;
    /** @type {[string, Record<string, unknown>][]} */
    const refused = [
      [
        'an instant end under an all-day start',
        createBody({
          start: { date: '2026-10-12' },
          end: { utc: '20261012T100000Z' },
        }),
      ],
      [
        'an all-day end under an instant start',
        createBody({
          start: { utc: STAMP },
          end: { date: '2026-10-13' },
        }),
      ],
      [
        'an end equal to the start',
        createBody({ start: { utc: STAMP }, end: { utc: STAMP } }),
      ],
      [
        'an end before the start',
        createBody({
          start: { utc: STAMP },
          end: { utc: '20261014T083000Z' },
        }),
      ],
    ];
    for (const [what, payload] of refused) {
      const response = await call(app, {
        method: 'POST',
        url: collection,
        subject: 'owner',
        payload,
      });
      assert.equal(response.statusCode, 422, `${what}: ${response.body}`);
      assertProblem(response.json(), 'invalid-input');
    }
    // None of them was written, and CalDAV was never asked to write one. The
    // double shares its call log with the calendar store, so only its own
    // operations are counted.
    assert.equal(caldav.objects.size, 0);
    for (const op of ['forUser', 'putObject', 'getObject', 'deleteObject']) {
      assert.equal(
        opsOf(caldav.events).filter((entry) => entry === op).length,
        0,
        op,
      );
    }

    // A valid pair of either value type is written.
    const timed = await created(app, calendarId);
    assert.match(timed.ical, /^DTSTART:20261014T090000Z$/m);
    const allDay = await created(
      app,
      calendarId,
      createBody({
        start: { date: '2026-10-12' },
        end: { date: '2026-10-13' },
      }),
    );
    assert.match(allDay.ical, /^DTEND;VALUE=DATE:20261013$/m);

    // A patch is checked against the merged object: one member moved past the
    // stored other one, or one member changing value type while the stored
    // other keeps its own, is the same fixed 422.
    const url = `${collection}/${timed.uid}`;
    const stored = caldav.stored(calendarId, `${timed.uid}.ics`);
    assert.ok(stored);
    const writes = opsOf(caldav.events).filter(
      (op) => op === 'putObject',
    ).length;
    /** @type {[string, Record<string, unknown>][]} */
    const badPatches = [
      ['a start after the stored end', { start: { utc: '20261014T110000Z' } }],
      ['a start that changes value type', { start: { date: '2026-10-14' } }],
      ['an end before the stored start', { end: { utc: '20261014T083000Z' } }],
    ];
    for (const [what, payload] of badPatches) {
      const response = await call(app, {
        method: 'PATCH',
        url,
        subject: 'owner',
        headers: { 'if-match': stored.etag },
        // Each patch moves a bound time, so it carries the re-sealed envelope's
        // hash and it is the start/end rule that refuses it (E13-R02).
        payload: { ...payload, envelopeSha256: RESEALED_HASH },
      });
      assert.equal(response.statusCode, 422, `${what}: ${response.body}`);
      assertProblem(response.json(), 'invalid-input');
    }
    // A refused patch writes nothing — it reads the object it would change, and
    // the revision does not move.
    assert.equal(
      opsOf(caldav.events).filter((op) => op === 'putObject').length,
      writes,
    );
    assert.equal(
      caldav.stored(calendarId, `${timed.uid}.ics`)?.ics,
      stored.ics,
    );

    // The control: the same members, moved together, are a 200.
    const moved = await call(app, {
      method: 'PATCH',
      url,
      subject: 'owner',
      headers: { 'if-match': stored.etag },
      payload: {
        start: { utc: '20261014T110000Z' },
        end: { utc: '20261014T113000Z' },
        envelopeSha256: RESEALED_HASH,
      },
    });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.match(moved.json().ical, /^DTSTART:20261014T110000Z$/m);
    assert.match(moved.json().ical, /^DTEND:20261014T113000Z$/m);
  } finally {
    await app.close();
  }
});

test('only the rule parts RFC 5545 names are written, and none ical.js mis-expands', async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    const collection = `/calendars/${calendarId}/events`;
    /** @type {[string, string, Record<string, unknown>][]} */
    const refused = [
      ['a part the RFC does not name', 'FREQ=DAILY;EXDATE=20261015', {}],
      ['a part the RFC does not name', 'FREQ=DAILY;BYEASTER=1', {}],
      ['a part twice', 'FREQ=DAILY;COUNT=3;COUNT=4', {}],
      [
        'COUNT together with UNTIL',
        'FREQ=DAILY;COUNT=3;UNTIL=20261015T090000Z',
        {},
      ],
      ['FREQ not first', 'UNTIL=20261015T090000Z;FREQ=DAILY', {}],
      ['FREQ absent', 'COUNT=3', {}],
      [
        'a rule ical.js expands wrongly',
        'FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO;COUNT=5',
        {},
      ],
      [
        'an instant UNTIL on an all-day start',
        'FREQ=DAILY;UNTIL=20261015T090000Z',
        { start: { date: '2026-10-12' }, end: { date: '2026-10-13' } },
      ],
      ['a date UNTIL on a timed start', 'FREQ=DAILY;UNTIL=20261015', {}],
      ['a COUNT that is not a positive integer', 'FREQ=DAILY;COUNT=0', {}],
      [
        'an INTERVAL that is not a positive integer',
        'FREQ=DAILY;INTERVAL=0',
        {},
      ],
      ['a WKST that is not a weekday', 'FREQ=DAILY;WKST=XX', {}],
      [
        'an UNTIL on a date that does not exist',
        'FREQ=DAILY;UNTIL=20260230T090000Z',
        {},
      ],
      [
        'a yearly rule anchored on 29 February',
        'FREQ=YEARLY',
        { start: { date: '2024-02-29' }, end: null },
      ],
    ];
    for (const [what, rrule, over] of refused) {
      const response = await call(app, {
        method: 'POST',
        url: collection,
        subject: 'owner',
        payload: createBody({ ...over, rrule }),
      });
      assert.equal(response.statusCode, 422, `${what}: ${response.body}`);
      assertProblem(response.json(), 'invalid-input');
    }
    assert.equal(caldav.objects.size, 0);

    // The rules a client may write are written as the engine reads them.
    const daily = await created(
      app,
      calendarId,
      createBody({ rrule: 'FREQ=DAILY;UNTIL=20261015T090000Z' }),
    );
    assert.match(daily.ical, /^RRULE:FREQ=DAILY;UNTIL=20261015T090000Z$/m);
    // A part whose value is the RFC's own default is the one thing the library
    // may leave out of what it writes back; everything else has to survive.
    const weekly = await created(
      app,
      calendarId,
      createBody({
        rrule: 'FREQ=WEEKLY;INTERVAL=1;COUNT=4;BYDAY=TU,SU;WKST=MO',
      }),
    );
    assert.match(weekly.ical, /^RRULE:FREQ=WEEKLY;COUNT=4;BYDAY=TU,SU$/m);
    const allDay = await created(
      app,
      calendarId,
      createBody({
        start: { date: '2026-10-12' },
        end: { date: '2026-10-13' },
        rrule: 'FREQ=DAILY;UNTIL=20261015',
      }),
    );
    assert.match(allDay.ical, /^RRULE:FREQ=DAILY;UNTIL=20261015$/m);
  } finally {
    await app.close();
  }
});

test('an empty PATCH is a 422 and leaves the stored revision alone', async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    const body = await created(app, calendarId);
    const url = `/calendars/${calendarId}/events/${body.uid}`;
    const stored = caldav.stored(calendarId, `${body.uid}.ics`);
    assert.ok(stored);
    const reached = caldav.events.length;

    const response = await call(app, {
      method: 'PATCH',
      url,
      subject: 'owner',
      headers: { 'if-match': stored.etag },
      payload: {},
    });
    assert.equal(response.statusCode, 422, response.body);
    assertProblem(response.json(), 'invalid-input');

    // `SEQUENCE`, `DTSTAMP` and the `ETag` did not move: no revision was made.
    assert.equal(caldav.events.length, reached);
    assert.equal(caldav.stored(calendarId, `${body.uid}.ics`)?.ics, stored.ics);
    assert.equal(
      caldav.stored(calendarId, `${body.uid}.ics`)?.etag,
      stored.etag,
    );

    // A body that is not a JSON object at all is the same 422.
    const notAnObject = await call(app, {
      method: 'PATCH',
      url,
      subject: 'owner',
      headers: { 'if-match': stored.etag },
      payload: [],
    });
    assert.equal(notAnObject.statusCode, 422, notAnObject.body);
  } finally {
    await app.close();
  }
});

test('a framework refusal is a problem document and never reaches CalDAV', async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    /** @type {[string, string, number, string][]} */
    const cases = [
      [
        'an over-long calendar id',
        `/calendars/${'a'.repeat(300)}/events`,
        404,
        'not-found',
      ],
      [
        'an over-long uid',
        `/calendars/${calendarId}/events/${'b'.repeat(300)}`,
        404,
        'not-found',
      ],
      ['a URL that is not a URL', '/%', 400, 'bad-request'],
    ];
    for (const [what, url, status, kind] of cases) {
      const response = await call(app, { url, subject: 'owner' });
      assert.equal(response.statusCode, status, `${what}: ${response.body}`);
      assert.match(
        String(response.headers['content-type']),
        /^application\/problem\+json/,
        what,
      );
      assertProblem(response.json(), kind);
      // The fixed body carries nothing of the request — Fastify's own body
      // names the path it refused.
      assert.ok(!response.body.includes('aaaa'), response.body);
      assert.ok(!response.body.includes('bbbb'), response.body);
    }
    // The router refused every one of them before a route or a hook ran, so no
    // view was ever built.
    for (const op of ['forUser', 'putObject', 'getObject', 'deleteObject']) {
      assert.equal(
        opsOf(caldav.events).filter((entry) => entry === op).length,
        0,
        op,
      );
    }
  } finally {
    await app.close();
  }
});

test('the new paths answer 405 with Allow for a method they do not register', async () => {
  const { app, calendarId } = await setup();
  try {
    const collection = await call(app, {
      url: `/calendars/${calendarId}/events`,
      subject: 'owner',
    });
    assert.equal(collection.statusCode, 405, collection.body);
    assertProblem(collection.json(), 'method-not-allowed');
    assert.equal(collection.headers.allow, 'POST');

    const object = await call(app, {
      method: 'PUT',
      url: `/calendars/${calendarId}/events/${randomUUID()}`,
      subject: 'owner',
    });
    assert.equal(object.statusCode, 405, object.body);
    // Fastify synthesises HEAD for a GET, so it is in the set too.
    assert.equal(object.headers.allow, 'DELETE, GET, HEAD, PATCH');
  } finally {
    await app.close();
  }
});
