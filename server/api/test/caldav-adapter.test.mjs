// --- E05-R02: the CalDAV adapter, without a container ------------------------
//
// These tests drive the adapter against a recording transport: every test sees
// the request the adapter actually sent — its method, URL, headers and body —
// and the response it was handed back. Nothing here needs the stack; the
// end-to-end suite that does is `test/integration/caldav-adapter.test.mjs`.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  CalDavError,
  MAX_INSTANCES_PRECONDITION,
  PRECONDITION_SCAN_LIMIT_BYTES,
  PRIVATE_CALENDAR_DISPLAY_NAME,
  PRINCIPAL_HEADER,
  REQUEST_ID_HEADER,
  createCalDavAdapter,
  delegationHeader,
  delegationTarget,
  parseDelegationKeys,
  parsePreconditions,
  randomNonce,
  signedFetchFor,
  syncTokenNumber,
  syncTokenText,
} from '../src/caldav/adapter.mjs';

const ORIGIN = 'http://caldav-internal:8081';
const KEY_ID = 'vector';
const KEY_BASE64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const KEY = Buffer.from(KEY_BASE64, 'base64');
const DELEGATION_KEYS = `${KEY_ID}:${KEY_BASE64}`;
const USER = '8b0e189c-43a5-4f1e-a810-5c4b5c021593';
const OTHER_USER = '1c2d3e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f';
const CALENDAR = '9a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const NONCE = 'AAECAwQFBgcICQoLDA0ODw';
const TIMESTAMP = 1791500000;

