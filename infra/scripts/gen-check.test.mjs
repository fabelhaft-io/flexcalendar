import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { snapshot, differences, main } from './gen-check.mjs';

test('make gen runs the Dart generator through its guard, never a bare wipe', () => {
  const result = spawnSync('make', ['-n', 'gen'], {
    cwd: resolve(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  // gen-dart.mjs replaces the old output only when the new one exists
  // (gen-dart.test.mjs); a recipe that deletes it first undoes that.
  assert.match(result.stdout, /node infra\/scripts\/gen-dart\.mjs/);
  assert.doesNotMatch(result.stdout, /rm -rf apps\/mobile\/lib\/api/);
  assert.doesNotMatch(result.stdout, /dart run swagger_parser/);
});

test('snapshots name edited, deleted and newly generated files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gen-fixture-'));
  try {
    writeFileSync(resolve(dir, 'schema.dart'), 'original');
    const before = snapshot(dir, ['schema.dart']);
    assert.deepEqual(differences(before, snapshot(dir, ['schema.dart'])), []);
    writeFileSync(resolve(dir, 'schema.dart'), 'edited');
    assert.deepEqual(differences(before, snapshot(dir, ['schema.dart'])), [
      'schema.dart',
    ]);
    rmSync(resolve(dir, 'schema.dart'));
    assert.deepEqual(differences(before, snapshot(dir, ['schema.dart'])), [
      'schema.dart',
    ]);
    writeFileSync(resolve(dir, 'new.dart'), 'new');
    assert.deepEqual(
      differences(before, snapshot(dir, ['schema.dart', 'new.dart'])).sort(),
      ['new.dart', 'schema.dart'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** @param {string} directory @param {string[]} args */
function git(directory, args) {
  const result = spawnSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  assert.equal(result.status, 0, result.stderr);
}

for (const scenario of [
  'clean',
  'regenerated',
  'hand-edited',
  'already-regenerated',
  'untracked',
  'deleted',
]) {
  test(`git generation check: ${scenario}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'gen-check-git-'));
    try {
      // This repository belongs only to this test, never to the worktree.
      git(directory, ['init']);
      git(directory, ['config', 'user.name', 'Fixture']);
      git(directory, ['config', 'user.email', 'fixture@example.invalid']);
      git(directory, ['config', 'commit.gpgsign', 'false']);
      git(directory, ['config', 'core.hooksPath', '/dev/null']);
      const schema = resolve(directory, 'schema.dart');
      writeFileSync(schema, 'original');
      git(directory, ['add', 'schema.dart']);
      git(directory, ['commit', '-m', 'fixture']);
      if (scenario === 'hand-edited') writeFileSync(schema, 'hand edit');
      if (scenario === 'already-regenerated')
        writeFileSync(schema, 'new output');
      if (scenario === 'deleted') rmSync(schema);
      if (scenario === 'untracked')
        writeFileSync(resolve(directory, 'extra.dart'), 'extra');
      let calls = 0;
      const check = () =>
        main(directory, ['schema.dart', 'extra.dart'], (root) => {
          assert.equal(root, directory);
          calls++;
          // Regeneration overwrites manual edits and restores missing outputs.
          writeFileSync(
            schema,
            ['regenerated', 'already-regenerated'].includes(scenario)
              ? 'new output'
              : 'original',
          );
        });
      if (scenario === 'clean') assert.doesNotThrow(check);
      else
        assert.throws(check, (error) => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /Generated API files are stale, missing or untracked/,
          );
          assert.ok(
            error.message.includes(
              scenario === 'untracked' ? 'extra.dart' : 'schema.dart',
            ),
          );
          return true;
        });
      assert.equal(calls, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
