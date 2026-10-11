// --- E05-R08: the stack suite stands on production dependencies only ---------
//
// `make test-api-caldav` runs `test/integration/*.test.mjs` inside
// `server/api/Dockerfile`'s `test` target, and that image is built from
// `corepack pnpm install --frozen-lockfile --prod`: it carries the production
// dependencies, `src/`, `test/` and nothing else. So an integration suite may
// import `node:` modules, `pg` and this package's `src/` — and a bare specifier
// that is only a devDependency (`yaml`, for one) makes the whole suite fail to
// load with `ERR_MODULE_NOT_FOUND`, which is a broken `make test-api-caldav`
// rather than a failing test.
//
// That happened: `test/integration/changes.test.mjs` imported
// `test/support/problem.mjs`, which reads `spec/openapi.yaml` with `yaml`. This
// test reads the imports of every integration suite — and, transitively, of the
// modules they reach — and refuses anything the image cannot resolve. It is
// database-free and dependency-free on purpose: it runs in the unit suite,
// where the mistake is cheap to make and cheap to catch.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/** This package's root, from `test/`. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INTEGRATION = join(PACKAGE_ROOT, 'test', 'integration');

/** The `test/` module the stack suite must not import (it needs a devDependency). */
const FORBIDDEN = join(PACKAGE_ROOT, 'test', 'support', 'problem.mjs');

/** @type {{dependencies?: Record<string, string>}} */
const manifest = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
);
/** The packages the `api-test` image installs, and the only bare ones allowed. */
const PRODUCTION = new Set(Object.keys(manifest.dependencies ?? {}));

/**
 * The static import specifiers of one module: a top-level `import` statement
 * (which is what a module loader resolves) begins at the start of a line, so a
 * specifier quoted inside a comment is never read as one.
 */
const IMPORT = /^import\s+(?:[^;'"]*?\bfrom\s+)?['"]([^'"]+)['"]/gm;

/** @param {string} text @returns {string[]} */
function specifiersOf(text) {
  return [...text.matchAll(IMPORT)].map((match) => match[1]);
}

/**
 * Every module reachable from `entry` through relative imports, and every bare
 * specifier seen on the way. A specifier that is neither `node:` nor a
 * `dependencies` entry is reported with the file that needs it.
 * @param {string} entry
 * @returns {{visited: string[], missing: string[]}}
 */
function reachable(entry) {
  /** @type {string[]} */
  const visited = [];
  /** @type {string[]} */
  const missing = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const pending = [entry];
  while (pending.length > 0) {
    const file = /** @type {string} */ (pending.pop());
    if (seen.has(file)) continue;
    seen.add(file);
    visited.push(file);
    for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        pending.push(resolve(dirname(file), specifier));
        continue;
      }
      if (specifier.startsWith('node:')) continue;
      if (PRODUCTION.has(specifier)) continue;
      missing.push(`${file}: ${specifier}`);
    }
  }
  return { visited, missing };
}

test('every integration suite imports only what the api-test image installs', () => {
  const suites = readdirSync(INTEGRATION)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort();
  // A path that stopped matching would leave nothing to check.
  assert.ok(suites.length >= 4, `found only ${suites.length} suites`);

  for (const name of suites) {
    const { visited, missing } = reachable(join(INTEGRATION, name));
    assert.deepEqual(
      missing,
      [],
      `${name} needs a package the test image does not install`,
    );
    assert.ok(
      visited.includes(join(INTEGRATION, name)),
      `${name} was not read`,
    );
    assert.equal(
      visited.includes(FORBIDDEN),
      false,
      `${name} imports test/support/problem.mjs, which reads the spec with "yaml"`,
    );
  }
});
