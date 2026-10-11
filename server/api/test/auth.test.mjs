// --- E05-R01: OIDC bearer auth over real HTTP --------------------------------
//
// Every token here is signed by the stub identity provider in
// `test/support/idp.mjs` and validated against the JWKS that stub serves —
// never by Zitadel. The API is a real child process talking real sockets, so
// the header parsing, the discovery/JWKS/userinfo calls and the `users` row
// behaviour are all exercised, not inferred.
//
// Postgres is not involved: `test/auth-db.test.mjs` covers the real `users`
// table through `support/postgres.mjs`.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startIdp } from './support/idp.mjs';

const apiDirectory = fileURLToPath(new URL('..', import.meta.url));

/**
 * @param {string} base
 * @param {string} path
 * @param {{method?: string, headers?: Record<string, string | string[]>}} [options]
 */
function request(base, path, { method = 'GET', headers = {} } = {}) {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const sent = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      (response) => {
        /** @type {Buffer[]} */
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    sent.on('error', reject);
    sent.end();
  });
}

/** @param {string} token */
const bearer = (token) => ({ authorization: `Bearer ${token}` });

/**
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string | undefined>} env
 */
async function startApi(t, env) {
  const child = spawn(process.execPath, ['test/support/serve.mjs'], {
    cwd: apiDirectory,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const baseUrl = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error('API readiness timed out')),
      5000,
    );
    timer.unref();
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = /listening on (http:\/\/\S+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on('exit', () => reject(new Error('API exited before readiness')));
  });
  t.after(() => child.kill());
  return { baseUrl, stderr: () => stderr };
}

/** @param {import('node:test').TestContext} t @param {{audience?: string}} [options] */
async function startStack(t, { audience = 'project-id' } = {}) {
  const idp = await startIdp();
  t.after(() => idp.close());
  const api = await startApi(t, {
    CALFLEX_OIDC_ISSUER: idp.issuer,
    CALFLEX_OIDC_BASE_URL: idp.baseUrl,
    CALFLEX_OIDC_AUDIENCE: audience,
  });
  return {
    idp,
    api,
    /** @type {(path: string, options?: any) => Promise<any>} */
    call: (path, options = {}) => request(api.baseUrl, path, options),
  };
}

/**
 * The one 401: same status, body and headers for every reason.
 * @param {any} response
 */
function refused(response) {
  assert.equal(response.status, 401, response.body);
  assert.deepEqual(JSON.parse(response.body), { error: 'unauthorized' });
  assert.equal(response.headers['www-authenticate'], 'Bearer');
  assert.equal(response.headers['cache-control'], 'no-store');
}

/** @param {{status: number | undefined, body: string, headers: Record<string, any>}} response */
const signature = (response) =>
  JSON.stringify([
    response.status,
    response.body,
    response.headers['www-authenticate'],
    response.headers['cache-control'],
  ]);

test('a seeded user’s token is accepted, and the first sight creates the row', async (t) => {
  const { idp, api, call } = await startStack(t);

  // The store already has this subject: no userinfo call, 200 straight away.
  const seeded = await call('/me', { headers: bearer(idp.token()) });
  assert.equal(seeded.status, 200, seeded.body);
  const alice = JSON.parse(seeded.body);
  assert.deepEqual(Object.keys(alice).sort(), ['email', 'handle', 'id']);
  assert.equal(alice.handle, 'alice');
  assert.equal(alice.email, 'alice@example.test');
  assert.equal(idp.calls.userinfo, 0);

  // A subject nobody has seen: userinfo is consulted once, then the row exists.
  idp.setUserinfo({
    sub: 'fresh-subject',
    email_verified: true,
    preferred_username: 'Fresh User',
    email: 'fresh@example.test',
  });
  const fresh = idp.token({ sub: 'fresh-subject' });
  const first = await call('/me', { headers: bearer(fresh) });
  assert.equal(first.status, 200, first.body);
  assert.equal(idp.calls.userinfo, 1);
  const created = JSON.parse(first.body);
  assert.equal(created.handle, 'Fresh User');
  assert.equal(created.email, 'fresh@example.test');
  assert.match(created.id, /^[0-9a-f-]{36}$/);

  // The second request finds that row: same id, and no second userinfo call.
  const second = await call('/me', { headers: bearer(fresh) });
  assert.equal(second.status, 200, second.body);
  assert.deepEqual(JSON.parse(second.body), created);
  assert.equal(idp.calls.userinfo, 1);

  // Discovery and JWKS went to the base URL, and carried the issuer's Host.
  assert.ok(
    idp.requests.some(
      (entry) => entry.path === '/.well-known/openid-configuration',
    ),
  );
  assert.ok(idp.requests.some((entry) => entry.path === '/oauth/v2/keys'));
  assert.ok(idp.requests.every((entry) => entry.host === 'auth.example.test'));

  // Nothing about the token reached stderr, and the response carries none of it.
  assert.equal(api.stderr(), '');
  assert.ok(!first.body.includes(fresh.split('.')[1]));
});

