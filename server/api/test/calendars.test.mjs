// --- E05-R03: the calendars API, without a database --------------------------
//
// Every route of E05-R03 through the real `buildApp`: the real hooks, the real
// validation, the real problem documents, against an in-memory calendar store
// and a fake CalDAV adapter. The store is mutable state the API changes, so
// "the row is gone" or "the version moved" is an assertion about what the
// routes did — not about a stub that always says yes.
//
// What is under test, in the order the requirement states it:
//
//   * create requires an explicit `mode`, only `private` is accepted, a missing
//     or bad envelope is refused, and a plaintext `name`/`color` is refused —
//     all of them as one 422 with a fixed body;
//   * the row and the membership row are committed before the collection is
//     made, and removed again when it fails;
//   * delete removes the collection first and the rows second;
//   * only the owner may rename or delete, and a non-member gets the same 404 an
//     unknown id gets;
//   * `If-Match` is required (428) and stale (412), and the id and the href are
//     UUIDv4 (INV-03).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { test } from 'node:test';

import { buildApp } from '../src/app.mjs';
import { CalDavError } from '../src/caldav/adapter.mjs';
import { readConfig } from '../src/config.mjs';
import { createMemoryCalendarStore } from './support/calendar-store.mjs';
import { assertProblem } from './support/problem.mjs';

const ISSUER = 'https://auth.example.test';
const AUDIENCE = 'project-id';
const OWNER = {
  id: '11111111-1111-4111-8111-111111111111',
  handle: 'alice',
  email: 'alice@example.test',
};
const OTHER = {
  id: '22222222-2222-4222-8222-222222222222',
  handle: 'bob',
  email: 'bob@example.test',
};
/** A user who is a member of nothing. */
const STRANGER = {
  id: '33333333-3333-4333-8333-333333333333',
  handle: 'carol',
  email: 'carol@example.test',
};
const USERS = { owner: OWNER, other: OTHER, stranger: STRANGER };
/** A value that must never reach a body or a log line. */
const CANARY = 'CALFLEX-E05R03-LOG-CANARY';
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

/** The `users` store: both subjects already have a row. */
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

/** An envelope of `length` bytes with `version` at byte 0 and `epoch` in 1–4. */
function envelopeOf(
  /** @type {number} */ epoch,
  { version = 1, length = 48 } = {},
) {
  const bytes = Buffer.alloc(Math.max(length, 5), 0xab);
  bytes[0] = version;
  bytes.writeUInt32BE(epoch, 1);
  return bytes.toString('base64');
}

/**
 * The fake CalDAV adapter. It records every call, and every call it would make
 * lands in the same event log the store writes to, so a test can assert the
 * order of "the rows are committed" and "the collection is made".
 * @param {{events?: Record<string, unknown>[], fail?: Record<string, unknown>}} [options]
 */
function fakeAdapter({ events = [], fail = {} } = {}) {
  /** @type {{userId: string, requestId?: string}[]} */
  const calls = [];
  return {
    calls,
    /** @param {string} userId @param {{requestId?: string}} [options] */
    forUser(userId, options = {}) {
      calls.push({ userId, requestId: options.requestId });
      events.push({ op: 'forUser', userId });
      return {
        /** @param {string} calendarId */
        async makeCalendar(calendarId) {
          events.push({ op: 'makeCalendar', calendarId });
          if (fail.makeCalendar !== undefined) throw fail.makeCalendar;
          return { status: 201 };
        },
        /** @param {string} calendarId */
        async deleteCalendar(calendarId) {
          events.push({ op: 'deleteCalendar', calendarId });
          if (fail.deleteCalendar !== undefined) throw fail.deleteCalendar;
          return { status: 204 };
        },
      };
    },
  };
}

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
 * The app, with a memory store, a fake adapter and a captured log. `fail` is
 * applied to whichever side owns the method: a calendar-store method breaks the
 * store, `makeCalendar`/`deleteCalendar` break CalDAV.
 * @param {{fail?: Record<string, unknown>}} [options]
 */
