import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { checkPins, readPins, admits } from './check-pins.mjs';

test('repository pins and the executable happy path pass offline', () => {
  checkPins(readPins());
  const result = spawnSync(process.execPath, ['infra/scripts/check-pins.mjs'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pins agree/);
});
const bad = JSON.parse(
  readFileSync(new URL('./fixtures/bad-pins.json', import.meta.url), 'utf8'),
);
for (const fixture of bad) {
  test(`rejects incompatible ${fixture.field} fixture`, () => {
    assert.throws(
      () => checkPins({ ...readPins(), [fixture.field]: fixture.value }),
      (error) =>
        error instanceof Error && error.message.includes(fixture.error),
    );
  });
}
test('range boundaries and unsupported constraints fail closed', () => {
  assert.equal(admits('24.17.0', '>=24.17.0 <25'), true);
  assert.equal(admits('25.0.0', '>=24.17.0 <25'), false);
  assert.equal(admits('3.13.4', '^3.13.5'), false);
  assert.equal(admits('4.0.0', '^3.13.5'), false);
  assert.throws(() => admits('3.13.5', '*'));
  assert.throws(() => admits('invalid', '^3.13.5'));
});
