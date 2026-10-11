// --- E05-R02: one module talks CalDAV ----------------------------------------
//
// The acceptance criterion is a lint rule, so this suite runs the real ESLint
// CLI with the repository's own `eslint.config.mjs` against real files: it
// shows an import of `tsdav` outside the adapter failing with that rule and the
// adapter passing. The second half is the same rule's other half — no other
// module under `server/api/src/` may so much as name the principal header, the
// origin variable or the delegation keys.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const api = fileURLToPath(new URL('../', import.meta.url));
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const adapter = path.join(api, 'src', 'caldav', 'adapter.mjs');
const eslintCli = path.join(
  repository,
  'node_modules',
  'eslint',
  'bin',
  'eslint.js',
);

/**
 * Runs the repository's ESLint over the given files and returns its JSON report.
 * @param {string[]} files
 */
function lint(files) {
  const run = spawnSync(
    process.execPath,
    [eslintCli, '--config', 'eslint.config.mjs', '--format', 'json', ...files],
    { cwd: repository, encoding: 'utf8', timeout: 120_000 },
  );
  if (run.error) throw run.error;
  // ESLint exits 1 when it reports an error, which is exactly what is asserted
  // below; anything else (a missing config, a crash) must not be mistaken for it.
  assert.ok(run.status === 0 || run.status === 1, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout);
  assert.ok(
    Array.isArray(report) && report.length === files.length,
    run.stdout,
  );
  // ESLint returns the results for a multi-file run in its own order.
  return new Map(report.map((entry) => [entry.filePath, entry]));
}

/** @param {unknown[]} messages */
const ruleIds = (messages) =>
  messages.map((message) => /** @type {{ruleId?: string}} */ (message).ruleId);

test('the repository ESLint forbids importing tsdav outside the adapter', async () => {
  assert.ok(
    eslintCli.startsWith(repository) &&
      (await readFile(eslintCli, 'utf8')).length > 0,
    'the workspace ESLint devDependency must be installed to run this gate',
  );
  const directory = await mkdtemp(path.join(api, 'test', 'lint-probe-'));
  /** @param {string} name @param {string} code @returns {Promise<string>} */
  const probe = async (name, code) => {
    const file = path.join(directory, name);
    await writeFile(file, code);
    return file;
  };
  try {
    /** @type {[string, string, string | null][]} */
    const cases = [
      [
        'static.mjs',
        "import { DAVClient } from 'tsdav';\nexport const x = DAVClient;\n",
        'no-restricted-imports',
      ],
      [
        'subpath.mjs',
        "import { davRequest } from 'tsdav/dist/tsdav.mjs';\nexport const x = davRequest;\n",
        'no-restricted-imports',
      ],
      [
        'dynamic.mjs',
        "export const x = await import('tsdav');\n",
        'no-restricted-syntax',
      ],
      [
        'computed.mjs',
        "const name = 'tsdav';\nexport const x = await import(name);\n",
        null,
      ],
    ];
    const files = new Map();
    for (const [name, code] of cases) files.set(name, await probe(name, code));
    // A file with no tsdav import is the control: the rule is not a blanket ban.
    files.set(
      'control.mjs',
      await probe(
        'control.mjs',
        "import { readFile } from 'node:fs/promises';\nexport const x = readFile;\n",
      ),
    );
    const reports = lint([...files.values(), adapter]);

    /** @param {string} name */
    const reportFor = (name) => {
      const report = reports.get(files.get(name));
      assert.ok(report, `${name} was not linted`);
      return report;
    };
    assert.deepEqual(ruleIds(reportFor('static.mjs').messages), [
      'no-restricted-imports',
    ]);
    assert.deepEqual(ruleIds(reportFor('subpath.mjs').messages), [
      'no-restricted-imports',
    ]);
    assert.deepEqual(ruleIds(reportFor('dynamic.mjs').messages), [
      'no-restricted-syntax',
    ]);
    // A computed specifier is not a static import; it is caught by review, not
    // by this rule, and that limit is recorded here rather than implied.
    assert.deepEqual(ruleIds(reportFor('computed.mjs').messages), []);
    assert.deepEqual(ruleIds(reportFor('control.mjs').messages), []);
    const adapterReport = reports.get(adapter);
    assert.ok(adapterReport, 'the adapter was not linted');
    assert.deepEqual(adapterReport.messages, []);
    assert.equal(reportFor('static.mjs').errorCount, 1);
    assert.equal(reportFor('dynamic.mjs').errorCount, 1);
    assert.match(String(reportFor('static.mjs').messages[0]?.message), /tsdav/);
    assert.match(
      String(reportFor('static.mjs').messages[0]?.message),
      /E05-R02/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('only the adapter knows the delegation material', async () => {
  /** @param {string} directory @returns {Promise<string[]>} */
  const sources = async (directory) => {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...(await sources(full)));
      else files.push(full);
    }
    return files;
  };

  const files = await sources(path.join(api, 'src'));
  assert.ok(
    files.includes(adapter),
    'the adapter must live under server/api/src',
  );
  assert.ok(files.length > 1, 'the scan must see the rest of the service');
  const forbidden = [
    /X-Calflex-Principal/i,
    /CALFLEX_CALDAV_ORIGIN/,
    /CALFLEX_DELEGATION_KEYS/,
    /from\s+['"]tsdav['"]/,
    /import\s*\(\s*['"]tsdav['"]\s*\)/,
    /require\s*\(\s*['"]tsdav['"]\s*\)/,
  ];
  for (const file of files) {
    if (file === adapter) continue;
    const text = await readFile(file, 'utf8');
    const relative = path.relative(repository, file);
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(text), `${relative} matches ${pattern}`);
    }
  }
  // And the adapter itself is where all of it lives.
  const text = await readFile(adapter, 'utf8');
  for (const pattern of [
    forbidden[0],
    forbidden[1],
    forbidden[2],
    forbidden[3],
  ]) {
    assert.ok(pattern.test(text), `the adapter must match ${pattern}`);
  }
  // It logs nothing: no event content, no header, no URL can reach a log line.
  assert.ok(!/console\./.test(text), 'the adapter must not log');
});
