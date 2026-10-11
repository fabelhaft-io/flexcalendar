// --- E05-R01: the connection pool survives a dropped idle client -------------
//
// `pg.Pool` emits `error` when a pooled client fails while idle — a Postgres
// restart, a connection the network dropped. An `error` event with no listener
// is an unhandled exception and ends the process (review 1 saw exactly that: a
// `podman restart` of Postgres took the API down. The dump held host, user and
// database). `createPool` attaches the listener; the test emits the event
// directly, so no database is involved and the assertion is precise: without
// the listener `emit` throws.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPool } from '../src/store.mjs';

test('an error on the pool is absorbed, and the pool stays usable', async () => {
  // Never connected: `pg.Pool` opens a client lazily, so nothing here dials.
  const pool = createPool({
    connectionString: 'postgresql://calflex_api@127.0.0.1:1/caldav',
  });
  assert.equal(pool.listenerCount('error'), 1);
  assert.doesNotThrow(() =>
    pool.emit('error', new Error('Connection terminated unexpectedly')),
  );
  // A dropped client is not a fatal state: the pool can still be closed.
  await pool.end();
});

test('the pool is created with the settings it was handed, and with sensible defaults', async () => {
  const configured = createPool({
    connectionString: 'postgresql://calflex_api@localhost:5432/caldav',
    connectionTimeoutMillis: 1234,
  });
  try {
    assert.equal(configured.options.connectionTimeoutMillis, 1234);
    assert.match(String(configured.options.connectionString), /\/caldav$/);
  } finally {
    await configured.end();
  }

  // The API boots before its database is up, so a connection attempt must give
  // up rather than hang forever.
  const defaulted = createPool();
  try {
    assert.equal(defaulted.options.connectionTimeoutMillis, 5000);
  } finally {
    await defaulted.end();
  }
});
