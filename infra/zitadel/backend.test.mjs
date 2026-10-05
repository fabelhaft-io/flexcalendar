import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { run } from './run.mjs';

test('state shares the Zitadel database lifecycle, not a profile-only volume', async () => {
  const compose = parse(await readFile('infra/dev/compose.yaml', 'utf8'));
  const config = compose.services['zitadel-config'];
  assert.match(
    config.environment.PG_CONN_STR,
    /@postgres:5432\/zitadel\?sslmode=disable/,
  );
  assert.match(config.environment.PG_CONN_STR, /CALFLEX_TOFU_PG_CONN_STR/);
  assert.equal(Object.hasOwn(compose.volumes, 'zitadel-state'), false);
  assert.ok(!config.volumes.some((volume) => volume.includes('/state')));
  const versions = await readFile('infra/zitadel/versions.tf', 'utf8');
  assert.match(
    versions,
    /backend "pg"\s*\{\s*schema_name = "calflex_tofu"\s*\}/,
  );
  assert.doesNotMatch(versions, /backend "local"/);
});

test('missing database connection fails before credentials or APIs are read', async () => {
  await assert.rejects(
    run({ args: ['apply'], env: { CALFLEX_SEED_PAT_PATH: '/not-readable' } }),
    /PG_CONN_STR must point/,
  );
});

test('make seed builds only the config image and runs without --build', async (t) => {
  await mkdir('infra/zitadel/.tools', { recursive: true });
  const directory = await mkdtemp('infra/zitadel/.tools/seed-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = `${directory}/commands.jsonl`;
  await writeFile(
    `${directory}/compose.mjs`,
    `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');`,
  );
  const result = spawnSync(
    'make',
    ['seed', `COMPOSE=node ${directory}/compose.mjs`],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const commands = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(commands, [
    ['up', '--detach', '--wait'],
    ['--profile', 'seed', 'run', '--rm', 'seed'],
    ['--profile', 'seed', 'build', 'zitadel-config'],
    ['--profile', 'seed', 'run', '--rm', '-T', 'zitadel-config', 'apply'],
  ]);
});
