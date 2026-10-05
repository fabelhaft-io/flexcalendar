import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
    assert.throws(() => suite(dir, 'fixture'));
    writeFileSync(resolve(dir, 'check.json'), '[]');
    assert.throws(() => suite(dir, 'fixture'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
import { readFileSync } from 'node:fs';
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
      'check-stack',
      'test-seed',
      'verify-invariants',
      'verify-corpus',
    ];
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), expected);
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
import { spawnSync } from 'node:child_process';
