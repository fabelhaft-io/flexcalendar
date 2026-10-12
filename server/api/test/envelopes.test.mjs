// --- E13-R02: the sidecar API, without a database -----------------------------
//
// Both routes through the real `buildApp`: the real hooks, the real validation,
// the real problem documents, against the in-memory calendar store, the
// in-memory CalDAV collection and the in-memory `event_envelopes` of
// `test/support/envelope-store.mjs`. All three are mutable state the API
// changes, so "the row went" or "the old envelope is still answered" is an
// assertion about what the routes did.
//
// What is under test, in the order the requirement states it:
//
//   * a bulk read by calendar, by `uid` and by delta, and the token it answers;
//   * D-06's read gate: an envelope no skeleton names is never answered, and a
//     row a crashed write left behind is invisible while the old one stays;
//   * D-06's write order — the row first, the skeleton second, the superseded
//     row last — and what a failure between the two steps leaves behind;
//   * the header, size and hash checks, and the fixed 422/428/403/404 refusals;
//   * the 24-hour orphan sweep, with a clock the test injects;
//   * no envelope byte reaching a body or a log line.
//
// The CalDAV double runs the Private write guard of E03-R09/E03-R11 on every
// PUT, so a skeleton this API re-writes for the new hash is also the claim that
// it stays a skeleton the guard accepts.

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { test } from 'node:test';

import { buildApp } from '../src/app.mjs';
import { CalDavError } from '../src/caldav/adapter.mjs';
import { readConfig } from '../src/config.mjs';
import { createOrphanCollector } from '../src/envelope-gc.mjs';
import { createMemoryCalendarStore } from './support/calendar-store.mjs';
import { createMemoryCalDavStore } from './support/caldav-store.mjs';
import { createMemoryEnvelopeStore } from './support/envelope-store.mjs';
import { assertProblem } from './support/problem.mjs';

