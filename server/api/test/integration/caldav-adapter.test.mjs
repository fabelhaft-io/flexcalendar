// --- E05-R02: the adapter against the local stack ----------------------------
//
// These tests run **inside** the stack (`make test-api-caldav`): the internal
// delegated listener has no published port, so the host cannot reach it, and
// the CalDAV service only accepts a request from the `delegation` network.
// `server/api/Dockerfile`'s `test` target is what runs them, as the
// `api-test` service with `calflex_api`'s database URL.
//
// The suite seeds its own users and calendars, does everything else through the
// adapter, and removes both again, so it can run twice in a row.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';

import { CalDavError, createCalDavAdapter } from '../../src/caldav/adapter.mjs';

const databaseUrl = process.env.CALFLEX_DATABASE_URL;
const origin = process.env.CALFLEX_CALDAV_ORIGIN;
const delegationKeys = process.env.CALFLEX_DELEGATION_KEYS;

/** A valid Private skeleton: no content properties, exactly one envelope hash. */
const skeleton = () => {
  const uid = randomUUID();
  return [
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
};

/** @param {string} ics @param {string} line */
const withLine = (ics, line) =>
  ics.replace('END:VEVENT', `${line}\r\nEND:VEVENT`);

/** @type {pg.Client} */
let client;
/** @type {ReturnType<typeof createCalDavAdapter>} */
let adapter;
/** @type {Record<string, string>} */
const users = { a: randomUUID(), b: randomUUID() };
/** @type {Record<string, string>} */
const calendars = { a: randomUUID(), b: randomUUID() };
/** Every object name this run wrote, so the suite can remove them again. */
const written = new Set();

/** @param {string} id */
async function seed(id) {
  // Both casts: one parameter is used as a `uuid` and as `text` here, and
  // PostgreSQL cannot deduce one type for both without them (`42P08`).
  await client.query(
    'INSERT INTO public.users (id, idp_subject, handle, email) VALUES ($1::uuid, $1::text, $1::text, $2::text)',
    [id, `${id}@example.invalid`],
  );
}

before(async () => {
  assert.ok(
    databaseUrl,
    'CALFLEX_DATABASE_URL must be set for the integration suite',
  );
  assert.ok(
    origin,
    'CALFLEX_CALDAV_ORIGIN must be set for the integration suite',
  );
  assert.ok(
    delegationKeys,
    'CALFLEX_DELEGATION_KEYS must be set for the integration suite',
  );
  client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  const role = await client.query('SELECT current_user');
  assert.equal(role.rows[0].current_user, 'calflex_api');
  adapter = createCalDavAdapter();
  for (const [key, id] of Object.entries(users)) {
    await seed(id);
    await client.query(
      "INSERT INTO public.calendars (id, owner_id, mode, caldav_href, meta_envelope, meta_epoch) VALUES ($1, $2, 'private', $3, decode('00', 'hex'), 1)",
      [calendars[key], id, `/calendars/${id}/${calendars[key]}/`],
    );
    await client.query(
      "INSERT INTO public.calendar_members (calendar_id, user_id, role) VALUES ($1, $2, 'owner')",
      [calendars[key], id],
    );
    const created = await adapter.forUser(id).makeCalendar(calendars[key]);
    assert.equal(created.status, 201);
  }
});

after(async () => {
  if (!client || !adapter) return;
  // Through the adapter first: the objects and collections are the CalDAV
  // service's state, and only DAV can remove them.
  for (const entry of written) {
    const [user, calendar, name] = entry.split('|');
    try {
      await adapter.forUser(user).deleteObject(calendar, name);
    } catch {
      // The test that wrote it already deleted it.
    }
  }
  for (const [key, id] of Object.entries(users)) {
    try {
      await adapter.forUser(id).deleteCalendar(calendars[key]);
    } catch {
      // Nothing left to remove.
    }
  }
  await client.query(
    'DELETE FROM public.calendar_members WHERE calendar_id = ANY($1::uuid[])',
    [Object.values(calendars)],
  );
  await client.query(
    'DELETE FROM public.calendars WHERE owner_id = ANY($1::uuid[])',
    [Object.values(users)],
  );
  await client.query('DELETE FROM public.users WHERE id = ANY($1::uuid[])', [
    Object.values(users),
  ]);
  await client.end();
});

/** @param {string} user @param {string} calendar @param {string} name @param {string} ics @param {any} [options] */
async function put(user, calendar, name, ics, options) {
  const result = await adapter
    .forUser(users[user])
    .putObject(calendar, name, ics, options);
  written.add(`${users[user]}|${calendar}|${name}`);
  return result;
}

/**
 * The rejection reason, so a test can assert on the error itself.
 * @param {Promise<unknown>} promise
 * @returns {Promise<unknown>}
 */
async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail('expected the call to be rejected');
}

