// --- E05-R03: the calendar-metadata envelope, checked as far as an API can ---
//
// A Private calendar's name and colour exist only inside an envelope the client
// seals under its CCK (D-18). The API never opens one: it links no content-crypto
// library and decrypts nothing (INV-07), and it must not log or echo a byte of
// it. So what is checked here is exactly what a server can check without a key:
//
//   * byte 0 is the envelope version the service knows (`0x01`);
//   * bytes 1–4 are the CCK epoch as a big-endian uint32, equal to the
//     `metaEpoch` the request carries (`calendars.meta_epoch` is that number);
//   * the blob is at least the fixed fields of `spec/crypto.md` (version 1 +
//     epoch 4 + nonce 24 + tag 16 = 45 bytes) and at most `MAX_ENVELOPE_BYTES`;
//   * the transport encoding is standard base64, canonically (OpenAPI
//     `format: byte`), so the stored `bytea` is exactly the bytes the client
//     sealed and a re-encode round-trips.
//
// Everything after byte 45 is ciphertext and is opaque here: the check is a
// header and a size check, never a parse (D-18). A refusal is one 422 with a
// fixed body — the caller learns which rule failed only from its own request,
// and no value of the envelope reaches a log line or a response body.

/** The only envelope version this service stores. */
export const ENVELOPE_VERSION = 0x01;

/** Version byte, epoch uint32, 24-byte nonce, 16-byte tag. */
export const ENVELOPE_FIXED_BYTES = 45;

/**
 * The metadata envelope's ceiling (D-18): an envelope larger than this is
 * refused. A calendar's name and colour are a few dozen bytes.
 */
export const MAX_ENVELOPE_BYTES = 4096;

/**
 * The event envelope's ceiling (`spec/crypto.md` §1.1,
 * `MAX_EVENT_ENVELOPE_BYTES`): 65,536 bytes. The clients enforce it too, but a
 * server-side check is what keeps one client from storing a blob the others
 * would refuse to open, so E13-R02 enforces it here as well.
 */
export const MAX_EVENT_ENVELOPE_BYTES = 65_536;

/** Standard base64, padded, no whitespace and no URL-safe alphabet. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The highest epoch an envelope may carry. The field itself is four bytes
 * (uint32), but the number has to fit `calendars.meta_epoch`, which is an
 * `integer` (E04), like `event_envelopes.epoch` and `calendar_keys.epoch`. An
 * epoch above this is refused as invalid input rather than by a database error.
 */
export const MAX_EPOCH = 2_147_483_647;

/**
 * One envelope `value` carries as standard base64, or undefined when it is not
 * one this service can store under a `ceiling`. `epoch` is the epoch the
 * request carries beside it.
 *
 * Only the encoded string is read here; a caller passes the decoded bytes on to
 * the store, so nothing else in the service has to know the layout.
 *
 * @param {unknown} value the request's envelope, standard base64
 * @param {unknown} epoch the epoch the request carries beside it
 * @param {number} ceiling the largest blob this kind of envelope may be
 * @returns {Buffer | undefined}
 */
function decodeEnvelope(value, epoch, ceiling) {
  if (typeof value !== 'string' || value === '') return undefined;
  if (!isEpoch(epoch)) return undefined;
  // Length first: a non-canonical length cannot be a padded base64 string, and
  // it keeps a huge value from being decoded before it is refused.
  if (value.length % 4 !== 0 || !BASE64.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64');
  // `Buffer.from` is lenient; the round-trip makes the encoding canonical, so
  // two spellings of the same bytes cannot become two rows.
  if (bytes.toString('base64') !== value) return undefined;
  if (bytes.length < ENVELOPE_FIXED_BYTES) return undefined;
  if (bytes.length > ceiling) return undefined;
  if (bytes[0] !== ENVELOPE_VERSION) return undefined;
  if (bytes.readUInt32BE(1) !== epoch) return undefined;
  return bytes;
}

/**
 * The calendar-metadata envelope (D-18): `decodeEnvelope` under the metadata
 * ceiling. `epoch` is the request's `metaEpoch`.
 *
 * @param {unknown} value the request's `metaEnvelope`
 * @param {unknown} epoch the request's `metaEpoch`
 * @returns {Buffer | undefined}
 */
export function decodeMetaEnvelope(value, epoch) {
  return decodeEnvelope(value, epoch, MAX_ENVELOPE_BYTES);
}

/**
 * The event envelope of E13-R02: the same header and the same canonical-base64
 * rule, under the 65,536-byte ceiling of `spec/crypto.md` §1.1. `epoch` is the
 * request's `epoch`, and it has to be the epoch the header carries.
 *
 * @param {unknown} value the request's `envelope`
 * @param {unknown} epoch the request's `epoch`
 * @returns {Buffer | undefined}
 */
export function decodeEventEnvelope(value, epoch) {
  return decodeEnvelope(value, epoch, MAX_EVENT_ENVELOPE_BYTES);
}

/**
 * Whether `value` is an epoch this service can store. The envelope's own epoch
 * field is a uint32, but the API accepts only the range `calendars.meta_epoch`
 * holds (a plain `integer`), so the caller learns the bound as a 422 instead of
 * as a database error — and a string that looks like a number is not an epoch
 * (and never coerced into one), because the envelope's header is compared with
 * it.
 * @param {unknown} value
 * @returns {value is number}
 */
export function isEpoch(value) {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_EPOCH
  );
}
