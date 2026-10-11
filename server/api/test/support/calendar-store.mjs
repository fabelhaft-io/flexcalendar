// --- E05-R03 test support: an in-memory calendar store ----------------------
//
// It mirrors the four methods `src/calendar-store.mjs` offers, with the
// properties the routes depend on: a membership join that hides other people's
// calendars, a version that only moves when the expected version still matches,
// and a delete whose membership rows cascade — so "the row is gone" is an
// assertion about state the store actually changed, not about a stub that
// always succeeds.
//
// `deletedUidsBetween` (E05-R08) mirrors the one read of the CalDAV service's
// outbox: a test can plant a deleted change and then see that a tombstone whose
// object name is not its `UID` is named from the outbox, and that a window with
// two candidates leaves the entry out rather than guessing.
//
// Every method can be made to fail (`fail('remove')`), because the interesting
// paths of E05-R03 are the ones where a step breaks: a failing `MKCALENDAR`,
// a failing compensation, a failing row delete after the collection is gone.
//
// It also refuses a `calendarId` that is not a UUID, the way Postgres does:
// `calendars.id` is a `uuid` column and `'not-a-uuid'` raises `22P02`
// (`invalid input syntax for type uuid`). Without that, a route that let such
// an id reach the store would look fine against this fake and be a 500 in the
// stack (review 1, fix 2).

import { randomUUID } from 'node:crypto';

/** Postgres' `invalid_text_representation` SQLSTATE, as `pg` raises it. */
const INVALID_TEXT_REPRESENTATION = '22P02';

/** The shape `calendars.id` holds: the canonical lowercase UUID. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Throws what Postgres throws for a `uuid` column given a value that is not a
 * UUID, so a missing check in a route is a 500 here too.
 * @param {unknown} calendarId
 */
function assertUuid(calendarId) {
  if (typeof calendarId !== 'string' || !UUID.test(calendarId)) {
    throw Object.assign(
      new Error(`invalid input syntax for type uuid: ${String(calendarId)}`),
      { code: INVALID_TEXT_REPRESENTATION },
    );
  }
}

/** @param {unknown} value */
const iso = (value) => (value instanceof Date ? value.toISOString() : value);

/**
 * @param {{calendars?: Array<{ownerId: string, userId?: string, role?: string, mode?: string, metaEnvelope?: string, metaEpoch?: number}>, events?: Record<string, unknown>[]}} [seed]
 */
