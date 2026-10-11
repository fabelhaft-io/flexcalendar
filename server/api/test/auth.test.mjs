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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startIdp } from './support/idp.mjs';
import { assertProblem } from './support/problem.mjs';

const apiDirectory = fileURLToPath(new URL('..', import.meta.url));

/**
 * The path is sent verbatim, never through `new URL(path, base)`: `//healthz`
 * would become a protocol-relative URL to host `healthz`, and the point of
 * those cases is what the API does with the raw request-target.
 * @param {string} base
 * @param {string} path
 * @param {{method?: string, headers?: Record<string, string | string[]>}} [options]
 */
function request(base, path, { method = 'GET', headers = {} } = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const sent = http.request(
      {
        host: url.hostname,
        port: url.port,
        path,
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

/**
 * @param {import('node:test').TestContext} t
 * @param {{audience?: string, env?: Record<string, string>}} [options]
 */
async function startStack(t, { audience = 'project-id', env = {} } = {}) {
  const idp = await startIdp();
  t.after(() => idp.close());
  const api = await startApi(t, {
    CALFLEX_OIDC_ISSUER: idp.issuer,
    CALFLEX_OIDC_BASE_URL: idp.baseUrl,
    // `audience: ''` leaves the variable empty, which `readConfig` trims to
    // "unset": the API then has no audience until the file says so.
    ...(audience === undefined ? {} : { CALFLEX_OIDC_AUDIENCE: audience }),
    ...env,
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
  assertProblem(JSON.parse(response.body), 'unauthorized');
  assert.equal(response.headers['www-authenticate'], 'Bearer');
  assert.equal(response.headers['cache-control'], 'no-store');
}

/** @param {{status: number | undefined, body: string, headers: Record<string, any>}} response */
const signature = (response) =>
  JSON.stringify([
    response.status,
    // The only per-request member is `instance`, the correlation ID: it is
    // normalised away so this compares everything a refusal could reveal.
    response.body.replace(
      /"instance":"urn:uuid:[0-9a-f-]+"/,
      '"instance":"urn:uuid:<request>"',
    ),
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
  assertProblem(JSON.parse(mismatched.body), 'bad-gateway');

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
  assertProblem(JSON.parse(conflict.body), 'conflict');

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
  assertProblem(JSON.parse(unconfigured.body), 'unavailable');
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

test('the exemption is the exact path, never a prefix or a normalised spelling', async (t) => {
  const { call } = await startStack(t);
  for (const path of [
    '/healthz/',
    '/healthz/x',
    '//healthz',
    '/healthz;x',
    '/HEALTHZ',
    '/health',
    '/healthz/..',
    '/healthzz',
  ]) {
    const response = await call(path);
    assert.equal(response.status, 401, `${path}: ${response.body}`);
    refused(response);
  }
  // A query string does not change the path, so the probe still answers.
  const withQuery = await call('/healthz?x=1');
  assert.equal(withQuery.status, 200, withQuery.body);
  assert.deepEqual(JSON.parse(withQuery.body), {
    status: 'ok',
    service: 'api',
  });
});

test('the bearer scheme is case-insensitive, and only that scheme is read', async (t) => {
  const { idp, call } = await startStack(t);
  for (const scheme of ['bearer', 'BEARER', 'BeArEr']) {
    const response = await call('/me', {
      headers: { authorization: `${scheme} ${idp.token()}` },
    });
    assert.equal(response.status, 200, `${scheme}: ${response.body}`);
  }
  const other = await call('/me', {
    headers: { authorization: `Token ${idp.token()}` },
  });
  refused(other);
});

test('a malformed or opaque token never reaches the identity provider', async (t) => {
  // A fresh API and a fresh stub: no request of any kind may be made for a
  // token that is not three base64url segments of a bounded length. An opaque
  // token is refused, never introspected.
  const { idp, call } = await startStack(t);
  const headers = [
    'Bearer not-a-jwt',
    'Bearer a.b',
    'Bearer a.b.c.d',
    'Bearer a.b.c=',
    `Bearer ${Buffer.alloc(32, 3).toString('base64url')}`,
    `Bearer a.a.${'a'.repeat(9000)}`,
    `Bearer ${'x'.repeat(9000)}`,
    'Bearer \u00e4.\u00f6.\u00fc',
    `Bearer ${'a'.repeat(9000)}.b.c`,
    'Basic YWxpY2U6c2VjcmV0',
    'Bearer',
    'Bearer ',
  ];
  for (const header of headers) {
    const response = await call('/me', { headers: { authorization: header } });
    assert.equal(
      response.status,
      401,
      `${header.slice(0, 24)}: ${response.body}`,
    );
    refused(response);
    const token = header.slice(7);
    if (token)
      assert.ok(
        !response.body.includes(token),
        'the response echoed the token',
      );
  }
  assert.equal(idp.calls.discovery, 0, 'discovery was called');
  assert.equal(idp.calls.jwks, 0, 'the JWKS was fetched');
  assert.equal(idp.calls.userinfo, 0, 'userinfo was called');
  assert.deepEqual(idp.requests, []);
});

test('expiry, not-before and the subject are bounded, with a five-second tolerance', async (t) => {
  const { idp, call } = await startStack(t);
  const now = () => Math.floor(Date.now() / 1000);
  const accepted = new Set([
    'expires in 2 seconds',
    'not before 2 seconds ahead',
    'a 255-character subject',
  ]);
  const cases = {
    'expired 30 seconds ago': idp.token({ exp: now() - 30 }),
    'expires in 2 seconds': idp.token({ exp: now() + 2 }),
    'not before 30 seconds ahead': idp.token({ nbf: now() + 30 }),
    'not before 2 seconds ahead': idp.token({ nbf: now() + 2 }),
    'no expiry': idp.token({ exp: undefined }),
    'no not-before': idp.token({ nbf: undefined }),
    'a 255-character subject': idp.token({ sub: 's'.repeat(255) }),
    'a 256-character subject': idp.token({ sub: 's'.repeat(256) }),
  };
  for (const [name, token] of Object.entries(cases)) {
    const response = await call('/me', { headers: bearer(token) });
    if (accepted.has(name)) {
      assert.equal(response.status, 200, `${name}: ${response.body}`);
      continue;
    }
    assert.equal(response.status, 401, `${name}: ${response.body}`);
    refused(response);
  }
});

test('an identity provider outage is a 503 without cached keys, and harmless with them', async (t) => {
  const { idp, call } = await startStack(t);
  const token = idp.token();
  const accepted = await call('/me', { headers: bearer(token) });
  assert.equal(accepted.status, 200, accepted.body);

  // From here the IdP is gone: discovery, JWKS and userinfo all refuse.
  await idp.close();

  // Cached keys keep working, and no refetch is needed inside the TTL.
  const cached = await call('/me', { headers: bearer(token) });
  assert.equal(cached.status, 200, cached.body);

  // An unknown kid needs the JWKS, finds nothing, and is a plain 401 — an
  // outage must not turn a bad token into a 503 once keys are cached.
  const unknown = await call('/me', {
    headers: bearer(idp.token({}, { key: idp.unknownKey('not-served') })),
  });
  assert.equal(unknown.status, 401, unknown.body);
  refused(unknown);
});

test('with no cached keys an outage is a 503, never an accepted request', async (t) => {
  // The IdP is closed before the API ever starts: it has nothing cached.
  const idp = await startIdp();
  const { issuer, baseUrl, audience } = idp;
  const token = idp.token();
  await idp.close();
  const api = await startApi(t, {
    CALFLEX_OIDC_ISSUER: issuer,
    CALFLEX_OIDC_BASE_URL: baseUrl,
    CALFLEX_OIDC_AUDIENCE: audience,
  });
  const response = await request(api.baseUrl, '/me', {
    headers: bearer(token),
  });
  assert.equal(response.status, 503, response.body);
  assertProblem(JSON.parse(response.body), 'unavailable');
});

test('an audience file that changes after boot is picked up without a restart', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'calflex-audience-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'audience');
  await writeFile(target, 'stale-project\n');

  const { idp, call } = await startStack(t, {
    // No explicit audience: the API has to take it from the file alone.
    audience: '',
    env: { CALFLEX_OIDC_AUDIENCE_FILE: target },
  });

  // The file's value is the configured audience, so it is accepted.
  const stale = await call('/me', {
    headers: bearer(idp.token({ aud: 'stale-project' })),
  });
  assert.equal(stale.status, 200, stale.body);

  // `zitadel-config apply` rewrites the file. The API re-reads it on the next
  // audience mismatch — no restart, no container recreate.
  await writeFile(target, 'project-id\n');
  const fresh = await call('/me', { headers: bearer(idp.token()) });
  assert.equal(fresh.status, 200, fresh.body);

  // …and the audience that was replaced is refused from then on.
  const replaced = await call('/me', {
    headers: bearer(idp.token({ aud: 'stale-project' })),
  });
  assert.equal(replaced.status, 401, replaced.body);
  refused(replaced);
});

test('a blank or missing handle or email from userinfo is a 502 and creates nothing', async (t) => {
  const { idp, api, call } = await startStack(t);
  const cases = {
    'a blank handle': {
      sub: 'blank-handle',
      email_verified: true,
      preferred_username: '   ',
      email: 'blank-handle@example.test',
    },
    'a missing handle': {
      sub: 'missing-handle',
      email_verified: true,
      email: 'missing-handle@example.test',
    },
    'a blank email': {
      sub: 'blank-email',
      email_verified: true,
      preferred_username: 'blank-email',
      email: '\t\n',
    },
    'a missing email': {
      sub: 'missing-email',
      email_verified: true,
      preferred_username: 'missing-email',
    },
  };
  for (const [name, userinfo] of Object.entries(cases)) {
    idp.setUserinfo(userinfo);
    const response = await call('/me', {
      headers: bearer(idp.token({ sub: userinfo.sub })),
    });
    assert.equal(response.status, 502, `${name}: ${response.body}`);
    assertProblem(JSON.parse(response.body), 'bad-gateway');
  }

  // No row was created for any of them: a later well-formed first sight for the
  // same subject still runs, and succeeds.
  idp.setUserinfo({
    sub: 'blank-handle',
    email_verified: true,
    preferred_username: 'now-valid',
    email: 'now-valid@example.test',
  });
  const retried = await call('/me', {
    headers: bearer(idp.token({ sub: 'blank-handle' })),
  });
  assert.equal(retried.status, 200, retried.body);
  assert.equal(JSON.parse(retried.body).handle, 'now-valid');
  assert.equal(api.stderr(), '');
});