const vectors = JSON.parse(
  await readFile(
    new URL(
      '../../caldav/tests/Fixtures/delegation-vectors.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

/** @param {string} body @param {number} [status] */
const xml =
  (body, status = 207) =>
  () =>
    new Response(body, {
      status,
      headers: { 'content-type': 'application/xml; charset=utf-8' },
    });

/** @param {number} status @param {string} [body] */
const plain =
  (status, body = '') =>
  () =>
    new Response(body, { status, headers: { 'content-type': 'text/plain' } });

/**
 * Records every request and answers from `handler`. The handler is called per
 * request, so a test can change its answer between calls.
 *
 * @param {(url: URL, init: RequestInit) => Response} handler
 */
function record(handler) {
  /** @type {{url: URL, init: any}[]} */
  const calls = [];
  /** @param {any} input @param {any} init @returns {Promise<Response>} */
  const transport = async (input, init) => {
    calls.push({ url: input, init });
    return handler(input, init);
  };
  return { calls, transport };
}

/** @param {(url: URL, init: RequestInit) => Response} handler */
function adapterFor(handler, options = {}) {
  const { calls, transport } = record(handler);
  const adapter = createCalDavAdapter({
    origin: ORIGIN,
    keys: DELEGATION_KEYS,
    fetch: transport,
    now: () => TIMESTAMP * 1000 + 750,
    nonce: () => NONCE,
    ...options,
  });
  return { adapter, calls };
}

/**
 * @param {string} header
 * @returns {Record<string, string>}
 */
function fields(header) {
  /** @type {Record<string, string>} */
  const parsed = {};
  for (const part of header.split('; ')) {
    const separator = part.indexOf('=');
    parsed[part.slice(0, separator)] = part.slice(separator + 1);
  }
  return parsed;
}

/** @param {{url: URL, init: any}} call */
function signedTarget(call) {
  return `${call.url.pathname}${call.url.search}`;
}

// --- the signing vector (E03-R01) --------------------------------------------

test('every published delegation vector reproduces its header', () => {
  assert.ok(vectors.length >= 3);
  for (const vector of vectors) {
    const header = delegationHeader({
      keyId: vector.keyId,
      key: Buffer.from(vector.key, 'base64'),
      principal: vector.principal,
      method: vector.method,
      target: vector.target,
      timestamp: vector.timestamp,
      nonce: vector.nonce,
    });
    assert.equal(header, vector.header, `${vector.method} ${vector.target}`);
  }
});

test('the header carries the shape the service parses', () => {
  const header = delegationHeader({
    keyId: KEY_ID,
    key: KEY,
    principal: USER,
    method: 'PUT',
    target: '/calendars/x/y.ics',
    timestamp: TIMESTAMP,
    nonce: NONCE,
  });
  assert.equal(
    header,
    `v=1; k=${KEY_ID}; p=${USER}; t=${TIMESTAMP}; n=${NONCE}; s=${header.split('s=')[1]}`,
  );
  const parsed = fields(header);
  assert.deepEqual(Object.keys(parsed).sort(), ['k', 'n', 'p', 's', 't', 'v']);
  assert.equal(parsed.v, '1');
  assert.match(parsed.n, /^[A-Za-z0-9_-]{22}$/);
  assert.match(parsed.s, /^[A-Za-z0-9_-]{43}$/);
  // The service rejects a non-canonical base64url representation.
  assert.equal(
    Buffer.from(parsed.s, 'base64url').toString('base64url'),
    parsed.s,
  );
});

test('nonces are 16 random bytes, base64url, unpadded and fresh', () => {
  const seen = new Set();
  for (let index = 0; index < 256; index += 1) {
    const nonce = randomNonce();
    assert.match(nonce, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(Buffer.from(nonce, 'base64url').length, 16);
    assert.equal(Buffer.from(nonce, 'base64url').toString('base64url'), nonce);
    seen.add(nonce);
  }
  assert.equal(seen.size, 256);
});

// --- key list parsing ---------------------------------------------------------

test('the key list is parsed in order and keeps the first key first', () => {
  const keys = parseDelegationKeys(
    `${KEY_ID}:${KEY_BASE64},second:${KEY_BASE64}`,
  );
  assert.equal(keys.length, 2);
  assert.equal(keys[0].id, KEY_ID);
  assert.equal(keys[0].key.length, 32);
  assert.equal(keys[1].id, 'second');
});

test('the signer uses the first key of the list', async () => {
  const second = 'second:' + KEY_BASE64;
  const { adapter, calls } = adapterFor(xml('<d:mkcol xmlns:d="DAV:"/>', 201), {
    keys: `${second},${KEY_ID}:${KEY_BASE64}`,
  });
  await adapter.forUser(USER).makeCalendar(CALENDAR);
  assert.equal(fields(calls[0].init.headers.get(PRINCIPAL_HEADER)).k, 'second');
});

test('an invalid key list fails at creation, without quoting the value', () => {
  const entries = [
    '',
    '   ',
    undefined,
    'no-separator',
    ':missing-id-and-key',
    `${KEY_ID}:`,
    'bad id:' + KEY_BASE64,
    `${KEY_ID}:not base64!`,
    // 16 bytes: below the 32-byte minimum.
    `${KEY_ID}:AAECAwQFBgcICQoLDA0ODw==`,
    // Unpadded: the service re-encodes and refuses it.
    `${KEY_ID}:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8`,
    // Non-canonical final character (unused low bits).
    `${KEY_ID}:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh9`,
    `${KEY_ID}:${KEY_BASE64},${KEY_ID}:${KEY_BASE64}`,
  ];
  for (const entry of entries) {
    assert.throws(
      () =>
        createCalDavAdapter({
          origin: ORIGIN,
          keys: entry,
          fetch: async () => new Response(),
        }),
      (/** @type {CalDavError} */ error) => {
        assert.ok(error instanceof CalDavError, String(entry));
        assert.equal(error.kind, 'config');
        // The configuration value is never quoted back.
        assert.ok(!error.message.includes(KEY_BASE64));
        assert.ok(!error.message.includes('not base64'));
        if (typeof entry === 'string' && entry.length >= 8) {
          assert.ok(!error.message.includes(entry), error.message);
        }
        return true;
      },
    );
  }
});

test('an invalid origin fails at creation', () => {
  for (const origin of [
    '',
    '   ',
    undefined,
    'caldav-internal:8081',
    'ftp://caldav/',
    `${ORIGIN}/internal`,
    `${ORIGIN}/?x=1`,
  ]) {
    assert.throws(
      () =>
        createCalDavAdapter({
          origin,
          keys: DELEGATION_KEYS,
          fetch: async () => new Response(),
        }),
      (/** @type {CalDavError} */ error) => {
        assert.ok(error instanceof CalDavError, String(origin));
        assert.equal(error.kind, 'config');
        return true;
      },
    );
  }
});

// --- what is signed is what is sent ------------------------------------------

test('the adapter signs the URL, method, timestamp and nonce it actually sends', async () => {
  const { adapter, calls } = adapterFor(xml('<d:mkcol xmlns:d="DAV:"/>', 201));
  await adapter.forUser(USER).makeCalendar(CALENDAR);

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.init.method, 'MKCALENDAR');
  assert.equal(String(call.url), `${ORIGIN}/calendars/${USER}/${CALENDAR}/`);
  assert.equal(call.init.redirect, 'manual');
  assert.ok(call.init.signal instanceof AbortSignal);

  const header = call.init.headers.get(PRINCIPAL_HEADER);
  const parsed = fields(header);
  assert.equal(parsed.p, USER);
  assert.equal(parsed.t, String(TIMESTAMP));
  assert.equal(parsed.n, NONCE);
  assert.equal(
    header,
    delegationHeader({
      keyId: parsed.k,
      key: KEY,
      principal: parsed.p,
      method: call.init.method,
      target: signedTarget(call),
      timestamp: Number(parsed.t),
      nonce: parsed.n,
    }),
  );
  // Signing anything other than what was sent cannot produce this header.
  assert.notEqual(
    header,
    delegationHeader({
      keyId: parsed.k,
      key: KEY,
      principal: parsed.p,
      method: call.init.method,
      target: `${signedTarget(call)}?extra=1`,
      timestamp: Number(parsed.t),
      nonce: parsed.n,
    }),
  );
  assert.notEqual(
    header,
    delegationHeader({
      keyId: parsed.k,
      key: KEY,
      principal: parsed.p,
      method: 'GET',
      target: signedTarget(call),
      timestamp: Number(parsed.t),
      nonce: parsed.n,
    }),
  );
});

test('a fresh nonce and timestamp go out with every request', async () => {
  const { adapter, calls } = adapterFor(xml('<d:mkcol xmlns:d="DAV:"/>', 201), {
    now: () => TIMESTAMP * 1000 + 900,
    nonce: () => randomNonce(),
  });
  const user = adapter.forUser(USER);
  await user.makeCalendar(CALENDAR);
  await user.makeCalendar(CALENDAR);
  await user.makeCalendar(CALENDAR);
  const parsed = calls.map((call) =>
    fields(call.init.headers.get(PRINCIPAL_HEADER)),
  );
  assert.equal(new Set(parsed.map((field) => field.n)).size, parsed.length);
  for (const field of parsed) {
    assert.equal(field.t, String(TIMESTAMP));
    assert.match(field.n, /^[A-Za-z0-9_-]{22}$/);
  }
});

test('a default adapter mints its own nonce: 22 base64url characters, never twice', async () => {
  /** @type {string[]} */
  const nonces = [];
  for (let round = 0; round < 2; round += 1) {
    // No `now` and no `nonce` are injected here: these are the defaults.
    const { calls, transport } = record(xml('<d:mkcol xmlns:d="DAV:"/>', 201));
    const adapter = createCalDavAdapter({
      origin: ORIGIN,
      keys: DELEGATION_KEYS,
      fetch: transport,
    });
    const user = adapter.forUser(USER);
    await user.makeCalendar(CALENDAR);
    await user.makeCalendar(CALENDAR);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      const parsed = fields(call.init.headers.get(PRINCIPAL_HEADER));
      assert.match(parsed.n, /^[A-Za-z0-9_-]{22}$/);
      assert.equal(Buffer.from(parsed.n, 'base64url').length, 16);
      assert.equal(
        Buffer.from(parsed.n, 'base64url').toString('base64url'),
        parsed.n,
      );
      assert.match(parsed.t, /^\d{10}$/);
      nonces.push(parsed.n);
    }
  }
  assert.equal(nonces.length, 4);
  assert.equal(new Set(nonces).size, nonces.length);
});

test('the signed target is the path and query URL serialisation produces', () => {
  assert.equal(
    delegationTarget(new URL(`${ORIGIN}/principals/`)),
    '/principals/',
  );
  assert.equal(
    delegationTarget(new URL(`${ORIGIN}/calendars/?a=1&b=%2F`)),
    '/calendars/?a=1&b=%2F',
  );
  assert.equal(
    delegationTarget(new URL(`${ORIGIN}/calendars/a/event%20one.ics`)),
    '/calendars/a/event%20one.ics',
  );
  assert.equal(delegationTarget(`${ORIGIN}/caf%C3%A9/`), '/caf%C3%A9/');
  // A bare `?` is not part of the serialisation.
  assert.equal(
    delegationTarget(new URL(`${ORIGIN}/principals/?`)),
    '/principals/',
  );
  // Dot segments are removed by the URL parser, so both sides sign the same path.
  assert.equal(
    delegationTarget(`${ORIGIN}/calendars/a/../b/`),
    '/calendars/b/',
  );
  assert.equal(
    delegationTarget(new URL(`${ORIGIN}/caf\u00e9/`)),
    '/caf%C3%A9/',
  );
});

test('every request is signed for the user it was created for', async () => {
  const { adapter, calls } = adapterFor(xml('<d:mkcol xmlns:d="DAV:"/>', 201));
  await adapter.forUser(USER).makeCalendar(CALENDAR);
  await adapter.forUser(OTHER_USER).makeCalendar(CALENDAR);
  assert.equal(fields(calls[0].init.headers.get(PRINCIPAL_HEADER)).p, USER);
  assert.equal(
    fields(calls[1].init.headers.get(PRINCIPAL_HEADER)).p,
    OTHER_USER,
  );
  assert.match(
    String(calls[1].url),
    new RegExp(`^${ORIGIN}/calendars/${OTHER_USER}/`),
  );
});

test('the signed fetch refuses a foreign origin and resolves a relative target', async () => {
  const { calls, transport } = record(plain(200, 'ok'));
  const signed = signedFetchFor({
    origin: new URL(ORIGIN),
    principal: USER,
    keyId: KEY_ID,
    key: KEY,
    transport,
    now: () => TIMESTAMP * 1000,
    nonce: () => NONCE,
    limit: 1024,
    timeout: 1000,
  });

  // A relative target is resolved against the origin, sent as such, and the
  // header signs exactly that target and the upper-cased method.
  const response = await signed('/calendars/x/?a=1', { method: 'get' });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].url), `${ORIGIN}/calendars/x/?a=1`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(
    calls[0].init.headers.get(PRINCIPAL_HEADER),
    delegationHeader({
      keyId: KEY_ID,
      key: KEY,
      principal: USER,
      method: 'GET',
      target: '/calendars/x/?a=1',
      timestamp: TIMESTAMP,
      nonce: NONCE,
    }),
  );

  // An absolute target on the same origin is accepted too.
  await signed(new URL(`${ORIGIN}/principals/`));
  assert.equal(String(calls[1].url), `${ORIGIN}/principals/`);
  assert.equal(calls[1].init.method, 'GET');

  // Another origin is refused before it is signed or sent.
  for (const target of [
    'http://elsewhere.invalid/calendars/',
    'https://caldav-internal:8081/calendars/',
    'http://caldav-internal:8082/calendars/',
  ]) {
    await assert.rejects(
      () => signed(target, { method: 'GET' }),
      (/** @type {CalDavError} */ error) => {
        assert.ok(error instanceof CalDavError, target);
        assert.equal(error.kind, 'invalid-target');
        assert.ok(!error.message.includes(target), error.message);
        return true;
      },
    );
  }
  assert.equal(calls.length, 2, 'a foreign target is never sent');
});

