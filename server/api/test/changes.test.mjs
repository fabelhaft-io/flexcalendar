// --- E05-R08: the delta endpoint, without a database -------------------------
//
// Every rule of E05-R08 through the real `buildApp`: the real hooks, the real
// validation, the real problem documents, against the in-memory calendar store
// of E05-R03 (with the outbox rows E03-R10 writes) and the in-memory CalDAV
// collection of `test/support/caldav-store.mjs`, whose `sync-collection` is
// modelled on SabreDAV's own — including the part that matters most here:
// **it accepts a token whose number is ahead of the collection**, because
// SabreDAV does (`CalDAV\Backend\PDO::getChangesForCalendar` only queries
// `calendarchanges.synctoken >= n` and echoes the number back). So the check
// that a token is real is this API's, and a test that made the double refuse
// one would prove nothing about the code under test.
//
// What is under test, in the order the requirement states it:
//
//   * with no `since`, the whole collection, each present object with its
//     `ETag` and no tombstone — the initial load;
//   * a create, an update and a delete between two tokens, each in the shape
//     the client acts on (a tombstone carries no `etag` at all);
//   * the token round trip: the token an answer returns is accepted as `since`
//     and, when nothing changed, answers no changes and the same token;
//   * a `since` that is malformed, empty, another calendar's, or ahead of the
//     collection is the one 410 — and none of them reaches CalDAV;
//   * SabreDAV's own refusal of a token is the same 410, while every other
//     CalDAV failure keeps its meaning (403, 502, 504);
//   * every member reads; a stranger, an id outside the shape and an unknown
//     calendar are the same 404, before CalDAV is asked;
//   * no event content, object text or token reaches a body or a log line;
//   * a tombstone whose object name is not its `UID` is named from the outbox,
//     and left out when the outbox cannot say (Phase 4).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { test } from 'node:test';

import { buildApp } from '../src/app.mjs';
import { CalDavError } from '../src/caldav/adapter.mjs';
import { readConfig } from '../src/config.mjs';
import { createMemoryCalDavStore } from './support/caldav-store.mjs';
import { createMemoryCalendarStore } from './support/calendar-store.mjs';
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
const CANARY = 'CALFLEX_CHANGES_CONTENT_CANARY';
const HASH = 'a'.repeat(64);
const STAMP = '20261014T090000Z';

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
  // A second calendar of the same owner, for "another calendar's token".
  const otherId = randomUUID();
  await calendars.createPrivate({
    id: otherId,
    ownerId: OWNER.id,
    href: `/calendars/${OWNER.id}/${otherId}/`,
    metaEnvelope: Buffer.alloc(45, 1),
    metaEpoch: 1,
  });
  return { app, capture, calendars, caldav, events, calendarId, otherId };
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

/** A create body with every optional member absent. */
const createBody = (/** @type {Record<string, unknown>} */ over = {}) => ({
  start: { utc: STAMP },
  end: { utc: '20261014T100000Z' },
  envelopeSha256: HASH,
  ...over,
});

/** One `GET …/changes`, with `since` as the query carries it. */
async function changes(
  /** @type {import('fastify').FastifyInstance} */ app,
  /** @type {string} */ calendarId,
  /** @type {string} */ subject,
  /** @type {string | undefined} */ since,
) {
  return call(app, {
    url: `/calendars/${calendarId}/changes${since === undefined ? '' : `?since=${encodeURIComponent(since)}`}`,
    subject,
  });
}

