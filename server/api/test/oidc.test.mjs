// --- E05-R01: the OIDC client's own boundaries (no API, no Zitadel) ----------
//
// `createOidcClient` takes its transport (`request`) and its clock (`now`), so
// the rules that a green end-to-end run never reaches are tested directly: a
// failed refresh must not throw away working keys, discovery may not point at
// another origin or another issuer, unusable JWKs are ignored rather than
// attempted, and `getJson` refuses a non-2xx status, an oversized body and a
// redirect. Tokens are signed by the stub IdP's key — never by Zitadel.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  KEY_TTL_MS,
  MAX_BODY_BYTES,
  UnavailableError,
  createOidcClient,
  getJson,
} from '../src/oidc.mjs';
import { AUDIENCE, ISSUER, startIdp } from './support/idp.mjs';

/** The discovery document the injected transport answers with. */
const discovery = (overrides = {}) => ({
  issuer: ISSUER,
  jwks_uri: `${ISSUER}/oauth/v2/keys`,
  userinfo_endpoint: `${ISSUER}/oidc/v1/userinfo`,
  ...overrides,
});

test('a failed JWKS refresh after the key TTL keeps the cached keys', async (t) => {
  const idp = await startIdp();
  t.after(() => idp.close());
  let clock = 0;
  let discoveryCalls = 0;
  let jwksCalls = 0;
  const client = createOidcClient({
    issuer: ISSUER,
    request: async (url) => {
      if (String(url).includes('openid-configuration')) {
        discoveryCalls += 1;
        return discovery();
      }
      jwksCalls += 1;
      // The first fetch is the good one; every later one is an outage.
      if (jwksCalls > 1) throw new Error('identity provider request failed');
      return { keys: [idp.key().jwk] };
    },
    now: () => clock,
  });
  const token = idp.token();

  assert.equal((await client.verify(token, AUDIENCE)).sub, 'known-subject');
  assert.equal(jwksCalls, 1);

  // Inside the TTL an outage is invisible: nothing is fetched at all.
  clock += KEY_TTL_MS - 1;
  await client.verify(token, AUDIENCE);
  assert.equal(jwksCalls, 1);
  assert.equal(discoveryCalls, 1);

  // Past it the refresh is attempted and fails; the cached key still verifies,
  // so a Postgres-sized blip in the IdP does not start refusing valid tokens.
  clock += 1;
  assert.equal((await client.verify(token, AUDIENCE)).sub, 'known-subject');
  assert.equal(jwksCalls, 2);

  // A key that was never cached is still refused after that same outage.
  await assert.rejects(
    client.verify(idp.token({}, { key: idp.unknownKey('gone') }), AUDIENCE),
    /signature|key/i,
  );
});

test('discovery that names another issuer is refused, and its JWKS is never fetched', async (t) => {
  const idp = await startIdp();
  t.after(() => idp.close());
  /** @type {string[]} */
  const requested = [];
  const client = createOidcClient({
    issuer: ISSUER,
    request: async (url) => {
      requested.push(String(url));
      return discovery({ issuer: 'https://elsewhere.example.test' });
    },
    now: () => 0,
  });
  await assert.rejects(client.verify(idp.token(), AUDIENCE), UnavailableError);
  assert.equal(requested.length, 1, `fetched ${requested.join(', ')}`);
});

test('discovery cannot point at another origin, for the JWKS or for userinfo', async (t) => {
  const idp = await startIdp();
  t.after(() => idp.close());
  /** @type {string[]} */
  const requested = [];
  /** @param {any} document */
  const client = (document) =>
    createOidcClient({
      issuer: ISSUER,
      request: async (url) => {
        requested.push(String(url));
        return String(url).includes('openid-configuration')
          ? document
          : { keys: [idp.key().jwk] };
      },
      now: () => 0,
    });

  await assert.rejects(
    client(discovery({ jwks_uri: 'https://evil.example.test/keys' })).verify(
      idp.token(),
      AUDIENCE,
    ),
    UnavailableError,
  );
  await assert.rejects(
    client(
      discovery({ userinfo_endpoint: 'https://evil.example.test/userinfo' }),
    ).userinfo(idp.token()),
    /cross-origin endpoint/,
  );
  // Neither document was acted on: only the two discovery calls were made.
  assert.deepEqual(requested, [
    `${ISSUER}/.well-known/openid-configuration`,
    `${ISSUER}/.well-known/openid-configuration`,
  ]);
});

