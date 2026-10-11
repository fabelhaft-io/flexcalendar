// --- E05-R08: the delta endpoint against the local stack ---------------------
//
// These tests run **inside** the stack (`make test-api-caldav`): the delegated
// listener has no published port, and the CalDAV service only accepts a request
// from the `delegation` network. `server/api/Dockerfile`'s `test` target is what
// runs them, as the `api-test` service.
//
// The app under test is the real one — the real hooks, the real Postgres store,
// the real D-05 adapter, the real CalDAV service — so the token this endpoint
// mints really does travel to SabreDAV and back, and the `410` for a number the
// collection never reached is really this API's decision. That last point is why
// this suite also asks the **adapter** what SabreDAV does with such a number: it
// accepts it and echoes it (`CalDAV\Backend\PDO::getChangesForCalendar` only runs
// `calendarchanges.synctoken >= n` and never compares it to the collection). An
// endpoint that trusted the service would answer `200` with an empty change set
// and a token past the end, and the client would skip every change in between.
//
// The Accept line, in the stack: a create, an update and a delete between two
// tokens, and each kind of rejected token is a 410 — malformed, another
// calendar's, and ahead of the collection.
//
// The suite seeds its own users and calendars and removes them again, so it can
// run twice in a row.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { after, before, test } from 'node:test';
import pg from 'pg';

import { buildApp } from '../../src/app.mjs';
import { createCalendarStore } from '../../src/calendar-store.mjs';
import { createCalDavAdapter } from '../../src/caldav/adapter.mjs';
import { readConfig } from '../../src/config.mjs';
import { PROBLEM_TYPE_BASE, PROBLEM_TYPES } from '../../src/problem.mjs';
import { createUserStore } from '../../src/store.mjs';

/**
 * The members a problem document may carry (`spec/openapi.yaml`'s `Problem`).
 * Declared here rather than read from the spec: this suite runs inside the
 * `api-test` image, which carries production dependencies only — `yaml` is a
 * devDependency, and `test/support/problem.mjs`, which parses the spec with it,
 * cannot be imported here. `test/integration-imports.test.mjs` keeps it that
 * way.
 */
const PROBLEM_MEMBERS = [
  'type',
  'title',
  'status',
  'instance',
  'property',
  'current',
];

/**
 * Asserts a body is the fixed problem for one kind, and nothing besides: the
 * `type`, the `title`, the `status`, an `instance` and no other member. The
 * assertion the stack suite needs is the absence of anything request-derived,
 * which the member list gives without the schema checker of the unit suite.
 * @param {any} body
 * @param {'gone' | 'not-found'} slug
 * @returns {any}
 */
function assertProblem(body, slug) {
  const entry = PROBLEM_TYPES[slug];
  assert.ok(entry !== undefined, `unknown problem type: ${slug}`);
  assert.equal(body.type, `${PROBLEM_TYPE_BASE}${slug}`);
  assert.equal(body.title, entry.title);
  assert.equal(body.status, entry.status);
  assert.match(body.instance, /^urn:uuid:[0-9a-f-]{36}$/);
  for (const key of Object.keys(body)) {
    assert.ok(PROBLEM_MEMBERS.includes(key), `unexpected member ${key}`);
  }
  return body;
}

const databaseUrl = process.env.CALFLEX_DATABASE_URL;
const origin = process.env.CALFLEX_CALDAV_ORIGIN;
const delegationKeys = process.env.CALFLEX_DELEGATION_KEYS;

const ISSUER = 'https://auth.example.test';
const AUDIENCE = 'project-id';
const HASH = 'c'.repeat(64);

const RUN = randomUUID();
const SUBJECTS = {
  a: `e05-r08-${RUN}-a`,
  b: `e05-r08-${RUN}-b`,
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
 * @param {keyof typeof SUBJECTS} key
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
          authorization: `Bearer a.${SUBJECTS[key]}.c`,
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
 * An envelope of the D-18 shape: opaque here, with a version byte and the epoch.
 * @param {number} epoch
 */
function envelopeOf(epoch) {
  const bytes = Buffer.alloc(60, 0xab);
  bytes[0] = 1;
  bytes.writeUInt32BE(epoch, 1);
  return bytes.toString('base64');
}

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
  envelopeSha256: HASH,
  ...over,
});