test('the correlation ID travels as X-Request-Id and is never signed', async () => {
  const { calls, transport } = record(plain(200, 'ok'));
  const signed = signedFetchFor({
    origin: new URL(ORIGIN),
    principal: USER,
    keyId: KEY_ID,
    key: KEY,
    transport,
    now: () => TIMESTAMP * 1000,
    nonce: () => NONCE,
    limit: 1024,
    timeout: 1000,
    requestId: USER,
  });

  await signed('/calendars/x/', { method: 'GET' });
  assert.equal(calls[0].init.headers.get(REQUEST_ID_HEADER), USER);
  // The delegation header is the same bytes with and without a request ID: the
  // correlation ID is not part of the D-05 signature.
  assert.equal(
    calls[0].init.headers.get(PRINCIPAL_HEADER),
    delegationHeader({
      keyId: KEY_ID,
      key: KEY,
      principal: USER,
      method: 'GET',
      target: '/calendars/x/',
      timestamp: TIMESTAMP,
      nonce: NONCE,
    }),
  );

  // Without one there is no header at all, rather than an empty value.
  const { calls: plainCalls, transport: plainTransport } = record(
    plain(200, 'ok'),
  );
  const bare = signedFetchFor({
    origin: new URL(ORIGIN),
    principal: USER,
    keyId: KEY_ID,
    key: KEY,
    transport: plainTransport,
    now: () => TIMESTAMP * 1000,
    nonce: () => NONCE,
    limit: 1024,
    timeout: 1000,
  });
  await bare('/calendars/x/', { method: 'GET' });
  assert.equal(plainCalls[0].init.headers.get(REQUEST_ID_HEADER), null);
});

