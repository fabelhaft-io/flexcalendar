// --- E05-R01: the global rate limiter (no network, no Postgres) --------------
//
// The limiter is one `onRequest` hook installed ahead of the bearer hook, so a
// flood of invalid tokens is counted before any of them is verified. These
// tests drive the real `buildApp` through `inject`, with an IdP stub whose
// `verify` counts its calls — the order is observable there and nowhere else.
// The bucket key is the client address, which is why the proxy-hop tests
// matter: `X-Forwarded-For` must only be believed when we know a proxy set it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.mjs';
import { readConfig } from '../src/config.mjs';
import { assertProblem } from './support/problem.mjs';

const ISSUER = 'https://auth.example.test';
const AUDIENCE = 'project-id';
/** The one token the stub verifier accepts. */
const TOKEN = 'aaa.bbb.ccc';
/** Three base64url segments, so the API rejects it without a call anywhere. */
const BAD_TOKEN = 'xxx.yyy.zzz';

/**
 * The store these tests need: one existing row, so a valid token answers 200
 * without a userinfo call. Whether first sight creates a row is
 * `test/auth.test.mjs`'s subject.
 */
const store = {
  /** @param {string} subject */
  async findBySubject(subject) {
    return subject === 'known-subject'
      ? {
          id: '11111111-1111-4111-8111-111111111111',
          handle: 'alice',
          email: 'alice@example.test',
        }
      : undefined;
  },
  async createFirstSight() {
    throw new Error('first sight is not part of the rate limiter');
  },
};

/** @param {Record<string, string>} [env] */
const config = (env = {}) =>
  readConfig({
    CALFLEX_OIDC_ISSUER: ISSUER,
    CALFLEX_OIDC_BASE_URL: ISSUER,
    CALFLEX_OIDC_AUDIENCE: AUDIENCE,
    ...env,
  });

/** A verifier that accepts one token and counts how often it was asked. */
function countingOidc() {
  const oidc = {
    calls: 0,
    /** @param {string} token */
    async verify(token) {
      oidc.calls += 1;
      if (token === TOKEN) return { sub: 'known-subject' };
      throw new Error('invalid token');
    },
    async userinfo() {
      throw new Error('userinfo is not part of the rate limiter');
    },
  };
  return oidc;
}

/** The audience never changes here; these tests are not about the file. */
const audience = {
  async current() {
    return AUDIENCE;
  },
  async refresh() {
    return false;
  },
};

/**
 * An app with a real limiter, a counting verifier and one known user, so a
 * valid token answers 200 without touching userinfo.
 * @param {Record<string, string>} [env]
 * @param {ReturnType<typeof countingOidc>} [oidc]
 */
function build(env = {}, oidc = countingOidc()) {
  return buildApp({ config: config(env), oidc, audience, store });
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{path?: string, token?: string, remoteAddress?: string, headers?: Record<string, string>, method?: import('fastify').HTTPMethods}} [options]
 * @returns {Promise<{statusCode: number, headers: Record<string, any>, body: string, json: () => any}>}
 */
async function call(
  app,
  {
    path = '/me',
    token = TOKEN,
    remoteAddress = '10.0.0.1',
    headers = {},
    method = 'GET',
  } = {},
) {
  const response = await app.inject(
    /** @type {any} */ ({
      url: path,
      method,
      remoteAddress,
      headers:
        token === ''
          ? headers
          : { authorization: `Bearer ${token}`, ...headers },
    }),
  );
  return /** @type {any} */ (response);
}

/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a flood of bad tokens is counted before any of them is verified', async () => {
  const oidc = countingOidc();
  const app = build({ CALFLEX_RATE_LIMIT_MAX: '3' }, oidc);

  /** @type {number[]} */
  const statuses = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    statuses.push((await call(app, { token: BAD_TOKEN })).statusCode);
  }

  // The fourth and fifth requests are refused by the limiter, which means the
  // limiter's hook ran before the hook that calls `verify`.
  assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
  assert.equal(oidc.calls, 3);
  await app.close();
});

test('a refused request is a 429 with Retry-After and the fixed body', async () => {
  const app = build({ CALFLEX_RATE_LIMIT_MAX: '1' });
  await call(app, { token: BAD_TOKEN });
  const refused = await call(app, { token: BAD_TOKEN });

  assert.equal(refused.statusCode, 429);
  // The fixed body, and only that: no counter, address or key in it, and not
  // the generic `request_failed` the error handler would otherwise send.
  assertProblem(refused.json(), 'rate-limited');
  assert.equal(refused.headers['retry-after'], '60');
  await app.close();
});

test('a valid token is refused past the limit, and a new window resets it', async () => {
  const oidc = countingOidc();
  const app = build(
    { CALFLEX_RATE_LIMIT_MAX: '1', CALFLEX_RATE_LIMIT_WINDOW_SECONDS: '1' },
    oidc,
  );

  const first = await call(app);
  assert.equal(first.statusCode, 200, first.body);

  const overLimit = await call(app);
  assert.equal(overLimit.statusCode, 429);
  assertProblem(overLimit.json(), 'rate-limited');
  assert.equal(oidc.calls, 1);

  // One window later the same client has its allowance back.
  await wait(1100);
  const afterWindow = await call(app);
  assert.equal(afterWindow.statusCode, 200, afterWindow.body);
  assert.equal(oidc.calls, 2);
  await app.close();
});

