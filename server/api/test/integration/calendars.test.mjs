// --- E05-R03: the calendars API against the local stack ----------------------
//
// These tests run **inside** the stack (`make test-api-caldav`): the delegated
// listener has no published port, and the CalDAV service only accepts a request
// from the `delegation` network. `server/api/Dockerfile`'s `test` target is what
// runs them, as the `api-test` service.
//
// The app under test is the real one — the real hooks, the real Postgres store,
// the real D-05 adapter — and the requests arrive as HTTP through `inject`, so
// what is exercised is the whole path of a create: validate, commit the rows,
// make the collection, answer 201. The end state is read back from both sides:
// the `calendars` rows through a second connection, the collection through the
// adapter and through a raw `PROPFIND` (the display name is a CalDAV property,
// and the adapter has no method that reads one back).
//
// The suite seeds its own users and removes them again, so it can run twice in
// a row.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { after, before, test } from 'node:test';
import pg from 'pg';

import { buildApp } from '../../src/app.mjs';
import { createCalendarStore } from '../../src/calendar-store.mjs';
import {
  RESPONSE_LIMIT_BYTES,
  REQUEST_TIMEOUT_MS,
  createCalDavAdapter,
  parseDelegationKeys,
  randomNonce,
  signedFetchFor,
} from '../../src/caldav/adapter.mjs';
import { readConfig } from '../../src/config.mjs';
import { createUserStore } from '../../src/store.mjs';

const databaseUrl = process.env.CALFLEX_DATABASE_URL;
const origin = process.env.CALFLEX_CALDAV_ORIGIN;
const delegationKeys = process.env.CALFLEX_DELEGATION_KEYS;

/** The correlation ID the Makefile greps the CalDAV log for (E05-R10). */
const REQUEST_ID = '11111111-2222-4333-8444-555555555555';

/** The fixed display name a Private collection carries (D-18, E03-R09). */
const DISPLAY_NAME = 'Private calendar';

/** A value that must never reach a log line or a response body. */
const CANARY = 'CALFLEX_API_ENVELOPE_CANARY';

const ISSUER = 'https://auth.example.test';
const AUDIENCE = 'project-id';

/** The two users this suite owns, by the subject their token carries. */
const RUN = randomUUID();
const SUBJECTS = {
  a: `e05-r03-${RUN}-a`,
  b: `e05-r03-${RUN}-b`,
};

/** @type {pg.Pool} */
let pool;
/** @type {pg.Client} */
let verifier;
/** @type {ReturnType<typeof createCalDavAdapter>} */
let adapter;
/** @type {Record<string, string>} */
const users = {};

/** The one range the suite asks about, wide enough for nothing. */
const RANGE = { start: '20260101T000000Z', end: '20270101T000000Z' };

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

/**
 * The app, with the real stores, the real adapter and a captured log.
 * @returns {{app: import('fastify').FastifyInstance, capture: {text: () => string}}}
 */
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
 * An envelope of `length` bytes, optionally carrying a marker after the header.
 * @param {number} epoch
 * @param {{length?: number, marker?: string}} [options]
 */
function envelopeOf(epoch, options = {}) {
  const { length = 60, marker } = options;
  const bytes = Buffer.alloc(Math.max(length, 45), 0xab);
  bytes[0] = 1;
  bytes.writeUInt32BE(epoch, 1);
  if (marker !== undefined) bytes.write(marker, 45, 'utf8');
  return bytes.toString('base64');
}

/**
 * A raw `PROPFIND` for one collection, through the API's own signed fetch.
 * @param {string} userId
 * @param {string} calendarId
 */
async function propfind(userId, calendarId) {
  const keys = parseDelegationKeys(delegationKeys);
  const signed = signedFetchFor({
    origin: new URL(String(adapter.origin)),
    principal: userId,
    keyId: keys[0].id,
    key: keys[0].key,
    transport: fetch,
    now: Date.now,
    nonce: randomNonce,
    limit: RESPONSE_LIMIT_BYTES,
    timeout: REQUEST_TIMEOUT_MS,
    requestId: REQUEST_ID,
  });
  const response = await signed(
    new URL(`/calendars/${userId}/${calendarId}/`, adapter.origin).href,
    {
      method: 'PROPFIND',
      headers: { depth: '0', 'content-type': 'application/xml' },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/>' +
        '</d:prop></d:propfind>',
    },
  );
  return { status: response.status, body: await response.text() };
}

