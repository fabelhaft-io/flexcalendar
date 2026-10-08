import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  readFile,
  readdir,
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
/** @param {string} database @param {string[]} [direction] @param {string} [configPath] */
function migrate(
  database,
  direction = ['up'],
  configPath = path.join(api, 'migrate.config.json'),
) {
  return spawnSync(
    process.execPath,
    [
      cli,
      ...direction,
      '--database-url-var',
      'CALFLEX_MIGRATE_DATABASE_URL',
      '-f',
      configPath,
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
async function tables(client, scoped = false) {
  const result = await client.query(
    scoped
      ? "SELECT schemaname || '.' || tablename AS name FROM pg_tables WHERE schemaname = 'sabredav' OR (schemaname = 'public' AND tablename = 'pgmigrations') ORDER BY name"
      : "SELECT schemaname || '.' || tablename AS name FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY name",
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
  const settings = JSON.parse(
    await readFile(path.join(api, 'migrate.config.json'), 'utf8'),
  );
  // node-pg-migrate 9.0.0 gives the config directory precedence over CLI
  // --migrations-dir, so each fixture gets a copy with only its path changed.
  settings['migrations-dir'] = path.join(dir, 'migrations');
  await writeFile(
    path.join(dir, 'migrate.config.json'),
    JSON.stringify(settings),
  );
  return dir;
}

test('fresh schema, idempotence, down to zero, then up again', async () => {
  const { name, client } = await fresh();
  try {
    assert.equal(migrate(name).status, 0);
    assert.deepEqual(await tables(client, true), expected);
    const first = (
      await client.query('SELECT * FROM public.pgmigrations ORDER BY id')
    ).rows;
    assert.equal(
      first.length,
      (await readdir(path.join(api, 'migrations'))).filter((file) =>
        /\.(mjs|sql)$/.test(file),
      ).length,
    );
    const second = migrate(name);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /No migrations to run/);
    assert.deepEqual(
      (await client.query('SELECT * FROM public.pgmigrations ORDER BY id'))
        .rows,
      first,
    );
    assert.deepEqual(await tables(client, true), expected);
    assert.equal(migrate(name, ['down', '0']).status, 0);
    await empty(client);
    assert.equal(migrate(name).status, 0);
    assert.deepEqual(await tables(client, true), expected);
  } finally {
    await client.end();
  }
});

async function sabreFixture() {
  const dir = await fixture();
  await cp(path.join(api, 'migrations'), path.join(dir, 'migrations'), {
    recursive: true,
  });
  await cp(path.join(api, 'sabredav'), path.join(dir, 'sabredav'), {
    recursive: true,
  });
  return dir;
}

test('search_path is reset before a later unqualified table is created', async () => {
  const { name, client } = await fresh();
  try {
    const dir = await sabreFixture();
    // Sort after the current chain, including future API migrations.
    await writeFile(
      path.join(dir, 'migrations', '9999999999999_search-path-probe.mjs'),
      "export const up = pgm => pgm.sql('CREATE TABLE search_path_probe (id integer)');\nexport const down = pgm => pgm.sql('DROP TABLE public.search_path_probe');\n",
    );
    assert.equal(
      migrate(name, ['up'], path.join(dir, 'migrate.config.json')).status,
      0,
    );
    assert.deepEqual(await tables(client, true), expected);
    assert.deepEqual(
      (
        await client.query(
          "SELECT schemaname FROM pg_tables WHERE tablename = 'search_path_probe'",
        )
      ).rows,
      [{ schemaname: 'public' }],
    );
  } finally {
    await client.end();
  }
});

test('propertystorage down alone leaves six tables; up restores seven', async () => {
  const { name, client } = await fresh();
  try {
    const dir = await sabreFixture();
    // Isolate these two migrations so later API migrations cannot change which
    // migration down 1 reverses.
    for (const file of await readdir(path.join(dir, 'migrations'))) {
      if (!/^[0-9]+_sabredav-(calendars|propertystorage)\.mjs$/.test(file))
        await rm(path.join(dir, 'migrations', file));
    }
    const configPath = path.join(dir, 'migrate.config.json');
    assert.equal(migrate(name, ['up'], configPath).status, 0);
    assert.equal(migrate(name, ['down', '1'], configPath).status, 0);
    assert.deepEqual(
      await tables(client, true),
      expected.filter((table) => table !== 'sabredav.propertystorage'),
    );
    assert.equal(
      (await client.query('SELECT count(*)::int AS n FROM public.pgmigrations'))
        .rows[0].n,
      1,
    );
    assert.equal(migrate(name, ['up'], configPath).status, 0);
    assert.deepEqual(await tables(client, true), expected);
    assert.equal(
      (await client.query('SELECT count(*)::int AS n FROM public.pgmigrations'))
        .rows[0].n,
      2,
    );
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
      const result = migrate(
        name,
        ['up'],
        path.join(dir, 'migrate.config.json'),
      );
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
    await mkdir(path.join(dir, 'migrations'));
    await writeFile(
      path.join(dir, 'migrations', `${Date.now()}_irreversible.mjs`),
      "export const up = pgm => pgm.sql('CREATE TABLE public.irreversible (id integer)');\n// No down: test of intentional irreversibility.\nexport const down = false;\n",
    );
    assert.equal(
      migrate(name, ['up'], path.join(dir, 'migrate.config.json')).status,
      0,
    );
    const first = (await client.query('SELECT * FROM public.pgmigrations'))
      .rows;
    const result = migrate(
      name,
      ['down', '1'],
      path.join(dir, 'migrate.config.json'),
    );
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
    const root = await fixture();
    const dir = path.join(root, 'migrations');
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
    const result = migrate(
      name,
      ['up'],
      path.join(root, 'migrate.config.json'),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /deliberately_missing_table/);
    await empty(client);
  } finally {
    await client.end();
  }
});
