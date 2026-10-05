import { test } from 'node:test';
import assert from 'node:assert/strict';

test('deliberately failing gate (E02-R06 review only)', () => {
  assert.equal(1, 2);
});