export function createMemoryCalendarStore(seed = {}) {
  /** @type {Map<string, any>} */
  const calendars = new Map();
  /** @type {Map<string, {userId: string, role: string}[]>} */
  const members = new Map();
  /** @type {Map<string, Error>} */
  const failures = new Map();
  /** @type {Record<string, unknown>[]} */
  const events = seed.events ?? [];
  /**
   * The `public.caldav_changes` rows a test cares about (E05-R08): the deleted
   * entries the CalDAV service's outbox holds, which is the only place a
   * tombstone's `UID` survives when the object name is not it.
   * @type {{calendarId: string, syncToken: string, uid: string}[]}
   */
  const outbox = [];

  /** @param {any} row @param {string} userId */
  const visible = (row, userId) => {
    const membership = (members.get(row.id) ?? []).find(
      (entry) => entry.userId === userId,
    );
    return membership === undefined
      ? undefined
      : {
          ...row,
          role: membership.role,
          createdAt: iso(row.createdAt),
          updatedAt: iso(row.updatedAt),
        };
  };

  /** @param {string} method */
  const guard = (method) => {
    const failure = failures.get(method);
    if (failure) throw failure;
  };

  for (const entry of seed.calendars ?? []) {
    const id = randomUUID();
    calendars.set(id, {
      id,
      ownerId: entry.ownerId,
      mode: entry.mode ?? 'private',
      metaEnvelope:
        entry.metaEnvelope ?? Buffer.alloc(45, 1).toString('base64'),
      metaEpoch: entry.metaEpoch ?? 1,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    members.set(id, [
      { userId: entry.userId ?? entry.ownerId, role: entry.role ?? 'owner' },
    ]);
  }

  return {
    /** The rows, for assertions about what a route left behind. */
    rows: () => [...calendars.values()],
    /** The membership rows, likewise. */
    memberships: () =>
      [...members.entries()].flatMap(([calendarId, entries]) =>
        entries.map((entry) => ({ calendarId, ...entry })),
      ),
    /** What this store did, in order, interleaved with the fake adapter's calls. */
    events,
    /**
     * Adds a membership row, so a test can put a second user in a calendar.
     * @param {string} calendarId @param {string} userId @param {string} [role]
     */
    addMember(calendarId, userId, role = 'editor') {
      const entries = members.get(calendarId);
      if (entries === undefined) throw new Error('no such calendar');
      entries.push({ userId, role });
    },
    /**
     * Makes one method throw from now on, so a test can hold the compensation
     * and the delete order. Passing no error restores it.
     * @param {string} method
     * @param {Error} [error]
     */
    /**
     * Makes one method throw from now on, so a test can hold the compensation
     * and the delete order. Passing no error restores it.
     * @param {string} method
     * @param {Error} [error]
     */
    fail(method, error = new Error(`${method} failed`)) {
      failures.set(method, error);
    },
    /** @param {string} method */
    heal(method) {
      failures.delete(method);
    },

    /** @param {string} userId */
    async listForMember(userId) {
      guard('listForMember');
      return [...calendars.values()]
        .map((row) => visible(row, userId))
        .filter((row) => row !== undefined);
    },

    /** @param {string} calendarId @param {string} userId */
    async findMembership(calendarId, userId) {
      assertUuid(calendarId);
      guard('findMembership');
      const row = calendars.get(calendarId);
      return row === undefined ? undefined : visible(row, userId);
    },

    /**
     * @param {{id: string, ownerId: string, href: string, metaEnvelope: Buffer, metaEpoch: number}} calendar
     */
    async createPrivate({ id, ownerId, href, metaEnvelope, metaEpoch }) {
      guard('createPrivate');
      if (calendars.has(id)) throw new Error('duplicate calendar id');
      // A Buffer in, an encoded string out: the routes see the same shape the
      // real store answers with.
      calendars.set(id, {
        id,
        ownerId,
        href,
        mode: 'private',
        metaEnvelope: metaEnvelope.toString('base64'),
        metaEpoch,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      members.set(id, [{ userId: ownerId, role: 'owner' }]);
      // Pushed last: the row and its membership are committed by the time this
      // returns, which is the order the CalDAV collection depends on.
      events.push({ op: 'createPrivate', id });
      return visible(calendars.get(id), ownerId);
    },

    /**
     * @param {{calendarId: string, expectedVersion: number, metaEnvelope: Buffer, metaEpoch: number}} update
     */
    async replaceMeta({
      calendarId,
      expectedVersion,
      metaEnvelope,
      metaEpoch,
    }) {
      assertUuid(calendarId);
      guard('replaceMeta');
      const row = calendars.get(calendarId);
      if (row === undefined || row.version !== expectedVersion)
        return undefined;
      row.metaEnvelope = metaEnvelope.toString('base64');
      row.metaEpoch = metaEpoch;
      row.version += 1;
      row.updatedAt = new Date();
      events.push({ op: 'replaceMeta', id: calendarId, version: row.version });
      return visible(row, row.ownerId);
    },

    /** @param {string} calendarId */
    async remove(calendarId) {
      assertUuid(calendarId);
      guard('remove');
      members.delete(calendarId);
      const removed = calendars.delete(calendarId);
      events.push({ op: 'remove', id: calendarId, removed });
      return removed;
    },

    /**
     * Appends an outbox row, as the CalDAV service does inside the write's
     * transaction (E03-R10). Only a test calls it; the API reads the table only.
     * @param {string} calendarId @param {string | number} syncToken @param {string} uid
     */
    deletedChange(calendarId, syncToken, uid) {
      outbox.push({ calendarId, syncToken: String(syncToken), uid });
    },

    /**
     * The deleted outbox rows of one calendar inside a sync window, exactly as
     * `src/calendar-store.mjs` selects them: `(from, to]`, by `bigint`.
     * @param {string} calendarId @param {string} from @param {string} to
     */
    async deletedUidsBetween(calendarId, from, to) {
      assertUuid(calendarId);
      guard('deletedUidsBetween');
      return outbox
        .filter(
          (row) =>
            row.calendarId === calendarId &&
            BigInt(row.syncToken) > BigInt(from) &&
            BigInt(row.syncToken) <= BigInt(to),
        )
        .sort((left, right) =>
          BigInt(left.syncToken) < BigInt(right.syncToken) ? -1 : 1,
        )
        .map((row) => ({ syncToken: row.syncToken, uid: row.uid }));
    },
  };
}
