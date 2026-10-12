// --- E05-R04: the events API against the local stack -------------------------
//
// These tests run **inside** the stack (`make test-api-caldav`): the delegated
// listener has no published port, and the CalDAV service only accepts a request
// from the `delegation` network. `server/api/Dockerfile`'s `test` target is what
// runs them, as the `api-test` service.
//
// The app under test is the real one — the real hooks, the real Postgres store,
// the real D-05 adapter, the real CalDAV service with the E03-R09 write guard
// behind it — and the requests arrive as HTTP through `inject`. So what is
// exercised is the whole path of a write: validate, read, `ical.js`
// read-modify-write, `PUT` with the caller's precondition, and the answer the
// client caches (`ical` plus `ETag`).
//
// The suite seeds its own users and its own calendar and removes them again, so
// it can run twice in a row.
//
// What the real guard does to a content property is E05-R02's suite
// (`test/integration/caldav-adapter.test.mjs`, which sends one through the
// adapter and reads the refusal); here the same refusal is driven once more, to
// show that the mapping of a `403` with the `cf:private-skeleton-only`
// precondition — the one `src/events.mjs` answers with — really is the answer
// the live service produces, and that the marker never comes back.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { after, before, test } from 'node:test';
import pg from 'pg';

import { buildApp } from '../../src/app.mjs';
import { createCalendarStore } from '../../src/calendar-store.mjs';
import { CalDavError, createCalDavAdapter } from '../../src/caldav/adapter.mjs';
import { readConfig } from '../../src/config.mjs';
import { classifyCalDavError } from '../../src/problem.mjs';
import { createUserStore } from '../../src/store.mjs';
import { rawLines } from '../ical-roundtrip.mjs';

const databaseUrl = process.env.CALFLEX_DATABASE_URL;
const origin = process.env.CALFLEX_CALDAV_ORIGIN;
const delegationKeys = process.env.CALFLEX_DELEGATION_KEYS;

/** A value that must never reach a body or a log line. */
const CANARY = 'CALFLEX_EVENT_CONTENT_CANARY';

const ISSUER = 'https://auth.example.test';
const AUDIENCE = 'project-id';
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = 'b'.repeat(64);
/**
 * The hash of a re-sealed envelope. A patch that moves `start` or `end` carries
 * one, because both are bound into the envelope's AAD (`spec/crypto.md` §2.2,
 * E13-R02).
 */
const RESEALED_HASH = 'c'.repeat(64);

/** The two users this suite owns, by the subject their token carries. */
const RUN = randomUUID();
const SUBJECTS = {
  a: `e05-r04-${RUN}-a`,
  b: `e05-r04-${RUN}-b`,
};

/** @type {pg.Pool} */
let pool;
/** @type {pg.Client} */
let verifier;
/** @type {ReturnType<typeof createCalDavAdapter>} */
let adapter;
/** @type {Record<string, string>} */
const users = {};

/** A writable that keeps every log line the app writes. */
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

/** The app, with the real stores, the real adapter and a captured log. */
function build() {
  const capture = captureLog();
  const app = buildApp({
    config: readConfig({
      CALFLEX_OIDC_ISSUER: ISSUER,
      CALFLEX_OIDC_BASE_URL: ISSUER,
      CALFLEX_OIDC_AUDIENCE: AUDIENCE,
      CALFLEX_DATABASE_URL: databaseUrl,
    }),
    oidc: {
      /** @param {string} value */
      async verify(value) {
        const subject = String(value).split('.')[1];
        if (!Object.values(SUBJECTS).includes(subject)) {
          throw new Error('unknown token');
        }
        return { sub: subject };
      },
      async userinfo() {
        throw new Error('userinfo is not part of this suite');
      },
    },
    audience: {
      async current() {
        return AUDIENCE;
      },
      async refresh() {
        return false;
      },
    },
    store: createUserStore(pool),
    calendars: createCalendarStore(pool),
    caldav: adapter,
    logger: { stream: capture.stream },
  });
  return { app, capture };
}

