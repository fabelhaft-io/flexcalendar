#!/usr/bin/env node
// --- calendar-flex local stack: development seed (E02-R03) -------------------
//
// Loads `infra/dev/seed/users.json` into the running local stack, by way of
// Zitadel's v1 Management API. `make seed` runs this inside the stack (the
// `seed` service of infra/dev/compose.yaml), so it needs no tooling on the
// developer's machine.
//
// It is **idempotent**: a user whose email address already exists is skipped,
// and a create that races another create (Zitadel answers ALREADY_EXISTS) is
// treated as success. Every run ends by reading the users back out of Zitadel
// and failing if one is missing — the acceptance criterion is "at least two
// test users in Zitadel", so the seed proves it instead of trusting its writes.
//
// It logs usernames, never event content (there is none), and never a
// credential: nothing here prints the PAT or the seed password.
//
// Configuration (all optional, defaults suit the compose stack):
//   CALFLEX_SEED_BASE_URL    Zitadel URL as reachable from where the seed runs;
//                            inside the stack that is Caddy on its *container*
//                            port, which is 8443 whatever the published one is
//                            (default https://auth.localhost:8443)
//   CALFLEX_SEED_HOST        Host header to send, i.e. the authority a browser
//                            uses — the published one. Zitadel resolves its
//                            instance from the request's Host and is never
//                            reached in this stack without one (default: the
//                            base URL's own authority)
//   CALFLEX_SEED_USERS_FILE  seed data           (default ./users.json)
//   CALFLEX_SEED_PAT_PATH    seed machine user's personal access token
//                            (default /zitadel-bootstrap/seed.pat)
//   CALFLEX_SEED_CA_PATH     Caddy's local CA root, for the https above
//                            (default /caddy-pki/caddy/pki/authorities/local/root.crt)
//   CALFLEX_SEED_PASSWORD    password for every seeded user (dev only)
//   CALFLEX_SEED_TIMEOUT_MS  how long to wait for Zitadel (default 300000)
//   CALFLEX_SEED_POLL_MS     poll interval while waiting (default 2000)

import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const settings = {
  baseUrl: process.env.CALFLEX_SEED_BASE_URL ?? 'https://auth.localhost:8443',
  // Left undefined in-process (the tests' stub) so node sends the Host it
  // derived from the URL; compose passes the published authority here.
  host: process.env.CALFLEX_SEED_HOST ?? undefined,
  usersFile: process.env.CALFLEX_SEED_USERS_FILE ?? new URL('users.json', import.meta.url).pathname,
  patPath: process.env.CALFLEX_SEED_PAT_PATH ?? '/zitadel-bootstrap/seed.pat',
  caPath: process.env.CALFLEX_SEED_CA_PATH ?? '/caddy-pki/caddy/pki/authorities/local/root.crt',
  password: process.env.CALFLEX_SEED_PASSWORD ?? 'Development1!',
  timeoutMs: Number(process.env.CALFLEX_SEED_TIMEOUT_MS ?? 300_000),
  pollMs: Number(process.env.CALFLEX_SEED_POLL_MS ?? 2_000),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line) => process.stdout.write(`${line}\n`);

/** One JSON request. `ca` is passed to node:https so the local CA is trusted. */
function requestJson(url, { method = 'GET', body, token, ca } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));

    const request = send(
      target,
      {
        method,
        ca,
        headers: {
          accept: 'application/json',
          // The authority a browser would use. Without it, Caddy's TLS and
          // routing still work, but Zitadel would see the container port.
          ...(settings.host ? { host: settings.host } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = text === '' ? undefined : JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: response.statusCode ?? 0, json, text });
        });
      },
    );

    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

/**
 * Caddy's local CA is written when Caddy first starts, which may be after this
 * container. Read it lazily, and keep trying, so the order they start in does
 * not matter. Plain http (the seed program's own tests) needs no CA at all.
 */
async function readLocalCa() {
  if (new URL(settings.baseUrl).protocol !== 'https:') return undefined;

  let lastError;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      return await readFile(settings.caPath, 'utf8');
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }
  throw new Error(`cannot read the local CA at ${settings.caPath}: ${lastError?.message}`);
}

