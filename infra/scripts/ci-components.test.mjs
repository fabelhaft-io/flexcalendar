import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { selectComponents } from './ci-components.mjs';
import { component } from './verify.mjs';

test('web-only selects web, without unrelated component gates', () => {
  assert.deepEqual(selectComponents(['apps/web/src/app.tsx']), {
    full: false,
    selected: ['apps-web'],
  });
  // The current web directory is a layout placeholder. The same make target
  // begins running its four gates automatically when its manifest arrives.
  component('apps-web');
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
    assert.ok(selection.selected.includes('apps-web'));
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
    ]).selected.includes('apps-web'),
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
  assert.ok(selection.selected.includes('apps-web'));
  assert.ok(selection.selected.includes('server-api'));
});

test('change detector executes a real git diff happy path', () => {
  const result = spawnSync(
    process.execPath,
    ['infra/scripts/ci-components.mjs', 'HEAD', 'HEAD'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /has-components=false/);
});