/**
 * One request as `a` or `b`, from an already verified token.
 * @param {import('fastify').FastifyInstance} app
 * @param {string} key
 * @param {string} method
 * @param {string} url
 * @param {unknown} [payload]
 * @param {Record<string, string>} [headers]
 */
async function request(app, key, method, url, payload, headers = {}) {
  return /** @type {any} */ (
    await app.inject(
      /** @type {any} */ ({
        method,
        url,
        headers: {
          authorization: `Bearer a.${SUBJECTS[/** @type {keyof typeof SUBJECTS} */ (key)]}.c`,
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json' }),
          ...headers,
        },
        payload: payload === undefined ? undefined : JSON.stringify(payload),
      }),
    )
  );
}

/**
 * An envelope of `length` bytes: the sealed metadata of D-18, opaque here.
 * @param {number} epoch
 * @param {number} [length]
 */
function envelopeOf(epoch, length = 60) {
  const bytes = Buffer.alloc(Math.max(length, 45), 0xab);
  bytes[0] = 1;
  bytes.writeUInt32BE(epoch, 1);
  return bytes.toString('base64');
}

/** The value of one property, unfolded, from the master VEVENT of a text. */
const valueOf = (/** @type {string} */ text, /** @type {string} */ name) =>
  rawLines(text).find(
    (line) =>
      line.kind === 'property' &&
      line.path === 'VCALENDAR/VEVENT[0]' &&
      line.name === name,
  )?.value;

/** Creates one calendar through the API and returns its id. */
async function calendar(/** @type {import('fastify').FastifyInstance} */ app) {
  const response = await request(app, 'a', 'POST', '/calendars', {
    mode: 'private',
    metaEnvelope: envelopeOf(1),
    metaEpoch: 1,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().id;
}

/** A create body for one event. */
const body = (/** @type {Record<string, unknown>} */ over = {}) => ({
  start: { utc: '20261014T090000Z' },
  end: { utc: '20261014T100000Z' },
  alarm: { trigger: '-PT15M' },
  envelopeSha256: HASH,
  ...over,
});

before(async () => {
  assert.ok(
    databaseUrl,
    'CALFLEX_DATABASE_URL must be set for the stack suite',
  );
  assert.ok(origin, 'CALFLEX_CALDAV_ORIGIN must be set for the stack suite');
  assert.ok(
    delegationKeys,
    'CALFLEX_DELEGATION_KEYS must be set for the stack suite',
  );
  pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  verifier = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
  });
  await verifier.connect();
  adapter = createCalDavAdapter();
  for (const [key, subject] of Object.entries(SUBJECTS)) {
    const { rows } = await verifier.query(
      `INSERT INTO public.users (idp_subject, handle, email)
       VALUES ($1, $2, $3) RETURNING id`,
      [subject, `${subject}-handle`, `${subject}@example.invalid`],
    );
    users[key] = rows[0].id;
  }
});

after(async () => {
  if (!verifier) return;
  try {
    // The collections first: only DAV can remove them, and a collection whose
    // rows are gone is invisible to everyone (E03-R08).
    const { rows } = await verifier.query(
      'SELECT id, owner_id FROM public.calendars WHERE owner_id = ANY($1::uuid[])',
      [Object.values(users)],
    );
    for (const row of rows) {
      try {
        await adapter.forUser(row.owner_id).deleteCalendar(row.id);
      } catch {
        // Already deleted by the test that created it.
      }
    }
    await verifier.query(
      'DELETE FROM public.calendars WHERE owner_id = ANY($1::uuid[])',
      [Object.values(users)],
    );
    await verifier.query(
      'DELETE FROM public.users WHERE id = ANY($1::uuid[])',
      [Object.values(users)],
    );
  } finally {
    await verifier.end();
    await pool.end();
  }
});

