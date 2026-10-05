// --- calendar-flex local stack: tests for the development seed (E02-R03) -----
//
// Runs `seed.mjs` against a stub Zitadel, so the parts of the seed that can lie
// are exercised without the stack: the Management API payloads, the
// idempotency (a second run must create nothing), and the read-back check that
// fails the run when a "created" user is not actually there.
//
// The stub *mutates* the state the seed reads next (`users/_search`), which is
// the point: a search that answered from a frozen fixture would pass whatever
// the seed did.
//
//   node --test infra/dev/seed/     (or: make test-seed)

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const seedProgram = fileURLToPath(new URL('seed.mjs', import.meta.url));

/** A stand-in for the two Zitadel endpoints the seed uses. */
async function startStubZitadel({ storeCreates = true } = {}) {
  const users = new Map(); // email -> {userName, email}
  const requests = [];

  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ method: request.method, url: request.url, body, authorization: request.headers.authorization });

      const json = (status, payload) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };

      if (request.method === 'GET' && request.url === '/.well-known/openid-configuration') {
        return json(200, { issuer: 'stub' });
      }

      if (request.method === 'POST' && request.url === '/management/v1/users/_search') {
        const wanted = body?.queries?.[0]?.emailQuery?.emailAddress;
        const found = users.has(wanted) ? 1 : 0;
        return json(200, { details: { totalResult: String(found) } });
      }

      if (request.method === 'POST' && request.url === '/management/v1/users/human/_import') {
        const email = body?.email?.email;
        if (users.has(email) || [...users.values()].some((user) => user.userName === body?.userName)) {
          return json(409, { code: 6, message: 'Errors.User.AlreadyExists' });
        }
        if (storeCreates) users.set(email, { userName: body?.userName, email });
        return json(200, { userId: `stub-${users.size}` });
      }

      return json(404, { message: `stub has no ${request.method} ${request.url}` });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    users,
    requests,
    created: () => requests.filter((entry) => entry.url === '/management/v1/users/human/_import').length,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function writeSeedFiles(users) {
  const directory = await mkdtemp(path.join(tmpdir(), 'calflex-seed-test-'));
  const usersFile = path.join(directory, 'users.json');
  const patFile = path.join(directory, 'seed.pat');
  await writeFile(usersFile, JSON.stringify({ users }));
  await writeFile(patFile, 'stub-personal-access-token\n');
  return { usersFile, patFile };
}

const twoUsers = [
  { userName: 'alice', firstName: 'Alice', lastName: 'Anders', email: 'alice@example.test' },
  { userName: 'bob', firstName: 'Bob', lastName: 'Berg', email: 'bob@example.test' },
];

function runSeed({ baseUrl, usersFile, patFile }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [seedProgram], {
      env: {
        ...process.env,
        CALFLEX_SEED_BASE_URL: baseUrl,
        CALFLEX_SEED_USERS_FILE: usersFile,
        CALFLEX_SEED_PAT_PATH: patFile,
        CALFLEX_SEED_PASSWORD: 'StubPassword1!',
        CALFLEX_SEED_TIMEOUT_MS: '10000',
        CALFLEX_SEED_POLL_MS: '50',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('creates the seeded users, and a second run creates none', async (t) => {
  const zitadel = await startStubZitadel();
  t.after(() => zitadel.close());
  const files = await writeSeedFiles(twoUsers);

  const first = await runSeed({ baseUrl: zitadel.url, ...files });
  assert.equal(first.code, 0, `first run failed: ${first.stderr}`);
  assert.match(first.stdout, /2\/2 development users present in Zitadel/);
  assert.deepEqual([...zitadel.users.keys()].sort(), ['alice@example.test', 'bob@example.test']);

  const createsAfterFirstRun = zitadel.created();
  assert.equal(createsAfterFirstRun, 2);

  // The seed sends what Zitadel needs: a login name, a verified email and a
  // password the developer can use.
  const firstCreate = zitadel.requests.find((entry) => entry.url === '/management/v1/users/human/_import');
  assert.equal(firstCreate.authorization, 'Bearer stub-personal-access-token');
  assert.equal(firstCreate.body.userName, 'alice');
  assert.equal(firstCreate.body.profile.firstName, 'Alice');
  assert.equal(firstCreate.body.email.isEmailVerified, true);
  assert.equal(firstCreate.body.passwordChangeRequired, false);
  assert.equal(typeof firstCreate.body.password, 'string');

  // Idempotent: nothing is created a second time, and the run still succeeds.
  const second = await runSeed({ baseUrl: zitadel.url, ...files });
  assert.equal(second.code, 0, `second run failed: ${second.stderr}`);
  assert.equal(zitadel.created(), createsAfterFirstRun);
  assert.match(second.stdout, /seed: exists\s+alice/);
  assert.equal(zitadel.users.size, 2);
});

test('fails when a "created" user cannot be read back', async (t) => {
  const zitadel = await startStubZitadel({ storeCreates: false });
  t.after(() => zitadel.close());
  const files = await writeSeedFiles(twoUsers);

  const run = await runSeed({ baseUrl: zitadel.url, ...files });
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /missing: alice@example\.test, bob@example\.test/);
});

test('refuses a users file with fewer than two users', async (t) => {
  const zitadel = await startStubZitadel();
  t.after(() => zitadel.close());
  const files = await writeSeedFiles([twoUsers[0]]);

  const run = await runSeed({ baseUrl: zitadel.url, ...files });
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /must list at least two users/);
  assert.equal(zitadel.requests.length, 0);
});