/** Creates one event through the API and returns its body. */
async function created(
  /** @type {import('fastify').FastifyInstance} */ app,
  /** @type {string} */ calendarId,
  /** @type {string} */ subject = 'owner',
) {
  const response = await call(app, {
    method: 'POST',
    url: `/calendars/${calendarId}/events`,
    subject,
    payload: createBody(),
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

/** Decodes a token, for asserting what it names. */
const decoded = (/** @type {string} */ value) =>
  Buffer.from(value, 'base64url').toString('utf8');

/** The token for a point in a calendar, built the way the API builds one. */
const mint = (/** @type {string} */ calendarId, /** @type {string} */ number) =>
  Buffer.from(`${calendarId}:${number}`).toString('base64url');

test('the initial load reports every object, and its token round trips', async () => {
  const { app, calendarId, otherId } = await setup();
  try {
    const first = await created(app, calendarId);
    const second = await created(app, calendarId, 'editor');

    const initial = await changes(app, calendarId, 'viewer', undefined);
    assert.equal(initial.statusCode, 200, initial.body);
    const body = initial.json();
    // Every object is there, and nothing is a tombstone: `ETag` included, which
    // is what the client compares against on its next read.
    assert.deepEqual(body.changes, [
      { uid: first.uid, deleted: false, etag: first.etag },
      { uid: second.uid, deleted: false, etag: second.etag },
    ]);
    assert.match(body.token, /^[A-Za-z0-9_-]+$/);
    assert.equal(decoded(body.token).startsWith(`${calendarId}:`), true);
    // No content of any kind: an entry is pointers only.
    for (const entry of body.changes) {
      assert.deepEqual(Object.keys(entry).sort(), ['deleted', 'etag', 'uid']);
    }

    // The token this answer returned is accepted, and says nothing changed.
    const again = await changes(app, calendarId, 'owner', body.token);
    assert.equal(again.statusCode, 200, again.body);
    assert.deepEqual(again.json().changes, []);
    assert.equal(again.json().token, body.token);

    // A calendar with nothing in it still answers the initial load: no changes,
    // and a token, so a client that starts there has somewhere to come back to.
    const empty = await changes(app, otherId, 'owner', undefined);
    assert.equal(empty.statusCode, 200, empty.body);
    assert.deepEqual(empty.json().changes, []);
    assert.equal(decoded(empty.json().token), `${otherId}:1`);
  } finally {
    await app.close();
  }
});

test('a create, an update and a delete between two tokens', async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    await created(app, calendarId);
    const before = await changes(app, calendarId, 'owner', undefined);
    assert.equal(before.statusCode, 200, before.body);
    const since = before.json().token;

    const updated = await created(app, calendarId);
    const removed = await created(app, calendarId);
    const patch = await call(app, {
      method: 'PATCH',
      url: `/calendars/${calendarId}/events/${updated.uid}`,
      subject: 'owner',
      headers: { 'if-match': updated.etag },
      // A moved time is bound into the envelope's AAD, so the patch carries a
      // re-sealed envelope's hash (E13-R02).
      payload: {
        start: { utc: '20261014T083000Z' },
        envelopeSha256: 'b'.repeat(64),
      },
    });
    assert.equal(patch.statusCode, 200, patch.body);
    const after = patch.json();
    const drop = await call(app, {
      method: 'DELETE',
      url: `/calendars/${calendarId}/events/${removed.uid}`,
      subject: 'owner',
      headers: { 'if-match': removed.etag },
    });
    assert.equal(drop.statusCode, 204, drop.body);

    const delta = await changes(app, calendarId, 'owner', since);
    assert.equal(delta.statusCode, 200, delta.body);
    const body = delta.json();
    // One entry per object, not per write: a create and the update that
    // followed it are one changed object, with its current `ETag`.
    assert.equal(body.changes.length, 2);
    assert.deepEqual(
      body.changes.find(
        (/** @type {any} */ entry) => entry.uid === updated.uid,
      ),
      { uid: updated.uid, deleted: false, etag: after.etag },
    );
    // A tombstone has no `etag` member at all — not `null`, not the old one.
    const tombstone = body.changes.find(
      (/** @type {any} */ entry) => entry.uid === removed.uid,
    );
    assert.deepEqual(tombstone, { uid: removed.uid, deleted: true });
    assert.equal(Object.hasOwn(tombstone, 'etag'), false);
    // The token moved on, and the deleted object is really gone.
    assert.notEqual(body.token, since);
    assert.equal(caldav.stored(calendarId, `${removed.uid}.ics`), undefined);

    // A second sync from the new token is empty: the cursor is the collection.
    const settled = await changes(app, calendarId, 'owner', body.token);
    assert.deepEqual(settled.json().changes, []);
  } finally {
    await app.close();
  }
});

test('a malformed or empty since is 410, and CalDAV is never asked', async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    await created(app, calendarId);
    const reached = caldav.events.length;
    const rejected = [
      'not-a-token',
      '',
      '########',
      Buffer.from('not a token').toString('base64url'),
      Buffer.from('x:y').toString('base64url'),
      Buffer.from(`${calendarId}:`).toString('base64url'),
      Buffer.from(`${calendarId}:-1`).toString('base64url'),
      Buffer.from(`${calendarId}:1e3`).toString('base64url'),
      Buffer.from(`${randomUUID()}:1`).toString('base64url'),
      mint(calendarId, '0'.repeat(30)),
    ];
    for (const value of rejected) {
      const response = await changes(app, calendarId, 'owner', value);
      assert.equal(response.statusCode, 410, `${value}: ${response.body}`);
      assertProblem(response.json(), 'gone');
    }
    assert.equal(
      caldav.events.length,
      reached,
      'a refused token reached CalDAV',
    );
  } finally {
    await app.close();
  }
});