/** Waits until Zitadel answers, so `make seed` can run right after `make dev`. */
async function waitForZitadel(ca) {
  const url = `${settings.baseUrl}/.well-known/openid-configuration`;
  const deadline = Date.now() + settings.timeoutMs;
  let lastAnswer = 'no answer';

  for (;;) {
    try {
      const response = await requestJson(url, { ca });
      if (response.status === 200) {
        log(`seed: Zitadel answers at ${settings.baseUrl}`);
        return;
      }
      lastAnswer = `HTTP ${response.status}`;
    } catch (error) {
      lastAnswer = error.message;
    }
    if (Date.now() > deadline) {
      throw new Error(`Zitadel did not become ready at ${url} within ${settings.timeoutMs} ms (${lastAnswer})`);
    }
    await sleep(settings.pollMs);
  }
}

/** How many users already carry this email address. */
async function countUsersByEmail(email, token, ca) {
  const response = await requestJson(`${settings.baseUrl}/management/v1/users/_search`, {
    method: 'POST',
    token,
    ca,
    body: {
      queries: [{ emailQuery: { emailAddress: email, method: 'TEXT_QUERY_METHOD_EQUALS' } }],
    },
  });
  if (response.status !== 200) {
    throw new Error(
      `searching for ${email} failed: HTTP ${response.status} ${response.text.slice(0, 300)}`,
    );
  }
  // `totalResult` is a uint64, so it comes back as a JSON string.
  return Number(response.json?.details?.totalResult ?? 0);
}

/** Creates one human user; 'exists' covers a lost race with another seed run. */
async function createUser(user, token, ca) {
  const response = await requestJson(`${settings.baseUrl}/management/v1/users/human/_import`, {
    method: 'POST',
    token,
    ca,
    body: {
      userName: user.userName,
      profile: { firstName: user.firstName, lastName: user.lastName, preferredLanguage: 'en' },
      email: { email: user.email, isEmailVerified: true },
      password: settings.password,
      passwordChangeRequired: false,
    },
  });

  if (response.status === 200 || response.status === 201) return 'created';
  // Zitadel reports ALREADY_EXISTS as gRPC code 6, over HTTP 409.
  if (response.status === 409 || response.json?.code === 6) return 'exists';
  throw new Error(
    `creating ${user.userName} failed: HTTP ${response.status} ${response.text.slice(0, 300)}`,
  );
}

function readSeedUsers(document) {
  const users = document?.users;
  if (!Array.isArray(users) || users.length < 2) {
    throw new Error(`${settings.usersFile} must list at least two users`);
  }
  for (const user of users) {
    for (const field of ['userName', 'firstName', 'lastName', 'email']) {
      if (typeof user?.[field] !== 'string' || user[field] === '') {
        throw new Error(`every seeded user needs a non-empty ${field}`);
      }
    }
  }
  return users;
}

function readPat() {
  return readFile(settings.patPath, 'utf8').then((pat) => {
    const token = pat.trim();
    if (token === '') throw new Error(`the seed PAT at ${settings.patPath} is empty`);
    return token;
  });
}

async function main() {
  const users = readSeedUsers(JSON.parse(await readFile(settings.usersFile, 'utf8')));

  const ca = await readLocalCa();
  await waitForZitadel(ca);
  const token = await readPat();

  const outcomes = [];
  for (const user of users) {
    const existing = await countUsersByEmail(user.email, token, ca);
    outcomes.push([user, existing > 0 ? 'exists' : await createUser(user, token, ca)]);
  }

  const missing = [];
  for (const user of users) {
    if ((await countUsersByEmail(user.email, token, ca)) === 0) missing.push(user.email);
  }

  for (const [user, outcome] of outcomes) {
    log(`seed: ${outcome.padEnd(7)} ${user.userName} <${user.email}>`);
  }
  log(`seed: ${users.length - missing.length}/${users.length} development users present in Zitadel`);
  if (missing.length > 0) {
    throw new Error(`the seed reported success but these users are missing: ${missing.join(', ')}`);
  }
}

main().catch((error) => {
  process.stderr.write(`seed failed: ${error.message}\n`);
  process.exit(1);
});