test('forUser carries request.id on every call and refuses one that is not a v4 UUID', async () => {
  const { adapter, calls } = adapterFor(plain(201, ''));
  await adapter.forUser(USER, { requestId: OTHER_USER }).makeCalendar(CALENDAR);
  assert.equal(calls[0].init.headers.get(REQUEST_ID_HEADER), OTHER_USER);
  await adapter
    .forUser(USER, { requestId: OTHER_USER })
    .deleteCalendar(CALENDAR);
  assert.equal(calls[1].init.headers.get(REQUEST_ID_HEADER), OTHER_USER);
  // Without a request ID every call still works and sends no such header.
  await adapter.forUser(USER).makeCalendar(CALENDAR);
  assert.equal(calls[2].init.headers.get(REQUEST_ID_HEADER), null);

  // Anything that is not a lowercase v4 UUID is refused before any request
  // exists, so a header value can never reach the wire unfiltered.
  for (const id of [
    '',
    'nope',
    OTHER_USER.toUpperCase(),
    `${OTHER_USER}\n`,
    42,
  ]) {
    assert.throws(
      () => adapter.forUser(USER, { requestId: /** @type {string} */ (id) }),
      (/** @type {CalDavError} */ error) => {
        assert.equal(error.kind, 'invalid-requestId', String(id));
        if (String(id) !== '') {
          assert.ok(!error.message.includes(String(id)), error.message);
        }
        return true;
      },
    );
  }
  assert.equal(
    calls.length,
    3,
    'a refused request ID never reaches the transport',
  );
});

// --- path safety -------------------------------------------------------------

test('a non-UUID user or calendar id is refused before any request', async () => {
  const { adapter, calls } = adapterFor(xml('<d:mkcol xmlns:d="DAV:"/>', 201));
  const badUsers = [
    '',
    'not-a-uuid',
    `${USER} `,
    USER.toUpperCase(),
    // A v1 UUID and one with a wrong variant are both refused.
    '8b0e189c-43a5-1f1e-a810-5c4b5c021593',
    '8b0e189c-43a5-4f1e-c810-5c4b5c021593',
    '../etc',
    `${USER}/x`,
    null,
    42,
  ];
  for (const id of badUsers) {
    assert.throws(
      () => adapter.forUser(/** @type {string} */ (id)),
      (/** @type {CalDavError} */ error) => {
        assert.equal(error.kind, 'invalid-userId', String(id));
        return true;
      },
    );
  }
  const user = adapter.forUser(USER);
  for (const id of ['', 'nope', CALENDAR.toUpperCase(), `${CALENDAR}/..`]) {
    await assert.rejects(() => user.makeCalendar(id), { name: 'CalDavError' });
    await assert.rejects(() => user.getObject(id, 'one.ics'), {
      name: 'CalDavError',
    });
    await assert.rejects(
      () =>
        user.listObjects(id, {
          start: '20260101T000000Z',
          end: '20260201T000000Z',
        }),
      {
        name: 'CalDavError',
      },
    );
  }
  assert.equal(calls.length, 0);
});

test('an object name that is not a safe path segment is refused', async () => {
  const { adapter, calls } = adapterFor(plain(200, 'x'));
  const user = adapter.forUser(USER);
  for (const name of [
    '',
    '.',
    '..',
    '../x',
    'a/b',
    'a%2Fb',
    'a b',
    'a\nb',
    '.hidden',
  ]) {
    await assert.rejects(
      () =>
        user.putObject(CALENDAR, name, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'),
      (/** @type {CalDavError} */ error) => {
        assert.equal(error.kind, 'invalid-name', JSON.stringify(name));
        return true;
      },
    );
  }
  assert.equal(calls.length, 0);
});

// --- the request surface ------------------------------------------------------

test('makeCalendar sends MKCALENDAR with the fixed Private display name', async () => {
  const { adapter, calls } = adapterFor(xml('<d:mkcol xmlns:d="DAV:"/>', 201));
  const result = await adapter.forUser(USER).makeCalendar(CALENDAR);
  assert.equal(result.status, 201);
  assert.equal(calls[0].init.method, 'MKCALENDAR');
  // The display name is spelled out here, not read from the constant: D-18's
  // write guard allows this one literal, so a changed constant must fail here.
  assert.equal(PRIVATE_CALENDAR_DISPLAY_NAME, 'Private calendar');
  const body = String(calls[0].init.body);
  assert.ok(
    body.includes('<d:displayname>Private calendar</d:displayname>'),
    body,
  );
  assert.equal(
    body.split('<d:displayname>').length,
    2,
    'only the display name is sent',
  );
  // …and nothing else: the whole request is that one property.
  assert.equal(
    body,
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ca="http://apple.com/ns/ical/">',
      '  <d:set>',
      '    <d:prop>',
      '      <d:displayname>Private calendar</d:displayname>',
      '    </d:prop>',
      '  </d:set>',
      '</c:mkcalendar>',
    ].join('\n'),
  );
});

test('putObject sends the calendar object with its preconditions', async () => {
  const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
  const { adapter, calls } = adapterFor(
    () =>
      new Response(null, {
        status: 204,
        headers: { etag: '"etag-1"' },
      }),
  );
  const result = await adapter
    .forUser(USER)
    .putObject(CALENDAR, 'adf46a78-3c92-4c1e-ab04-7f791296e61e.ics', ics, {
      ifMatch: '"etag-0"',
    });
  assert.equal(result.status, 204);
  assert.equal(result.etag, '"etag-1"');
  const call = calls[0];
  assert.equal(call.init.method, 'PUT');
  assert.equal(
    String(call.url),
    `${ORIGIN}/calendars/${USER}/${CALENDAR}/adf46a78-3c92-4c1e-ab04-7f791296e61e.ics`,
  );
  assert.equal(call.init.body, ics);
  assert.equal(
    call.init.headers.get('content-type'),
    'text/calendar; charset=utf-8',
  );
  assert.equal(call.init.headers.get('if-match'), '"etag-0"');
  assert.equal(call.init.headers.get('if-none-match'), null);
});

