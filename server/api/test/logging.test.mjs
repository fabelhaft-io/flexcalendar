// --- E05-R10: the error model and the request log ----------------------------
//
// Every test here drives the real `buildApp` through `inject`, with the log
// stream captured (`logger: { stream }`). Nothing needs a database, a network
// or a container: the stub verifier accepts one token by name, and the store is
// in memory. What the tests are actually about is what leaves the service —
// response headers, response bodies and log lines.
//
// The rule they exist to hold: a request-derived value (a path, a query value, a
// header, a token, a body) never reaches a log line or a response body, and
// every error is an RFC 9457 problem document.

import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';

import { buildApp } from '../src/app.mjs';
import { readConfig } from '../src/config.mjs';
import { PROBLEM_CONTENT_TYPE } from '../src/problem.mjs';
import {
  assertProblem,
  firstSchemaViolation,
  specProblemSchema,
} from './support/problem.mjs';

const ISSUER = 'https://auth.example.test';
const AUDIENCE = 'project-id';
const TOKEN = 'aaa.bbb.ccc';
/** The value that must never appear in a log line or a response body. */
const CANARY = 'CALFLEX-E05R10-LOG-CANARY';
const KNOWN_USER = {
  id: '11111111-1111-4111-8111-111111111111',
  handle: 'alice',
  email: 'alice@example.test',
};

/** @param {Record<string, string>} [env] */
const config = (env = {}) =>
  readConfig({
    CALFLEX_OIDC_ISSUER: ISSUER,
    CALFLEX_OIDC_BASE_URL: ISSUER,
    CALFLEX_OIDC_AUDIENCE: AUDIENCE,
    ...env,
  });

/** A verifier that accepts exactly one token. */
function stubOidc() {
  return {
    /** @param {string} token */
    async verify(token) {
      if (token !== TOKEN) throw new Error('invalid token');
      return { sub: 'known-subject' };
    },
    async userinfo() {
      throw new Error('userinfo is not part of these tests');
    },
  };
}

/** @param {Partial<{findBySubject: Function, createFirstSight: Function}>} [store] */
function stubStore(store = {}) {
  return {
    /** @param {string} subject */
    async findBySubject(subject) {
      return subject === 'known-subject' ? KNOWN_USER : undefined;
    },
    async createFirstSight() {
      throw new Error('first sight is not part of these tests');
    },
    ...store,
  };
}

const audience = {
  async current() {
    return AUDIENCE;
  },
  async refresh() {
    return false;
  },
};