test('every malformed, forged or expired token is the same 401', async (t) => {
  const { idp, api, call } = await startStack(t);
  const before = idp.calls.userinfo;
  const now = Math.floor(Date.now() / 1000);
  const unknown = idp.unknownKey();

  const cases = {
    'no header': undefined,
    'empty header': '',
    'wrong scheme': 'Basic ',
    broken: 'Bearer not-a-jwt',
    opaque: `Bearer ${Buffer.alloc(32, 3).toString('base64url')}`,
    'two segments': 'Bearer a.b',
    'four segments': 'Bearer a.b.c.d',
    padding: 'Bearer a.b.c=',
    'too long': `Bearer a.a.${'a'.repeat(9000)}`,
    expired: `Bearer ${idp.token({ exp: now - 3600 })}`,
    'not before in the future': `Bearer ${idp.token({ nbf: now + 3600 })}`,
    'wrong audience': `Bearer ${idp.token({ aud: 'another-project' })}`,
    'no audience': `Bearer ${idp.token({ aud: undefined })}`,
    'alg none': `Bearer ${idp.token({}, { alg: 'none' })}`,
    'HS256 with the public key bytes': `Bearer ${idp.token({}, { alg: 'HS256', secret: String(idp.publicKeyBytes()) })}`,
    'signed by an unpublished key': `Bearer ${idp.token({}, { key: unknown })}`,
    'wrong signer for a served kid': `Bearer ${idp.token({}, { key: unknown, alg: 'RS256' })}`,
    'wrong issuer': `Bearer ${idp.token({ iss: 'https://elsewhere.example.test' })}`,
    'missing subject': `Bearer ${idp.token({ sub: undefined })}`,
  };

  /** @type {string | undefined} */
  let expected;
  for (const [name, header] of Object.entries(cases)) {
    const token = header?.slice(7);
    const response = await call('/me', {
      headers: header === undefined ? {} : { authorization: header },
    });
    assert.equal(response.status, 401, `${name}: ${response.body}`);
    refused(response);
    const seen = signature(response);
    if (expected === undefined) expected = seen;
    assert.equal(seen, expected, `${name} answered differently`);
    if (token && token.length < 9000)
      assert.ok(!response.body.includes(token), `${name} echoed its token`);
  }

  // Two Authorization headers are refused, not merged into one token.
  const duplicated = await call('/me', {
    headers: {
      authorization: [`Bearer ${idp.token()}`, `Bearer ${idp.token()}`],
    },
  });
  refused(duplicated);

  // A token in the query string is never read.
  const fromQuery = await call(
    `/me?access_token=${idp.token({ sub: 'known-subject' })}`,
  );
  refused(fromQuery);

  // None of these reached userinfo (no first sight on a 401 path).
  assert.equal(idp.calls.userinfo, before);
  // …and none of them reached stderr either.
  assert.equal(api.stderr(), '');
});

test('JWKS rotation is applied without a restart, and unknown kids cannot flood it', async (t) => {
  const { idp, call } = await startStack(t);

  const first = await call('/me', { headers: bearer(idp.token()) });
  assert.equal(first.status, 200, first.body);
  const fetches = idp.calls.jwks;

  // The stub rotates and the old key is gone from its JWKS.
  const rotated = idp.rotate('key-rotated');
  const afterRotation = await call('/me', {
    headers: bearer(idp.token({ sub: 'known-subject' }, { key: rotated })),
  });
  assert.equal(afterRotation.status, 200, afterRotation.body);
  assert.equal(idp.calls.jwks, fetches + 1);

  // A flood of unknown kids refetches at most once in the window.
  const before = idp.calls.jwks;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await call('/me', {
      headers: bearer(
        idp.token({}, { key: idp.unknownKey(`nope-${attempt}`) }),
      ),
    });
    assert.equal(response.status, 401);
  }
  assert.ok(
    idp.calls.jwks - before <= 1,
    `unknown kids caused ${idp.calls.jwks - before} refetches`,
  );
});

