// --- E13-R02: the rows behind the sidecar API --------------------------------
//
// `public.event_envelopes` holds one sealed envelope per `VEVENT`, keyed
// `(calendar_id, uid, recurrence_id, envelope_sha256)` (E04-R04, D-06). This
// module is the only place the API writes or reads it, and it treats every blob
// as opaque: the bytes go in as they came from the client and come back
// standard base64, never parsed (INV-07).
//
// The four operations are exactly the four steps D-06 needs and one more:
//
//   * `insert` is the first write step. It is idempotent — re-committing the
//     same envelope is not an error — because a client that retries a write whose
//     skeleton `PUT` was answered `412` must be able to insert the same row
//     again;
//   * `deleteSuperseded` is the last write step: every row of the same key whose
//     hash is not the one the skeleton now carries is garbage;
//   * `list` answers the read, by calendar or by a `uid` list;
//   * `listStaleBefore` and `deleteExact` are the 24-hour orphan sweep of
//     `src/envelope-gc.mjs`.
//
// `envelope_sha256` travels as lowercase hex in both directions (Postgres'
// `encode`), because the gate compares it with the `X-CALFLEX-ENVELOPE-SHA256`
// of a skeleton, which is hex text.

/** The columns every row answer is built from. */
const COLUMNS = `uid, recurrence_id, encode(envelope_sha256, 'hex') AS envelope_sha256,
  epoch, envelope, created_at`;

/** @param {any} row */
function envelopeRow(row) {
  return {
    uid: String(row.uid),
    recurrenceId:
      row.recurrence_id === null || row.recurrence_id === undefined
        ? null
        : String(row.recurrence_id),
    envelopeSha256: String(row.envelope_sha256),
    epoch: Number(row.epoch),
    // Opaque ciphertext, carried as standard base64 to match the request's
    // `format` (D-18, INV-07). The API never looks inside it.
    envelope: Buffer.from(row.envelope).toString('base64'),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at
        : new Date(row.created_at),
  };
}

/**
 * @param {{query: (text: string, values?: unknown[]) => Promise<{rows: any[]}>}} pool
 */
export function createEnvelopeStore(pool) {
  return {
    /**
     * Inserts one envelope, or does nothing when the row is already there.
     * A unique violation is a client that committed the same envelope twice,
     * which is a retry, not a conflict: the bytes it would store are the bytes
     * already stored.
     *
     * @param {{calendarId: string, uid: string, recurrenceId: string | null, envelopeSha256: string, epoch: number, envelope: Buffer}} row
     */
    async insert({
      calendarId,
      uid,
      recurrenceId,
      envelopeSha256,
      epoch,
      envelope,
    }) {
      await pool.query(
        `INSERT INTO public.event_envelopes
           (calendar_id, uid, recurrence_id, envelope_sha256, epoch, envelope)
         VALUES ($1, $2, $3, decode($4, 'hex'), $5, $6)
         ON CONFLICT ON CONSTRAINT event_envelopes_key DO NOTHING`,
        [calendarId, uid, recurrenceId, envelopeSha256, epoch, envelope],
      );
    },

    /**
     * Every row of one calendar, or of a `uid` list inside it. `uids` is
     * `undefined` for the whole calendar; an empty array reads nothing.
     * @param {string} calendarId
     * @param {string[]} [uids]
     */
    async list(calendarId, uids) {
      if (uids !== undefined && uids.length === 0) return [];
      const { rows } =
        uids === undefined
          ? await pool.query(
              `SELECT ${COLUMNS} FROM public.event_envelopes
                WHERE calendar_id = $1
                ORDER BY uid, recurrence_id NULLS FIRST, envelope_sha256`,
              [calendarId],
            )
          : await pool.query(
              `SELECT ${COLUMNS} FROM public.event_envelopes
                WHERE calendar_id = $1 AND uid = ANY($2::text[])
                ORDER BY uid, recurrence_id NULLS FIRST, envelope_sha256`,
              [calendarId, uids],
            );
      return rows.map(envelopeRow);
    },

    /**
     * D-06's last write step: the rows of one key the new skeleton does not
     * name. It only ever removes rows whose hash differs from `keepSha256`, so
     * it can never delete the envelope just committed.
     * @param {{calendarId: string, uid: string, recurrenceId: string | null, keepSha256: string}} key
     */
    async deleteSuperseded({ calendarId, uid, recurrenceId, keepSha256 }) {
      await pool.query(
        `DELETE FROM public.event_envelopes
          WHERE calendar_id = $1 AND uid = $2
            AND recurrence_id IS NOT DISTINCT FROM $3
            AND envelope_sha256 <> decode($4, 'hex')`,
        [calendarId, uid, recurrenceId, keepSha256],
      );
    },

    /**
     * The rows of one calendar created before `before`, oldest first: what the
     * orphan sweep considers. A row a skeleton still names is older than the
     * sweep's grace too, so the caller tells the two apart by reading the
     * skeletons; nothing here decides.
     * @param {string} calendarId
     * @param {Date} before
     */
    async listStaleBefore(calendarId, before) {
      const { rows } = await pool.query(
        `SELECT ${COLUMNS} FROM public.event_envelopes
          WHERE calendar_id = $1 AND created_at < $2
          ORDER BY created_at, uid`,
        [calendarId, before],
      );
      return rows.map(envelopeRow);
    },

    /**
     * Removes exactly one row. The orphan sweep is the only caller: the row it
     * names is one no skeleton carries.
     * @param {{calendarId: string, uid: string, recurrenceId: string | null, envelopeSha256: string}} key
     */
    async deleteExact({ calendarId, uid, recurrenceId, envelopeSha256 }) {
      await pool.query(
        `DELETE FROM public.event_envelopes
          WHERE calendar_id = $1 AND uid = $2
            AND recurrence_id IS NOT DISTINCT FROM $3
            AND envelope_sha256 = decode($4, 'hex')`,
        [calendarId, uid, recurrenceId, envelopeSha256],
      );
    },
  };
}