test('create, read back byte for byte, patch on the right precondition, delete', async () => {
  const { app, capture } = build();
  try {
    const calendarId = await calendar(app);
    const created = await request(
      app,
      'a',
      'POST',
      `/calendars/${calendarId}/events`,
      body(),
      { 'x-request-id': randomUUID() },
    );
    assert.equal(created.statusCode, 201, created.body);
    const event = created.json();
    // INV-03: the UID is a random UUIDv4, and the object is addressed by it.
    assert.match(event.uid, UUID_V4);
    assert.equal(
      created.headers.location,
      `/calendars/${calendarId}/events/${event.uid}`,
    );
    assert.ok(event.etag, 'the create answered without an ETag');
    assert.equal(created.headers.etag, event.etag);
    assert.equal(valueOf(event.ical, 'UID'), event.uid);
    assert.equal(valueOf(event.ical, 'X-CALFLEX-ENVELOPE-SHA256'), HASH);
    assert.deepEqual(event.parsed.start, { utc: '20261014T090000Z' });

    // The read is the stored bytes, not a re-serialisation of them.
    const read = await request(
      app,
      'a',
      'GET',
      `/calendars/${calendarId}/events/${event.uid}`,
    );
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.json().ical, event.ical);
    assert.equal(read.json().etag, event.etag);
    assert.equal(read.headers.etag, event.etag);

    // A stale precondition is a 412 carrying the current representation, and
    // nothing of the request that lost the race.
    const stale = await request(
      app,
      'a',
      'PATCH',
      `/calendars/${calendarId}/events/${event.uid}`,
      {
        start: { utc: '20301231T235900Z' },
        end: { utc: '20301231T235959Z' },
        envelopeSha256: RESEALED_HASH,
      },
      { 'if-match': '"stale"' },
    );
    assert.equal(stale.statusCode, 412, stale.body);
    const problem = stale.json();
    assert.equal(
      problem.type,
      'https://flexcalendar.de/problems/precondition-failed',
    );
    assert.equal(problem.current.ical, event.ical);
    assert.equal(problem.current.etag, event.etag);
    assert.ok(!stale.body.includes('20301231T235900Z'), stale.body);

    // Without `If-Match` there is nothing to be optimistic against.
    const unconditional = await request(
      app,
      'a',
      'PATCH',
      `/calendars/${calendarId}/events/${event.uid}`,
      { start: { utc: '20261014T110000Z' } },
    );
    assert.equal(unconditional.statusCode, 428, unconditional.body);

    // The write that wins: `SEQUENCE` and `DTSTAMP` move, the fields change,
    // and the envelope hash stays where the sidecar needs it.
    const patched = await request(
      app,
      'a',
      'PATCH',
      `/calendars/${calendarId}/events/${event.uid}`,
      {
        start: { utc: '20261014T110000Z' },
        end: { utc: '20261014T113000Z' },
        alarm: null,
        envelopeSha256: RESEALED_HASH,
      },
      { 'if-match': event.etag },
    );
    assert.equal(patched.statusCode, 200, patched.body);
    const after = patched.json();
    assert.equal(valueOf(after.ical, 'DTSTART'), '20261014T110000Z');
    assert.equal(valueOf(after.ical, 'DTEND'), '20261014T113000Z');
    assert.equal(valueOf(after.ical, 'SEQUENCE'), '1');
    assert.equal(
      valueOf(after.ical, 'X-CALFLEX-ENVELOPE-SHA256'),
      RESEALED_HASH,
    );
    assert.equal(valueOf(after.ical, 'TRIGGER'), undefined);
    assert.equal(after.parsed.sequence, 1);
    assert.notEqual(after.etag, event.etag);

    // A stale validator on a delete leaves the object alone; the right one
    // removes it, and the collection answers 404 afterwards.
    const staleDelete = await request(
      app,
      'a',
      'DELETE',
      `/calendars/${calendarId}/events/${event.uid}`,
      undefined,
      { 'if-match': event.etag },
    );
    assert.equal(staleDelete.statusCode, 412, staleDelete.body);
    assert.equal(staleDelete.json().current.etag, after.etag);

    const deleted = await request(
      app,
      'a',
      'DELETE',
      `/calendars/${calendarId}/events/${event.uid}`,
      undefined,
      { 'if-match': after.etag },
    );
    assert.equal(deleted.statusCode, 204, deleted.body);
    const gone = await request(
      app,
      'a',
      'GET',
      `/calendars/${calendarId}/events/${event.uid}`,
    );
    assert.equal(gone.statusCode, 404, gone.body);

    assert.ok(!capture.text().includes(CANARY), capture.text());
  } finally {
    await app.close();
  }
});