function build({ fail = {} } = {}) {
  const capture = captureLog();
  /** @type {Record<string, unknown>[]} */
  const events = [];
  const calendars = createMemoryCalendarStore({ events });
  /** @type {Record<string, unknown>} */
  const adapterFail = {};
  for (const [method, error] of Object.entries(fail)) {
    if (STORE_METHODS.includes(method))
      calendars.fail(method, /** @type {Error} */ (error));
    else adapterFail[method] = error;
  }
  const caldav = fakeAdapter({ events, fail: adapterFail });
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
    logger: { stream: capture.stream },
  });
  return { app, capture, calendars, caldav, events };
}

/** The calendar-store methods a `fail` entry can break. */
const STORE_METHODS = [
  'listForMember',
  'findMembership',
  'createPrivate',
  'replaceMeta',
  'remove',
];

/** @param {Record<string, unknown>[]} events */
const opsOf = (events) => events.map((entry) => String(entry.op));

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

/** Seeds one calendar directly in the store, as an earlier request would have. */
async function seeded(
  /** @type {ReturnType<typeof createMemoryCalendarStore>} */ calendars,
  { epoch = 1, ownerId = OWNER.id } = {},
) {
  const id = randomUUID();
  await calendars.createPrivate({
    id,
    ownerId,
    href: `/calendars/${ownerId}/${id}/`,
    metaEnvelope: Buffer.from(envelopeOf(epoch), 'base64'),
    metaEpoch: epoch,
  });
  return id;
}

