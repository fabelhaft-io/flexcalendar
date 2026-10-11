// --- E05-R01: first sight against the real `users` table ---------------------
//
// These run against PostgreSQL (through `support/postgres.mjs`, the same
// disposable container the migration tests use). The IdP is an injected stub,
// so the database behaviour is what is under test: the `ON CONFLICT
// (idp_subject) DO NOTHING` insert, both unique indexes, and the rule that a
// refused first sight creates no row.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.mjs';
import { readConfig } from '../src/config.mjs';
import { createUserStore } from '../src/store.mjs';
import { fresh, migrate } from './support/postgres.mjs';

/** A three-segment token whose payload is the subject under test. */
const fakeToken = (/** @type {string} */ subject) =>
  `a.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.c`;

/**
 * Builds the app on a fresh database, with an injected IdP.
 * @param {(context: {client: any, calls: {userinfo: number}, app: any, setUserinfo: (value: any) => void, users: () => Promise<any[]>}) => Promise<void>} run
 */
async function withApp(run) {
  const { name, client } = await fresh();
  try {
    assert.equal(migrate(name).status, 0, 'migration failed');
    const calls = { userinfo: 0 };
    let userinfo = {};
    const oidc = {
      /** @param {string} token */
      async verify(token) {
        const payload = JSON.parse(
          Buffer.from(String(token).split('.')[1], 'base64url').toString(),
        );
        return { sub: payload.sub };
      },
      async userinfo() {
        calls.userinfo += 1;
        return userinfo;
      },
    };
    const app = buildApp({
      config: {
        ...readConfig({}),
        issuer: 'https://auth.example.test',
      },
      store: createUserStore(client),
      oidc,
      audience: {
        current: async () => 'project-id',
        refresh: async () => false,
      },
    });
    try {
      await run({
        client,
        calls,
        app,
        setUserinfo: (/** @type {any} */ value) => {
          userinfo = value;
        },
        users: async () =>
          (
            await client.query(
              'SELECT id, idp_subject, handle, email FROM public.users',
            )
          ).rows,
      });
    } finally {
      await app.close();
    }
  } finally {
    await client.end();
  }
}

/** @param {any} app @param {string | undefined} subject */
const call = (app, subject) =>
  app.inject({
    method: 'GET',
    url: '/me',
    headers:
      subject === undefined
        ? {}
        : { authorization: `Bearer ${fakeToken(subject)}` },
  });

test('a subject with a row answers from that row, without userinfo', async () => {
  await withApp(async ({ app, calls, users, client }) => {
    const inserted = (
      await client.query(
        `INSERT INTO public.users (idp_subject, handle, email)
         VALUES ('seeded-subject', 'Alice', 'Alice@example.test') RETURNING id`,
      )
    ).rows[0];
    const response = await call(app, 'seeded-subject');
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      id: inserted.id,
      handle: 'Alice',
      email: 'Alice@example.test',
    });
    assert.equal(calls.userinfo, 0);
    assert.equal((await users()).length, 1);
  });
});

test('the first request creates the row and the second one finds it', async () => {
  await withApp(async ({ app, calls, setUserinfo, users }) => {
    setUserinfo({
      sub: 'first-sight',
      email_verified: true,
      preferred_username: 'New User',
      email: 'new@example.test',
    });
    const first = await call(app, 'first-sight');
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(calls.userinfo, 1);
    const created = first.json();
    assert.equal(created.handle, 'New User');
    assert.equal(created.email, 'new@example.test');
    assert.match(created.id, /^[0-9a-f-]{36}$/);

    const second = await call(app, 'first-sight');
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(second.json(), created);
    assert.equal(calls.userinfo, 1);
    assert.equal((await users()).length, 1);
  });
});

test('two simultaneous first requests create exactly one row', async () => {
  await withApp(async ({ app, setUserinfo, users }) => {
    setUserinfo({
      sub: 'racing-subject',
      email_verified: true,
      preferred_username: 'racer',
      email: 'racer@example.test',
    });
    const [left, right] = await Promise.all([
      call(app, 'racing-subject'),
      call(app, 'racing-subject'),
    ]);
    assert.equal(left.statusCode, 200, left.body);
    assert.equal(right.statusCode, 200, right.body);
    assert.equal(left.json().id, right.json().id);
    assert.equal((await users()).length, 1);
  });
});

test('a refused first sight never creates a row', async () => {
  await withApp(async ({ app, calls, setUserinfo, users }) => {
    // email_verified false → 403.
    setUserinfo({
      sub: 'unverified',
      email_verified: false,
      preferred_username: 'unverified',
      email: 'unverified@example.test',
    });
    assert.equal((await call(app, 'unverified')).statusCode, 403);
    assert.equal((await users()).length, 0);

    // userinfo answering about another subject → 502.
    setUserinfo({
      sub: 'somebody-else',
      email_verified: true,
      preferred_username: 'mallory',
      email: 'mallory@example.test',
    });
    assert.equal((await call(app, 'mismatched')).statusCode, 502);
    assert.equal((await users()).length, 0);

    // userinfo failing → 502.
    setUserinfo(() => {
      throw new Error('userinfo unavailable');
    });
    assert.equal((await call(app, 'unreachable')).statusCode, 502);
    assert.equal((await users()).length, 0);

    // No row was created, so a later valid first sight still calls userinfo.
    setUserinfo({
      sub: 'unverified',
      email_verified: true,
      preferred_username: 'now-verified',
      email: 'now-verified@example.test',
    });
    const accepted = await call(app, 'unverified');
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(calls.userinfo, 4);
    assert.equal((await users()).length, 1);
  });
});

test('a taken handle or email is a 409 and creates nothing', async () => {
  await withApp(async ({ app, setUserinfo, users, client }) => {
    await client.query(`INSERT INTO public.users (idp_subject, handle, email)
      VALUES ('sitting-tenant', 'bob', 'taken@example.test')`);
    setUserinfo({
      sub: 'newcomer',
      email_verified: true,
      preferred_username: 'someone-else',
      email: 'Taken@example.test',
    });
    const conflict = await call(app, 'newcomer');
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.deepEqual(conflict.json(), { error: 'conflict' });
    assert.equal((await users()).length, 1);

    // The same subject with a free email and a taken handle is a 409 as well.
    setUserinfo({
      sub: 'newcomer',
      email_verified: true,
      preferred_username: 'BOB',
      email: 'free@example.test',
    });
    assert.equal((await call(app, 'newcomer')).statusCode, 409);
    assert.equal((await users()).length, 1);
  });
});

test('without a token the request is refused before any database work', async () => {
  await withApp(async ({ app, calls, users }) => {
    const response = await call(app, undefined);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'unauthorized' });
    assert.equal(response.headers['www-authenticate'], 'Bearer');
    assert.equal(calls.userinfo, 0);
    assert.equal((await users()).length, 0);
  });
});