test('a TZID event with its VTIMEZONE is accepted by the live write guard', async () => {
  const { app, capture } = build();
  try {
    const calendarId = await calendar(app);
    // E05-R09: the `VTIMEZONE` this API generates has to be one the real guard
    // of E03-R09 accepts — a Private collection stores skeletons, and a
    // `VTIMEZONE` property outside its allow-list would be a `403` here.
    const created = await request(
      app,
      'a',
      'POST',
      `/calendars/${calendarId}/events`,
      body({
        start: { local: '20261014T100000', tzid: 'Europe/Berlin' },
        end: { local: '20261014T110000', tzid: 'Europe/Berlin' },
      }),
    );
    assert.equal(created.statusCode, 201, created.body);
    const event = created.json();
    assert.equal(valueOf(event.ical, 'DTSTART'), '20261014T100000');
    assert.equal(valueOf(event.ical, 'DTEND'), '20261014T110000');
    assert.equal((event.ical.match(/BEGIN:VTIMEZONE/g) ?? []).length, 1);
    assert.deepEqual(event.parsed.start, {
      tzid: 'Europe/Berlin',
      local: '20261014T100000',
      utc: '20261014T080000Z',
    });

    // The read is the bytes the collection holds, the definition included.
    const read = await request(
      app,
      'a',
      'GET',
      `/calendars/${calendarId}/events/${event.uid}`,
    );
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.json().ical, event.ical);

    // A patch of the end keeps the definition the object already carries and
    // writes the new wall clock into the same zone.
    const patched = await request(
      app,
      'a',
      'PATCH',
      `/calendars/${calendarId}/events/${event.uid}`,
      {
        end: { local: '20261014T120000', tzid: 'Europe/Berlin' },
        envelopeSha256: RESEALED_HASH,
      },
      { 'if-match': event.etag },
    );
    assert.equal(patched.statusCode, 200, patched.body);
    const after = patched.json();
    assert.equal(valueOf(after.ical, 'DTEND'), '20261014T120000');
    assert.equal((after.ical.match(/BEGIN:VTIMEZONE/g) ?? []).length, 1);
    assert.deepEqual(after.parsed.end, {
      tzid: 'Europe/Berlin',
      local: '20261014T120000',
      utc: '20261014T100000Z',
    });
    assert.ok(!capture.text().includes(CANARY), capture.text());
  } finally {
    await app.close();
  }
});

test('a member who may read is refused a write, and a content field never reaches the guard', async () => {
  const { app, capture } = build();
  try {
    const calendarId = await calendar(app);
    await verifier.query(
      `INSERT INTO public.calendar_members (calendar_id, user_id, role)
       VALUES ($1, $2, 'viewer')`,
      [calendarId, users.b],
    );
    const created = await request(
      app,
      'a',
      'POST',
      `/calendars/${calendarId}/events`,
      body(),
    );
    assert.equal(created.statusCode, 201, created.body);
    const uid = created.json().uid;

    // The viewer reads and cannot write.
    const read = await request(
      app,
      'b',
      'GET',
      `/calendars/${calendarId}/events/${uid}`,
    );
    assert.equal(read.statusCode, 200, read.body);
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const refused = await request(
        app,
        'b',
        method,
        method === 'POST'
          ? `/calendars/${calendarId}/events`
          : `/calendars/${calendarId}/events/${uid}`,
        method === 'POST' ? body() : { start: { utc: '20261014T110000Z' } },
        method === 'POST' ? {} : { 'if-match': created.json().etag },
      );
      assert.equal(refused.statusCode, 403, `${method}: ${refused.body}`);
      assert.ok(!refused.body.includes(CANARY), method);
    }

    // A content field on a Private calendar is the API's own 422: the guard
    // never sees it, and its value never comes back.
    const content = await request(
      app,
      'a',
      'POST',
      `/calendars/${calendarId}/events`,
      body({ summary: CANARY }),
    );
    assert.equal(content.statusCode, 422, content.body);
    assert.equal(
      content.json().type,
      'https://flexcalendar.de/problems/invalid-input',
    );
    assert.ok(!content.body.includes(CANARY), content.body);
    assert.ok(!capture.text().includes(CANARY), capture.text());
  } finally {
    await app.close();
  }
});