test('putObject can create only, and deleteObject can match an ETag', async () => {
  const { adapter, calls } = adapterFor(plain(201));
  const user = adapter.forUser(USER);
  await user.putObject(
    CALENDAR,
    'one.ics',
    'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
    { ifNoneMatch: '*' },
  );
  assert.equal(calls[0].init.headers.get('if-none-match'), '*');
  assert.equal(calls[0].init.headers.get('if-match'), null);

  await user.deleteObject(CALENDAR, 'one.ics', { ifMatch: '"etag-1"' });
  assert.equal(calls[1].init.method, 'DELETE');
  assert.equal(calls[1].init.headers.get('if-match'), '"etag-1"');
});

test('getObject is a plain GET and returns the stored bytes', async () => {
  const ics =
    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-CALFLEX-ENVELOPE-SHA256:' +
    'a'.repeat(64) +
    '\r\nEND:VCALENDAR\r\n';
  const { adapter, calls } = adapterFor(
    () => new Response(ics, { status: 200, headers: { etag: '"e"' } }),
  );
  const object = await adapter.forUser(USER).getObject(CALENDAR, 'one.ics');
  assert.deepEqual(object, { status: 200, etag: '"e"', data: ics });
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
});

test('listObjects asks for a calendar-query over the requested window', async () => {
  const multistatus = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/${USER}/${CALENDAR}/one.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag-1"</d:getetag>
        <cal:calendar-data>BEGIN:VCALENDAR&#13;&#10;END:VCALENDAR&#13;&#10;</cal:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
  const { adapter, calls } = adapterFor(xml(multistatus));
  const objects = await adapter.forUser(USER).listObjects(CALENDAR, {
    start: '20260101T000000Z',
    end: '20260201T000000Z',
  });
  assert.deepEqual(objects, [
    {
      href: `/calendars/${USER}/${CALENDAR}/one.ics`,
      etag: '"etag-1"',
      data: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
    },
  ]);
  assert.equal(calls[0].init.method, 'REPORT');
  const body = String(calls[0].init.body);
  assert.ok(
    body.includes('<c:calendar-query') || body.includes('<cal:calendar-query'),
  );
  assert.ok(body.includes('start="20260101T000000Z"'));
  assert.ok(body.includes('end="20260201T000000Z"'));
  assert.ok(body.includes('name="VEVENT"'));
  assert.equal(calls[0].init.headers.get('depth'), '1');
});

test('listObjects without a range asks for the whole collection', async () => {
  const { adapter, calls } = adapterFor(xml('<d:multistatus xmlns:d="DAV:"/>'));
  await adapter.forUser(USER).listObjects(CALENDAR);
  const body = String(calls[0].init.body);
  // The component filter alone: no `time-range`, so the service's own engine
  // never expands a series and the caller's expansion decides the window
  // (E05-R05).
  assert.ok(
    body.includes('<c:calendar-query') || body.includes('<cal:calendar-query'),
    body,
  );
  assert.ok(body.includes('name="VEVENT"'), body);
  assert.ok(!body.includes('time-range'), body);
  assert.equal(calls[0].init.headers.get('depth'), '1');
  assert.equal(calls.length, 1);
});

test('listObjects accepts ISO instants and refuses anything else', async () => {
  const { adapter, calls } = adapterFor(xml('<d:multistatus xmlns:d="DAV:"/>'));
  const user = adapter.forUser(USER);
  await user.listObjects(CALENDAR, {
    start: '2026-01-01T00:00:00Z',
    end: '2026-02-01T00:00:00Z',
  });
  const body = String(calls[0].init.body);
  assert.ok(body.includes('start="20260101T000000Z"'), body);
  assert.ok(body.includes('end="20260201T000000Z"'), body);
  for (const range of [
    null,
    {},
    { start: '2026-01-01', end: '2026-02-01' },
    { start: 'x', end: 'y' },
  ]) {
    await assert.rejects(
      () => user.listObjects(CALENDAR, /** @type {any} */ (range)),
      { name: 'CalDavError' },
    );
  }
  assert.equal(calls.length, 1);
});