test("another calendar's token is 410, though SabreDAV would accept its number", async () => {
  const { app, calendarId, otherId } = await setup();
  try {
    await created(app, calendarId);
    const other = await changes(app, otherId, 'owner', undefined);
    assert.equal(other.statusCode, 200, other.body);
    const foreign = await changes(app, calendarId, 'owner', other.json().token);
    assert.equal(foreign.statusCode, 410, foreign.body);
    assertProblem(foreign.json(), 'gone');
    // The calendar's own token is still accepted, so what was refused is the
    // binding and not the number: SabreDAV would have answered both.
    const own = await changes(app, calendarId, 'owner', undefined);
    assert.equal(
      (await changes(app, calendarId, 'owner', own.json().token)).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});

test('a token ahead of the collection is 410, and a behind one is not', async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    await created(app, calendarId);
    const initial = await changes(app, calendarId, 'owner', undefined);
    const current = caldav.tokenOf(calendarId);

    // SabreDAV accepts a number it has never reached and echoes it, so this is
    // the API's own check, made against the collection's current token.
    const ahead = await changes(
      app,
      calendarId,
      'owner',
      mint(calendarId, String(current + 5)),
    );
    assert.equal(ahead.statusCode, 410, ahead.body);
    assertProblem(ahead.json(), 'gone');

    // The largest number a token can carry is ahead too, and is answered the
    // same way rather than reaching Postgres as an out-of-range `bigint`.
    const boundless = await changes(
      app,
      calendarId,
      'owner',
      mint(calendarId, '9'.repeat(18)),
    );
    assert.equal(boundless.statusCode, 410, boundless.body);
    assertProblem(boundless.json(), 'gone');

    // A collection that moved on without an object changing leaves a behind
    // token valid: the answer is no changes, at the collection's new number.
    caldav.touch(calendarId);
    const behind = await changes(
      app,
      calendarId,
      'owner',
      initial.json().token,
    );
    assert.equal(behind.statusCode, 200, behind.body);
    assert.deepEqual(behind.json().changes, []);
    assert.equal(
      decoded(behind.json().token),
      `${calendarId}:${caldav.tokenOf(calendarId)}`,
    );
  } finally {
    await app.close();
  }
});

