import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  chmodSync,
} from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { cryptoName } from './invariants.mjs';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const checker = resolve(directory, 'invariants.mjs');
const fixtures = JSON.parse(
  readFileSync(resolve(directory, 'fixtures/invariants-bad.json'), 'utf8'),
);

/** @param {Record<string, any>} files @param {(root: string) => void} check */
function tree(files, check) {
  const root = mkdtempSync(join(tmpdir(), 'calendar-flex-invariant-test-'));
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
      assert.equal(result.stderr, `${fixture.diagnostic}\n`);
    });
  });
}

for (const invariant of ['INV-03', 'INV-05', 'INV-07']) {
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
        'Invariant check input error: pnpm-lock.yaml (no source data logged).\n',
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

const goodFixtures = JSON.parse(
  readFileSync(resolve(directory, 'fixtures/invariants-good.json'), 'utf8'),
);
for (const fixture of goodFixtures) {
  test(`allows ${fixture.label} for ${fixture.invariant}`, () => {
    tree(fixture.files, (root) => {
      const result = run(fixture.invariant, root);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, `${fixture.invariant}: pass\n`);
      assert.equal(result.stderr, '');
    });
  });
}

test('INV-05 skips symlinks and Flutter generated directories', () => {
  tree(
    {
      'apps/mobile/ios/.symlinks/plugins/ignored.dart': 'EXDATE',
      'apps/mobile/ios/Flutter/ephemeral/ignored.dart': 'RECURRENCE-ID',
      'packages/ordinary/emitter.dart': 'EXDATE',
    },
    (root) => {
      symlinkSync(
        '../../..',
        resolve(root, 'apps/mobile/ios/.symlinks/plugins/loop'),
      );
      symlinkSync('../..', resolve(root, 'apps/mobile/loop'));
      symlinkSync('missing.dart', resolve(root, 'apps/mobile/dangling.dart'));
      symlinkSync('ordinary', resolve(root, 'packages/crypto_link'));
      const result = run('INV-05', root);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
    },
  );
});

for (const name of [
  'crypt',
  'cipher',
  'sodium',
  'nacl',
  'aes',
  'chacha',
  'salsa',
  'poly1305',
  '25519',
  'secp',
  'elliptic',
  'jose',
  'jwe',
  'pgp',
  'openssl',
  'tls',
  'ssl',
  'hash',
  'hmac',
  'sha',
  'argon',
  'bcrypt',
  'scrypt',
  'pbkdf',
]) {
  test(`crypto-name heuristic rejects unreviewed ${name} packages`, () => {
    const packageName = `@example/${name}256-util`;
    assert.equal(cryptoName(packageName), true);
    tree(
      {
        'server/api/package.json': { dependencies: { [packageName]: '1.0.0' } },
        'pnpm-lock.yaml': JSON.stringify({
          importers: {
            'server/api': {
              dependencies: { [packageName]: { version: '1.0.0' } },
            },
          },
          snapshots: { [`${packageName}@1.0.0`]: {} },
        }),
      },
      (root) => {
        const result = run('INV-07', root);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.equal(
          result.stderr,
          ['sodium', 'nacl'].includes(name)
            ? `INV-07: content-crypto dependency ${packageName}@1.0.0 in server tree.\n`
            : `INV-07: unreviewed crypto-looking dependency ${packageName}@1.0.0; a non-content-crypto justification is required.\n`,
        );
      },
    );
  });
}

test('short crypto names match segments, not arbitrary substrings', () => {
  for (const name of [
    'shared-utils',
    'shallow',
    'please',
    'joseph',
    'tlsutil',
    'sslutil',
    'jweutil',
    'pgputil',
  ]) {
    assert.equal(cryptoName(name), false, name);
  }
  for (const delimiter of ['-', '_', '.', '/', '@', '2']) {
    for (const name of ['aes', 'sha', 'tls', 'ssl', 'jwe', 'pgp', 'jose']) {
      assert.equal(
        cryptoName(`prefix${delimiter}${name}${delimiter}suffix`),
        true,
      );
    }
  }
});

for (const [path, content] of [
  ['server/api/package.json', 'sensitive-marker malformed JSON'],
  ['server/php/composer.lock', 'sensitive-marker malformed JSON'],
]) {
  test(`input errors name ${path} without contents`, () => {
    tree(
      {
        'server/api/package.json': {},
        'pnpm-lock.yaml': JSON.stringify({ importers: { 'server/api': {} } }),
        'server/php/composer.json': {},
        'server/php/composer.lock': { packages: [], 'packages-dev': [] },
        [path]: content,
      },
      (root) => {
        const result = run('INV-07', root);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.equal(
          result.stderr,
          `Invariant check input error: ${path} (no source data logged).\n`,
        );
      },
    );
  });
}

/** @param {string} label @param {string} path */
const uuidDiagnostic = (label, path) =>
  `INV-03: non-v4 UUID generator ${label} in ${path}; generated IDs must be a random UUIDv4.\n`;

test('INV-03 decides on whole tokens and cannot let a longer identifier hide a real generator', () => {
  tree(
    { 'server/api/src/tokens.ts': 'export const my_uuidv7_free = 1;' },
    (root) => {
      const result = run('INV-03', root);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, 'INV-03: pass\n');
    },
  );
  tree(
    {
      'server/api/src/tokens.ts':
        'export const my_uuidv7_free = 1; const id = uuidv7();',
    },
    (root) => {
      const result = run('INV-03', root);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(
        result.stderr,
        uuidDiagnostic('uuidv7()', 'server/api/src/tokens.ts'),
      );
    },
  );
});

test('INV-03 allows the v4 uuid-ossp function and flags a non-v4 sibling', () => {
  tree({ 'server/api/db/x.sql': 'SELECT uuid_generate_v4();' }, (root) =>
    assert.equal(run('INV-03', root).status, 0),
  );
  tree({ 'server/api/db/x.sql': 'SELECT uuid_generate_v1mc();' }, (root) => {
    const result = run('INV-03', root);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      uuidDiagnostic('uuid_generate_v1mc()', 'server/api/db/x.sql'),
    );
  });
});

test('INV-03 flags a generator name in a comment, as a literal-name tripwire', () => {
  tree({ 'server/api/src/legacy.ts': '// uuidv7() is forbidden' }, (root) => {
    const result = run('INV-03', root);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      uuidDiagnostic('uuidv7()', 'server/api/src/legacy.ts'),
    );
  });
});

test('INV-03 ignores installed dependencies and skips symlinks', () => {
  tree(
    {
      'server/api/node_modules/pkg/ids.ts': 'export const id = uuidv7();',
      'apps/web/node_modules/pkg/ids.dart': 'final id = uuid1();',
      'outside/leak.ts': 'export const id = uuid7();',
    },
    (root) => {
      symlinkSync('../../outside/leak.ts', resolve(root, 'server/api/leak.ts'));
      const result = run('INV-03', root);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, 'INV-03: pass\n');
      assert.equal(result.stderr, '');
    },
  );
});

test(
  'INV-03 fails closed on an unreadable file',
  { skip: typeof process.getuid === 'function' && process.getuid() === 0 },
  () => {
    tree({ 'server/api/locked.ts': 'export const id = 1;' }, (root) => {
      chmodSync(resolve(root, 'server/api/locked.ts'), 0o000);
      const result = run('INV-03', root);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(
        result.stderr,
        'Invariant check input error: server/api/locked.ts (no source data logged).\n',
      );
    });
  },
);