/** @param {Promise<unknown>} promise */
async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail('expected the call to be rejected');
}

/**
 * Creates one calendar through the API and returns it.
 * @param {import('fastify').FastifyInstance} app
 * @param {number} [epoch]
 */
async function create(app, epoch = 1) {
  const response = await request(app, 'a', 'POST', '/calendars', {
    mode: 'private',
    metaEnvelope: envelopeOf(epoch),
    metaEpoch: epoch,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response;
}

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
  const role = await verifier.query('SELECT current_user');
  assert.equal(role.rows[0].current_user, 'calflex_api');
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

test('create makes the collection with the fixed name, and only its owner sees it', async () => {
  const { app, capture } = build();
  try {
    const metaEnvelope = envelopeOf(3);
    const created = await request(
      app,
      'a',
      'POST',
      '/calendars',
      { mode: 'private', metaEnvelope, metaEpoch: 3 },
      { 'x-request-id': REQUEST_ID },
    );
    assert.equal(created.statusCode, 201, created.body);
    const calendar = created.json();
    assert.equal(created.headers['x-request-id'], REQUEST_ID);
    assert.equal(created.headers.location, `/calendars/${calendar.id}`);
    assert.equal(calendar.metaEnvelope, metaEnvelope);

    // The rows, read through a second connection: committed by the time the
    // collection was made, which is what E03-R08 requires.
    const rows = await verifier.query(
      'SELECT id, owner_id, mode, caldav_href FROM public.calendars WHERE id = $1',
      [calendar.id],
    );
    assert.deepEqual(rows.rows, [
      {
        id: calendar.id,
        owner_id: users.a,
        mode: 'private',
        caldav_href: `/calendars/${users.a}/${calendar.id}/`,
      },
    ]);
    const membership = await verifier.query(
      'SELECT user_id, role FROM public.calendar_members WHERE calendar_id = $1',
      [calendar.id],
    );
    assert.deepEqual(membership.rows, [{ user_id: users.a, role: 'owner' }]);

    // The collection exists — a collection without a `calendars` row, or
    // without the collection, answers 404 on every method — and it carries the
    // fixed display name, never the client's sealed one.
    const listed = await adapter
      .forUser(users.a)
      .listObjects(calendar.id, RANGE);
    assert.ok(Array.isArray(listed));
    const propfinded = await propfind(users.a, calendar.id);
    assert.equal(propfinded.status, 207, propfinded.body);
    assert.match(propfinded.body, new RegExp(`displayname>${DISPLAY_NAME}<`));

    // The second user cannot see it: not in their list, and not on CalDAV.
    const own = await request(app, 'b', 'GET', '/calendars');
    assert.equal(own.statusCode, 200, own.body);
    assert.deepEqual(own.json(), { calendars: [] });
    const invisible = await rejectionOf(
      adapter.forUser(users.b).listObjects(calendar.id, RANGE),
    );
    assert.equal(/** @type {any} */ (invisible).kind, 'not-found');

    // Nothing of the envelope reached a log line: the API logs fixed fields
    // only, and the value never leaves the row (INV-07).
    assert.ok(!capture.text().includes(metaEnvelope));
  } finally {
    await app.close();
  }
});

test('a refused envelope is a 422 and its marker reaches neither body nor log', async () => {
  const { app, capture } = build();
  try {
    // The marker really is inside the envelope this request carries.
    const marked = envelopeOf(2, {
      length: 45 + CANARY.length + 4,
      marker: CANARY,
    });
    assert.ok(Buffer.from(marked, 'base64').includes(CANARY));
    // The epoch in the header disagrees with `metaEpoch`, so it is refused
    // whatever else is in the blob — the marker included.
    const refused = await request(app, 'a', 'POST', '/calendars', {
      mode: 'private',
      metaEnvelope: marked,
      metaEpoch: 1,
    });
    assert.equal(refused.statusCode, 422, refused.body);
    assert.ok(!refused.body.includes(CANARY));
    assert.ok(!refused.body.includes(marked.slice(0, 40)));

    // An envelope over the 4 KiB ceiling, likewise.
    const oversized = envelopeOf(1, { length: 4097 });
    const tooBig = await request(app, 'a', 'POST', '/calendars', {
      mode: 'private',
      metaEnvelope: oversized,
      metaEpoch: 1,
    });
    assert.equal(tooBig.statusCode, 422, tooBig.body);

    assert.ok(!capture.text().includes(CANARY), capture.text());
    assert.ok(!capture.text().includes(oversized));
    // Neither refusal created anything.
    const rows = await verifier.query(
      'SELECT count(*)::int AS n FROM public.calendars WHERE owner_id = $1',
      [users.a],
    );
    assert.equal(rows.rows[0].n, 0);
  } finally {
    await app.close();
  }
});

test('PATCH rewrites the envelope and leaves the collection alone', async () => {
  const { app, capture } = build();
  try {
    const calendarId = (await create(app, 1)).json().id;
    const replacement = envelopeOf(5);
    const renamed = await request(
      app,
      'a',
      'PATCH',
      `/calendars/${calendarId}`,
      { metaEnvelope: replacement, metaEpoch: 5 },
      { 'if-match': '"1"' },
    );
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal(renamed.json().version, 2);
    assert.equal(renamed.json().metaEnvelope, replacement);
    assert.equal(renamed.headers.etag, '"2"');

    // The collection is untouched: same address, same display name, and the
    // API made no CalDAV request for a rename at all.
    const propfinded = await propfind(users.a, calendarId);
    assert.equal(propfinded.status, 207, propfinded.body);
    assert.match(propfinded.body, new RegExp(`displayname>${DISPLAY_NAME}<`));
    const stored = await verifier.query(
      'SELECT meta_envelope, version FROM public.calendars WHERE id = $1',
      [calendarId],
    );
    assert.equal(stored.rows[0].version, 2);
    assert.equal(
      Buffer.from(stored.rows[0].meta_envelope).toString('base64'),
      replacement,
    );

    // A stale version is refused without touching anything.
    const stale = await request(
      app,
      'a',
      'PATCH',
      `/calendars/${calendarId}`,
      { metaEnvelope: envelopeOf(6), metaEpoch: 6 },
      { 'if-match': '"1"' },
    );
    assert.equal(stale.statusCode, 412, stale.body);
    assert.ok(!capture.text().includes(replacement));
  } finally {
    await app.close();
  }
});

test('DELETE removes the collection and the rows, and the collection answers 404', async () => {
  const { app } = build();
  try {
    const calendarId = (await create(app, 1)).json().id;
    const deleted = await request(
      app,
      'a',
      'DELETE',
      `/calendars/${calendarId}`,
    );
    assert.equal(deleted.statusCode, 204, deleted.body);

    // The collection is gone: every method on it is a 404 now.
    const gone = await rejectionOf(
      adapter.forUser(users.a).listObjects(calendarId, RANGE),
    );
    assert.equal(/** @type {any} */ (gone).kind, 'not-found');
    for (const [table, column] of [
      ['public.calendars', 'id'],
      ['public.calendar_members', 'calendar_id'],
    ]) {
      const rows = await verifier.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`,
        [calendarId],
      );
      assert.equal(rows.rows[0].n, 0, `${table} kept a row`);
    }
    // A retry is a 404 for the caller too: the calendar is not theirs any more.
    const retried = await request(
      app,
      'a',
      'DELETE',
      `/calendars/${calendarId}`,
    );
    assert.equal(retried.statusCode, 404, retried.body);
  } finally {
    await app.close();
  }
});

test('a second user cannot rename or delete what they are not a member of', async () => {
  const { app } = build();
  try {
    const calendarId = (await create(app, 1)).json().id;
    const renamed = await request(
      app,
      'b',
      'PATCH',
      `/calendars/${calendarId}`,
      { metaEnvelope: envelopeOf(2), metaEpoch: 2 },
      { 'if-match': '"1"' },
    );
    assert.equal(renamed.statusCode, 404, renamed.body);
    const deleted = await request(
      app,
      'b',
      'DELETE',
      `/calendars/${calendarId}`,
    );
    assert.equal(deleted.statusCode, 404, deleted.body);

    // The owner's calendar is exactly as it was.
    const stored = await verifier.query(
      'SELECT version, meta_epoch FROM public.calendars WHERE id = $1',
      [calendarId],
    );
    assert.deepEqual(stored.rows, [{ version: 1, meta_epoch: 1 }]);
    const stillThere = await adapter
      .forUser(users.a)
      .listObjects(calendarId, RANGE);
    assert.ok(Array.isArray(stillThere));
  } finally {
    await app.close();
  }
});