test("the answer's token is the report's, even when the collection moves on", async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    await created(app, calendarId);
    const initial = await changes(app, calendarId, 'owner', undefined);
    assert.equal(initial.statusCode, 200, initial.body);
    const since = initial.json().token;
    const position = caldav.tokenOf(calendarId);
    assert.equal(decoded(since), `${calendarId}:${position}`);

    // A change lands between the `REPORT` — which saw nothing since `since` —
    // and the `PROPFIND` that follows it. Those are two requests, so if the
    // answer's token came from the later one the client would store a position
    // past this change and never see it.
    const raced = randomUUID();
    caldav.beforeCurrentSyncToken(() => {
      caldav.seed(
        calendarId,
        `${raced}.ics`,
        `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${raced}\r\nDTSTAMP:${STAMP}\r\nDTSTART:${STAMP}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
      );
    });

    const inSync = await changes(app, calendarId, 'owner', since);
    assert.equal(inSync.statusCode, 200, inSync.body);
    assert.deepEqual(inSync.json().changes, []);
    // The token is the report's own number, and the collection really has moved
    // past it: the write above happened while this answer was being assembled.
    assert.equal(decoded(inSync.json().token), `${calendarId}:${position}`);
    assert.equal(caldav.tokenOf(calendarId), position + 1);

    // So the next poll, from that token, reports the change that raced.
    const caughtUp = await changes(
      app,
      calendarId,
      'owner',
      inSync.json().token,
    );
    assert.equal(caughtUp.statusCode, 200, caughtUp.body);
    assert.deepEqual(caughtUp.json().changes, [
      {
        uid: raced,
        deleted: false,
        etag: caldav.stored(calendarId, `${raced}.ics`)?.etag,
      },
    ]);
    assert.equal(
      decoded(caughtUp.json().token),
      `${calendarId}:${position + 1}`,
    );
  } finally {
    await app.close();
  }
});

test("SabreDAV's own refusal of a token is 410; other CalDAV failures are not", async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    await created(app, calendarId);
    const initial = await changes(app, calendarId, 'owner', undefined);
    const since = initial.json().token;

    // `InvalidSyncToken` is a `403` whose body carries `DAV:valid-sync-token`
    // and no `cf:` precondition: the adapter reports exactly that shape.
    caldav.failOnce('syncChanges', new CalDavError('forbidden', 403));
    const refused = await changes(app, calendarId, 'owner', since);
    assert.equal(refused.statusCode, 410, refused.body);
    assertProblem(refused.json(), 'gone');

    // A `403` that carries a precondition of ours is our guard, and keeps 403.
    caldav.failOnce(
      'syncChanges',
      new CalDavError('forbidden', 403, [
        'cf:private-skeleton-only',
        'SUMMARY',
      ]),
    );
    const guarded = await changes(app, calendarId, 'owner', since);
    assert.equal(guarded.statusCode, 403, guarded.body);
    assertProblem(guarded.json(), 'private-skeleton-only');

    // A deadline is a 504, a broken upstream answer a 502.
    caldav.failOnce('syncChanges', new CalDavError('timeout'));
    assert.equal(
      (await changes(app, calendarId, 'owner', since)).statusCode,
      504,
    );
    caldav.failOnce('syncChanges', new CalDavError('server', 500));
    assert.equal(
      (await changes(app, calendarId, 'owner', since)).statusCode,
      502,
    );

    // A collection whose current token cannot be read is a 502 too, never a
    // token invented from nothing.
    caldav.touch(calendarId);
    caldav.failOnce('currentSyncToken', new CalDavError('protocol'));
    const unreadable = await changes(app, calendarId, 'owner', since);
    assert.equal(unreadable.statusCode, 502, unreadable.body);
  } finally {
    await app.close();
  }
});

test('every member reads; a stranger and an id outside the shape are 404', async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    await created(app, calendarId);
    for (const subject of ['owner', 'editor', 'viewer']) {
      const response = await changes(app, calendarId, subject, undefined);
      assert.equal(response.statusCode, 200, `${subject}: ${response.body}`);
    }
    const stranger = await changes(app, calendarId, 'stranger', undefined);
    assert.equal(stranger.statusCode, 404, stranger.body);
    assertProblem(stranger.json(), 'not-found');
    const unknown = await changes(app, randomUUID(), 'owner', undefined);
    assert.equal(unknown.statusCode, 404, unknown.body);
    assertProblem(unknown.json(), 'not-found');

    const reached = caldav.events.length;
    const shaped = await changes(app, 'not-a-uuid', 'owner', undefined);
    assert.equal(shaped.statusCode, 404, shaped.body);
    assert.equal(caldav.events.length, reached);
  } finally {
    await app.close();
  }
});

test('neither the token, the object text nor its content reaches a log line', async () => {
  const { app, capture, caldav, calendarId } = await setup();
  try {
    // A stored object carrying content, the way a stock app's object would. It
    // is read for its `UID` and never echoed.
    const seededUid = randomUUID();
    caldav.seed(
      calendarId,
      'not-a-uuid-name.ics',
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        `UID:${seededUid}`,
        `SUMMARY:${CANARY}`,
        'DTSTAMP:20261014T090000Z',
        'DTSTART:20261014T090000Z',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
    );
    const initial = await changes(app, calendarId, 'owner', undefined);
    assert.equal(initial.statusCode, 200, initial.body);
    const body = initial.json();
    assert.equal(
      body.changes.find((/** @type {any} */ entry) => entry.uid === seededUid)
        .deleted,
      false,
    );
    const since = body.token;
    // The number the token names, which a log line must not carry either: the
    // token as a client sends it and its decoded `<calendar id>:<n>` are the
    // same secret in two shapes, and the SabreDAV token behind it is a third.
    const number = decoded(since).slice(calendarId.length + 1);

    // A poll with the good token — the path that reads the collection again and
    // is therefore the one a careless log line would sit in — a token this API
    // never minted, and a token SabreDAV refuses, so every path of the route has
    // logged by the time the assertions below run.
    const polled = await changes(app, calendarId, 'owner', since);
    assert.equal(polled.statusCode, 200, polled.body);
    const refused = await changes(app, calendarId, 'owner', 'not-a-token');
    assert.equal(refused.statusCode, 410, refused.body);
    caldav.failOnce('syncChanges', new CalDavError('forbidden', 403));
    const gone = await changes(app, calendarId, 'owner', since);
    assert.equal(gone.statusCode, 410, gone.body);

    const log = capture.text();
    assert.ok(!log.includes(CANARY), `the content reached the log: ${log}`);
    assert.ok(!log.includes(since), 'the token reached the log');
    assert.ok(
      !log.includes(decoded(since)),
      'the decoded token reached the log',
    );
    assert.ok(
      !log.includes(`http://sabre.io/ns/sync/${number}`),
      'the SabreDAV token reached the log',
    );
    assert.ok(
      !log.includes('not-a-token'),
      'the refused token reached the log',
    );
    assert.ok(!log.includes(seededUid), 'the uid reached the log');
    assert.ok(!log.includes('BEGIN:VEVENT'), 'the object text reached the log');
    assert.ok(
      !JSON.stringify(body).includes(CANARY),
      'the content reached the answer',
    );
  } finally {
    await app.close();
  }
});

