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

test('migration layout and explicit rollback contract; Make targets exist', async () => {
  const migrations = await readdir(new URL('migrations/', api));
  assert.equal(migrations.length, 2);
  for (const name of migrations) {
    assert.match(name, /^\d{13}_[a-z-]+\.mjs$/);
    const source = await readFile(new URL(`migrations/${name}`, api), 'utf8');
    const migration = await import(new URL(`migrations/${name}`, api).href);
    assert.equal(typeof migration.up, 'function');
    assert.ok(typeof migration.down === 'function' || migration.down === false);
    if (migration.down === false)
      assert.match(source, /\/\/[^\n]+|\/\*[\s\S]+?\*\//);
    assert.match(source, /readVerifiedScript/);
  }
  const make = await readFile(
    new URL('../../../Makefile', import.meta.url),
    'utf8',
  );
  assert.match(make, /^migrate:.*$/m);
  assert.match(make, /^migrate-down:.*$/m);
});