/** A writable that keeps every log line, so a test can scan them. */
function captureLog() {
  /** @type {string[]} */
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return {
    stream,
    text: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').filter(Boolean),
    json: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

/**
 * @param {{logger?: any, store?: any, env?: Record<string, string>}} [options]
 */
function build({ logger, store, env } = {}) {
  const capture = captureLog();
  const app = buildApp({
    config: config(env),
    oidc: stubOidc(),
    audience,
    store: stubStore(store),
    logger: logger ?? { stream: capture.stream },
  });
  return { app, capture };
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{url?: string, method?: string, token?: string, headers?: Record<string, string>, payload?: string}} [options]
 */
async function call(
  app,
  { url = '/me', method = 'GET', token = TOKEN, headers = {}, payload } = {},
) {
  return /** @type {any} */ (
    await app.inject(
      /** @type {any} */ ({
        url,
        method,
        headers:
          token === ''
            ? headers
            : { authorization: `Bearer ${token}`, ...headers },
        payload,
      }),
    )
  );
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('every response carries a correlation ID, and an inbound one is only trusted when it is a v4 UUID', async () => {
  const { app, capture } = build();
  try {
    // Minted for a request that sent nothing.
    const minted = await call(app);
    assert.equal(minted.statusCode, 200, minted.body);
    const mintedId = minted.headers['x-request-id'];
    assert.match(String(mintedId), UUID_V4);

    // A valid v4 UUID is kept, byte for byte.
    const known = '8f14e45f-ceea-4a67-b0b6-3a3a4e62a1f2';
    const kept = await call(app, { headers: { 'x-request-id': known } });
    assert.equal(kept.headers['x-request-id'], known);

    // Anything else is replaced: uppercase, a v1 UUID, free text, a newline.
    for (const hostile of [
      '8F14E45F-CEEA-4A67-B0B6-3A3A4E62A1F2',
      '8f14e45f-ceea-1a67-b0b6-3a3a4e62a1f2',
      `${CANARY}\nlevel=error`,
      '',
    ]) {
      const replaced = await call(app, {
        headers: { 'x-request-id': hostile },
      });
      const id = String(replaced.headers['x-request-id']);
      assert.match(id, UUID_V4, `kept ${hostile}`);
      assert.notEqual(id, hostile);
    }

    // The refusals that never reach a route carry it too.
    const refused = await call(app, { token: 'xxx.yyy.zzz' });
    assert.equal(refused.statusCode, 401);
    assert.match(String(refused.headers['x-request-id']), UUID_V4);

    const unknown = await call(app, { url: '/not-a-route' });
    assert.equal(unknown.statusCode, 404);
    assert.match(String(unknown.headers['x-request-id']), UUID_V4);

    // …and the limiter's 429, which is thrown by an `onRequest` hook.
    const limited = build({ env: { CALFLEX_RATE_LIMIT_MAX: '1' } });
    try {
      assert.equal((await call(limited.app)).statusCode, 200);
      const flood = await call(limited.app);
      assert.equal(flood.statusCode, 429);
      assert.match(String(flood.headers['x-request-id']), UUID_V4);
    } finally {
      await limited.app.close();
    }

    // The logged correlation ID is the one the response carries.
    const line = capture.json().find((entry) => entry.msg === 'request');
    assert.ok(line, 'a request line was logged');
    assert.equal(typeof line.reqId, 'string');
    assert.match(line.reqId, UUID_V4);
  } finally {
    await app.close();
  }
});

test('no request-derived value reaches a log line or a response body', async () => {
  const { app, capture } = build();
  try {
    /** @type {[string, Record<string, any>, number][]} */
    const cases = [
      // [description, request, expected status]
      ['the path', { url: `/${CANARY}?x=1` }, 404],
      ['the query string', { url: `/me?secret=${CANARY}` }, 200],
      ['a header', { url: '/me', headers: { 'x-canary': CANARY } }, 200],
      [
        'the authorization header',
        { url: '/me', token: `aaa.${CANARY}.ccc` },
        401,
      ],
      [
        'a JSON body',
        {
          url: '/not-a-route',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ secret: CANARY }),
        },
        404,
      ],
      [
        'a body that is not JSON',
        {
          url: '/not-a-route',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          payload: `not json ${CANARY}`,
        },
        400,
      ],
      [
        'an oversized body',
        {
          url: '/not-a-route',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          payload: `{"secret":"${CANARY}","padding":"${'x'.repeat(1_100_000)}"}`,
        },
        413,
      ],
      ['an unknown route', { url: `/unknown/${CANARY}` }, 404],
    ];

    for (const [what, request, status] of cases) {
      const response = await call(app, /** @type {any} */ (request));
      assert.equal(response.statusCode, status, `${what}: ${response.body}`);
      assert.ok(
        !response.body.includes(CANARY),
        `${what} reached a response body: ${response.body}`,
      );
      // An error body is a problem document, never Fastify's default JSON.
      if (status >= 400) {
        assert.match(
          String(response.headers['content-type']),
          /^application\/problem\+json/,
          `${what}: ${response.headers['content-type']}`,
        );
      }
    }

    assert.ok(
      !capture.text().includes(CANARY),
      `a log line carried the canary:\n${capture.text()}`,
    );
  } finally {
    await app.close();
  }
});

test('the request line is fixed fields only', async () => {
  const { app, capture } = build();
  try {
    await call(app, { url: `/me?secret=${CANARY}` });
    await call(app, { url: '/not-a-route' });
    const lines = capture.json().filter((entry) => entry.msg === 'request');
    assert.equal(lines.length, 2);
    assert.deepEqual(
      Object.keys(lines[0]).sort(),
      [
        'durationMs',
        'level',
        'method',
        'msg',
        'pid',
        'reqId',
        'route',
        'status',
        'time',
        'hostname',
      ].sort(),
    );
    assert.equal(lines[0].route, '/me');
    assert.equal(lines[0].method, 'GET');
    assert.equal(lines[0].status, 200);
    assert.equal(typeof lines[0].durationMs, 'number');
    // An unmatched request is `unmatched` — never the URL, which held the query.
    assert.equal(lines[1].route, 'unmatched');
    assert.equal(lines[1].status, 404);
    assert.ok(!capture.text().includes('secret='));
  } finally {
    await app.close();
  }
});

test('a failing store answers a 500 problem and logs the error by name only', async () => {
  const email = 'alice@example.test';
  const { app, capture } = build({
    store: {
      async findBySubject() {
        // A `pg` message can name a row's values: this is what a unique
        // violation on `users.email` prints.
        throw Object.assign(
          new Error(
            `duplicate key value violates unique constraint "users_email_unique": ${email}`,
          ),
          { code: '23505' },
        );
      },
    },
  });
  try {
    const response = await call(app);
    assert.equal(response.statusCode, 500);
    assertProblem(response.json(), 'internal-error');
    const text = capture.text();
    assert.ok(!text.includes(email), 'the e-mail address reached the log');
    assert.ok(
      !text.includes('unique constraint'),
      'the message reached the log',
    );
    assert.ok(
      text.includes('"code":"23505"'),
      `the SQLSTATE must be logged: ${text}`,
    );
    assert.ok(text.includes('"type":"Error"'), 'the error name must be logged');
  } finally {
    await app.close();
  }
});

test('every error body validates against the spec Problem schema', async () => {
  const { app } = build();
  const limited = build({ env: { CALFLEX_RATE_LIMIT_MAX: '1' } });
  try {
    const responses = [
      await call(app, { token: '' }), // 401
      await call(app, { token: 'xxx.yyy.zzz' }), // 401
      await call(app, { url: '/not-a-route' }), // 404
      await call(app, { method: 'POST', url: '/me' }), // 404 (no route)
    ];
    assert.equal((await call(limited.app)).statusCode, 200);
    responses.push(await call(limited.app)); // 429
    for (const response of responses) {
      assert.ok(response.statusCode >= 400, response.body);
      assert.match(
        String(response.headers['content-type']),
        /^application\/problem\+json/,
      );
      const body = response.json();
      assert.equal(body.status, response.statusCode);
      assert.equal(
        firstSchemaViolation(specProblemSchema, body),
        undefined,
        response.body,
      );
      assert.match(String(response.headers['x-request-id']), UUID_V4);
      assert.equal(
        body.instance,
        `urn:uuid:${response.headers['x-request-id']}`,
      );
    }
  } finally {
    await app.close();
    await limited.app.close();
  }
});

test('one trusted hop keys the limiter on the last X-Forwarded-For entry', async () => {
  // The forged entry is the *first* one: a client behind one trusted proxy can
  // prepend anything, and the bucket must still be the entry the proxy added.
  const { app } = build({
    env: {
      CALFLEX_RATE_LIMIT_MAX: '1',
      CALFLEX_TRUSTED_PROXY_HOPS: '1',
    },
  });
  try {
    /** @param {string} value */
    const forwarded = async (value) =>
      /** @type {any} */ (
        await app.inject({
          url: '/me',
          remoteAddress: '10.0.0.1',
          headers: {
            'x-forwarded-for': value,
            authorization: 'Bearer xxx.yyy.zzz',
          },
        })
      ).statusCode;

    assert.equal(await forwarded('9.9.9.9, 8.8.8.8'), 401);
    // Same last entry, a different forged first one: the same bucket.
    assert.equal(await forwarded('7.7.7.7, 8.8.8.8'), 429);
    // A different last entry is a different client.
    assert.equal(await forwarded('7.7.7.7, 6.6.6.6'), 401);
  } finally {
    await app.close();
  }
});

test('the log level setting is validated at startup', () => {
  assert.equal(config().logLevel, 'info');
  assert.equal(config({ CALFLEX_LOG_LEVEL: 'debug' }).logLevel, 'debug');
  for (const value of ['verbose', 'INFO', '1', 'info,debug', '']) {
    if (value === '') {
      assert.equal(config({ CALFLEX_LOG_LEVEL: '' }).logLevel, 'info');
      continue;
    }
    assert.throws(
      () => config({ CALFLEX_LOG_LEVEL: value }),
      /CALFLEX_LOG_LEVEL/,
      `CALFLEX_LOG_LEVEL=${value} must not be accepted`,
    );
  }
});

test('the problem content type is the one the spec declares', async () => {
  const { app } = build();
  try {
    const response = await call(app, { token: '' });
    assert.equal(response.statusCode, 401);
    assert.equal(
      String(response.headers['content-type']).split(';')[0],
      PROBLEM_CONTENT_TYPE,
    );
  } finally {
    await app.close();
  }
});
