// --- E13-R02: the sidecar API against the local stack -------------------------
//
// These tests run **inside** the stack (`make test-api-caldav`): the delegated
// listener has no published port, and the CalDAV service only accepts a request
// from the `delegation` network. `server/api/Dockerfile`'s `test` target is what
// runs them, as the `api-test` service.
//
// The app under test is the real one — the real hooks, the real Postgres
// `event_envelopes` store, the real D-05 adapter and the real CalDAV service
// with its Private write guard behind it — and the requests arrive as HTTP
// through `inject`.
//
// What only the stack can show, and what this suite is for:
//
//   * a committed envelope is the bytes the client sealed, byte for byte, in
//     the real `bytea` columns;
//   * D-06's order really holds against the live service, and a fault between
//     the row insert and the skeleton `PUT` leaves the previous envelope
//     readable — the row that was inserted is an orphan the read gate ignores,
//     and the superseded-row collection removes the old row once the retry
//     commits.
//
// The suite seeds its own users and its own calendars and removes them again,
// so it can run twice in a row.

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { after, before, test } from 'node:test';
import pg from 'pg';

import { buildApp } from '../../src/app.mjs';
import { createCalendarStore } from '../../src/calendar-store.mjs';
import { CalDavError, createCalDavAdapter } from '../../src/caldav/adapter.mjs';
import { readConfig } from '../../src/config.mjs';
import { createEnvelopeStore } from '../../src/envelope-store.mjs';
import { createUserStore } from '../../src/store.mjs';

const databaseUrl = process.env.CALFLEX_DATABASE_URL;
const origin = process.env.CALFLEX_CALDAV_ORIGIN;
const delegationKeys = process.env.CALFLEX_DELEGATION_KEYS;

const ISSUER = 'https://auth.example.test';
const AUDIENCE = 'project-id';

/** The two users this suite owns, by the subject their token carries. */
const RUN = randomUUID();
const SUBJECTS = {
  a: `e13-r02-${RUN}-a`,
  b: `e13-r02-${RUN}-b`,
};

/** @type {pg.Pool} */
let pool;
/** @type {pg.Client} */
let verifier;
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

/**
 * The real adapter with one injectable fault: the next `putObject` of a
 * delegated view throws, which is how the write between D-06's first and second
 * steps is killed without stopping the service.
 */
function faultyAdapter() {
  const real = createCalDavAdapter();
  let failing = false;
  return {
    /** @param {boolean} value */
    failNextPut(value) {
      failing = value;
    },
    /** @param {string} userId @param {{requestId?: string}} [options] */
    forUser(userId, options) {
      const view = /** @type {any} */ (real.forUser(userId, options));
      return {
        ...view,
        /** @param {unknown[]} args */
        async putObject(...args) {
          if (failing) {
            failing = false;
            throw new CalDavError('network');
          }
          return view.putObject(...args);
        },
      };
    },
  };
}

/**
 * The app, with the real stores, the real adapter (or the faulty one) and a
 * captured log.
 * @param {{caldav?: any}} [options]
 */