test('each user creates a Private calendar and reads their own object back', async () => {
  const name = `${randomUUID()}.ics`;
  const ics = skeleton();
  const created = await put('a', calendars.a, name, ics, { ifNoneMatch: '*' });
  assert.equal(created.status, 201);
  assert.match(String(created.etag), /^"?\S+"?$/);

  const read = await adapter.forUser(users.a).getObject(calendars.a, name);
  assert.equal(read.status, 200);
  assert.equal(read.data, ics, 'GET returns the stored bytes');
  assert.equal(read.etag, created.etag);

  // B's own collection is empty and usable, so the isolation below is about
  // the principal, not about a missing calendar.
  const own = `${randomUUID()}.ics`;
  const bWrite = await put('b', calendars.b, own, skeleton(), {
    ifNoneMatch: '*',
  });
  assert.equal(bWrite.status, 201);
  assert.equal(
    (await adapter.forUser(users.b).getObject(calendars.b, own)).status,
    200,
  );
});

test("another user's object answers 404, like an id that exists nowhere", async () => {
  const name = `${randomUUID()}.ics`;
  await put('a', calendars.a, name, skeleton(), { ifNoneMatch: '*' });
  for (const call of [
    () => adapter.forUser(users.b).getObject(calendars.a, name),
    () =>
      adapter.forUser(users.b).listObjects(calendars.a, {
        start: '20260101T000000Z',
        end: '20270101T000000Z',
      }),
    () =>
      adapter
        .forUser(users.b)
        .putObject(calendars.a, name, skeleton(), { ifNoneMatch: '*' }),
    () => adapter.forUser(users.b).deleteObject(calendars.a, name),
  ]) {
    const error = await rejectionOf(call());
    assert.ok(error instanceof CalDavError);
    assert.equal(error.kind, 'not-found');
    assert.equal(error.status, 404);
  }
  // The object is still there for its owner.
  assert.equal(
    (await adapter.forUser(users.a).getObject(calendars.a, name)).status,
    200,
  );
});

test('create-only and stale preconditions answer 412', async () => {
  const name = `${randomUUID()}.ics`;
  const first = await put('a', calendars.a, name, skeleton(), {
    ifNoneMatch: '*',
  });
  assert.equal(first.status, 201);
  const createOnly = await rejectionOf(
    adapter
      .forUser(users.a)
      .putObject(calendars.a, name, skeleton(), { ifNoneMatch: '*' }),
  );
  assert.ok(createOnly instanceof CalDavError);
  assert.equal(createOnly.kind, 'precondition-failed');
  const stale = await rejectionOf(
    adapter
      .forUser(users.a)
      .putObject(calendars.a, name, skeleton(), { ifMatch: '"stale-etag"' }),
  );
  assert.ok(stale instanceof CalDavError);
  assert.equal(stale.kind, 'precondition-failed');
  const staleDelete = await rejectionOf(
    adapter
      .forUser(users.a)
      .deleteObject(calendars.a, name, { ifMatch: '"stale-etag"' }),
  );
  assert.ok(staleDelete instanceof CalDavError);
  assert.equal(staleDelete.kind, 'precondition-failed');
  // The object is untouched by the three refusals.
  assert.equal(
    (await adapter.forUser(users.a).getObject(calendars.a, name)).etag,
    first.etag,
  );
  // A matching If-Match does update it.
  const updated = await adapter
    .forUser(users.a)
    .putObject(calendars.a, name, withLine(skeleton(), 'SEQUENCE:1'), {
      ifMatch: /** @type {string} */ (first.etag),
    });
  assert.ok(updated.status < 300);
});

test('a content property is refused with the precondition and its name only', async () => {
  const name = `${randomUUID()}.ics`;
  const error = await rejectionOf(
    adapter
      .forUser(users.a)
      .putObject(
        calendars.a,
        name,
        withLine(skeleton(), 'SUMMARY:CALFLEX_INTEGRATION_MARKER'),
        {
          ifNoneMatch: '*',
        },
      ),
  );
  assert.ok(error instanceof CalDavError);
  assert.equal(error.kind, 'forbidden');
  assert.equal(error.status, 403);
  assert.deepEqual(error.preconditions, [
    'cf:private-skeleton-only',
    'SUMMARY',
  ]);
  const serialised = `${error.message}\n${error.stack ?? ''}\n${JSON.stringify(error)}`;
  assert.ok(
    !serialised.includes('CALFLEX_INTEGRATION_MARKER'),
    'the property value must not come out',
  );
  assert.ok(!serialised.includes('/calendars/'), 'the URL must not come out');
  // Nothing was stored.
  const stored = await rejectionOf(
    adapter.forUser(users.a).getObject(calendars.a, name),
  );
  assert.equal(/** @type {CalDavError} */ (stored).kind, 'not-found');
});