test('the health probe is never limited, and nothing else is exempt', async () => {
  const app = build({ CALFLEX_RATE_LIMIT_MAX: '1' });

  // More probes than the limit, with no token: the container health check
  // keeps working while a client is over its limit. HEAD is what the probe
  // uses when a container asks for headers only.
  for (const method of /** @type {import('fastify').HTTPMethods[]} */ ([
    'GET',
    'HEAD',
    'GET',
    'HEAD',
    'GET',
  ])) {
    const probe = await call(app, { path: '/healthz', token: '', method });
    assert.equal(probe.statusCode, 200, method);
  }

  // The exemption is GET/HEAD on exactly `/healthz`: a POST is authenticated
  // and counted, so the second one is refused.
  const wrongMethod = await call(app, {
    path: '/healthz',
    token: '',
    method: 'POST',
  });
  assert.equal(wrongMethod.statusCode, 401);
  const flood = await call(app, {
    path: '/healthz',
    token: '',
    method: 'POST',
  });
  assert.equal(flood.statusCode, 429);
  assertProblem(flood.json(), 'rate-limited');
  await app.close();
});

test('unknown paths are limited too, because the auth hook runs there', async () => {
  const app = build({ CALFLEX_RATE_LIMIT_MAX: '1' });
  const first = await call(app, { path: '/not-a-route', token: BAD_TOKEN });
  assert.equal(first.statusCode, 401);
  const second = await call(app, { path: '/not-a-route', token: BAD_TOKEN });
  assert.equal(second.statusCode, 429);
  await app.close();
});

test('each client address has its own bucket', async () => {
  const app = build({ CALFLEX_RATE_LIMIT_MAX: '1' });

  assert.equal(
    (await call(app, { token: BAD_TOKEN, remoteAddress: '10.0.0.1' }))
      .statusCode,
    401,
  );
  assert.equal(
    (await call(app, { token: BAD_TOKEN, remoteAddress: '10.0.0.1' }))
      .statusCode,
    429,
  );
  assert.equal(
    (await call(app, { token: BAD_TOKEN, remoteAddress: '10.0.0.2' }))
      .statusCode,
    401,
  );
  await app.close();
});

test('without a trusted hop a forged X-Forwarded-For does not select a bucket', async () => {
  const app = build({ CALFLEX_RATE_LIMIT_MAX: '1' });

  assert.equal(
    (
      await call(app, {
        token: BAD_TOKEN,
        headers: { 'x-forwarded-for': '9.9.9.9' },
      })
    ).statusCode,
    401,
  );
  // The same socket, a "different" forged client: one bucket, so 429.
  assert.equal(
    (
      await call(app, {
        token: BAD_TOKEN,
        headers: { 'x-forwarded-for': '8.8.8.8' },
      })
    ).statusCode,
    429,
  );
  await app.close();
});

test('with one trusted hop X-Forwarded-For selects the bucket', async () => {
  const app = build({
    CALFLEX_RATE_LIMIT_MAX: '1',
    CALFLEX_TRUSTED_PROXY_HOPS: '1',
  });
  /** @param {string} address */
  const client = async (address) =>
    (
      await call(app, {
        token: BAD_TOKEN,
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': address },
      })
    ).statusCode;

  assert.equal(await client('9.9.9.9'), 401);
  // A second client through the same proxy has its own allowance.
  assert.equal(await client('8.8.8.8'), 401);
  assert.equal(await client('9.9.9.9'), 429);
  await app.close();
});

test('the limiter settings are validated at startup', () => {
  for (const value of ['three', '0', '-1', '1.5', '300 requests']) {
    assert.throws(
      () => config({ CALFLEX_RATE_LIMIT_MAX: value }),
      /CALFLEX_RATE_LIMIT_MAX/,
      `CALFLEX_RATE_LIMIT_MAX=${value} must not be accepted`,
    );
    assert.throws(
      () => config({ CALFLEX_RATE_LIMIT_WINDOW_SECONDS: value }),
      /CALFLEX_RATE_LIMIT_WINDOW_SECONDS/,
      `CALFLEX_RATE_LIMIT_WINDOW_SECONDS=${value} must not be accepted`,
    );
  }
  for (const value of ['-1', '1.5', 'one']) {
    assert.throws(
      () => config({ CALFLEX_TRUSTED_PROXY_HOPS: value }),
      /CALFLEX_TRUSTED_PROXY_HOPS/,
    );
  }

  // The defaults, and the boundaries that are allowed.
  const defaults = config();
  assert.equal(defaults.rateLimitMax, 300);
  assert.equal(defaults.rateLimitWindowSeconds, 60);
  assert.equal(defaults.trustedProxyHops, 0);
  assert.equal(config({ CALFLEX_RATE_LIMIT_MAX: '1' }).rateLimitMax, 1);
  assert.equal(config({ CALFLEX_TRUSTED_PROXY_HOPS: '2' }).trustedProxyHops, 2);
});