function build(options = {}) {
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
    envelopes: createEnvelopeStore(pool),
    caldav: options.caldav ?? createCalDavAdapter(),
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
 * A metadata envelope for `POST /calendars`, opaque here (D-18).
 * @param {number} epoch
 * @param {number} [length]
 */
function metaEnvelope(epoch, length = 60) {
  const bytes = Buffer.alloc(Math.max(length, 45), 0xab);
  bytes[0] = 1;
  bytes.writeUInt32BE(epoch, 1);
  return bytes.toString('base64');
}

/**
 * An event envelope with the fixed header and opaque bytes after it.
 * @param {number} epoch
 * @param {number} [marker]
 */
function envelopeOf(epoch, marker = 0x7) {
  const bytes = Buffer.alloc(64, marker);
  bytes[0] = 1;
  bytes.writeUInt32BE(epoch, 1);
  return bytes;
}

/** @param {Buffer} bytes */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Creates one Private calendar through the API and returns its id. */
async function calendar(/** @type {import('fastify').FastifyInstance} */ app) {
  const response = await request(app, 'a', 'POST', '/calendars', {
    mode: 'private',
    metaEnvelope: metaEnvelope(1),
    metaEpoch: 1,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().id;
}

/** The stored rows of one calendar, straight from Postgres. */
async function rowsOf(/** @type {string} */ calendarId) {
  const { rows } = await verifier.query(
    `SELECT uid, recurrence_id, encode(envelope_sha256, 'hex') AS envelope_sha256,
            epoch, encode(envelope, 'hex') AS envelope
       FROM public.event_envelopes WHERE calendar_id = $1
      ORDER BY uid, envelope_sha256`,
    [calendarId],
  );
  return rows;
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
    const adapter = createCalDavAdapter();
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

test('a committed envelope is the bytes the client sealed, read back through the stack', async () => {
  const { app, capture } = build();
  try {
    const calendarId = await calendar(app);
    const uid = randomUUID();
    const bytes = envelopeOf(1);
    const hash = sha256(bytes);

    // A Private create is one request: it commits the skeleton and the envelope
    // in D-06's order — the row first, then the skeleton `PUT` (E13-R02).
    const created = await request(
      app,
      'a',
      'POST',
      `/calendars/${calendarId}/events`,
      {
        uid,
        start: { utc: '20261014T090000Z' },
        end: { utc: '20261014T100000Z' },
        alarm: { trigger: '-PT15M' },
        epoch: 1,
        envelope: bytes.toString('base64'),
        envelopeSha256: hash,
      },
    );
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().uid, uid);

    // The row holds exactly the bytes the client sealed, and its own hash.
    let rows = await rowsOf(calendarId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].uid, uid);
    assert.equal(rows[0].recurrence_id, null);
    assert.equal(rows[0].envelope_sha256, hash);
    assert.equal(rows[0].epoch, 1);
    assert.equal(rows[0].envelope, bytes.toString('hex'));

    // A re-seal goes through the sidecar write: the new row first, then the
    // skeleton carrying the new hash.
    const reSealed = envelopeOf(2, 0x22);
    const reSealedHash = sha256(reSealed);
    const written = await request(
      app,
      'a',
      'PUT',
      `/calendars/${calendarId}/envelopes/${uid}`,
      {
        envelope: reSealed.toString('base64'),
        epoch: 2,
        envelopeSha256: reSealedHash,
      },
      { 'if-match': created.json().etag },
    );
    assert.equal(written.statusCode, 200, written.body);
    assert.deepEqual(written.json(), {
      uid,
      recurrenceId: null,
      epoch: 2,
      envelopeSha256: reSealedHash,
      etag: written.json().etag,
    });

    rows = await rowsOf(calendarId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].envelope_sha256, reSealedHash);
    assert.equal(rows[0].envelope, reSealed.toString('hex'));

    // The read gate answers it, byte for byte.
    const read = await request(
      app,
      'a',
      'GET',
      `/calendars/${calendarId}/envelopes?uid=${uid}`,
    );
    assert.equal(read.statusCode, 200, read.body);
    const envelopes = read.json().envelopes;
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].envelopeSha256, reSealedHash);
    assert.deepEqual(Buffer.from(envelopes[0].envelope, 'base64'), reSealed);
    assert.ok(!capture.text().includes(bytes.toString('base64')));
    assert.ok(!capture.text().includes(reSealed.toString('base64')));
  } finally {
    await app.close();
  }
});