test('the path answers 405 with Allow for a method it does not register', async () => {
  const { app, calendarId } = await setup();
  try {
    const response = await call(app, {
      method: 'POST',
      url: `/calendars/${calendarId}/changes`,
      subject: 'owner',
    });
    assert.equal(response.statusCode, 405, response.body);
    assertProblem(response.json(), 'method-not-allowed');
    // Fastify synthesises HEAD for a GET.
    assert.equal(response.headers.allow, 'GET, HEAD');
  } finally {
    await app.close();
  }
});

test('a tombstone whose name is not its UID is named from the outbox', async () => {
  const { app, calendars, caldav, calendarId } = await setup();
  try {
    const uid = 'stock-app-uid-0001';
    caldav.seed(
      calendarId,
      'random-object-name.ics',
      `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:20261014T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
    );
    const before = await changes(app, calendarId, 'owner', undefined);
    const since = before.json().token;

    await caldav
      .forUser(OWNER.id)
      .deleteObject(calendarId, 'random-object-name.ics');
    const written = caldav.tokenOf(calendarId);
    // The outbox row the CalDAV service writes with that delete (E03-R10).
    calendars.deletedChange(calendarId, written, uid);

    const delta = await changes(app, calendarId, 'owner', since);
    assert.equal(delta.statusCode, 200, delta.body);
    assert.deepEqual(delta.json().changes, [{ uid, deleted: true }]);

    // Two deletions in the window and no name to tell them apart: the entry is
    // left out rather than guessed at.
    const secondUid = 'stock-app-uid-0002';
    caldav.seed(
      calendarId,
      'another-object.ics',
      `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:${secondUid}\r\nDTSTART:20261014T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
    );
    const marker = caldav.tokenOf(calendarId);
    // A collection change SabreDAV records but a sync never reports as an
    // object, so the second candidate sits inside the window.
    caldav.touch(calendarId);
    const stray = caldav.tokenOf(calendarId);
    await caldav
      .forUser(OWNER.id)
      .deleteObject(calendarId, 'another-object.ics');
    const removed = caldav.tokenOf(calendarId);
    calendars.deletedChange(calendarId, stray, 'stock-app-uid-0003');
    calendars.deletedChange(calendarId, removed, secondUid);

    const ambiguous = await changes(
      app,
      calendarId,
      'owner',
      mint(calendarId, String(marker)),
    );
    assert.equal(ambiguous.statusCode, 200, ambiguous.body);
    assert.deepEqual(ambiguous.json().changes, []);
  } finally {
    await app.close();
  }
});