test('a first sight that is refused creates no row', async (t) => {
  const { idp, api, call } = await startStack(t);

  // An unverified email is a 403.
  idp.setUserinfo({
    sub: 'pending',
    email_verified: false,
    preferred_username: 'pending',
    email: 'pending@example.test',
  });
  const unverified = await call('/me', {
    headers: bearer(idp.token({ sub: 'pending' })),
  });
  assert.equal(unverified.status, 403, unverified.body);

  // The same subject, now verified, still needs userinfo: no row was created.
  idp.setUserinfo({
    sub: 'pending',
    email_verified: true,
    preferred_username: 'pending',
    email: 'pending@example.test',
  });
  const accepted = await call('/me', {
    headers: bearer(idp.token({ sub: 'pending' })),
  });
  assert.equal(accepted.status, 200, accepted.body);
  assert.equal(idp.calls.userinfo, 2);

  // userinfo answering about somebody else is a 502.
  idp.setUserinfo({
    sub: 'somebody-else',
    email_verified: true,
    preferred_username: 'mallory',
    email: 'mallory@example.test',
  });
  const mismatched = await call('/me', {
    headers: bearer(idp.token({ sub: 'mismatch' })),
  });
  assert.equal(mismatched.status, 502, mismatched.body);
  assert.deepEqual(JSON.parse(mismatched.body), { error: 'bad_gateway' });

  // userinfo being down is a 502 too.
  idp.setUserinfo(() => undefined);
  const down = await call('/me', {
    headers: bearer(idp.token({ sub: 'unreachable' })),
  });
  assert.equal(down.status, 502, down.body);

  // None of those three subjects has a row: a later valid first sight for one
  // of them calls userinfo again.
  idp.setUserinfo({
    sub: 'mismatch',
    email_verified: true,
    preferred_username: 'mismatch',
    email: 'mismatch@example.test',
  });
  const retried = await call('/me', {
    headers: bearer(idp.token({ sub: 'mismatch' })),
  });
  assert.equal(retried.status, 200, retried.body);

  // A handle or email that is already taken is a 409.
  idp.setUserinfo({
    sub: 'duplicate-email',
    email_verified: true,
    preferred_username: 'bob-two',
    email: 'BOB@example.test',
  });
  const conflict = await call('/me', {
    headers: bearer(idp.token({ sub: 'duplicate-email' })),
  });
  assert.equal(conflict.status, 409, conflict.body);
  assert.deepEqual(JSON.parse(conflict.body), { error: 'conflict' });

  assert.equal(api.stderr(), '');
});

test('two simultaneous first requests create one row', async (t) => {
  const { idp, call } = await startStack(t);
  const token = idp.token({ sub: 'race-subject' });
  const [left, right] = await Promise.all([
    call('/me', { headers: bearer(token) }),
    call('/me', { headers: bearer(token) }),
  ]);
  assert.equal(left.status, 200, left.body);
  assert.equal(right.status, 200, right.body);
  assert.equal(JSON.parse(left.body).id, JSON.parse(right.body).id);
  assert.equal(idp.calls.userinfo, 2);
});

test('without a configured audience everything but the health probe is 503', async (t) => {
  const { idp, call } = await startStack(t, { audience: '' });

  const health = await call('/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { status: 'ok', service: 'api' });

  // A perfectly good token is refused with 503: never accepted, and never a
  // 401 either, because nothing about the token was even examined.
  const unconfigured = await call('/me', { headers: bearer(idp.token()) });
  assert.equal(unconfigured.status, 503, unconfigured.body);
  assert.deepEqual(JSON.parse(unconfigured.body), { error: 'unavailable' });
  assert.equal(idp.calls.userinfo, 0);
});

test('the health probe is exempt for GET and HEAD, and nothing else is', async (t) => {
  const { idp, call } = await startStack(t);
  const head = await call('/healthz', { method: 'HEAD' });
  assert.equal(head.status, 200);
  const wrongMethod = await call('/healthz', { method: 'POST' });
  assert.equal(wrongMethod.status, 401);
  const unknownRoute = await call('/not-a-route');
  assert.equal(unknownRoute.status, 401);
  const unknownRouteWithToken = await call('/not-a-route', {
    headers: bearer(idp.token()),
  });
  assert.equal(unknownRouteWithToken.status, 404);
  assert.equal(idp.calls.userinfo, 0);
});
