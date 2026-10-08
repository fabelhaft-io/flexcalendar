import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** @typedef {{package: string, tag: string, commit: string, files: Record<string, {sourceUrl: string, sha256: string}>}} ScriptRecord */
/** @param {string} name @param {URL} [directory] */
export function readVerifiedScript(
  name,
  directory = new URL('./', import.meta.url),
) {
  /** @type {ScriptRecord} */
  const record = JSON.parse(
    readFileSync(new URL('record.json', directory), 'utf8'),
  );
  const expected = record.files[name]?.sha256;
  if (!expected) throw new Error('Unrecorded SabreDAV SQL script');
  const bytes = readFileSync(new URL(name, directory));
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error(`SabreDAV SQL checksum mismatch: ${name}`);
  }
  return bytes.toString('utf8');
}