/** One event through the API, and its representation back. */
async function created(
  /** @type {import('fastify').FastifyInstance} */ app,
  /** @type {string} */ calendarId,
) {
  const response = await request(
    app,
    'a',
    'POST',
    `/calendars/${calendarId}/events`,
    body(),
  );
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

/** `GET …/changes`, with `since` only when there is one. */
async function changes(
  /** @type {import('fastify').FastifyInstance} */ app,
  /** @type {string} */ calendarId,
  /** @type {string | undefined} */ since,
  /** @type {keyof typeof SUBJECTS} */ key = 'a',
) {
  return request(
    app,
    key,
    'GET',
    `/calendars/${calendarId}/changes${since === undefined ? '' : `?since=${encodeURIComponent(since)}`}`,
  );
}

/** The calendar id and the number an opaque token names. */
function decode(/** @type {string} */ value) {
  const text = Buffer.from(value, 'base64url').toString('utf8');
  const separator = text.lastIndexOf(':');
  return {
    calendarId: text.slice(0, separator),
    number: text.slice(separator + 1),
  };
}

/** The token for a point in a calendar, built the way the API builds one. */
const mint = (/** @type {string} */ calendarId, /** @type {string} */ number) =>
  Buffer.from(`${calendarId}:${number}`).toString('base64url');

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

test('a create, an update and a delete between two tokens', async () => {
  const { app, capture } = build();
  try {
    const calendarId = await calendar(app);
    // Two objects first, so the window starts somewhere real: one to update, one
    // to delete.
    const touched = await created(app, calendarId);
    const doomed = await created(app, calendarId);
    const start = await changes(app, calendarId, undefined);
    assert.equal(start.statusCode, 200, start.body);
    const since = start.json().token;
    assert.equal(start.json().changes.length, 2);
    assert.equal(decode(since).calendarId, calendarId);

    // A create, an update and a delete *between two tokens*.
    const added = await created(app, calendarId);
    const patch = await request(
      app,
      'a',
      'PATCH',
      `/calendars/${calendarId}/events/${touched.uid}`,
      { start: { utc: '20261014T083000Z' } },
      { 'if-match': touched.etag },
    );
    assert.equal(patch.statusCode, 200, patch.body);
    const updated = patch.json();
    const drop = await request(
      app,
      'a',
      'DELETE',
      `/calendars/${calendarId}/events/${doomed.uid}`,
      undefined,
      { 'if-match': doomed.etag },
    );
    assert.equal(drop.statusCode, 204, drop.body);

    const delta = await changes(app, calendarId, since);
    assert.equal(delta.statusCode, 200, delta.body);
    const answer = delta.json();
    assert.equal(answer.changes.length, 3);
    assert.deepEqual(
      answer.changes.find(
        (/** @type {any} */ entry) => entry.uid === added.uid,
      ),
      { uid: added.uid, deleted: false, etag: added.etag },
    );
    assert.deepEqual(
      answer.changes.find(
        (/** @type {any} */ entry) => entry.uid === updated.uid,
      ),
      { uid: updated.uid, deleted: false, etag: updated.etag },
    );
    const tombstone = answer.changes.find(
      (/** @type {any} */ entry) => entry.uid === doomed.uid,
    );
    assert.deepEqual(tombstone, { uid: doomed.uid, deleted: true });
    assert.equal(Object.hasOwn(tombstone, 'etag'), false);
    assert.notEqual(answer.token, since);

    // The new token is the collection's position: nothing is left to report.
    assert.deepEqual(
      (await changes(app, calendarId, answer.token)).json().changes,
      [],
    );
    // The token went to CalDAV and back, and no log line carries it — neither
    // as the client sent it (`since`, and the token this answer returned, which
    // the next poll sends) nor as the `<calendar id>:<n>` it decodes to.
    const log = capture.text();
    assert.ok(!log.includes(answer.token), 'the answer token reached the log');
    assert.ok(!log.includes(since), 'the since token reached the log');
    assert.ok(
      !log.includes(Buffer.from(since, 'base64url').toString('utf8')),
      'the decoded token reached the log',
    );
  } finally {
    await app.close();
  }
});

test('each kind of rejected token is a 410', async () => {
  const { app, capture } = build();
  try {
    const calendarId = await calendar(app);
    const elsewhere = await calendar(app);
    await created(app, calendarId);
    await created(app, elsewhere);
    const ours = await changes(app, calendarId, undefined);
    const theirs = await changes(app, elsewhere, undefined);
    assert.equal(ours.statusCode, 200, ours.body);
    assert.equal(theirs.statusCode, 200, theirs.body);

    const rejected = [
      // Not a token this API minted at all.
      'not-a-token',
      '',
      Buffer.from('not a token').toString('base64url'),
      Buffer.from(`${calendarId}:1e3`).toString('base64url'),
      // A number this collection has never reached. SabreDAV would accept it
      // (see the adapter test below), so the 410 is this API's own check.
      mint(calendarId, String(Number(decode(ours.json().token).number) + 5)),
      // A live token of a calendar that is not the one in the path.
      theirs.json().token,
    ];
    for (const value of rejected) {
      const response = await changes(app, calendarId, value);
      assert.equal(response.statusCode, 410, `${value}: ${response.body}`);
      assertProblem(response.json(), 'gone');
      // The refused token is never echoed back. The empty `since` is left out:
      // every string contains it.
      if (value !== '') assert.ok(!response.body.includes(value));
    }

    // The calendar is unharmed: its own token still answers.
    assert.equal(
      (await changes(app, calendarId, ours.json().token)).statusCode,
      200,
    );

    // And no refused token reached a log line either — not the one the client
    // sent, not a refused value's `<calendar id>:<n>` form. The empty `since`
    // is left out: every string contains it.
    const log = capture.text();
    for (const value of rejected) {
      if (value === '') continue;
      assert.ok(
        !log.includes(value),
        `a refused token reached the log: ${value}`,
      );
      assert.ok(
        !log.includes(Buffer.from(value, 'base64url').toString('utf8')),
        'a refused token reached the log decoded',
      );
    }
  } finally {
    await app.close();
  }
});

test('every member reads; a non-member gets the 404 an unknown calendar gets', async () => {
  const { app } = build();
  try {
    const shared = await calendar(app);
    const other = await calendar(app);
    await created(app, shared);
    await verifier.query(
      `INSERT INTO public.calendar_members (calendar_id, user_id, role)
       VALUES ($1, $2, 'viewer')`,
      [shared, users.b],
    );
    // A viewer reads the delta of a calendar they are a member of…
    const viewer = await changes(app, shared, undefined, 'b');
    assert.equal(viewer.statusCode, 200, viewer.body);
    assert.equal(viewer.json().changes.length, 1);
    // …and gets the same 404 for one they are not: no membership, no calendar.
    const stranger = await changes(app, other, undefined, 'b');
    assert.equal(stranger.statusCode, 404, stranger.body);
    assertProblem(stranger.json(), 'not-found');
  } finally {
    await app.close();
  }
});

test('the live service accepts a token ahead of the collection, so the API must not', async () => {
  const { app } = build();
  try {
    const calendarId = await calendar(app);
    await created(app, calendarId);
    const initial = await changes(app, calendarId, undefined);
    const { number } = decode(initial.json().token);
    const ahead = `http://sabre.io/ns/sync/${Number(number) + 5}`;
    const report = await adapter
      .forUser(users.a)
      .syncChanges(calendarId, ahead);
    // SabreDAV answers 207 with the number it was given and nothing to report.
    // This is the evidence for the API's own check: an endpoint that trusted the
    // service here would answer 200 with an empty change set and a token five
    // changes past the collection, and the client would never see the changes in
    // between.
    assert.equal(report.syncToken, ahead);
    assert.deepEqual(report.changed, []);
  } finally {
    await app.close();
  }
});
