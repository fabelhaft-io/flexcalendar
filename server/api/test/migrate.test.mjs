import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  readFile,
  mkdtemp,
  cp,
  appendFile,
  mkdir,
  writeFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'yaml';
import pg from 'pg';

const api = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(
  api,
  'node_modules/node-pg-migrate/bin/node-pg-migrate.js',
);
let container = '';
let port = 0;
let nextDatabase = 0;
const password = 'migration-test-only';
/** @type {string[]} */
const temporary = [];
/** @param {string} database */
const config = (database) => ({
  host: '127.0.0.1',
  port,
  user: 'postgres',
  password,
  database,
  connectionTimeoutMillis: 1000,
});
/** @param {string[]} args */
const podman = (args) =>
  execFileSync('podman', args, { encoding: 'utf8', timeout: 120000 }).trim();

before(
  async () => {
    // A missing runtime is a failed gate, never a skip.
    try {
      podman(['--version']);
    } catch {
      throw new Error(
        'Migration component tests require working rootless Podman on PATH',
      );
    }
    const compose = parse(
      await readFile(
        new URL('../../../infra/dev/compose.yaml', import.meta.url),
        'utf8',
      ),
    );
    const image = compose.services.postgres.image;
    assert.match(image, /^postgres:[\w.-]+$/);
    container = podman([
      'run',
      '--rm',
      '-d',
      '-p',
      '127.0.0.1::5432',
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      `docker.io/library/${image}`,
    ]);
    const mapping = podman(['port', container, '5432/tcp']);
    const match = /^127\.0\.0\.1:(\d+)$/.exec(mapping);
    assert.ok(match, 'Postgres must publish only an ephemeral loopback port');
    port = Number(match[1]);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const client = new pg.Client(config('postgres'));
      try {
        await client.connect();
        await client.query('SELECT 1');
        return;
      } catch {
        await delay(250);
      } finally {
        await client.end();
      }
    }
    throw new Error(
      'Disposable Postgres did not become ready over TCP in 60 seconds',
    );
  },
  { timeout: 180000 },
);

after(async () => {
  try {
    if (container) podman(['stop', '--time', '5', container]);
  } finally {
    await Promise.all(
      temporary.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  }
});

async function fresh() {
  const name = `migration_test_${++nextDatabase}`;
  const admin = new pg.Client(config('postgres'));
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const client = new pg.Client(config(name));
  await client.connect();
  return { name, client };
}
/** @param {string} database @param {string[]} [direction] @param {string} [directory] */
function migrate(
  database,
  direction = ['up'],
  directory = path.join(api, 'migrations'),
) {
  return spawnSync(
    process.execPath,
    [
      cli,
      ...direction,
      '--database-url-var',
      'CALFLEX_MIGRATE_DATABASE_URL',
      '--migrations-dir',
      directory,
      '--schema',
      'public',
      '--check-order',
      '--single-transaction',
      '--lock',
      '--no-verbose',
    ],
    {
      cwd: api,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        CALFLEX_MIGRATE_DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/${database}`,
      },
    },
  );
}
/** @param {pg.Client} client */
async function tables(client) {
  const result = await client.query(
    "SELECT schemaname || '.' || tablename AS name FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY name",
  );
  return result.rows.map((row) => row.name);
}
const expected = [
  'public.pgmigrations',
  ...[
    'calendarchanges',
    'calendarinstances',
    'calendarobjects',
    'calendars',
    'calendarsubscriptions',
    'propertystorage',
    'schedulingobjects',
  ].map((name) => `sabredav.${name}`),
];
/** @param {pg.Client} client */
async function empty(client) {
  assert.deepEqual(await tables(client), ['public.pgmigrations']);
  assert.equal(
    (await client.query('SELECT count(*)::int AS n FROM public.pgmigrations'))
      .rows[0].n,
    0,
  );
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'sabredav'",
      )
    ).rows[0].n,
    0,
  );
}
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'calflex-migration-'));
  temporary.push(dir);
  return dir;
}

test('fresh schema, idempotence, down to zero, then up again', async () => {
  const { name, client } = await fresh();
  try {
    assert.equal(migrate(name).status, 0);
    assert.deepEqual(await tables(client), expected);
    const first = (
      await client.query('SELECT * FROM public.pgmigrations ORDER BY id')
    ).rows;
    assert.equal(first.length, 2);
    const second = migrate(name);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /No migrations to run/);
    assert.deepEqual(
      (await client.query('SELECT * FROM public.pgmigrations ORDER BY id'))
        .rows,
      first,
    );
    assert.deepEqual(await tables(client), expected);
    assert.equal(migrate(name, ['down', '0']).status, 0);
    await empty(client);
    assert.equal(migrate(name).status, 0);
    assert.deepEqual(await tables(client), expected);
  } finally {
    await client.end();
  }
});

for (const file of ['pgsql.calendars.sql', 'pgsql.propertystorage.sql']) {
  test(`tampered ${file} fails and rolls back the whole run`, async () => {
    const { name, client } = await fresh();
    try {
      const dir = await fixture();
      await cp(path.join(api, 'migrations'), path.join(dir, 'migrations'), {
        recursive: true,
      });
      await cp(path.join(api, 'sabredav'), path.join(dir, 'sabredav'), {
        recursive: true,
      });
      await appendFile(path.join(dir, 'sabredav', file), ' ');
      const result = migrate(name, ['up'], path.join(dir, 'migrations'));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /checksum mismatch/);
      await empty(client);
    } finally {
      await client.end();
    }
  });
}

test('irreversible migration refuses down and retains its row and table', async () => {
  const { name, client } = await fresh();
  try {
    const dir = await fixture();
    await writeFile(
      path.join(dir, `${Date.now()}_irreversible.mjs`),
      "export const up = pgm => pgm.sql('CREATE TABLE public.irreversible (id integer)');\n// No down: test of intentional irreversibility.\nexport const down = false;\n",
    );
    assert.equal(migrate(name, ['up'], dir).status, 0);
    const first = (await client.query('SELECT * FROM public.pgmigrations'))
      .rows;
    const result = migrate(name, ['down', '1'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /User has disabled down migration/);
    assert.deepEqual(
      (await client.query('SELECT * FROM public.pgmigrations')).rows,
      first,
    );
    assert.deepEqual(await tables(client), [
      'public.irreversible',
      'public.pgmigrations',
    ]);
  } finally {
    await client.end();
  }
});

test('a broken second migration rolls back the earlier successful DDL', async () => {
  const { name, client } = await fresh();
  try {
    const dir = path.join(await fixture(), 'migrations');
    await mkdir(dir);
    const stamp = Date.now();
    await writeFile(
      path.join(dir, `${stamp}_good.mjs`),
      "export const up = pgm => pgm.sql('CREATE TABLE public.good (id integer)');\nexport const down = pgm => pgm.sql('DROP TABLE public.good');\n",
    );
    await writeFile(
      path.join(dir, `${stamp + 1}_broken.mjs`),
      "export const up = pgm => pgm.sql('SELECT * FROM deliberately_missing_table');\nexport const down = false; // No state is created.\n",
    );
    const result = migrate(name, ['up'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /deliberately_missing_table/);
    await empty(client);
  } finally {
    await client.end();
  }
});
