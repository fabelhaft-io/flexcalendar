import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { selectComponents } from './ci-components.mjs';
import { components, component } from './verify.mjs';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('README-only web selects no component and is not a verification package', () => {
  assert.deepEqual(selectComponents(['apps/web/README.md']), {
    full: false,
    selected: [],
  });
  assert.throws(() => component('apps-web'), /Unknown verification component/);
});
test('web with a manifest is discovered and selected in a fixture tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-components-'));
  try {
    mkdirSync(join(root, 'infra/scripts'), { recursive: true });
    mkdirSync(join(root, 'apps/web'), { recursive: true });
    writeFileSync(join(root, 'apps/web/package.json'), '{}');
    copyFileSync(
      'infra/scripts/verify.mjs',
      join(root, 'infra/scripts/verify.mjs'),
    );
    const fixture = await import(
      pathToFileURL(join(root, 'infra/scripts/verify.mjs')).href
    );
    assert.deepEqual(
      selectComponents(['apps/web/src/app.tsx'], fixture.components()),
      {
        full: false,
        selected: ['apps-web'],
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('cross-cutting files select every component and full verify', () => {
  for (const path of [
    'Makefile',
    'pnpm-lock.yaml',
    'infra/scripts/check-pins.mjs',
    '.github/workflows/verify.yml',
  ]) {
    const selection = selectComponents([path]);
    assert.equal(selection.full, true);
    assert.ok(selection.selected.includes('server-caldav'));
    assert.ok(selection.selected.includes('apps-mobile'));
    assert.deepEqual(
      selection.selected,
      components()
        .map(({ name }) => name)
        .filter((name) => name !== 'tooling'),
    );
  }
});
test('component filters, shared dependencies, deletions and docs-only PRs', () => {
  assert.deepEqual(selectComponents(['server/caldav/deleted.php']).selected, [
    'server-caldav',
  ]);
  assert.ok(
    selectComponents(['packages/crypto_dart/lib/key.dart']).selected.includes(
      'apps-mobile',
    ),
  );
  assert.ok(
    selectComponents([
      'packages/api-client-ts/src/client.ts',
    ]).selected.includes('server-api'),
  );
  assert.deepEqual(selectComponents(['docs/02-technology-choices.md']), {
    full: false,
    selected: [],
  });
});
test('mixed shared-package changes select the union of consumers', () => {
  const selection = selectComponents([
    'packages/api-client-ts/src/client.ts',
    'packages/crypto_dart/lib/key.dart',
  ]);
  assert.ok(selection.selected.includes('apps-mobile'));
  assert.ok(!selection.selected.includes('apps-web'));
  assert.ok(selection.selected.includes('server-api'));
});

test('change detector executes a real git diff happy path', () => {
  const env = { ...process.env };
  delete env.GITHUB_OUTPUT;
  const result = spawnSync(
    process.execPath,
    ['infra/scripts/ci-components.mjs', 'HEAD', 'HEAD'],
    { encoding: 'utf8', env },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    'full=false\ncomponents=["tooling"]\nhas-components=false\n',
  );
});

test('change detector writes GitHub outputs to a file instead of stdout', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-components-output-'));
  try {
    const output = join(root, 'output');
    const result = spawnSync(
      process.execPath,
      ['infra/scripts/ci-components.mjs', 'HEAD', 'HEAD'],
      {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: output },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(
      readFileSync(output, 'utf8'),
      'full=false\ncomponents=["tooling"]\nhas-components=false\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
