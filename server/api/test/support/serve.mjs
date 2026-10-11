// --- E05-R01 test support: the API with an in-memory store -------------------
//
// Spawned by the database-free HTTP tests so the whole auth path runs for real
// (real headers, real sockets, real JWKS fetches) without Postgres. The store
// holds one user whose `sub` is already known, and one whose email is already
// taken, so "first sight" and "409" are exercised against state the API itself
// cannot reset.

import { buildApp } from '../../src/app.mjs';
import { readConfig } from '../../src/config.mjs';
import { createMemoryStore } from './store.mjs';

const store = createMemoryStore([
  { subject: 'known-subject', handle: 'alice', email: 'alice@example.test' },
  { subject: 'taken-email', handle: 'bob', email: 'bob@example.test' },
]);

const app = buildApp({ config: readConfig(), store });
const address = await app.listen({ port: 0, host: '127.0.0.1' });
process.stdout.write(`listening on ${address}\n`);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    app.close().then(() => process.exit(0));
  });
