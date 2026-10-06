import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { snapshot, differences } from './gen-check.mjs';

test('snapshots name edited, deleted and newly generated files', () => {
  const dir = mkdtempSync(resolve('infra/scripts/gen-fixture-'));
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
