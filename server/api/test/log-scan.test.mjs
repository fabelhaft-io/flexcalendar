// --- E05-R10: the log-marker scan, exercised on its own ----------------------
//
// `make test-caldav` and `make test-api-caldav` hand the real `compose logs`
// output to the `check-log-canaries` target. That target is a shell one-liner,
// so the only honest way to check it is to run it: this file plants a marker in
// a file and asserts the target fails, then runs it on a clean file and asserts
// it passes. It also holds the Makefile's fixed correlation ID and the
// integration suite's copy of it together, so the "the request ID reaches the
// CalDAV log" check cannot silently drift.
//
// Nothing here needs Podman, Postgres or a container: it runs `make`, which the
// repository already requires.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repository = fileURLToPath(new URL('../../..', import.meta.url));
const makefile = await readFile(path.join(repository, 'Makefile'), 'utf8');
const integrationTest = await readFile(
  new URL('./integration/caldav-adapter.test.mjs', import.meta.url),
  'utf8',
);

/** Every value a suite plants in content, envelopes or a request body. */
const markers = [
  'CALFLEX_REJECTED_HEADER_CANARY',
  'CALFLEX_REJECTED_BODY_CANARY',
  'CALFLEX_EVENT_CONTENT_CANARY',
  'CALFLEX_API_PROPERTY_CANARY',
  'CALFLEX_API_ENVELOPE_CANARY',
  'CALFLEX_API_BODY_CANARY',
  'CALFLEX_GUARD_MARKER',
];

/** The `CALFLEX_LOG_CANARIES` value the Makefile declares. */
const canaryPattern = (() => {
  const match = /^CALFLEX_LOG_CANARIES \?= (.+)$/m.exec(makefile);
  assert.ok(match, 'the Makefile declares CALFLEX_LOG_CANARIES');
  return match[1].trim();
})();

/** The fixed correlation ID the Makefile looks for in the CalDAV log. */
const makeRequestId = (() => {
  const match = /^CALFLEX_API_REQUEST_ID \?= (.+)$/m.exec(makefile);
  assert.ok(match, 'the Makefile declares CALFLEX_API_REQUEST_ID');
  return match[1].trim();
})();

/**
 * Runs the real target against one log file.
 * @param {string} file
 * @returns {Promise<{code: number, stderr: string}>}
 */
async function scan(file) {
  try {
    const { stderr } = await run(
      'make',
      ['check-log-canaries', `LOGS=${file}`],
      { cwd: repository },
    );
    return { code: 0, stderr };
  } catch (error) {
    return {
      code: /** @type {any} */ (error).code,
      stderr: String(/** @type {any} */ (error).stderr ?? ''),
    };
  }
}

test('the scan passes a clean log and fails one marker per run', async () => {
  for (const marker of markers) {
    // Every marker really is in the pattern the target greps for.
    assert.match(marker, new RegExp(canaryPattern), marker);
  }
  assert.doesNotMatch('a line of ordinary output', new RegExp(canaryPattern));

  const directory = await mkdtemp(path.join(tmpdir(), 'calflex-logs-'));
  try {
    const clean = path.join(directory, 'clean.log');
    await writeFile(
      clean,
      [
        'caldav request GET 207 11111111-2222-4333-8444-555555555555',
        'caldav delegation_denied malformed -',
        '{"level":30,"msg":"request","route":"/me","status":200}',
        '',
      ].join('\n'),
    );
    assert.deepEqual(await scan(clean), { code: 0, stderr: '' });

    for (const marker of markers) {
      const planted = path.join(directory, 'planted.log');
      await writeFile(planted, `some prefix ${marker} some suffix\n`);
      const result = await scan(planted);
      // `make` reports a failed recipe as exit 2 whatever the recipe returned;
      // the message is what names the failure.
      assert.equal(result.code, 2, `${marker} was not caught`);
      assert.match(result.stderr, /logs leaked test canary data/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the scan refuses to run without a log file', async () => {
  try {
    await run('make', ['check-log-canaries'], { cwd: repository });
    assert.fail('the target must refuse an empty LOGS');
  } catch (/** @type {any} */ error) {
    assert.equal(error.code, 2);
    assert.match(String(error.stderr), /LOGS=<file> is required/);
  }
});

test('both suites scan their logs, and the fixed request ID is the same in both places', () => {
  const recipe = (/** @type {string} */ target) => {
    const match = new RegExp(`^${target}:.*\\n((?:\\t[^\\n]*\\n)*)`, 'm').exec(
      makefile,
    );
    return match?.[1] ?? '';
  };

  for (const target of ['test-caldav', 'test-api-caldav']) {
    const body = recipe(target);
    assert.ok(body.includes('--profile test run --build --rm -T'), target);
    assert.ok(
      body.includes('check-log-canaries'),
      `${target} does not run the marker scan`,
    );
  }
  // The API suite scans both logs and asserts the correlation ID arrived.
  const apiTest = recipe('test-api-caldav');
  assert.match(apiTest, /\$\(COMPOSE\) logs caldav api/);
  assert.match(apiTest, /CALFLEX_API_REQUEST_ID/);

  // The integration suite sends the same ID the Makefile greps for.
  const declared = /const REQUEST_ID = '([0-9a-f-]+)'/.exec(integrationTest);
  assert.ok(declared, 'the integration suite declares REQUEST_ID');
  assert.equal(declared[1], makeRequestId);
  assert.match(
    makeRequestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});
