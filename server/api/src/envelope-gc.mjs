// --- E13-R02: the orphan sweep ------------------------------------------------
//
// D-06's write inserts the envelope row first and writes the skeleton second, so
// a crash between the two leaves a row no skeleton names: an **orphan**. The row
// is harmless — the read gate only answers an envelope its skeleton carries —
// but it is garbage, and this module removes it once it is 24 hours old.
//
// The rule is the read gate read backwards: for every stale row, the object's
// current `X-CALFLEX-ENVELOPE-SHA256` per `VEVENT` says which rows a skeleton
// names, and a row it does not name is deleted. A stale row a skeleton *does*
// name — an envelope that has not been re-sealed in a day — is left exactly as
// it is; the age only decides which rows are considered, never which are
// orphans.
//
// Two cases are deliberately left alone rather than guessed at: an object that
// cannot be read at all (a CalDAV failure, a deadline) keeps every row, because
// "cannot tell" is not "no skeleton names it"; an object that is gone (`404`)
// names nothing, so all of its stale rows go.
//
// `graceMs` and `now` are injectable so the 24-hour rule can be exercised
// without waiting a day.

import { envelopeRefsOf } from './envelope-refs.mjs';

/** The grace D-06 states: an orphan is removed once it is a day old. */
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/** @param {string | null} recurrenceId @param {string} envelopeSha256 */
const namedKey = (recurrenceId, envelopeSha256) =>
  `${recurrenceId ?? ''}\u0000${envelopeSha256}`;

/**
 * @param {object} dependencies
 * @param {{listStaleBefore: Function, deleteExact: Function}} dependencies.store
 * @param {number} [dependencies.graceMs]
 * @param {() => Date} [dependencies.now]
 */
export function createOrphanCollector({
  store,
  graceMs = ORPHAN_GRACE_MS,
  now = () => new Date(),
}) {
  return {
    /**
     * Removes this calendar's stale orphan rows and answers how many went. The
     * `view` is the caller's delegated CalDAV identity: the sweep reads the
     * collection exactly as a member reads it.
     * @param {{calendarId: string, view: {getObject: (calendarId: string, name: string) => Promise<{data: string}>}}} input
     * @returns {Promise<number>}
     */
    async sweep({ calendarId, view }) {
      const cutoff = new Date(now().getTime() - graceMs);
      const stale = await store.listStaleBefore(calendarId, cutoff);
      if (stale.length === 0) return 0;

      /** @type {Map<string, any[]>} */
      const byUid = new Map();
      for (const row of stale) {
        const rows = byUid.get(row.uid);
        if (rows === undefined) byUid.set(row.uid, [row]);
        else rows.push(row);
      }

      let removed = 0;
      for (const [uid, rows] of byUid) {
        /** @type {Set<string>} */
        let named;
        try {
          const object = await view.getObject(calendarId, `${uid}.ics`);
          named = new Set(
            envelopeRefsOf(object.data).map((ref) =>
              namedKey(ref.recurrenceId, ref.envelopeSha256),
            ),
          );
        } catch (error) {
          if (/** @type {any} */ (error)?.status === 404) {
            // The object is gone: no skeleton names any of its rows.
            named = new Set();
          } else {
            // Cannot tell; leave every row rather than delete a live one.
            continue;
          }
        }
        for (const row of rows) {
          if (named.has(namedKey(row.recurrenceId, row.envelopeSha256)))
            continue;
          await store.deleteExact({
            calendarId,
            uid,
            recurrenceId: row.recurrenceId,
            envelopeSha256: row.envelopeSha256,
          });
          removed += 1;
        }
      }
      return removed;
    },
  };
}