test('a fault between the row insert and the skeleton PUT leaves the old envelope readable', async () => {
  const caldav = faultyAdapter();
  const { app, capture } = build({ caldav });
  try {
    const calendarId = await calendar(app);
    const uid = randomUUID();
    const first = envelopeOf(1, 0x11);
    const second = envelopeOf(2, 0x22);

    // The create commits `first` in one request.
    const created = await request(
      app,
      'a',
      'POST',
      `/calendars/${calendarId}/events`,
      {
        uid,
        start: { utc: '20261014T090000Z' },
        end: { utc: '20261014T100000Z' },
        alarm: { trigger: '-PT15M' },
        epoch: 1,
        envelope: first.toString('base64'),
        envelopeSha256: sha256(first),
      },
    );
    assert.equal(created.statusCode, 201, created.body);
    const etag = created.json().etag;

    // The re-seal is killed between the two steps: the row is inserted, the
    // skeleton `PUT` never happens.
    caldav.failNextPut(true);
    const killed = await request(
      app,
      'a',
      'PUT',
      `/calendars/${calendarId}/envelopes/${uid}`,
      {
        envelope: second.toString('base64'),
        epoch: 2,
        envelopeSha256: sha256(second),
      },
      { 'if-match': etag },
    );
    assert.equal(killed.statusCode, 502, killed.body);

    // Both rows are in the table; the skeleton still names the first, so only
    // the first is answered — a crash cannot show a newer envelope than the
    // skeleton it belongs to (D-06).
    assert.equal((await rowsOf(calendarId)).length, 2);
    const afterCrash = await request(
      app,
      'a',
      'GET',
      `/calendars/${calendarId}/envelopes?uid=${uid}`,
    );
    assert.equal(afterCrash.statusCode, 200, afterCrash.body);
    assert.equal(afterCrash.json().envelopes.length, 1);
    assert.equal(afterCrash.json().envelopes[0].envelopeSha256, sha256(first));
    assert.deepEqual(
      Buffer.from(afterCrash.json().envelopes[0].envelope, 'base64'),
      first,
    );

    // The retry commits: the skeleton moves, the row is answered and the
    // superseded one is garbage-collected.
    const retried = await request(
      app,
      'a',
      'PUT',
      `/calendars/${calendarId}/envelopes/${uid}`,
      {
        envelope: second.toString('base64'),
        epoch: 2,
        envelopeSha256: sha256(second),
      },
      { 'if-match': etag },
    );
    assert.equal(retried.statusCode, 200, retried.body);
    const rows = await rowsOf(calendarId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].envelope_sha256, sha256(second));
    assert.equal(rows[0].envelope, second.toString('hex'));
    const after = await request(
      app,
      'a',
      'GET',
      `/calendars/${calendarId}/envelopes?uid=${uid}`,
    );
    assert.equal(after.json().envelopes[0].envelopeSha256, sha256(second));
    assert.ok(!capture.text().includes(second.toString('base64')));
  } finally {
    await app.close();
  }
});

test('a fault between the create row insert and the skeleton PUT leaves only an orphan row', async () => {
  const caldav = faultyAdapter();
  const { app, capture } = build({ caldav });
  try {
    const calendarId = await calendar(app);
    const uid = randomUUID();
    const bytes = envelopeOf(1, 0x33);

    // The create is killed after the row insert: the skeleton `PUT` never
    // happens, so no object exists — the crash leaves an orphan row, never a
    // skeleton whose envelope never existed (D-06).
    caldav.failNextPut(true);
    const crashed = await request(
      app,
      'a',
      'POST',
      `/calendars/${calendarId}/events`,
      {
        uid,
        start: { utc: '20261014T090000Z' },
        end: { utc: '20261014T100000Z' },
        epoch: 1,
        envelope: bytes.toString('base64'),
        envelopeSha256: sha256(bytes),
      },
    );
    assert.equal(crashed.statusCode, 502, crashed.body);

    // The row is there; no object is, and nothing is answered for the uid.
    let rows = await rowsOf(calendarId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].envelope_sha256, sha256(bytes));
    const afterCrash = await request(
      app,
      'a',
      'GET',
      `/calendars/${calendarId}/events/${uid}`,
    );
    assert.equal(afterCrash.statusCode, 404, afterCrash.body);
    const read = await request(
      app,
      'a',
      'GET',
      `/calendars/${calendarId}/envelopes?uid=${uid}`,
    );
    assert.equal(read.statusCode, 200, read.body);
    assert.deepEqual(read.json().envelopes, []);

    // The orphan is removed once it is a day old: age the row past the grace
    // and let the next successful write run the sweep. No skeleton names it and
    // the object is gone, so it is garbage.
    await verifier.query(
      `UPDATE public.event_envelopes SET created_at = now() - interval '25 hours'
        WHERE calendar_id = $1 AND uid = $2`,
      [calendarId, uid],
    );
    const other = envelopeOf(1, 0x44);
    const created = await request(
      app,
      'a',
      'POST',
      `/calendars/${calendarId}/events`,
      {
        uid: randomUUID(),
        start: { utc: '20261014T090000Z' },
        end: { utc: '20261014T100000Z' },
        epoch: 1,
        envelope: other.toString('base64'),
        envelopeSha256: sha256(other),
      },
    );
    assert.equal(created.statusCode, 201, created.body);

    rows = await rowsOf(calendarId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].envelope_sha256, sha256(other));
    assert.ok(!capture.text().includes(bytes.toString('base64')));
  } finally {
    await app.close();
  }
});

test('a non-member reads neither the envelopes nor the object', async () => {
  const { app } = build();
  try {
    const calendarId = await calendar(app);
    const refused = await request(
      app,
      'b',
      'GET',
      `/calendars/${calendarId}/envelopes`,
    );
    assert.equal(refused.statusCode, 404, refused.body);
  } finally {
    await app.close();
  }
});
