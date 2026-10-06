import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, suite, run, components, component } from './verify.mjs';

test('empty suites report success, registrations execute and failures propagate', () => {
  const dir = mkdtempSync(resolve(root, 'infra/scripts/verify/fixture-'));
  try {
    /** @type {string[]} */
    const messages = [];
    const originalLog = console.log;
    try {
      console.log = (message) => messages.push(message);
      suite(dir, 'fixture');
    } finally {
      console.log = originalLog;
    }
    assert.deepEqual(messages, ['fixture: no registered checks yet; pass']);
    const marker = resolve(dir, 'executed');
    writeFileSync(
      resolve(dir, 'check.json'),
      JSON.stringify([
        [
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`,
        ],
      ]),
    );
    suite(dir, 'fixture');
    assert.ok(components().some((item) => item.name === 'server-api'));
    assert.equal(readMarker(marker), 'ok');
    writeFileSync(
      resolve(dir, 'check.json'),
      JSON.stringify([[process.execPath, '-e', 'process.exit(7)']]),
    );
    assert.throws(
      () => suite(dir, 'fixture'),
      /check\.json: entry 1: verification failed/,
    );
    writeFileSync(resolve(dir, 'check.json'), '[]');
    assert.throws(() => suite(dir, 'fixture'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
/** @param {string} path */
function readMarker(path) {
  return readFileSync(path, 'utf8');
}

test('unknown components and hung or failed checks fail closed', () => {
  assert.throws(() => component('unknown'));
  assert.throws(() => run([process.execPath, '-e', 'process.exit(1)']));
  assert.throws(() =>
    run([process.execPath, '-e', 'setInterval(() => {}, 1000)'], root, 50),
  );
});

test('all orchestrates components before stack suites and stops on first failure', () => {
  const dir = mkdtempSync(resolve(root, 'infra/scripts/verify/orchestration-'));
  try {
    const log = resolve(dir, 'calls');
    const make = resolve(dir, 'make');
    writeFileSync(
      make,
      '#!/bin/sh\nprintf "%s\\n" "$1" >> "$VERIFY_TEST_LOG"\n[ "$1" != "$VERIFY_TEST_FAIL" ]\n',
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      VERIFY_TEST_LOG: log,
    };
    const command = resolve(root, 'infra/scripts/verify.mjs');
    const happy = spawnSync(process.execPath, [command, 'all'], { env });
    assert.equal(happy.status, 0);
    const expected = [
      ...components().map(({ name }) => `verify-${name}`),
      'gen-check',
      'check-stack',
      'test-seed',
      'verify-invariants',
      'verify-corpus',
    ];
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), expected);
    writeFileSync(log, '');
    const generationFailure = spawnSync(process.execPath, [command, 'all'], {
      env: { ...env, VERIFY_TEST_FAIL: 'gen-check' },
    });
    assert.notEqual(generationFailure.status, 0);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
      ...components().map(({ name }) => `verify-${name}`),
      'gen-check',
    ]);
    writeFileSync(log, '');
    const failure = spawnSync(process.execPath, [command, 'all'], {
      env: { ...env, VERIFY_TEST_FAIL: 'test-seed' },
    });
    assert.notEqual(failure.status, 0);
    assert.deepEqual(
      readFileSync(log, 'utf8').trim().split('\n'),
      expected.slice(0, -2),
    );
    const unknown = spawnSync('make', ['verify-does-not-exist'], { cwd: root });
    assert.notEqual(unknown.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing tools identify the component phase and provide setup guidance', () => {
  const dir = mkdtempSync(resolve(root, 'infra/scripts/verify/missing-tool-'));
  try {
    const result = spawnSync(
      process.execPath,
      [resolve(root, 'infra/scripts/verify.mjs'), 'server-caldav'],
      { env: { ...process.env, PATH: dir }, encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /server-caldav: format:check: composer not found on PATH/,
    );
    assert.match(
      result.stderr,
      /CONTRIBUTING\.md § Single verification entry point/,
    );
    writeFileSync(
      resolve(dir, 'missing.json'),
      JSON.stringify([[resolve(dir, 'absent-tool'), 'do-not-print-argument']]),
    );
    assert.throws(
      () => suite(dir, 'fixture'),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /missing\.json: entry 1: .* not found on PATH/,
        );
        assert.doesNotMatch(error.message, /do-not-print-argument/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