const ISSUER = 'https://auth.example.test';
const AUDIENCE = 'project-id';
const OWNER = {
  id: '11111111-1111-4111-8111-111111111111',
  handle: 'alice',
  email: 'alice@example.test',
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
const USERS = { owner: OWNER, viewer: VIEWER, stranger: STRANGER };

const STAMP = '20261014T090000Z';

/** A value that must never reach a body or a log line. */
const CANARY = 'CALFLEX_API_ENVELOPE_CANARY';

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
 * An envelope with the fixed header: version, epoch, and opaque bytes.
 * @param {number} epoch
 * @param {{length?: number, marker?: string}} [options]
 */
function envelopeOf(epoch, { length = 48, marker } = {}) {
  const size = Math.max(length, 45);
  const bytes = Buffer.alloc(size, 7);
  bytes[0] = 0x01;
  bytes.writeUInt32BE(epoch, 1);
  if (marker !== undefined) {
    bytes.write(marker, 29, 'utf8');
  }
  return bytes;
}

/** @param {Buffer} bytes */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * The write body for one envelope.
 * @param {Buffer} bytes @param {Record<string, unknown>} [over]
 */
const writeBody = (bytes, over = {}) => ({
  envelope: bytes.toString('base64'),
  epoch: bytes.readUInt32BE(1),
  envelopeSha256: sha256(bytes),
  ...over,
});

/**
 * The app, all three in-memory stores, a captured log and one Private calendar
 * with an owner and a viewer.
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
 * Creates a Private event with a client-chosen `uid` in **one request**, the
 * shape E13-R02 asks for: the create body carries the sealed envelope, and the
 * API commits skeleton and envelope in D-06's order (row first, then the
 * skeleton `PUT`). The envelope bytes are what the returned `hash` names.
 *
 * @param {ReturnType<typeof setup> extends Promise<infer T> ? T : never} context
 * @param {{uid?: string, bytes?: Buffer, epoch?: number, start?: string, end?: string}} [options]
 */
async function committed(context, options = {}) {
  const { app, calendarId } = context;
  const uid = options.uid ?? randomUUID();
  const bytes = options.bytes ?? envelopeOf(options.epoch ?? 1);
  const start = options.start ?? STAMP;
  const end = options.end ?? '20261014T100000Z';
  const created = await call(app, {
    method: 'POST',
    url: `/calendars/${calendarId}/events`,
    subject: 'owner',
    payload: {
      uid,
      start: { utc: start },
      end: { utc: end },
      alarm: { trigger: '-PT15M' },
      ...writeBody(bytes),
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const body = created.json();
  return { uid, bytes, hash: sha256(bytes), created: body };
}

/** @param {Record<string, unknown>[]} events */
const opsOf = (events) => events.map((entry) => String(entry.op));

test('a bulk read answers the envelopes the skeleton names, and the token for them', async () => {
  const context = await setup();
  const { app, calendarId } = context;
  try {
    const first = await committed(context);
    const second = await committed(context);

    const response = await call(app, {
      url: `/calendars/${calendarId}/envelopes`,
      subject: 'owner',
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.match(body.token, /^[A-Za-z0-9_-]+$/);
    assert.equal(body.envelopes.length, 2);
    const byUid = new Map(
      body.envelopes.map((/** @type {any} */ entry) => [entry.uid, entry]),
    );
    assert.deepEqual(byUid.get(first.uid), {
      uid: first.uid,
      deleted: false,
      recurrenceId: null,
      epoch: 1,
      envelopeSha256: first.hash,
      envelope: first.bytes.toString('base64'),
    });
    assert.equal(byUid.get(second.uid).envelopeSha256, second.hash);
  } finally {
    await app.close();
  }
});

test('a read by uid names only the objects asked for, and answers nothing for an unknown one', async () => {
  const context = await setup();
  const { app, calendarId } = context;
  try {
    const first = await committed(context);
    const second = await committed(context);

    const response = await call(app, {
      url: `/calendars/${calendarId}/envelopes?uid=${first.uid}&uid=${randomUUID()}`,
      subject: 'owner',
    });
    assert.equal(response.statusCode, 200, response.body);
    const uids = response
      .json()
      .envelopes.map((/** @type {any} */ entry) => entry.uid);
    assert.deepEqual(uids, [first.uid]);
    assert.ok(!uids.includes(second.uid));
  } finally {
    await app.close();
  }
});

test('a delta read answers what changed since the token, and a tombstone for a deletion', async () => {
  const context = await setup();
  const { app, caldav, calendarId } = context;
  try {
    const first = await committed(context);
    const second = await committed(context);

    // The cursor stands before the next change.
    const before = await call(app, {
      url: `/calendars/${calendarId}/changes`,
      subject: 'owner',
    });
    assert.equal(before.statusCode, 200, before.body);
    const token = before.json().token;

    // A new envelope for the second object, plus a deletion of the first.
    const replacement = envelopeOf(2);
    const secondStored = caldav.stored(calendarId, `${second.uid}.ics`);
    assert.ok(secondStored);
    const reSealed = await call(app, {
      method: 'PUT',
      url: `/calendars/${calendarId}/envelopes/${second.uid}`,
      subject: 'owner',
      headers: { 'if-match': secondStored.etag },
      payload: writeBody(replacement),
    });
    assert.equal(reSealed.statusCode, 200, reSealed.body);
    const reSealedHash = sha256(replacement);
    const etag = caldav.stored(calendarId, `${first.uid}.ics`)?.etag;
    const removed = await call(app, {
      method: 'DELETE',
      url: `/calendars/${calendarId}/events/${first.uid}`,
      subject: 'owner',
      headers: { 'if-match': String(etag) },
    });
    assert.equal(removed.statusCode, 204, removed.body);

    const response = await call(app, {
      url: `/calendars/${calendarId}/envelopes?since=${encodeURIComponent(token)}`,
      subject: 'owner',
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.notEqual(body.token, token, 'the cursor must move on');
    const entries = new Map(
      body.envelopes.map((/** @type {any} */ entry) => [entry.uid, entry]),
    );
    assert.equal(entries.get(first.uid).deleted, true);
    assert.equal(entries.get(second.uid).deleted, false);
    assert.equal(entries.get(second.uid).envelopeSha256, reSealedHash);
    assert.equal(
      entries.get(second.uid).envelope,
      replacement.toString('base64'),
    );
  } finally {
    await app.close();
  }
});

test('a row no skeleton names is never answered, and the old version stays readable', async () => {
  const context = await setup();
  const { app, caldav, calendarId } = context;
  try {
    const first = await committed(context);
    const stored = caldav.stored(calendarId, `${first.uid}.ics`);
    assert.ok(stored);

    // A re-seal whose skeleton PUT never happened: the row is inserted, the
    // skeleton still carries the old hash.
    const replacement = envelopeOf(2);
    caldav.fail('putObject', new CalDavError('network'));
    const crashed = await call(app, {
      method: 'PUT',
      url: `/calendars/${calendarId}/envelopes/${first.uid}`,
      subject: 'owner',
      headers: { 'if-match': stored.etag },
      payload: writeBody(replacement),
    });
    assert.equal(crashed.statusCode, 502, crashed.body);
    assertProblem(crashed.json(), 'bad-gateway');

    // The old skeleton still names the old envelope, and only that one is
    // answered — the newer row is an orphan no skeleton carries (D-06).
    const response = await call(app, {
      url: `/calendars/${calendarId}/envelopes?uid=${first.uid}`,
      subject: 'owner',
    });
    assert.equal(response.statusCode, 200, response.body);
    const entries = response.json().envelopes;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].envelopeSha256, first.hash);
    assert.equal(entries[0].envelope, first.bytes.toString('base64'));

    // Both rows are in the table; only the skeleton is the gate.
    assert.equal(context.envelopes.rows().length, 2);

    // The retry commits: the skeleton moves, the row is answered, and the
    // superseded row is garbage-collected.
    caldav.heal('putObject');
    const retried = await call(app, {
      method: 'PUT',
      url: `/calendars/${calendarId}/envelopes/${first.uid}`,
      subject: 'owner',
      headers: { 'if-match': stored.etag },
      payload: writeBody(replacement),
    });
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(retried.json().envelopeSha256, sha256(replacement));
    const after = await call(app, {
      url: `/calendars/${calendarId}/envelopes?uid=${first.uid}`,
      subject: 'owner',
    });
    assert.equal(after.json().envelopes.length, 1);
    assert.equal(after.json().envelopes[0].envelopeSha256, sha256(replacement));
    assert.equal(context.envelopes.rows().length, 1);
  } finally {
    await app.close();
  }
});

test('a crash between the create row insert and the skeleton PUT leaves only an orphan', async () => {
  const context = await setup();
  const { app, caldav, envelopes, calendarId } = context;
  try {
    const uid = randomUUID();
    const bytes = envelopeOf(1);
    // The fault is injected after the row insert: the row lands, the skeleton
    // `PUT` fails, so no object exists. The crash therefore leaves an orphan row
    // — never a skeleton whose envelope never existed.
    caldav.fail('putObject', new CalDavError('network'));
    const crashed = await call(app, {
      method: 'POST',
      url: `/calendars/${calendarId}/events`,
      subject: 'owner',
      payload: {
        uid,
        start: { utc: STAMP },
        end: { utc: '20261014T100000Z' },
        ...writeBody(bytes),
      },
    });
    assert.equal(crashed.statusCode, 502, crashed.body);
    assertProblem(crashed.json(), 'bad-gateway');
    assert.equal(caldav.stored(calendarId, `${uid}.ics`), undefined);
    assert.equal(envelopes.rows().length, 1);
    assert.equal(envelopes.rows()[0].uid, uid);

    // A read answers nothing: no skeleton names the row.
    const read = await call(app, {
      url: `/calendars/${calendarId}/envelopes?uid=${uid}`,
      subject: 'owner',
    });
    assert.equal(read.statusCode, 200, read.body);
    assert.deepEqual(read.json().envelopes, []);

    // The 24-hour sweep — here with a clock that has crossed the grace — removes
    // the orphan, because no skeleton names it and the object is gone.
    const collector = createOrphanCollector({
      store: envelopes,
      now: () => new Date(Date.now() + 25 * 60 * 60 * 1000),
    });
    assert.equal(
      await collector.sweep({ calendarId, view: caldav.forUser(OWNER.id) }),
      1,
    );
    assert.deepEqual(envelopes.rows(), []);
  } finally {
    await app.close();
  }
});

test('a write inserts the row before the skeleton PUT and garbage-collects the superseded row', async () => {
  const context = await setup();
  const { app, events, calendarId } = context;
  try {
    const first = await committed(context);
    const before = opsOf(events);
    const insertIndex = before.indexOf('envelopeInsert');
    const putIndex = before.findIndex(
      (op, index) => op === 'putObject' && index > insertIndex,
    );
    assert.ok(insertIndex !== -1, 'the row was never inserted');
    assert.ok(putIndex !== -1, 'the skeleton was never written');
    assert.ok(
      insertIndex < putIndex,
      'the row must be inserted before the skeleton is PUT (D-06)',
    );
    assert.ok(
      before.indexOf('envelopeDeleteSuperseded') > putIndex,
      'the superseded row is collected after the commit',
    );

    // The skeleton the guard accepted carries the hash of the stored bytes.
    const response = await call(app, {
      url: `/calendars/${calendarId}/envelopes?uid=${first.uid}`,
      subject: 'owner',
    });
    const envelope = response.json().envelopes[0];
    assert.equal(envelope.envelopeSha256, first.hash);
    assert.equal(sha256(Buffer.from(envelope.envelope, 'base64')), first.hash);
  } finally {
    await app.close();
  }
});

test('a write refuses a bad envelope, a bad hash, a bad epoch and no If-Match', async () => {
  const context = await setup();
  const { app, calendarId } = context;
  try {
    const first = await committed(context);
    const url = `/calendars/${calendarId}/envelopes/${first.uid}`;
    const etag = first.created.etag;
    const good = envelopeOf(1, { length: 48 });

    /** @type {[string, unknown][]} */
    const cases = [
      ['a body that is not an object', []],
      ['a member the write does not take', { ...writeBody(good), start: 'x' }],
      ['no envelope', { epoch: 1, envelopeSha256: sha256(good) }],
      [
        'an envelope that is not standard base64',
        { ...writeBody(good), envelope: 'not base64 !' },
      ],
      [
        'an envelope shorter than the fixed fields',
        writeBody(Buffer.alloc(44, 1)),
      ],
      [
        'an envelope with the wrong version byte',
        writeBody(
          Buffer.concat([Buffer.from([0x02]), envelopeOf(1).subarray(1)]),
        ),
      ],
      [
        'an epoch that is not the header epoch',
        { ...writeBody(good), epoch: 2 },
      ],
      [
        'an epoch above the column range',
        { ...writeBody(good), epoch: 2147483648 },
      ],
      [
        'a hash that is not hex',
        { ...writeBody(good), envelopeSha256: 'z'.repeat(64) },
      ],
      [
        'a hash that is not the hash of the bytes',
        { ...writeBody(good), envelopeSha256: 'a'.repeat(64) },
      ],
      [
        'a recurrence id that is not canonical',
        { ...writeBody(good), recurrenceId: 'x' },
      ],
      [
        'an envelope over the 64 KiB ceiling',
        writeBody(envelopeOf(1, { length: 65_537 })),
      ],
    ];
    for (const [what, payload] of cases) {
      const response = await call(app, {
        method: 'PUT',
        url,
        subject: 'owner',
        headers: { 'if-match': String(etag) },
        payload,
      });
      assert.equal(response.statusCode, 422, `${what}: ${response.body}`);
      assertProblem(response.json(), 'invalid-input');
    }

    // Without a version to commit against there is nothing to be optimistic
    // about (RFC 9110 § 13.1.1).
    const unconditional = await call(app, {
      method: 'PUT',
      url,
      subject: 'owner',
      payload: writeBody(good),
    });
    assert.equal(unconditional.statusCode, 428, unconditional.body);
    assertProblem(unconditional.json(), 'precondition-required');
  } finally {
    await app.close();
  }
});

test('only a member may read or write, and an id or uid outside the shape is the 404', async () => {
  const context = await setup();
  const { app, calendarId } = context;
  try {
    const first = await committed(context);
    const read = `/calendars/${calendarId}/envelopes`;
    const write = `/calendars/${calendarId}/envelopes/${first.uid}`;

    for (const subject of ['stranger']) {
      const opened = await call(app, { url: read, subject });
      assert.equal(opened.statusCode, 404, opened.body);
      assertProblem(opened.json(), 'not-found');
      const wrote = await call(app, {
        method: 'PUT',
        url: write,
        subject,
        headers: { 'if-match': '"1"' },
        payload: writeBody(envelopeOf(1)),
      });
      assert.equal(wrote.statusCode, 404, wrote.body);
    }

    // A member who may read may not write.
    const viewer = await call(app, {
      method: 'PUT',
      url: write,
      subject: 'viewer',
      headers: { 'if-match': '"1"' },
      payload: writeBody(envelopeOf(1)),
    });
    assert.equal(viewer.statusCode, 403, viewer.body);
    const viewerRead = await call(app, { url: read, subject: 'viewer' });
    assert.equal(viewerRead.statusCode, 200, viewerRead.body);

    // An id or a uid this API never wrote cannot name anything.
    const badCalendar = await call(app, {
      url: '/calendars/not-a-uuid/envelopes',
      subject: 'owner',
    });
    assert.equal(badCalendar.statusCode, 404, badCalendar.body);
    const badUid = await call(app, {
      method: 'PUT',
      url: `/calendars/${calendarId}/envelopes/Not-A-Uuid`,
      subject: 'owner',
      headers: { 'if-match': '"1"' },
      payload: writeBody(envelopeOf(1)),
    });
    assert.equal(badUid.statusCode, 404, badUid.body);
    // An unknown but well-formed uid names no object.
    const absent = await call(app, {
      method: 'PUT',
      url: `/calendars/${calendarId}/envelopes/${randomUUID()}`,
      subject: 'owner',
      headers: { 'if-match': '"1"' },
      payload: writeBody(envelopeOf(1)),
    });
    assert.equal(absent.statusCode, 404, absent.body);
    assertProblem(absent.json(), 'not-found');
  } finally {
    await app.close();
  }
});

test('a uid together with a since is a 422, and a since that is not a token is a 410', async () => {
  const context = await setup();
  const { app, calendarId } = context;
  try {
    const first = await committed(context);
    const both = await call(app, {
      url: `/calendars/${calendarId}/envelopes?uid=${first.uid}&since=whatever`,
      subject: 'owner',
    });
    assert.equal(both.statusCode, 422, both.body);
    assertProblem(both.json(), 'invalid-input');

    const bad = await call(app, {
      url: `/calendars/${calendarId}/envelopes?since=not-a-token`,
      subject: 'owner',
    });
    assert.equal(bad.statusCode, 410, bad.body);
    assertProblem(bad.json(), 'gone');
  } finally {
    await app.close();
  }
});

test('the 24-hour sweep removes an orphan and leaves the envelope a skeleton names', async () => {
  const context = await setup();
  const { app, envelopes, calendarId } = context;
  try {
    const first = await committed(context);
    const now = Date.now();

    // The live row, made old: an envelope untouched for two days is still the
    // one the skeleton names.
    const live = envelopes.rows()[0];
    envelopes.seed({
      calendarId,
      uid: live.uid,
      recurrenceId: live.recurrenceId,
      envelopeSha256: live.envelopeSha256,
      epoch: live.epoch,
      envelope: Buffer.from(live.envelope, 'base64'),
      createdAt: new Date(now - 48 * 60 * 60 * 1000),
    });
    // An orphan a crashed write left behind, likewise old.
    const orphan = envelopeOf(3);
    envelopes.seed({
      calendarId,
      uid: first.uid,
      recurrenceId: null,
      envelopeSha256: sha256(orphan),
      epoch: 3,
      envelope: orphan,
      createdAt: new Date(now - 25 * 60 * 60 * 1000),
    });
    // And a fresh orphan, which the grace protects.
    const fresh = envelopeOf(4);
    envelopes.seed({
      calendarId,
      uid: first.uid,
      recurrenceId: null,
      envelopeSha256: sha256(fresh),
      epoch: 4,
      envelope: fresh,
      createdAt: new Date(now - 60 * 60 * 1000),
    });

    // Any successful write runs the sweep for the calendar.
    await committed(context);

    const hashes = envelopes.rows().map((row) => row.envelopeSha256);
    assert.ok(hashes.includes(first.hash), 'the live envelope was removed');
    assert.ok(
      !hashes.includes(sha256(orphan)),
      'the old orphan should have been collected',
    );
    assert.ok(
      hashes.includes(sha256(fresh)),
      'a fresh row is inside the grace and must stay',
    );
  } finally {
    await app.close();
  }
});

test('the collector is the one whose clock the caller injects', async () => {
  const calendarId = randomUUID();
  const uid = randomUUID();
  /** @type {Record<string, unknown>[]} */
  const events = [];
  const store = createMemoryEnvelopeStore({ events });
  const described = envelopeOf(1);
  const orphan = envelopeOf(2);
  const old = envelopeOf(3);
  store.seed({
    calendarId,
    uid,
    envelopeSha256: sha256(described),
    envelope: described,
    createdAt: new Date('2026-10-01T00:00:00Z'),
  });
  store.seed({
    calendarId,
    uid,
    envelopeSha256: sha256(orphan),
    envelope: orphan,
    createdAt: new Date('2026-10-01T00:00:00Z'),
  });

  // The skeleton names only `described`.
  const view = {
    /** @param {string} _calendarId @param {string} name */
    async getObject(_calendarId, name) {
      if (name !== `${uid}.ics`) throw new Error('unexpected name');
      return {
        data: [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'BEGIN:VEVENT',
          `UID:${uid}`,
          'DTSTART:20261014T100000Z',
          `X-CALFLEX-ENVELOPE-SHA256:${sha256(described)}`,
          'END:VEVENT',
          'END:VCALENDAR',
          '',
        ].join('\r\n'),
      };
    },
  };

  // One hour after the rows were created: nothing is old enough.
  const early = createOrphanCollector({
    store,
    now: () => new Date('2026-10-01T01:00:00Z'),
  });
  assert.equal(await early.sweep({ calendarId, view }), 0);

  // A day and an hour later the orphan goes and the named row stays.
  const later = createOrphanCollector({
    store,
    now: () => new Date('2026-10-02T01:00:00Z'),
  });
  assert.equal(await later.sweep({ calendarId, view }), 1);
  const remaining = store.rows().map((row) => row.envelopeSha256);
  assert.deepEqual(remaining, [sha256(described)]);

  // An object that is gone names nothing, so all of its stale rows go.
  store.seed({
    calendarId,
    uid,
    envelopeSha256: sha256(old),
    envelope: old,
    createdAt: new Date('2026-10-01T00:00:00Z'),
  });
  const gone = createOrphanCollector({ store });
  const missing = {
    async getObject() {
      throw new CalDavError('not-found', 404);
    },
  };
  // Both rows belong to the object that is gone, so both are orphans.
  assert.equal(
    await gone.sweep({ calendarId, view: missing }),
    2,
    'every row of a deleted object is an orphan',
  );
  assert.deepEqual(store.rows(), []);
});

test('envelope bytes reach neither a body nor a log line', async () => {
  const context = await setup();
  const { app, capture, calendarId } = context;
  try {
    // A well-formed envelope carrying the canary in its opaque bytes.
    const bytes = envelopeOf(1, { length: 45 + CANARY.length });
    bytes.write(CANARY, 29, 'utf8');
    // The create itself carries the envelope now, so the canary is in the
    // request the API commits (E13-R02).
    const created = await call(app, {
      method: 'POST',
      url: `/calendars/${calendarId}/events`,
      subject: 'owner',
      payload: {
        uid: randomUUID(),
        start: { utc: STAMP },
        end: { utc: '20261014T100000Z' },
        ...writeBody(bytes),
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const uid = created.json().uid;

    // A commit that fails the hash check, so the canary is in the request and
    // the refusal is the only thing that can echo it.
    const refused = await call(app, {
      method: 'PUT',
      url: `/calendars/${calendarId}/envelopes/${uid}`,
      subject: 'owner',
      headers: { 'if-match': created.json().etag },
      payload: { ...writeBody(bytes), envelopeSha256: 'b'.repeat(64) },
    });
    assert.equal(refused.statusCode, 422, refused.body);
    assert.ok(!refused.body.includes(CANARY), refused.body);
    assert.ok(!refused.body.includes(bytes.toString('base64')));

    // The read answers the bytes, and nothing else does.
    const read = await call(app, {
      url: `/calendars/${calendarId}/envelopes?uid=${uid}`,
      subject: 'owner',
    });
    assert.equal(read.json().envelopes[0].envelope, bytes.toString('base64'));
    assert.ok(!capture.text().includes(CANARY), capture.text());
    assert.ok(!capture.text().includes(bytes.toString('base64')));
  } finally {
    await app.close();
  }
});
