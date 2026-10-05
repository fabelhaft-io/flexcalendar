import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const checker = resolve(directory, 'invariants.mjs');
const fixtures = JSON.parse(
  readFileSync(resolve(directory, 'fixtures/invariants-bad.json'), 'utf8'),
);

/** @param {Record<string, any>} files @param {(root: string) => void} check */
function tree(files, check) {
  // Test writes remain inside the requirement's writable subtree, never /tmp.
  const root = mkdtempSync(resolve(directory, '.invariant-test-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      const target = resolve(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(
        target,
        typeof content === 'string' ? content : JSON.stringify(content),
      );
    }
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** @param {string} invariant @param {string} root */
function run(invariant, root) {
  return spawnSync(process.execPath, [checker, invariant, root], {
    encoding: 'utf8',
  });
}

for (const fixture of fixtures) {
  test(`rejects ${fixture.label} for ${fixture.invariant}`, () => {
    tree(fixture.files, (root) => {
      const result = run(fixture.invariant, root);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(
        result.stderr,
        `${fixture.invariant}: ${fixture.reason}${fixture.invariant === 'INV-05' ? '; send an intent instead.' : fixture.reason.startsWith('unreviewed') ? '; a non-content-crypto justification is required.' : ' in server tree.'}\n`,
      );
    });
  });
}

for (const invariant of ['INV-05', 'INV-07']) {
  test(`${invariant} passes the current tree through its CLI`, () => {
    const result = run(invariant, resolve(directory, '../..'));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${invariant}: pass\n`);
    assert.equal(result.stderr, '');
  });
}

test('INV-05 ignores documentation/data and allows intent code', () => {
  tree(
    {
      'apps/web/src/edit.ts': 'export const intent = { scope: "occurrence" };',
      'apps/web/README.md': 'Do not emit EXDATE or RECURRENCE-ID.',
      'apps/web/test/data.ics': 'EXDATE:',
      'server/api/edit.ts': 'export const property = "EXDATE";',
    },
    (root) => assert.equal(run('INV-05', root).status, 0),
  );
});

test('INV-07 only traverses server roots, supports multi-document pnpm lock and peer suffixes', () => {
  tree(
    {
      'server/nested/api/package.json': { dependencies: { fastify: '5.12.5' } },
      'pnpm-lock.yaml':
        '---\nimporters: {".": {}}\n---\n' +
        JSON.stringify({
          importers: {
            'server/nested/api': {
              dependencies: { fastify: { version: '5.12.5(peer@1.0.0)' } },
            },
            'apps/web': { dependencies: { tweetnacl: { version: '1.0.0' } } },
          },
          snapshots: {
            'fastify@5.12.5(peer@1.0.0)': {},
            'tweetnacl@1.0.0': {},
          },
        }),
      'server/php/composer.json': { require: { 'react/socket': '*' } },
      'server/php/composer.lock': {
        packages: [
          {
            name: 'react/socket',
            require: { 'ext-openssl': '*' },
            'require-dev': { 'uninstalled-dev-cipher': '*' },
          },
        ],
        'packages-dev': [],
      },
    },
    (root) => assert.equal(run('INV-07', root).status, 0),
  );
});

test('reviewed workspace dependencies are traversed rather than blanket rejected', () => {
  tree(
    {
      'server/api/package.json': {
        dependencies: { 'local-http': 'workspace:*' },
      },
      'packages/http/package.json': { name: 'fastify' },
      'pnpm-lock.yaml': JSON.stringify({
        importers: {
          'server/api': {
            dependencies: {
              'local-http': { version: 'link:../../packages/http' },
            },
          },
          'packages/http': {},
        },
        snapshots: {},
      }),
    },
    (root) => assert.equal(run('INV-07', root).status, 0),
  );
});

test('malformed input fails closed without logging input contents', () => {
  tree(
    {
      'server/api/package.json': 'sensitive-marker malformed JSON',
      'pnpm-lock.yaml': '{ broken',
    },
    (root) => {
      const result = run('INV-07', root);
      assert.equal(result.status, 1);
      assert.equal(
        result.stderr,
        'Invariant check input error (no source data logged).\n',
      );
      assert.equal(result.stdout, '');
    },
  );
});

test('missing transitive snapshots cannot silently pass', () => {
  tree(
    {
      'server/api/package.json': { dependencies: { fastify: '*' } },
      'pnpm-lock.yaml': JSON.stringify({
        importers: {
          'server/api': { dependencies: { fastify: { version: '5.12.5' } } },
        },
        snapshots: {},
      }),
    },
    (root) => {
      const result = run('INV-07', root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /input error/);
    },
  );
});