test('syncChanges reports the sync token, changes and deletions', async () => {
  const multistatus = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/${USER}/${CALENDAR}/one.ics</d:href>
    <d:propstat>
      <d:prop><d:getetag>"etag-2"</d:getetag><cal:calendar-data>BEGIN:VCALENDAR&#13;&#10;END:VCALENDAR&#13;&#10;</cal:calendar-data></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/calendars/${USER}/${CALENDAR}/two.ics</d:href>
    <d:status>HTTP/1.1 404 Not Found</d:status>
  </d:response>
  <d:sync-token>http://sabre.io/ns/sync/7</d:sync-token>
</d:multistatus>`;
  const { adapter, calls } = adapterFor(xml(multistatus));
  const user = adapter.forUser(USER);
  const result = await user.syncChanges(CALENDAR, 'http://sabre.io/ns/sync/6');
  assert.equal(result.syncToken, 'http://sabre.io/ns/sync/7');
  assert.equal(result.changed.length, 2);
  assert.deepEqual(result.changed[0], {
    href: `/calendars/${USER}/${CALENDAR}/one.ics`,
    // tsdav reports the report's own status (207) for a present object.
    status: 207,
    deleted: false,
    etag: '"etag-2"',
    data: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
  });
  assert.deepEqual(result.changed[1], {
    href: `/calendars/${USER}/${CALENDAR}/two.ics`,
    status: 404,
    deleted: true,
    etag: '',
    data: '',
  });
  assert.ok(String(calls[0].init.body).includes('http://sabre.io/ns/sync/6'));

  // No token: the service answers the whole collection.
  await user.syncChanges(CALENDAR);
  assert.ok(!String(calls[1].init.body).includes('http://sabre.io/ns/sync/6'));
  await assert.rejects(
    () => user.syncChanges(CALENDAR, /** @type {any} */ (42)),
    { name: 'CalDavError' },
  );
});

// --- currentSyncToken (E05-R08) -----------------------------------------------

test("currentSyncToken reads the collection's own token with a depth-0 PROPFIND", async () => {
  const multistatus = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/calendars/${USER}/${CALENDAR}/</d:href>
    <d:propstat>
      <d:prop><d:sync-token>http://sabre.io/ns/sync/12</d:sync-token></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
  const { adapter, calls } = adapterFor(xml(multistatus));
  const number = await adapter.forUser(USER).currentSyncToken(CALENDAR);
  assert.equal(number, '12');
  assert.equal(calls[0].init.method, 'PROPFIND');
  assert.equal(calls[0].init.headers.get('depth'), '0');
  assert.equal(calls[0].url.pathname, `/calendars/${USER}/${CALENDAR}/`);
  assert.ok(String(calls[0].init.body).includes('sync-token'));

  // A number beyond what a JS float holds exactly survives as a string.
  const big = '999999999999999999';
  /** @param {string} uri @param {string} [status] */
  const propstat = (uri, status = 'HTTP/1.1 200 OK') =>
    `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x</d:href><d:propstat><d:prop><d:sync-token>${uri}</d:sync-token></d:prop><d:status>${status}</d:status></d:propstat></d:response></d:multistatus>`;
  const { adapter: wide } = adapterFor(
    xml(propstat(`http://sabre.io/ns/sync/${big}`)),
  );
  assert.equal(await wide.forUser(USER).currentSyncToken(CALENDAR), big);

  // A `207` the collection did not answer the property in is not a token, and
  // a token of some other shape is not one either.
  for (const body of [
    '<d:multistatus xmlns:d="DAV:"/>',
    propstat(NONCE),
    propstat('http://sabre.io/ns/sync/007'),
    propstat('http://sabre.io/ns/sync/7/nope'),
  ]) {
    const { adapter: narrow } = adapterFor(xml(body));
    await assert.rejects(
      () => narrow.forUser(USER).currentSyncToken(CALENDAR),
      { name: 'CalDavError', kind: 'protocol' },
    );
  }

  // A refusal of the collection keeps its meaning.
  const { adapter: refused } = adapterFor(plain(403));
  await assert.rejects(() => refused.forUser(USER).currentSyncToken(CALENDAR), {
    name: 'CalDavError',
    kind: 'forbidden',
  });
});

test('the sync token helpers mint and read only the canonical form', () => {
  assert.equal(syncTokenText('7'), 'http://sabre.io/ns/sync/7');
  assert.equal(syncTokenText('0'), 'http://sabre.io/ns/sync/0');
  assert.equal(syncTokenNumber('http://sabre.io/ns/sync/7'), '7');
  assert.equal(
    syncTokenNumber('http://sabre.io/ns/sync/999999999999999999'),
    '999999999999999999',
  );
  for (const value of [
    '7',
    'http://sabre.io/ns/sync/',
    'http://sabre.io/ns/sync/07',
    'http://sabre.io/ns/sync/-1',
    'http://sabre.io/ns/sync/x',
    `http://sabre.io/ns/sync/7/`,
    // One digit more than a signed 64-bit can hold: never a token of ours.
    'http://sabre.io/ns/sync/92233720368547758070',
    7,
    undefined,
    null,
    {},
  ]) {
    assert.equal(syncTokenNumber(/** @type {any} */ (value)), undefined);
  }
  // A value the service would refuse is never built into a URI, so a client's
  // own string cannot be forwarded by accident.
  for (const value of [
    '',
    '07',
    '-1',
    '1e3',
    '١٢',
    '7 ',
    '92233720368547758070',
  ]) {
    assert.throws(
      () => syncTokenText(value),
      { name: 'CalDavError', kind: 'invalid-token' },
      value,
    );
  }
});

// --- status and error mapping -------------------------------------------------

