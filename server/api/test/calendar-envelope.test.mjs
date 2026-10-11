// --- E05-R03: the envelope check, without a request --------------------------
//
// The rules the API can apply without a key (D-18, INV-07): a version byte it
// knows, an epoch that agrees with the header, the fixed fields present, at most
// 4096 bytes, and standard base64. Everything here is about those boundaries —
// a change that lets a 4097-byte blob through, or accepts an envelope whose
// epoch disagrees with `metaEpoch`, is what these tests fail on.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ENVELOPE_FIXED_BYTES,
  ENVELOPE_VERSION,
  MAX_ENVELOPE_BYTES,
  MAX_EPOCH,
  decodeMetaEnvelope,
  isEpoch,
} from '../src/calendar-envelope.mjs';

/**
 * An envelope of `length` bytes: the fixed fields, with `version` at byte 0 and
 * `epoch` in bytes 1–4, and `0xab` everywhere else — which stands in for the
 * ciphertext the API never reads.
 * @param {{version?: number, epoch?: number, length?: number}} [options]
 */
function envelope({ version = ENVELOPE_VERSION, epoch = 1, length = 60 } = {}) {
  const bytes = Buffer.alloc(Math.max(length, ENVELOPE_FIXED_BYTES), 0xab);
  bytes[0] = version;
  bytes.writeUInt32BE(epoch, 1);
  return bytes.toString('base64');
}

test('a well-formed envelope decodes to exactly the bytes it encoded', () => {
  const bytes = Buffer.alloc(120, 0x17);
  bytes[0] = ENVELOPE_VERSION;
  bytes.writeUInt32BE(MAX_EPOCH, 1);
  const decoded = decodeMetaEnvelope(bytes.toString('base64'), MAX_EPOCH);
  assert.ok(Buffer.isBuffer(decoded));
  assert.deepEqual(decoded, bytes);

  // The minimum: exactly the fixed fields, with an empty ciphertext.
  const minimal = decodeMetaEnvelope(envelope({ length: 45 }), 1);
  assert.equal(minimal?.length, ENVELOPE_FIXED_BYTES);
});

test('an epoch the calendar row could not hold is refused, not stored', () => {
  // The header's field is a uint32, but `calendars.meta_epoch` is an `integer`:
  // an epoch above its range is invalid input rather than a database error.
  assert.equal(MAX_EPOCH, 2_147_483_647);
  const tooBig = Buffer.alloc(60, 0xab);
  tooBig[0] = ENVELOPE_VERSION;
  tooBig.writeUInt32BE(MAX_EPOCH + 1, 1);
  assert.equal(
    decodeMetaEnvelope(tooBig.toString('base64'), MAX_EPOCH + 1),
    undefined,
  );
  assert.equal(
    decodeMetaEnvelope(envelope({ epoch: 1 }), MAX_EPOCH + 1),
    undefined,
  );
  assert.ok(!isEpoch(MAX_EPOCH + 1));
  assert.ok(isEpoch(MAX_EPOCH));
  // …and the largest one it can hold round-trips.
  assert.ok(decodeMetaEnvelope(envelope({ epoch: MAX_EPOCH }), MAX_EPOCH));
});

test('the version byte, the epoch and the fixed fields are checked', () => {
  // A version this service does not know — including 0 and the next one.
  for (const version of [0x00, 0x02, 0xff]) {
    assert.equal(
      decodeMetaEnvelope(envelope({ version }), 1),
      undefined,
      `version ${version}`,
    );
  }
  // The epoch field is compared with `metaEpoch`: a header that names another
  // epoch is refused in both directions, so a caller cannot store a blob under
  // a number the header does not carry.
  assert.equal(decodeMetaEnvelope(envelope({ epoch: 2 }), 1), undefined);
  assert.equal(decodeMetaEnvelope(envelope({ epoch: 1 }), 2), undefined);
  // One byte short of the fixed fields.
  const short = Buffer.alloc(44, 0xab);
  short[0] = ENVELOPE_VERSION;
  short.writeUInt32BE(1, 1);
  assert.equal(decodeMetaEnvelope(short.toString('base64'), 1), undefined);
});

test('the size limit is inclusive at 4096 bytes and exclusive above it', () => {
  assert.equal(
    decodeMetaEnvelope(envelope({ length: MAX_ENVELOPE_BYTES }), 1)?.length,
    MAX_ENVELOPE_BYTES,
  );
  assert.equal(
    decodeMetaEnvelope(envelope({ length: MAX_ENVELOPE_BYTES + 1 }), 1),
    undefined,
  );
});

test('the encoding must be standard base64, canonically', () => {
  const encoded = envelope();
  assert.ok(decodeMetaEnvelope(encoded, 1));
  // An envelope whose base64 spelling really carries `+` and `/`, so the
  // URL-safe check below cannot pass by having nothing to replace.
  const alphabet = Buffer.alloc(48, 0xfb);
  alphabet[0] = ENVELOPE_VERSION;
  alphabet.writeUInt32BE(1, 1);
  const spelled = alphabet.toString('base64');
  assert.ok(spelled.includes('+') && spelled.includes('/'), spelled);
  const urlSafe = spelled.replaceAll('+', '-').replaceAll('/', '_');
  assert.notEqual(urlSafe, spelled);
  for (const value of [
    // Not base64 at all.
    'not base64!!',
    // Whitespace and newlines are not part of the transport encoding.
    `${encoded.slice(0, 4)} ${encoded.slice(4)}`,
    `${encoded}\n`,
    // The URL-safe alphabet is another encoding, not this one.
    urlSafe,
    // Truncated, unpadded and over-padded spellings.
    encoded.slice(0, encoded.length - 2),
    `${encoded}====`,
    '',
  ]) {
    assert.equal(decodeMetaEnvelope(value, 1), undefined, value);
  }
  // A value that is not a string, and an epoch that is not an integer in range.
  for (const value of [undefined, null, 42, { length: 60 }, [encoded]]) {
    assert.equal(decodeMetaEnvelope(value, 1), undefined);
  }
  for (const epoch of [undefined, null, -1, 1.5, '1', MAX_EPOCH + 1, true]) {
    assert.equal(decodeMetaEnvelope(encoded, epoch), undefined, `${epoch}`);
  }
});

test('isEpoch is the range the calendar row can hold', () => {
  for (const value of [0, 1, MAX_EPOCH]) assert.ok(isEpoch(value), `${value}`);
  for (const value of [
    -1,
    0.5,
    MAX_EPOCH + 1,
    0x1_0000_0000,
    '1',
    null,
    undefined,
  ])
    assert.ok(!isEpoch(value), `${value}`);
});