test('JWKs that are not an RSA RS256 signing key are ignored, not attempted', async (t) => {
  const idp = await startIdp();
  t.after(() => idp.close());
  const good = idp.key().jwk;
  // A different key that claims the *same* `kid` as the real one: an entry the
  // client must not accept is only observable if accepting it would shadow the
  // real key, so these all carry `kid: 'key-a'` and different key material.
  const impostor = idp.unknownKey(good.kid).jwk;
  const unusable = [
    // Not RSA, and jose will happily import this one for RS256 — only the
    // `kty` filter keeps it out of the key map.
    { kty: 'oct', k: Buffer.alloc(32, 7).toString('base64url'), kid: good.kid },
    { ...good, kty: 'EC', crv: 'P-256' },
    // No `kid` at all: nothing can select it.
    { ...good, kid: undefined },
    // An encryption key, not a signing key.
    { ...impostor, use: 'enc' },
    // A different algorithm than the allow-list.
    { ...impostor, alg: 'RS512' },
  ];
  /** @param {any[]} keys */
  const client = (keys) =>
    createOidcClient({
      issuer: ISSUER,
      request: async (url) =>
        String(url).includes('openid-configuration') ? discovery() : { keys },
      now: () => 0,
    });

  // Unusable keys only: the client has no usable key at all, so it is 503-shaped.
  await assert.rejects(
    client(unusable).verify(idp.token(), AUDIENCE),
    UnavailableError,
  );
  // A usable key first, then the impostors: the real key must still be the one
  // that verifies, i.e. the unusable entries were dropped rather than imported
  // over it.
  const claims = await client([good, ...unusable]).verify(
    idp.token(),
    AUDIENCE,
  );
  assert.equal(claims.sub, 'known-subject');
  // …and in the other order, an impostor must not add itself under a new name.
  await assert.rejects(
    client([...unusable, impostor]).verify(idp.token(), AUDIENCE),
    /signature|key/i,
  );
});

test('getJson refuses a non-2xx status, an oversized body and a redirect', async (t) => {
  // 1 MiB of JSON, a little over the cap once the quoting is added.
  const oversized = JSON.stringify({ data: 'x'.repeat(MAX_BODY_BYTES) });
  const server = createServer((request, response) => {
    // A client that abandons an oversized body resets the socket; that is the
    // point of the cap, not a failure of this stub.
    response.on('error', () => {});
    const send = (/** @type {number} */ status, /** @type {string} */ body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body);
    };
    if (request.url === '/ok') return send(200, '{"ok":true}');
    if (request.url === '/error') return send(500, '{}');
    if (request.url === '/big') return send(200, oversized);
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/ok' });
      response.end();
      return;
    }
    send(404, '{}');
  });
  server.on('clientError', () => {});
  await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  t.after(
    () => new Promise((resolve) => server.close(() => resolve(undefined))),
  );
  const address = /** @type {import('node:net').AddressInfo} */ (
    server.address()
  );
  const base = `http://127.0.0.1:${address.port}`;

  assert.deepEqual(await getJson(`${base}/ok`), { ok: true });
  await assert.rejects(getJson(`${base}/error`), /request failed/);
  await assert.rejects(getJson(`${base}/big`), /too large/);
  // A 3xx is not success: the client never follows a redirect.
  await assert.rejects(getJson(`${base}/redirect`), /request failed/);
  await assert.rejects(getJson(`${base}/missing`), /request failed/);
});
