import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readFile,
  readdir,
  mkdtemp,
  cp,
  appendFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readVerifiedScript } from '../sabredav/verify.mjs';

const api = new URL('../', import.meta.url);
const vendor = new URL('sabredav/', api);
const files = ['pgsql.calendars.sql', 'pgsql.propertystorage.sql'];

test('pristine SQL and provenance: only the two approved upstream scripts', async () => {
  const record = JSON.parse(
    await readFile(new URL('record.json', vendor), 'utf8'),
  );
  assert.equal(record.package, 'sabre/dav');
  assert.equal(record.tag, '4.7.1');
  assert.equal(record.commit, 'f36f002dce082e1d425c4a0dc8c71a6b176c3b07');
  assert.deepEqual(Object.keys(record.files).sort(), files);
  assert.deepEqual(
    (await readdir(vendor)).filter((f) => f.endsWith('.sql')).sort(),
    files,
  );
  const hashes = [
    '871609815dd8f642cb7909f736a70efa396b8b2144b10f8d458a3624048c2496',
    'bf0f3445f47c1ae0d647ad29d4c8edb41366687a55dfb3ad92ed2fd8bf96db3c',
  ];
  for (const [i, file] of files.entries()) {
    assert.equal(record.files[file].sha256, hashes[i]);
    assert.equal(
      record.files[file].sourceUrl,
      `https://raw.githubusercontent.com/sabre-io/dav/4.7.1/examples/sql/${file}`,
    );
    assert.match(readVerifiedScript(file), /CREATE TABLE/);
  }
});

test('one changed byte is refused for each script', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'calflex-record-'));
  try {
    await cp(vendor, temp, { recursive: true });
    for (const file of files) {
      await appendFile(path.join(temp, file), ' ');
      assert.throws(
        () => readVerifiedScript(file, pathToFileURL(`${temp}/`)),
        /checksum mismatch/,
      );
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

/** @param {string} source */
function hasIrreversibleReason(source) {
  const lines = source.split('\n');
  const index = lines.findIndex((line) =>
    /^\s*export const down = false\s*;?/.test(line),
  );
  if (index < 0) return false;
  // Require a nonempty line comment attached to the declaration, not an
  // unrelated comment elsewhere (including a parameter JSDoc).
  return (
    /\/\/\s*\S/.test(lines[index]) ||
    (index > 0 && /^\s*\/\/\s*\S/.test(lines[index - 1]))
  );
}

test('irreversible reason must be a line comment attached to down = false', () => {
  assert.equal(
    hasIrreversibleReason(
      '// Retained data cannot be recovered.\nexport const down = false;\n',
    ),
    true,
  );
  assert.equal(
    hasIrreversibleReason(
      '/** Migration builder. */\nexport const down = false;\n',
    ),
    false,
  );
  assert.equal(
    hasIrreversibleReason('export const down = false; // No state to undo.\n'),
    true,
  );
  assert.equal(
    hasIrreversibleReason(
      '// Unrelated comment.\nexport const up = () => {};\nexport const down = false;\n',
    ),
    false,
  );
});

test('migration layout and explicit rollback contract; Make targets exist', async () => {
  const migrations = (await readdir(new URL('migrations/', api))).sort();
  const sabreMigrations = [
    '1791496692781_sabredav-calendars.mjs',
    '1791496692782_sabredav-propertystorage.mjs',
  ];
  for (const name of sabreMigrations) assert.ok(migrations.includes(name));
  let previousTimestamp = 0;
  for (const name of migrations) {
    assert.match(name, /^\d{13}_[a-z-]+\.(mjs|sql)$/);
    const timestamp = Number(name.slice(0, 13));
    assert.ok(
      timestamp > previousTimestamp,
      'timestamps must be unique and ascending',
    );
    previousTimestamp = timestamp;
    const source = await readFile(new URL(`migrations/${name}`, api), 'utf8');
    if (name.endsWith('.mjs')) {
      const migration = await import(new URL(`migrations/${name}`, api).href);
      assert.equal(typeof migration.up, 'function');
      assert.ok(
        typeof migration.down === 'function' || migration.down === false,
      );
      if (migration.down === false)
        assert.ok(
          hasIrreversibleReason(source),
          'irreversible down needs an attached reason',
        );
    } else {
      assert.match(source, /^-- Up Migration\s*$/m);
      assert.match(source, /^-- Down Migration\s*$/m);
    }
    if (sabreMigrations.includes(name))
      assert.match(source, /\breadVerifiedScript\s*\(\s*['"]pgsql\./);
  }
  const make = await readFile(
    new URL('../../../Makefile', import.meta.url),
    'utf8',
  );
  assert.match(make, /^migrate:.*$/m);
  assert.match(make, /^migrate-down:.*$/m);
});
