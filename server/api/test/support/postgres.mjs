import assert from 'node:assert/strict';
import { before, after } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'yaml';
import pg from 'pg';

const api = fileURLToPath(new URL('../../', import.meta.url));
const cli = path.join(
  api,
  'node_modules/node-pg-migrate/bin/node-pg-migrate.js',
);
let container = '';
let port = 0;
let nextDatabase = 0;
const password = 'migration-test-only';
/** @param {string} database */
export const config = (database, user = 'calflex_migrate') => ({
  host: '127.0.0.1',
  port,
  user,
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
        new URL('../../../../infra/dev/compose.yaml', import.meta.url),
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
      '-e',
      `CALFLEX_MIGRATE_PASSWORD=${password}`,
      '-e',
      `CALFLEX_API_PASSWORD=${password}`,
      '-e',
      `CALFLEX_CALDAV_PASSWORD=${password}`,
      '-v',
      `${fileURLToPath(new URL('../../../../infra/dev/postgres/initdb', import.meta.url))}:/docker-entrypoint-initdb.d:ro`,
      `docker.io/library/${image}`,
    ]);
    const mapping = podman(['port', container, '5432/tcp']);
    const match = /^127\.0\.0\.1:(\d+)$/.exec(mapping);
    assert.ok(match, 'Postgres must publish only an ephemeral loopback port');
    port = Number(match[1]);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const client = new pg.Client(config('postgres', 'postgres'));
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

after(() => {
  if (container) podman(['stop', '--time', '5', container]);
});

export async function fresh() {
  const name = `migration_test_${++nextDatabase}`;
  const admin = new pg.Client(config('postgres', 'postgres'));
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name} OWNER calflex_migrate`);
  } finally {
    await admin.end();
  }
  const databaseAdmin = new pg.Client(config(name, 'postgres'));
  try {
    await databaseAdmin.connect();
    await databaseAdmin.query('ALTER SCHEMA public OWNER TO calflex_migrate');
  } finally {
    await databaseAdmin.end();
  }
  const client = new pg.Client(config(name));
  await client.connect();
  return { name, client };
}
/** @param {string} database @param {string[]} [direction] @param {string} [configPath] */
export function migrate(
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
        CALFLEX_MIGRATE_DATABASE_URL: `postgresql://calflex_migrate:${password}@127.0.0.1:${port}/${database}`,
      },
    },
  );
}