test('every non-2xx status maps to one error kind', async () => {
  const expected = new Map([
    [300, 'redirect'],
    [301, 'redirect'],
    [302, 'redirect'],
    [307, 'redirect'],
    [308, 'redirect'],
    [400, 'failed'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [405, 'failed'],
    [409, 'conflict'],
    [412, 'precondition-failed'],
    [415, 'unsupported-media-type'],
    [418, 'failed'],
    [500, 'server'],
    [502, 'server'],
    [503, 'server'],
  ]);
  for (const [status, kind] of expected) {
    const { adapter } = adapterFor(plain(status, `HTTP_MARKER ${status}`));
    await assert.rejects(
      () => adapter.forUser(USER).getObject(CALENDAR, 'one.ics'),
      (/** @type {CalDavError} */ error) => {
        assert.ok(error instanceof CalDavError, String(status));
        assert.equal(error.kind, kind);
        assert.equal(error.status, status);
        assert.ok(!error.message.includes('HTTP_MARKER'));
        return true;
      },
    );
  }
});

test('a 401 is one kind whatever the reason behind it', async () => {
  for (const body of [
    'Unauthorized\n',
    '',
    'delegation_denied replay',
    '<d:error xmlns:d="DAV:"/>',
  ]) {
    const { adapter } = adapterFor(plain(401, body));
    await assert.rejects(
      () => adapter.forUser(USER).getObject(CALENDAR, 'one.ics'),
      (/** @type {CalDavError} */ error) => {
        assert.equal(error.kind, 'unauthorized');
        assert.equal(error.status, 401);
        assert.equal(error.message, 'CalDAV unauthorized (401)');
        return true;
      },
    );
  }
});

test('a DAV:error precondition carries element names and nothing else', async () => {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns"><cf:private-skeleton-only xmlns:cf="https://flexcalendar.de/ns/caldav"><cf:name>SUMMARY</cf:name></cf:private-skeleton-only></d:error>`;
  const { adapter } = adapterFor(plain(403, body));
  await assert.rejects(
    () =>
      adapter
        .forUser(USER)
        .putObject(CALENDAR, 'one.ics', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'),
    (/** @type {CalDavError} */ error) => {
      assert.equal(error.kind, 'forbidden');
      assert.deepEqual(error.preconditions, [
        'cf:private-skeleton-only',
        'SUMMARY',
      ]);
      return true;
    },
  );
});

test('a CalDAV `403` over the recurrence bound reaches the adapter as the max-instances precondition', async () => {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns"><C:max-instances xmlns:C="urn:ietf:params:xml:ns:caldav"><C:reason>CALFLEX_BODY_MARKER</C:reason></C:max-instances></d:error>`;
  const { adapter } = adapterFor(plain(403, body));
  await assert.rejects(
    () =>
      adapter
        .forUser(USER)
        .putObject(CALENDAR, 'one.ics', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'),
    (/** @type {CalDavError} */ error) => {
      assert.equal(error.kind, 'forbidden');
      assert.equal(error.status, 403);
      assert.deepEqual(error.preconditions, ['C:max-instances']);
      assert.ok(!JSON.stringify(error).includes('CALFLEX_BODY_MARKER'));
      return true;
    },
  );
});

test('parsePreconditions reads only well-formed cf: names out of a DAV:error', () => {
  /** @param {string} children @returns {string} */
  /** @param {string} children @returns {string} */
  const wrap = (children) => `<d:error xmlns:d="DAV:">${children}</d:error>`;
  const caldav = 'xmlns:cf="https://flexcalendar.de/ns/caldav"';
  assert.deepEqual(parsePreconditions(Buffer.from('')), []);
  assert.deepEqual(
    parsePreconditions(
      Buffer.from(wrap(`<cf:unmapped-collection ${caldav}/>`)),
    ),
    ['cf:unmapped-collection'],
  );
  assert.deepEqual(
    parsePreconditions(
      Buffer.from(
        wrap(
          `<cf:private-skeleton-only ${caldav}><cf:name>X-ANYTHING</cf:name></cf:private-skeleton-only>`,
        ),
      ),
    ),
    ['cf:private-skeleton-only', 'X-ANYTHING'],
  );
  // A name outside the grammar is dropped rather than carried out.
  for (const name of [
    'summary',
    'A'.repeat(65),
    'SECRET MARKER',
    '\u00c4',
    '',
  ]) {
    assert.deepEqual(
      parsePreconditions(
        Buffer.from(
          wrap(
            `<cf:private-skeleton-only ${caldav}><cf:name>${name}</cf:name></cf:private-skeleton-only>`,
          ),
        ),
      ),
      ['cf:private-skeleton-only'],
    );
  }
  // The namespace is resolved, not the prefix: another namespace is ignored.
  assert.deepEqual(
    parsePreconditions(
      Buffer.from(
        wrap(
          '<cf:private-skeleton-only xmlns:cf="https://example.invalid/ns/caldav"/>',
        ),
      ),
    ),
    [],
  );
  // Only a DAV:error root is read at all.
  assert.deepEqual(
    parsePreconditions(
      Buffer.from(
        `<d:multistatus xmlns:d="DAV:"><cf:private-skeleton-only ${caldav}/></d:multistatus>`,
      ),
    ),
    [],
  );
  assert.deepEqual(
    parsePreconditions(Buffer.from('not xml at all MARKER')),
    [],
  );
  // A hostile body never turns into a precondition name.
  const hostile = wrap(
    `<cf:private-skeleton-only ${caldav}><cf:name>SUMMARY</cf:name></cf:private-skeleton-only><cf:x>SUMMARY:CALFLEX_MARKER</cf:x>`,
  );
  assert.deepEqual(parsePreconditions(Buffer.from(hostile)), [
    'cf:private-skeleton-only',
    'SUMMARY',
    'cf:x',
  ]);
});

test('parsePreconditions reports RFC 4791 max-instances and nothing else of the CalDAV namespace', () => {
  /** @param {string} children @returns {string} */
  const wrap = (children) => `<d:error xmlns:d="DAV:">${children}</d:error>`;
  const caldav = 'xmlns:C="urn:ietf:params:xml:ns:caldav"';
  assert.equal(MAX_INSTANCES_PRECONDITION, 'C:max-instances');
  assert.deepEqual(
    parsePreconditions(Buffer.from(wrap(`<C:max-instances ${caldav}/>`))),
    ['C:max-instances'],
  );
  // The prefix is irrelevant: the namespace is what is read, so a body that
  // spells it `cal:` or `x:` is the same precondition.
  for (const prefix of ['cal', 'x']) {
    assert.deepEqual(
      parsePreconditions(
        Buffer.from(
          wrap(
            `<${prefix}:max-instances xmlns:${prefix}="urn:ietf:params:xml:ns:caldav"/>`,
          ),
        ),
      ),
      ['C:max-instances'],
    );
  }
  // Its text and its attributes are never read, so a hostile body cannot leave
  // through them.
  assert.deepEqual(
    parsePreconditions(
      Buffer.from(
        wrap(
          `<C:max-instances ${caldav} marker="CALFLEX_BODY_MARKER">CALFLEX_BODY_MARKER</C:max-instances>`,
        ),
      ),
    ),
    ['C:max-instances'],
  );
  // Another namespace's `max-instances` is not the precondition — and ours is
  // still read as the `cf:` element it is, never as the RFC's.
  assert.deepEqual(
    parsePreconditions(
      Buffer.from(
        wrap('<m:max-instances xmlns:m="https://example.invalid/ns"/>'),
      ),
    ),
    [],
  );
  assert.deepEqual(
    parsePreconditions(
      Buffer.from(
        wrap('<m:max-instances xmlns:m="https://flexcalendar.de/ns/caldav"/>'),
      ),
    ),
    ['cf:max-instances'],
  );
  // Only a `DAV:error` root is read at all.
  assert.deepEqual(
    parsePreconditions(
      Buffer.from(
        `<d:multistatus xmlns:d="DAV:"><C:max-instances ${caldav}/></d:multistatus>`,
      ),
    ),
    [],
  );
});

test('parsePreconditions reads a bounded, linear amount of a hostile body', () => {
  assert.equal(PRECONDITION_SCAN_LIMIT_BYTES, 16 * 1024);
  /** @param {string} unit @param {number} [bytes] */
  const repeated = (unit, bytes = 4 * 1024 * 1024) =>
    Buffer.from(unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes));
  // Both shapes are 4 MiB of an unfinished tag; neither may cost more than the
  // 16 KiB that is read, whatever the response cap allowed through.
  for (const unit of ['<a ', '<a x="']) {
    const started = performance.now();
    assert.deepEqual(parsePreconditions(repeated(unit)), []);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 500, `${JSON.stringify(unit)} took ${elapsed} ms`);
  }
  const caldav = 'xmlns:cf="https://flexcalendar.de/ns/caldav"';
  const document =
    `<d:error xmlns:d="DAV:"><cf:private-skeleton-only ${caldav}>` +
    '<cf:name>SUMMARY</cf:name></cf:private-skeleton-only></d:error>';
  // A document behind the limit is not read at all.
  assert.deepEqual(
    parsePreconditions(
      Buffer.from(`${' '.repeat(PRECONDITION_SCAN_LIMIT_BYTES)}${document}`),
    ),
    [],
  );
  // Junk behind a real precondition document, inside the limit, does not stop
  // it — an unfinished tag after the last one just ends the scan.
  const body = Buffer.from(`${document}\n${'<'.repeat(64)}not a tag`);
  assert.ok(body.length < PRECONDITION_SCAN_LIMIT_BYTES);
  assert.deepEqual(parsePreconditions(body), [
    'cf:private-skeleton-only',
    'SUMMARY',
  ]);
});

test('a hostile body never reaches the error', async () => {
  const marker = 'CALFLEX_BODY_MARKER_0123456789';
  const bodies = [
    `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x</d:href><d:responsedescription>${marker}</d:responsedescription></d:response></d:multistatus>`,
    `plain text ${marker}`,
    JSON.stringify({ error: marker }),
    `<d:error xmlns:d="DAV:"><cf:private-skeleton-only xmlns:cf="https://flexcalendar.de/ns/caldav"><cf:name>${marker}</cf:name></cf:private-skeleton-only></d:error>`,
  ];
  for (const body of bodies) {
    for (const status of [400, 403, 404, 500]) {
      const { adapter } = adapterFor(plain(status, body));
      await assert.rejects(
        () => adapter.forUser(USER).getObject(CALENDAR, 'one.ics'),
        (/** @type {CalDavError} */ error) => {
          const serialised = `${error.message}\n${error.stack ?? ''}\n${JSON.stringify(error)}`;
          assert.ok(!serialised.includes(marker), serialised);
          return true;
        },
      );
    }
  }
});

test('a tsdav protocol failure becomes a body-free error', async () => {
  // XML tsdav cannot parse makes it throw an error whose message quotes the
  // response; the adapter replaces it with a fixed, body-free one.
  const marker = 'CALFLEX_PARSE_MARKER';
  const { adapter } = adapterFor(
    () =>
      new Response(marker, {
        status: 207,
        headers: { 'content-type': 'application/xml; charset=utf-8' },
      }),
  );
  await assert.rejects(
    () =>
      adapter.forUser(USER).listObjects(CALENDAR, {
        start: '20260101T000000Z',
        end: '20260201T000000Z',
      }),
    (/** @type {CalDavError} */ error) => {
      assert.equal(error.kind, 'protocol');
      assert.ok(!error.message.includes(marker));
      return true;
    },
  );
});

test('a redirect is an error and is never followed', async () => {
  const { adapter, calls } = adapterFor(
    () =>
      new Response('', {
        status: 302,
        headers: { location: 'http://elsewhere.invalid/' },
      }),
  );
  await assert.rejects(
    () => adapter.forUser(USER).getObject(CALENDAR, 'one.ics'),
    (/** @type {CalDavError} */ error) => {
      assert.equal(error.kind, 'redirect');
      assert.equal(error.status, 302);
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'manual');
});

test('an oversized response fails instead of being read into memory', async () => {
  const { adapter } = adapterFor(
    () => new Response('x'.repeat(5000), { status: 200 }),
    {
      limit: 1024,
    },
  );
  await assert.rejects(
    () => adapter.forUser(USER).getObject(CALENDAR, 'one.ics'),
    (/** @type {CalDavError} */ error) => {
      assert.equal(error.kind, 'oversize');
      return true;
    },
  );
});

test('a request that outlives its deadline is a timeout', async () => {
  /** @param {URL} url @param {any} init @returns {any} */
  const never = (url, init) =>
    new Promise((_resolve, reject) => {
      /** @type {AbortSignal} */ (init.signal).addEventListener('abort', () =>
        reject(/** @type {AbortSignal} */ (init.signal).reason),
      );
    });
  const { adapter, calls } = adapterFor(never, { timeout: 25 });
  await assert.rejects(
    () => adapter.forUser(USER).getObject(CALENDAR, 'one.ics'),
    (/** @type {CalDavError} */ error) => {
      assert.equal(error.kind, 'timeout');
      assert.equal(error.status, null);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test('a transport failure is a network error without the address', async () => {
  const { adapter } = adapterFor(() => {
    throw Object.assign(new TypeError('fetch failed'), {
      cause: new Error(`connect ECONNREFUSED ${ORIGIN}`),
    });
  });
  await assert.rejects(
    () => adapter.forUser(USER).getObject(CALENDAR, 'one.ics'),
    (/** @type {CalDavError} */ error) => {
      assert.equal(error.kind, 'network');
      assert.ok(!error.message.includes(ORIGIN));
      assert.ok(!String(error.stack).includes(ORIGIN));
      return true;
    },
  );
});