test('listObjects returns what was written, and only that', async () => {
  const name = `${randomUUID()}.ics`;
  const ics = skeleton();
  await put('a', calendars.a, name, ics, { ifNoneMatch: '*' });
  const objects = await adapter.forUser(users.a).listObjects(calendars.a, {
    start: '20261001T000000Z',
    end: '20261101T000000Z',
  });
  const found = objects.filter(
    (object) => object.href === `/calendars/${users.a}/${calendars.a}/${name}`,
  );
  assert.equal(
    found.length,
    1,
    JSON.stringify(objects.map((object) => object.href)),
  );
  // A report's `calendar-data` is LF-normalised: the service strips the `\r`
  // bytes so they cannot disturb the XML. The `getObject` call below is the one
  // that returns the stored bytes, CRLF and all, so this case pins both halves.
  assert.equal(found[0].data, ics.replaceAll('\r\n', '\n'));
  assert.match(String(found[0].etag), /^"?\S+"?$/);
  const stored = await adapter.forUser(users.a).getObject(calendars.a, name);
  assert.equal(stored.data, ics, 'GET returns exactly the CRLF bytes written');
  assert.ok(ics.includes('\r\n'));
  // A window that cannot contain the event returns nothing.
  assert.deepEqual(
    await adapter.forUser(users.a).listObjects(calendars.a, {
      start: '20200101T000000Z',
      end: '20200201T000000Z',
    }),
    [],
  );
});

test('syncChanges reports the collection, then only what changed, deletions included', async () => {
  const user = adapter.forUser(users.a);
  const initial = await user.syncChanges(calendars.a);
  assert.match(
    String(initial.syncToken),
    /^http:\/\/sabre\.io\/ns\/sync\/\d+$/,
  );
  const known = initial.changed
    .filter((entry) => !entry.deleted)
    .map((entry) => entry.href);
  assert.ok(known.length >= 1);

  const name = `${randomUUID()}.ics`;
  const ics = skeleton();
  await put('a', calendars.a, name, ics, { ifNoneMatch: '*' });
  const href = `/calendars/${users.a}/${calendars.a}/${name}`;
  const delta = await user.syncChanges(
    calendars.a,
    /** @type {string} */ (initial.syncToken),
  );
  assert.ok(delta.syncToken !== initial.syncToken, 'the token moves on');
  assert.deepEqual(
    delta.changed.map((entry) => [entry.href, entry.deleted]),
    [[href, false]],
  );
  // As with `listObjects`, the report's data is LF-normalised; `getObject`
  // returns the stored CRLF bytes exactly.
  const stored = await user.getObject(calendars.a, name);
  assert.equal(stored.data, ics, 'GET returns exactly the CRLF bytes written');
  assert.ok(ics.includes('\r\n'));
  assert.equal(delta.changed[0].data, stored.data.replaceAll('\r\n', '\n'));

  const removed = await user.deleteObject(calendars.a, name, {});
  assert.ok(removed.status < 300);
  const tombstone = await user.syncChanges(
    calendars.a,
    /** @type {string} */ (delta.syncToken),
  );
  assert.deepEqual(
    tombstone.changed.map((entry) => [entry.href, entry.deleted]),
    [[href, true]],
  );
});

test('a bad key id or a tampered signature is the one 401', async () => {
  const [id, key] = String(delegationKeys).split(',')[0].split(':');
  const otherKey = Buffer.alloc(32, 7).toString('base64');
  const cases = [
    // The key id is unknown to the service.
    createCalDavAdapter({ origin, keys: `unknown:${key}` }),
    // A known id with different key bytes: the signature does not verify.
    createCalDavAdapter({ origin, keys: `${id}:${otherKey}` }),
  ];
  for (const candidate of cases) {
    const error = await rejectionOf(
      candidate.forUser(users.a).listObjects(calendars.a, {
        start: '20261001T000000Z',
        end: '20261101T000000Z',
      }),
    );
    assert.ok(error instanceof CalDavError);
    assert.equal(error.kind, 'unauthorized');
    assert.equal(error.status, 401);
    assert.equal(error.message, 'CalDAV unauthorized (401)');
  }
});