test('the live guard refuses a content write, and the mapping the API uses names the property only', async () => {
  const { app } = build();
  try {
    const calendarId = await calendar(app);
    // A skeleton someone wrote directly — a stock app, or a build that skipped
    // the API's field set — with one content property added. This is the write
    // E03-R09 exists to refuse, and the refusal the API maps for its caller.
    const created = await request(
      app,
      'a',
      'POST',
      `/calendars/${calendarId}/events`,
      body(),
    );
    assert.equal(created.statusCode, 201, created.body);
    const uid = randomUUID();
    const error = await (async () => {
      try {
        await adapter
          .forUser(users.a)
          .putObject(
            calendarId,
            `${uid}.ics`,
            `${created
              .json()
              .ical.replace(
                'BEGIN:VALARM',
                `SUMMARY:${CANARY}\r\nBEGIN:VALARM`,
              )}`,
            { ifNoneMatch: '*' },
          );
      } catch (thrown) {
        return thrown;
      }
      return assert.fail('the guard accepted a content property');
    })();
    assert.ok(error instanceof CalDavError);
    assert.equal(error.status, 403);
    const classified = classifyCalDavError(error);
    assert.equal(classified.problem, 'private-skeleton-only');
    assert.equal(classified.property, 'SUMMARY');
    assert.ok(!JSON.stringify(classified).includes(CANARY));
    assert.ok(!String(error.message).includes(CANARY));
  } finally {
    await app.close();
  }
});

test('a series over the recurrence bound is a 422, and the CalDAV 403 behind it is the max-instances precondition', async () => {
  const { app } = build();
  try {
    const calendarId = await calendar(app);
    // The `FREQ=MINUTELY;COUNT=60000` series is over the service's 50,000
    // instances and finished well before 2038, so the walk SabreDAV makes on
    // every write is the one that crosses the bound.
    const refused = await request(
      app,
      'a',
      'POST',
      `/calendars/${calendarId}/events`,
      body({ rrule: 'FREQ=MINUTELY;COUNT=60000' }),
    );
    assert.equal(refused.statusCode, 422, refused.body);
    assert.deepEqual(
      { type: refused.json().type, status: refused.json().status },
      {
        type: 'https://flexcalendar.de/problems/too-many-instances',
        status: 422,
      },
    );
    assert.ok(!refused.body.includes('MINUTELY'), refused.body);

    // The `403` the API's answer is mapped from, read from the live service.
    const uid = randomUUID();
    const skeleton =
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Calflex//EN',
        'BEGIN:VEVENT',
        `UID:${uid}`,
        'DTSTAMP:20260101T000000Z',
        'DTSTART:20260101T090000Z',
        'DTEND:20260101T100000Z',
        'RRULE:FREQ=MINUTELY;COUNT=60000',
        `X-CALFLEX-ENVELOPE-SHA256:${HASH}`,
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n') + '\r\n';
    const error = await (async () => {
      try {
        await adapter
          .forUser(users.a)
          .putObject(calendarId, `${uid}.ics`, skeleton, { ifNoneMatch: '*' });
      } catch (thrown) {
        return thrown;
      }
      return assert.fail('the service stored a series over the bound');
    })();
    assert.ok(error instanceof CalDavError);
    assert.equal(error.status, 403);
    assert.ok(error.preconditions.includes('C:max-instances'), error.message);
    const classified = classifyCalDavError(error);
    assert.equal(classified.problem, 'too-many-instances');
    assert.ok(!classified.property);

    // Nothing of the refused write was stored.
    await assert.rejects(
      () => adapter.forUser(users.a).getObject(calendarId, `${uid}.ics`),
      (/** @type {CalDavError} */ read) => {
        assert.equal(read.kind, 'not-found');
        return true;
      },
    );
  } finally {
    await app.close();
  }
});
