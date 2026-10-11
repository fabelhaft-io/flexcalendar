// --- E05-R03: the rows behind the calendars API ------------------------------
//
// `public.calendars` holds no event content (INV-01): an id, an owner, a mode,
// the CalDAV collection's href, the sealed metadata envelope and its epoch, a
// version and two timestamps. `public.calendar_members` says who may see the
// calendar and in which role. This module is the only place that writes either
// table; the CalDAV service reads them through its own connection, which is why
// a create commits both rows **before** the collection is made (E03-R08).
//
// Everything is one statement per step, and the version bump is part of the
// update: `PATCH` reads the version it was given and the write only lands when
// that version is still the row's, so a lost update is impossible rather than
// unlikely.
//
// The envelope is opaque here (INV-07): it is stored as the bytes the client
// sent, read back base64-encoded, and never inspected.
//
// `deletedUidsBetween` (E05-R08) is the one read of `public.caldav_changes`, the
// CalDAV service's own outbox (E03-R10). It exists so a tombstone can name a
// `UID` when the object's name is not it — a stock app's object, Phase 4 — and
// it never writes that table: the CalDAV service owns it.

/**
 * The columns every calendar answer is built from. `role` comes from the
 * membership join, so a caller can tell owner from member without a second
 * query.
 */
const COLUMNS = `c.id, c.owner_id, c.mode, c.meta_envelope, c.meta_epoch,
  c.version, c.created_at, c.updated_at, m.role`;

/** @param {unknown} value */
function iso(value) {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : '';
}

/** @param {any} row */
function calendarRow(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    mode: row.mode,
    role: row.role,
    // Opaque ciphertext, carried as standard base64 to match the request's
    // `format: byte` (D-18). A non-Private calendar has none.
    metaEnvelope:
      row.meta_envelope === null || row.meta_envelope === undefined
        ? null
        : Buffer.from(row.meta_envelope).toString('base64'),
    metaEpoch: row.meta_epoch,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** @param {any} row */
const deletedChangeRow = (row) => ({
  syncToken: String(row.sync_token),
  uid: String(row.uid),
});

/**
 * The API's view of `public.calendars` and `public.calendar_members`. The API
 * role (`calflex_api`) already holds the DML grant on both (E04-R02).
 * @param {{connect: Function, query: Function}} pool
 */
export function createCalendarStore(pool) {
  return {
    /**
     * The calendars the user is a member of, oldest first.
     * @param {string} userId
     */
    async listForMember(userId) {
      const { rows } = await pool.query(
        `SELECT ${COLUMNS}
           FROM public.calendar_members m
           JOIN public.calendars c ON c.id = m.calendar_id
          WHERE m.user_id = $1
          ORDER BY c.created_at, c.id`,
        [userId],
      );
      return rows.map(calendarRow);
    },

    /**
     * The caller's own row for one calendar, or undefined. A calendar the
     * caller is not a member of is indistinguishable from one that does not
     * exist — which is exactly what the routes need to answer the same 404 to
     * both (E03-R01).
     * @param {string} calendarId
     * @param {string} userId
     */
    async findMembership(calendarId, userId) {
      const { rows } = await pool.query(
        `SELECT ${COLUMNS}
           FROM public.calendar_members m
           JOIN public.calendars c ON c.id = m.calendar_id
          WHERE m.calendar_id = $1 AND m.user_id = $2`,
        [calendarId, userId],
      );
      return rows[0] ? calendarRow(rows[0]) : undefined;
    },

    /**
     * Inserts the calendar and its owner's membership row in one transaction,
     * and commits before returning. The CalDAV service only sees a collection
     * whose row is committed, and the collection is created *after* this
     * returns (E03-R08), so a failure here leaves no collection to compensate.
     *
     * @param {{id: string, ownerId: string, href: string, metaEnvelope: Buffer, metaEpoch: number}} calendar
     */
    async createPrivate({ id, ownerId, href, metaEnvelope, metaEpoch }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `INSERT INTO public.calendars
             (id, owner_id, mode, caldav_href, meta_envelope, meta_epoch)
           VALUES ($1, $2, 'private', $3, $4, $5)
           RETURNING id, owner_id, mode, meta_envelope, meta_epoch,
             version, created_at, updated_at`,
          [id, ownerId, href, metaEnvelope, metaEpoch],
        );
        await client.query(
          `INSERT INTO public.calendar_members (calendar_id, user_id, role)
           VALUES ($1, $2, 'owner')`,
          [id, ownerId],
        );
        await client.query('COMMIT');
        return { ...calendarRow(rows[0]), role: 'owner' };
      } catch (error) {
        // A failed create must leave nothing behind: the rollback is what makes
        // the compensation in the create route a one-step delete.
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    /**
     * Replaces the sealed envelope, bumping the version, only when the row is
     * still at `expectedVersion`. Returns the updated row, or undefined when
     * another write won the race (the route answers 412).
     *
     * @param {{calendarId: string, expectedVersion: number, metaEnvelope: Buffer, metaEpoch: number}} update
     */
    async replaceMeta({
      calendarId,
      expectedVersion,
      metaEnvelope,
      metaEpoch,
    }) {
      const { rows } = await pool.query(
        `UPDATE public.calendars
            SET meta_envelope = $2, meta_epoch = $3,
                version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $4
        RETURNING id, owner_id, mode, meta_envelope, meta_epoch,
          version, created_at, updated_at`,
        [calendarId, metaEnvelope, metaEpoch, expectedVersion],
      );
      return rows[0] ? calendarRow(rows[0]) : undefined;
    },

    /**
     * The `uid`s the CalDAV service's outbox (E03-R10) reports as deleted in the
     * sync window `(from, to]` for one calendar. It answers exactly the shape
     * `src/changes.mjs` needs for a tombstone whose object name is not the
     * `UID`: a stock app names an object something other than its `UID`, and
     * nothing but the outbox knows which `uid` that name held.
     *
     * Read-only, and the API role already holds `SELECT` on
     * `public.caldav_changes` (E04-R02); the numbers are compared as `bigint` in
     * SQL, so a sync number does not have to fit a JS number.
     *
     * @param {string} calendarId
     * @param {string} from exclusive lower bound, a decimal sync number
     * @param {string} to inclusive upper bound, a decimal sync number
     */
    async deletedUidsBetween(calendarId, from, to) {
      const { rows } = await pool.query(
        `SELECT sync_token, uid
           FROM public.caldav_changes
          WHERE calendar_id = $1
            AND change_type = 'deleted'
            AND sync_token > $2::bigint
            AND sync_token <= $3::bigint
          ORDER BY sync_token`,
        [calendarId, from, to],
      );
      return rows.map(deletedChangeRow);
    },

    /**
     * Deletes the calendar row; the membership row and every dependent row
     * cascade from it. Returns whether a row was there.
     * @param {string} calendarId
     */
    async remove(calendarId) {
      const { rowCount } = await pool.query(
        'DELETE FROM public.calendars WHERE id = $1',
        [calendarId],
      );
      return rowCount > 0;
    },
  };
}