test('create mints a UUIDv4 id, stores the envelope and commits the rows first', async () => {
  const { app, calendars, caldav, events } = build();
  try {
    const metaEnvelope = envelopeOf(7);
    const response = await call(app, {
      method: 'POST',
      url: '/calendars',
      subject: 'owner',
      payload: { mode: 'private', metaEnvelope, metaEpoch: 7 },
    });
    assert.equal(response.statusCode, 201, response.body);
    const body = response.json();
    // INV-03: the id, and therefore the collection href, is a random UUIDv4.
    assert.match(body.id, UUID_V4);
    assert.equal(body.mode, 'private');
    assert.equal(body.role, 'owner');
    assert.equal(body.version, 1);
    assert.equal(body.metaEnvelope, metaEnvelope);
    assert.equal(body.metaEpoch, 7);
    assert.match(body.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(body.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(response.headers.location, `/calendars/${body.id}`);
    assert.equal(response.headers.etag, '"1"');

    // The rows: the calendar, the owner's membership, and the href the CalDAV
    // collection is addressed by.
    const rows = calendars.rows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, body.id);
    assert.equal(rows[0].ownerId, OWNER.id);
    assert.equal(rows[0].href, `/calendars/${OWNER.id}/${body.id}/`);
    assert.deepEqual(calendars.memberships(), [
      { calendarId: body.id, userId: OWNER.id, role: 'owner' },
    ]);
    // The row is committed before the collection is made (E03-R08): the store
    // appends its event only once the row and its membership are there.
    assert.deepEqual(opsOf(events), [
      'forUser',
      'createPrivate',
      'makeCalendar',
    ]);
    assert.equal(String(events[2].calendarId), body.id);
    // The delegation and the correlation ID are the caller's (E05-R10).
    assert.equal(caldav.calls.length, 1);
    assert.equal(caldav.calls[0].userId, OWNER.id);
    assert.match(String(response.headers['x-request-id']), UUID_V4);
    assert.equal(caldav.calls[0].requestId, response.headers['x-request-id']);
  } finally {
    await app.close();
  }
});

test('the create refusals are one 422 with a fixed body, and none of them touches CalDAV', async () => {
  const { app, capture, calendars, events } = build();
  try {
    const valid = {
      mode: 'private',
      metaEnvelope: envelopeOf(1),
      metaEpoch: 1,
    };
    /** @type {[string, unknown][]} */
    const cases = [
      ['no body at all', undefined],
      ['no mode', { metaEnvelope: envelopeOf(1), metaEpoch: 1 }],
      ['mode shared', { ...valid, mode: 'shared' }],
      ['mode published', { ...valid, mode: 'published' }],
      ['mode not a string', { ...valid, mode: 5 }],
      ['mode null', { ...valid, mode: null }],
      ['no metaEnvelope', { mode: 'private', metaEpoch: 1 }],
      ['no metaEpoch', { mode: 'private', metaEnvelope: envelopeOf(1) }],
      ['epoch not an integer', { ...valid, metaEpoch: '1' }],
      [
        'an unknown envelope version',
        { ...valid, metaEnvelope: envelopeOf(1, { version: 2 }) },
      ],
      [
        'an epoch that disagrees with the header',
        { mode: 'private', metaEnvelope: envelopeOf(2), metaEpoch: 1 },
      ],
      [
        'an envelope short of the fixed fields',
        { ...valid, metaEnvelope: envelopeOf(1, { length: 44 }) },
      ],
      [
        'an envelope over 4096 bytes',
        { ...valid, metaEnvelope: envelopeOf(1, { length: 4097 }) },
      ],
      ['an envelope that is not base64', { ...valid, metaEnvelope: CANARY }],
      ['a plaintext name', { ...valid, name: 'Chemo' }],
      ['a plaintext color', { ...valid, color: '#ff0000' }],
      ['a member the operation does not take', { ...valid, colour: 'red' }],
    ];
    for (const [what, payload] of cases) {
      const response = await call(app, {
        method: 'POST',
        url: '/calendars',
        subject: 'owner',
        payload,
      });
      assert.equal(response.statusCode, 422, `${what}: ${response.body}`);
      assertProblem(response.json(), 'invalid-input');
      assert.ok(!response.body.includes(CANARY), what);
      assert.ok(!response.body.includes('Chemo'), what);
      assert.ok(!response.body.includes('#ff0000'), what);
    }
    // Nothing was stored and nothing reached CalDAV.
    assert.deepEqual(calendars.rows(), []);
    assert.deepEqual(calendars.memberships(), []);
    assert.deepEqual(opsOf(events), []);
    assert.ok(!capture.text().includes(CANARY));
  } finally {
    await app.close();
  }
});

test('a body that is not JSON is a 400, a body that is not an object a 422', async () => {
  const { app, calendars } = build();
  try {
    const malformed = await call(app, {
      method: 'POST',
      url: '/calendars',
      subject: 'owner',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    assert.equal(malformed.statusCode, 400, malformed.body);
    assertProblem(malformed.json(), 'bad-request');

    for (const payload of ['["array"]', '"string"', 'null', '7']) {
      const response = await call(app, {
        method: 'POST',
        url: '/calendars',
        subject: 'owner',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      assert.equal(response.statusCode, 422, `${payload}: ${response.body}`);
      assertProblem(response.json(), 'invalid-input');
    }
    assert.deepEqual(calendars.rows(), []);
  } finally {
    await app.close();
  }
});

test('a collection that cannot be made removes the rows again, and a CalDAV 401 is not the caller 401', async () => {
  /** @type {[string, unknown, number][]} */
  const cases = [
    // A 401 from the listener is our delegation failing, not the caller's
    // token: answering 401 would sign a correctly authenticated client out.
    ['a listener 401', new CalDavError('unauthorized', 401), 502],
    ['a listener 503', new CalDavError('server', 503), 503],
    ['a listener 412', new CalDavError('precondition-failed', 412), 412],
    ['a timeout', new CalDavError('timeout'), 504],
    ['a refusal', new CalDavError('forbidden', 403), 403],
    ['a redirect', new CalDavError('redirect', 302), 502],
  ];
  for (const [what, error, status] of cases) {
    const { app, calendars, events } = build({ fail: { makeCalendar: error } });
    try {
      const response = await call(app, {
        method: 'POST',
        url: '/calendars',
        subject: 'owner',
        payload: { mode: 'private', metaEnvelope: envelopeOf(1), metaEpoch: 1 },
      });
      assert.equal(response.statusCode, status, `${what}: ${response.body}`);
      // The compensation: no calendar row and no membership row is left
      // claiming the id that was already handed out.
      assert.deepEqual(calendars.rows(), [], what);
      assert.deepEqual(calendars.memberships(), [], what);
      assert.deepEqual(
        opsOf(events),
        ['forUser', 'createPrivate', 'makeCalendar', 'remove'],
        what,
      );
    } finally {
      await app.close();
    }
  }
});

test('a compensation that fails answers 500 and logs error names only', async () => {
  const { app, capture, calendars } = build({
    fail: {
      makeCalendar: new CalDavError('server', 503),
      remove: new Error(CANARY),
    },
  });
  try {
    const response = await call(app, {
      method: 'POST',
      url: '/calendars',
      subject: 'owner',
      payload: { mode: 'private', metaEnvelope: envelopeOf(1), metaEpoch: 1 },
    });
    assert.equal(response.statusCode, 500, response.body);
    assertProblem(response.json(), 'internal-error');
    const text = capture.text();
    assert.ok(
      !text.includes(CANARY),
      'the compensation message reached the log',
    );
    assert.ok(!response.body.includes(CANARY));
    assert.ok(text.includes('calendar_create_failed'));
    assert.ok(text.includes('calendar_compensation_failed'));
    assert.ok(text.includes('"type":"CalDavError"'));
    assert.ok(text.includes('"type":"Error"'));
    // The row is still there — that is exactly why the answer is a 500.
    assert.equal(calendars.rows().length, 1);
  } finally {
    await app.close();
  }
});

test('PATCH replaces the envelope behind an If-Match and never touches CalDAV', async () => {
  const { app, calendars, caldav, events } = build();
  try {
    const id = await seeded(calendars);
    const metaEnvelope = envelopeOf(9);
    const response = await call(app, {
      method: 'PATCH',
      url: `/calendars/${id}`,
      subject: 'owner',
      headers: { 'if-match': '"1"' },
      payload: { metaEnvelope, metaEpoch: 9 },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.id, id);
    assert.equal(body.role, 'owner');
    assert.equal(body.version, 2);
    assert.equal(body.metaEnvelope, metaEnvelope);
    assert.equal(body.metaEpoch, 9);
    assert.equal(response.headers.etag, '"2"');
    // The row: the new bytes, the new epoch, the bumped version.
    const row = calendars.rows()[0];
    assert.equal(row.version, 2);
    assert.equal(row.metaEpoch, 9);
    assert.equal(row.metaEnvelope, metaEnvelope);
    // A rename is rows-only: the collection keeps the fixed display name.
    assert.deepEqual(opsOf(events), ['createPrivate', 'replaceMeta']);
    assert.equal(caldav.calls.length, 0);
  } finally {
    await app.close();
  }
});

test('two renames with the same If-Match: one wins, the other is a 412', async () => {
  const { app, calendars } = build();
  try {
    const id = await seeded(calendars);
    const first = await call(app, {
      method: 'PATCH',
      url: `/calendars/${id}`,
      subject: 'owner',
      headers: { 'if-match': '"1"' },
      payload: { metaEnvelope: envelopeOf(2), metaEpoch: 2 },
    });
    assert.equal(first.statusCode, 200, first.body);
    const second = await call(app, {
      method: 'PATCH',
      url: `/calendars/${id}`,
      subject: 'owner',
      headers: { 'if-match': '"1"' },
      payload: { metaEnvelope: envelopeOf(3), metaEpoch: 3 },
    });
    assert.equal(second.statusCode, 412, second.body);
    assertProblem(second.json(), 'precondition-failed');
    // The loser's envelope is nowhere: the row still holds the winner's.
    assert.equal(calendars.rows()[0].version, 2);
    assert.equal(calendars.rows()[0].metaEpoch, 2);
  } finally {
    await app.close();
  }
});

test('PATCH without If-Match is a 428, and a stale or weak one a 412', async () => {
  const { app, calendars } = build();
  try {
    const id = await seeded(calendars);
    const payload = { metaEnvelope: envelopeOf(2), metaEpoch: 2 };

    const missing = await call(app, {
      method: 'PATCH',
      url: `/calendars/${id}`,
      subject: 'owner',
      payload,
    });
    assert.equal(missing.statusCode, 428, missing.body);
    assertProblem(missing.json(), 'precondition-required');

    // An empty `If-Match` carries no validator at all, so it is the same
    // refusal as a missing one.
    const empty = await call(app, {
      method: 'PATCH',
      url: `/calendars/${id}`,
      subject: 'owner',
      headers: { 'if-match': '' },
      payload,
    });
    assert.equal(empty.statusCode, 428, empty.body);
    assertProblem(empty.json(), 'precondition-required');

    for (const header of ['"2"', '"0"', 'W/"1"', '"not-a-version"', '*x']) {
      const response = await call(app, {
        method: 'PATCH',
        url: `/calendars/${id}`,
        subject: 'owner',
        headers: { 'if-match': header },
        payload,
      });
      assert.equal(response.statusCode, 412, `${header}: ${response.body}`);
      assertProblem(response.json(), 'precondition-failed');
    }
    // A list matches on one of its entries; `*` accepts whatever the current
    // version is. Each one bumps the version, so they run in this order.
    for (const header of ['"9", "1"', '*']) {
      const response = await call(app, {
        method: 'PATCH',
        url: `/calendars/${id}`,
        subject: 'owner',
        headers: { 'if-match': header },
        payload,
      });
      assert.equal(response.statusCode, 200, `${header}: ${response.body}`);
    }
    assert.equal(calendars.rows()[0].version, 3);
  } finally {
    await app.close();
  }
});

test('the rename refusals are one 422 and change nothing', async () => {
  const { app, calendars } = build();
  try {
    const id = await seeded(calendars);
    /** @type {[string, unknown][]} */
    const cases = [
      ['no body at all', undefined],
      ['a plaintext name', { name: 'Chemo' }],
      [
        'a plaintext color',
        { metaEnvelope: envelopeOf(2), metaEpoch: 2, color: '#ff0000' },
      ],
      [
        'a mode change',
        { metaEnvelope: envelopeOf(2), metaEpoch: 2, mode: 'shared' },
      ],
      ['no metaEnvelope', { metaEpoch: 2 }],
      [
        'a bad version byte',
        { metaEnvelope: envelopeOf(2, { version: 3 }), metaEpoch: 2 },
      ],
      ['a mismatched epoch', { metaEnvelope: envelopeOf(5), metaEpoch: 2 }],
      [
        'over 4096 bytes',
        { metaEnvelope: envelopeOf(2, { length: 4097 }), metaEpoch: 2 },
      ],
      [
        'an unknown member',
        { metaEnvelope: envelopeOf(2), metaEpoch: 2, x: 1 },
      ],
    ];
    for (const [what, payload] of cases) {
      const response = await call(app, {
        method: 'PATCH',
        url: `/calendars/${id}`,
        subject: 'owner',
        headers: { 'if-match': '"1"' },
        payload,
      });
      assert.equal(response.statusCode, 422, `${what}: ${response.body}`);
      assertProblem(response.json(), 'invalid-input');
      assert.ok(!response.body.includes('Chemo'), what);
    }
    assert.equal(calendars.rows()[0].version, 1);
    assert.equal(calendars.rows()[0].metaEpoch, 1);
  } finally {
    await app.close();
  }
});

test('only the owner may rename or delete; everyone else gets a 403 or a 404', async () => {
  const { app, calendars, events } = build();
  try {
    const id = await seeded(calendars);
    calendars.addMember(id, OTHER.id, 'viewer');
    const meta = { metaEnvelope: envelopeOf(2), metaEpoch: 2 };

    // A member who is not the owner may see the calendar, so the answer is a
    // 403 rather than the 404 a stranger gets.
    for (const [
      what,
      method,
      payload,
    ] of /** @type {[string, string, unknown][]} */ ([
      ['rename', 'PATCH', meta],
      ['delete', 'DELETE', undefined],
    ])) {
      const response = await call(app, {
        method,
        url: `/calendars/${id}`,
        subject: 'other',
        headers: { 'if-match': '"1"' },
        payload,
      });
      assert.equal(response.statusCode, 403, `${what}: ${response.body}`);
      assertProblem(response.json(), 'forbidden');
    }

    // The owner's calendar is untouched, and the reader deleted nothing.
    assert.equal(calendars.rows().length, 1);
    assert.equal(calendars.rows()[0].version, 1);
    assert.deepEqual(opsOf(events), ['createPrivate']);

    // An id no calendar has is a 404 — for the owner too.
    const unknown = randomUUID();
    for (const [method, payload] of /** @type {[string, unknown][]} */ ([
      ['PATCH', meta],
      ['DELETE', undefined],
    ])) {
      const response = await call(app, {
        method,
        url: `/calendars/${unknown}`,
        subject: 'owner',
        headers: { 'if-match': '"1"' },
        payload,
      });
      assert.equal(response.statusCode, 404, response.body);
      assertProblem(response.json(), 'not-found');
    }
    // A caller with no membership row at all: a 404, the same answer the
    // unknown id got, and never a hint that the calendar exists (E03-R01).
    for (const [method, payload] of /** @type {[string, unknown][]} */ ([
      ['PATCH', meta],
      ['DELETE', undefined],
    ])) {
      const stranger = await call(app, {
        method,
        url: `/calendars/${id}`,
        subject: 'stranger',
        headers: { 'if-match': '"1"' },
        payload,
      });
      assert.equal(stranger.statusCode, 404, stranger.body);
      assertProblem(stranger.json(), 'not-found');
    }
    assert.deepEqual(calendars.rows().length, 1);
  } finally {
    await app.close();
  }
});

test('delete removes the collection first and the rows second', async () => {
  const { app, calendars, caldav, events } = build();
  try {
    const id = await seeded(calendars);
    calendars.addMember(id, OTHER.id, 'editor');
    const response = await call(app, {
      method: 'DELETE',
      url: `/calendars/${id}`,
      subject: 'owner',
    });
    assert.equal(response.statusCode, 204, response.body);
    assert.equal(response.body, '');
    assert.deepEqual(opsOf(events), [
      'createPrivate',
      'forUser',
      'deleteCalendar',
      'remove',
    ]);
    assert.equal(caldav.calls[0].userId, OWNER.id);
    assert.equal(caldav.calls[0].requestId, response.headers['x-request-id']);
    assert.deepEqual(calendars.rows(), []);
    // The membership row cascades from the calendar row.
    assert.deepEqual(calendars.memberships(), []);
  } finally {
    await app.close();
  }
});

test('a collection that is already gone is not an error, and a CalDAV refusal keeps the rows', async () => {
  // Already gone: the 404 from the listener is the state this request wanted.
  const gone = build({
    fail: { deleteCalendar: new CalDavError('not-found', 404) },
  });
  try {
    const id = await seeded(gone.calendars);
    const response = await call(gone.app, {
      method: 'DELETE',
      url: `/calendars/${id}`,
      subject: 'owner',
    });
    assert.equal(response.statusCode, 204, response.body);
    assert.deepEqual(gone.calendars.rows(), []);
  } finally {
    await gone.app.close();
  }

  // A refusal is not a delete: the rows stay, so the client can retry.
  const refused = build({
    fail: { deleteCalendar: new CalDavError('network') },
  });
  try {
    const id = await seeded(refused.calendars);
    const response = await call(refused.app, {
      method: 'DELETE',
      url: `/calendars/${id}`,
      subject: 'owner',
    });
    assert.equal(response.statusCode, 502, response.body);
    assertProblem(response.json(), 'bad-gateway');
    assert.equal(refused.calendars.rows().length, 1);
  } finally {
    await refused.app.close();
  }
});

test('a store failure after the collection is gone answers 500, and the retry finishes the delete', async () => {
  const { app, calendars, events } = build({
    fail: { remove: new Error(CANARY) },
  });
  try {
    const id = await seeded(calendars);
    const failed = await call(app, {
      method: 'DELETE',
      url: `/calendars/${id}`,
      subject: 'owner',
    });
    assert.equal(failed.statusCode, 500, failed.body);
    assertProblem(failed.json(), 'internal-error');
    assert.equal(calendars.rows().length, 1);

    calendars.heal('remove');
    const retried = await call(app, {
      method: 'DELETE',
      url: `/calendars/${id}`,
      subject: 'owner',
    });
    assert.equal(retried.statusCode, 204, retried.body);
    assert.deepEqual(calendars.rows(), []);
    // The collection was deleted twice — the second delete is the retry, which
    // a real listener answers with 404 and the route treats as gone. The first
    // `remove` failed before it recorded anything, which is why it is absent.
    assert.deepEqual(
      opsOf(events).filter((op) => op !== 'forUser'),
      ['createPrivate', 'deleteCalendar', 'deleteCalendar', 'remove'],
    );
  } finally {
    await app.close();
  }
});

test('the list holds the caller memberships, and nothing else', async () => {
  const { app, calendars } = build();
  try {
    const mine = await seeded(calendars);
    const shared = await seeded(calendars, { ownerId: OTHER.id });
    calendars.addMember(shared, OWNER.id, 'viewer');

    const ownerList = await call(app, { url: '/calendars', subject: 'owner' });
    assert.equal(ownerList.statusCode, 200, ownerList.body);
    const calendarsSeen = ownerList.json().calendars;
    assert.deepEqual(
      calendarsSeen.map((/** @type {any} */ entry) => entry.id).sort(),
      [mine, shared].sort(),
    );
    const viewer = calendarsSeen.find(
      (/** @type {any} */ entry) => entry.id === shared,
    );
    assert.equal(viewer.role, 'viewer');
    assert.equal(viewer.mode, 'private');
    assert.equal(viewer.metaEpoch, 1);
    assert.match(viewer.metaEnvelope, /^[A-Za-z0-9+/]+={0,2}$/);

    // The other user sees the calendar they own, never the caller's, and a
    // calendar with no membership row is invisible to everyone.
    const otherList = await call(app, { url: '/calendars', subject: 'other' });
    assert.deepEqual(
      otherList
        .json()
        .calendars.map((/** @type {any} */ entry) => entry.id)
        .sort(),
      [shared].sort(),
    );
  } finally {
    await app.close();
  }
});

test('405 is answered with Allow for every registered path, and 404 without one', async () => {
  const { app } = build();
  try {
    /** @type {[string, string, string][]} */
    const cases = [
      ['PUT', '/calendars', 'GET, HEAD, POST'],
      ['POST', '/me', 'GET, HEAD'],
      ['POST', '/healthz', 'GET, HEAD'],
      ['GET', '/calendars/abc', 'DELETE, PATCH'],
      ['POST', '/calendars/abc', 'DELETE, PATCH'],
    ];
    for (const [method, url, allow] of cases) {
      const response = await call(app, { method, url, subject: 'owner' });
      assert.equal(
        response.statusCode,
        405,
        `${method} ${url}: ${response.body}`,
      );
      assert.equal(response.headers.allow, allow, `${method} ${url}`);
      assertProblem(response.json(), 'method-not-allowed');
    }
    // An unknown path is a 404, and carries no `Allow` at all.
    const missing = await call(app, {
      method: 'PUT',
      url: '/nope',
      subject: 'owner',
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.headers.allow, undefined);
    assertProblem(missing.json(), 'not-found');

    // The readiness probe is still exempt for GET and HEAD, so a POST without a
    // token is a 401 — the 405 above needed the token first.
    assert.equal((await call(app, { url: '/healthz' })).statusCode, 200);
    assert.equal(
      (await call(app, { method: 'POST', url: '/healthz' })).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});

test('a hostile store exception is a 500 problem, and the canary stays out of body and log', async () => {
  const { app, capture, calendars } = build();
  try {
    const id = await seeded(calendars);
    calendars.fail('listForMember', new Error(CANARY));
    const response = await call(app, { url: '/calendars', subject: 'owner' });
    assert.equal(response.statusCode, 500, response.body);
    assertProblem(response.json(), 'internal-error');
    assert.ok(!response.body.includes(CANARY));

    // The same for a route that reads one calendar first.
    calendars.heal('listForMember');
    calendars.fail('findMembership', new Error(CANARY));
    const patch = await call(app, {
      method: 'PATCH',
      url: `/calendars/${id}`,
      subject: 'owner',
      headers: { 'if-match': '"1"' },
      payload: { metaEnvelope: envelopeOf(2), metaEpoch: 2 },
    });
    assert.equal(patch.statusCode, 500, patch.body);
    assertProblem(patch.json(), 'internal-error');
    assert.ok(!patch.body.includes(CANARY));

    assert.ok(!capture.text().includes(CANARY), capture.text());
    assert.ok(capture.text().includes('"type":"Error"'));
  } finally {
    await app.close();
  }
});
