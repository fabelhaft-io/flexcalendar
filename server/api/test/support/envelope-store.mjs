// --- E13-R02 test support: an in-memory `event_envelopes` --------------------
//
// It mirrors the five things `src/envelope-store.mjs` offers, with the
// properties the routes depend on: the key is
// `(calendar_id, uid, recurrence_id, envelope_sha256)` and `recurrence_id` is
// `NULL`-distinct, an insert of a row that is already there is a no-op, and
// every delete names exactly one row. It is mutable state the API changes, so
// "the superseded row is gone" or "the orphan is gone" is an assertion about
// what the routes did rather than about a stub that always says yes.
//
// `seed` writes a row directly, so a test can plant what a crash left behind —
// with any `createdAt`, which is how the 24-hour sweep is exercised without
// waiting a day. `fail` makes one method throw from now on, which is how the
// break between D-06's first and second steps is modelled.
//
// Every operation is recorded in the shared `events` array, interleaved with
// the CalDAV double's calls, so "the row was inserted before the skeleton was
// PUT" is an assertion about the order the API actually wrote in.

/**
 * @param {{events?: Record<string, unknown>[], now?: () => Date}} [options]
 */
export function createMemoryEnvelopeStore({
  events = [],
  now = () => new Date(),
} = {}) {
  /** @type {{calendarId: string, uid: string, recurrenceId: string | null, envelopeSha256: string, epoch: number, envelope: Buffer, createdAt: Date}[]} */
  const rows = [];
  /** @type {Map<string, Error>} */
  const failures = new Map();

  /** @param {string} calendarId @param {string} uid @param {string | null} recurrenceId @param {string} hash */
  const rowOf = (calendarId, uid, recurrenceId, hash) =>
    rows.find(
      (row) =>
        row.calendarId === calendarId &&
        row.uid === uid &&
        row.recurrenceId === recurrenceId &&
        row.envelopeSha256 === hash,
    );

  /** @param {string} method */
  const guard = (method) => {
    const failure = failures.get(method);
    if (failure) throw failure;
  };

  /** The row shape `src/envelope-store.mjs` answers with. @param {any} row */
  const view = (row) => ({
    uid: row.uid,
    recurrenceId: row.recurrenceId,
    envelopeSha256: row.envelopeSha256,
    epoch: row.epoch,
    envelope: row.envelope.toString('base64'),
    createdAt: row.createdAt,
  });

  return {
    events,
    /** Every live row, for assertions. */
    rows: () => rows.map(view),
    /**
     * Writes one row directly, without a skeleton: the orphan a crashed write
     * leaves. `createdAt` defaults to now, so the sweep's grace can be crossed.
     * @param {{calendarId: string, uid: string, recurrenceId?: string | null, envelopeSha256: string, epoch?: number, envelope: Buffer, createdAt?: Date}} row
     */
    seed({
      calendarId,
      uid,
      recurrenceId = null,
      envelopeSha256,
      epoch = 1,
      envelope,
      createdAt = now(),
    }) {
      rows.push({
        calendarId,
        uid,
        recurrenceId,
        envelopeSha256,
        epoch,
        envelope,
        createdAt,
      });
    },
    /**
     * Makes one method throw from now on. Passing no error restores it.
     * @param {string} method @param {Error} [error]
     */
    fail(method, error = new Error(`${method} failed`)) {
      failures.set(method, error);
    },
    /** @param {string} method */
    heal(method) {
      failures.delete(method);
    },

    /** @param {{calendarId: string, uid: string, recurrenceId: string | null, envelopeSha256: string, epoch: number, envelope: Buffer}} row */
    async insert({
      calendarId,
      uid,
      recurrenceId,
      envelopeSha256,
      epoch,
      envelope,
    }) {
      events.push({ op: 'envelopeInsert', calendarId, uid, recurrenceId });
      guard('insert');
      if (rowOf(calendarId, uid, recurrenceId, envelopeSha256) !== undefined)
        return;
      rows.push({
        calendarId,
        uid,
        recurrenceId,
        envelopeSha256,
        epoch,
        envelope: Buffer.from(envelope),
        createdAt: now(),
      });
    },

    /** @param {string} calendarId @param {string[]} [uids] */
    async list(calendarId, uids) {
      events.push({ op: 'envelopeList', calendarId, uids });
      guard('list');
      if (uids !== undefined && uids.length === 0) return [];
      return rows
        .filter(
          (row) =>
            row.calendarId === calendarId &&
            (uids === undefined || uids.includes(row.uid)),
        )
        .map(view);
    },

    /** @param {{calendarId: string, uid: string, recurrenceId: string | null, keepSha256: string}} key */
    async deleteSuperseded({ calendarId, uid, recurrenceId, keepSha256 }) {
      events.push({ op: 'envelopeDeleteSuperseded', calendarId, uid });
      guard('deleteSuperseded');
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (
          row.calendarId === calendarId &&
          row.uid === uid &&
          row.recurrenceId === recurrenceId &&
          row.envelopeSha256 !== keepSha256
        ) {
          rows.splice(index, 1);
        }
      }
    },

    /**
     * @param {string} calendarId @param {Date} before
     */
    async listStaleBefore(calendarId, before) {
      events.push({ op: 'envelopeListStale', calendarId });
      guard('listStaleBefore');
      return rows
        .filter(
          (row) => row.calendarId === calendarId && row.createdAt < before,
        )
        .sort(
          (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
        )
        .map(view);
    },

    /** @param {{calendarId: string, uid: string, recurrenceId: string | null, envelopeSha256: string}} key */
    async deleteExact({ calendarId, uid, recurrenceId, envelopeSha256 }) {
      events.push({ op: 'envelopeDeleteExact', calendarId, uid });
      guard('deleteExact');
      const index = rows.findIndex(
        (row) =>
          row.calendarId === calendarId &&
          row.uid === uid &&
          row.recurrenceId === recurrenceId &&
          row.envelopeSha256 === envelopeSha256,
      );
      if (index !== -1) rows.splice(index, 1);
    },
  };
}
