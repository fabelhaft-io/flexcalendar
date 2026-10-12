// --- E13-R02: what a skeleton names -----------------------------------------
//
// The sidecar key is `(calendar_id, uid, recurrence_id, envelope_sha256)`, and
// the skeleton is the only place the fourth of those lives (`spec/crypto.md`
// §5.1). So the two functions here are the whole of D-06's read gate: given the
// object the collection stores, which envelope keys does it name, and which
// `VEVENT` of the object does a key belong to.
//
// Nothing here opens an envelope (INV-07). A `VEVENT` that carries no hash, or
// a hash that is not 64 lowercase hex digits, names no envelope; a
// `RECURRENCE-ID` the zone data cannot resolve is skipped rather than guessed
// at, because a wrong key would select another override's envelope.

import {
  ENVELOPE_HASH_PROPERTY,
  IcalError,
  master,
  parse,
} from './ical-rmw.mjs';
import { recurrenceKey } from './recurrence-key.mjs';

/** The text form of the SHA-256 of an envelope (`spec/crypto.md` §5.1). */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The envelope keys one stored object names, in the order its `VEVENT`s appear.
 * `recurrenceId` is `null` for the master and the canonical `RECURRENCE-ID`
 * otherwise (`spec/crypto.md` §5.2).
 *
 * @param {string} text the stored object, byte for byte
 * @returns {{uid: string, recurrenceId: string | null, envelopeSha256: string}[]}
 */
export function envelopeRefsOf(text) {
  /** @type {import('ical.js').default.Component} */
  let calendar;
  try {
    calendar = parse(text);
  } catch (error) {
    if (error instanceof IcalError) return [];
    throw error;
  }
  /** @type {{uid: string, recurrenceId: string | null, envelopeSha256: string}[]} */
  const refs = [];
  for (const event of calendar.getAllSubcomponents('vevent')) {
    const uid = event.getFirstPropertyValue('uid');
    if (typeof uid !== 'string' || uid === '') continue;
    const hash = event.getFirstPropertyValue(ENVELOPE_HASH_PROPERTY);
    if (typeof hash !== 'string' || !SHA256_HEX.test(hash)) continue;
    const property = event.getFirstProperty('recurrence-id');
    /** @type {string | null} */
    let recurrenceId = null;
    if (property) {
      try {
        recurrenceId = recurrenceKey(property);
      } catch {
        // A `RECURRENCE-ID` this API cannot canonicalise names no sidecar row.
        continue;
      }
    }
    refs.push({ uid, recurrenceId, envelopeSha256: hash });
  }
  return refs;
}

/**
 * The `VEVENT` of one object an envelope belongs to: the master when
 * `recurrenceId` is `null`, and otherwise the `VEVENT` whose canonical
 * `RECURRENCE-ID` equals it. `undefined` when the object holds none, which the
 * caller answers as rejected input rather than writing an envelope nothing can
 * ever open.
 *
 * @param {import('ical.js').default.Component} calendar
 * @param {string | null} recurrenceId
 * @returns {import('ical.js').default.Component | undefined}
 */
export function eventFor(calendar, recurrenceId) {
  if (recurrenceId === null) return master(calendar);
  for (const event of calendar.getAllSubcomponents('vevent')) {
    const property = event.getFirstProperty('recurrence-id');
    if (!property) continue;
    try {
      if (recurrenceKey(property) === recurrenceId) return event;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * The key of one sidecar row, as `(uid, recurrenceId, envelopeSha256)` text. A
 * NUL separator cannot occur in a `UID`, a canonical `RECURRENCE-ID` or a hex
 * digest, so two different keys can never spell the same string.
 * @param {string} uid
 * @param {string | null} recurrenceId
 * @param {string} envelopeSha256
 * @returns {string}
 */
export function refKey(uid, recurrenceId, envelopeSha256) {
  return `${uid}\u0000${recurrenceId ?? ''}\u0000${envelopeSha256}`;
}
