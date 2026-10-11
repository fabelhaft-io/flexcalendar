// --- E05-R01: the audience source (no filesystem, no IdP) --------------------
//
// The audience is the Zitadel project ID, which `make seed` writes *after* the
// API boots. The source is read lazily, re-read on an audience mismatch, and
// its window keeps a flood of bad tokens from becoming a flood of file reads.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUDIENCE_WINDOW_MS, createAudienceSource } from '../src/audience.mjs';

/** A reader that answers whatever the current "file" holds. */
function file(/** @type {string | undefined} */ content) {
  let value = content;
  return {
    read: async () => {
      if (value === undefined) throw new Error('ENOENT');
      return value;
    },
    write: (/** @type {string} */ next) => {
      value = next;
    },
  };
}

test('an explicit audience wins over the file and is never re-read', async () => {
  const store = file('from-file');
  const source = createAudienceSource({
    audience: 'from-environment',
    file: '/oidc/audience',
    read: store.read,
    now: () => 0,
  });
  assert.equal(await source.current(), 'from-environment');
  assert.equal(await source.refresh(), false);
  assert.equal(await source.current(), 'from-environment');
});

test('the trimmed first line of the file is the audience', async () => {
  const store = file('  project-id  \nignored\n');
  const source = createAudienceSource({
    file: '/oidc/audience',
    read: store.read,
    now: () => 0,
  });
  assert.equal(await source.current(), 'project-id');
});

test('a missing or empty file is unconfigured, and it is re-read', async () => {
  const store = file(undefined);
  let clock = 0;
  const source = createAudienceSource({
    file: '/oidc/audience',
    read: store.read,
    now: () => clock,
  });
  assert.equal(await source.current(), undefined);
  // Inside the window nothing is read again, even once the file appears.
  store.write('project-id');
  assert.equal(await source.current(), undefined);
  clock += AUDIENCE_WINDOW_MS;
  assert.equal(await source.current(), 'project-id');
  assert.equal(await source.current(), 'project-id');
});

test('a mismatch re-reads the file at most once per window', async () => {
  const store = file('stale-project');
  let clock = 0;
  const source = createAudienceSource({
    file: '/oidc/audience',
    read: store.read,
    now: () => clock,
  });
  assert.equal(await source.current(), 'stale-project');
  store.write('fresh-project');
  assert.equal(await source.refresh(), true);
  assert.equal(await source.current(), 'fresh-project');
  // A second mismatch inside the window does not read the file again.
  store.write('newer-project');
  assert.equal(await source.refresh(), false);
  assert.equal(await source.current(), 'fresh-project');
  clock += AUDIENCE_WINDOW_MS;
  assert.equal(await source.refresh(), true);
  assert.equal(await source.current(), 'newer-project');
});

test('no audience and no file stays unconfigured', async () => {
  const source = createAudienceSource({ now: () => 0 });
  assert.equal(await source.current(), undefined);
  assert.equal(await source.refresh(), false);
});
