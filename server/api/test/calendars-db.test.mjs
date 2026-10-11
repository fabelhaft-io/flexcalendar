// --- E05-R03: the calendars rows against the real Postgres schema ------------
//
// The database-free suite drives the routes; this one drives
// `src/calendar-store.mjs` itself, because three of the requirement's promises
// are only about the store and only a real database can show them:
//
//   * create is **one transaction** — a failure leaves neither the `calendars`
//     row nor the owner's `calendar_members` row;
//   * a create is **committed** before it returns, which is what makes the
//     collection that is made afterwards visible to the CalDAV service
//     (E03-R08) — a second connection is what proves it;
//   * the version only moves when the expected version still matches, and a
//     delete cascades to the membership row.
//
// It needs the same disposable rootless-Podman Postgres as the other schema
// suites (`test/support/postgres.mjs`), and it runs in `make verify-server-api`.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';

import { createCalendarStore } from '../src/calendar-store.mjs';
import { config, fresh, migrate } from './support/postgres.mjs';

/**
 * A fresh migrated database, the API pool, and an independent connection whose
 * only job is to see what is committed.
 * @param {(context: {pool: pg.Pool, verifier: pg.Pool, name: string, user: string, other: string}) => Promise<void>} run
 */
async function withDatabase(run) {
  // `fresh()` hands back an admin connection of its own; it must be closed
  // again, or the process never leaves the event loop once the tests are done.
  const { name, client: admin } = await fresh();
  const result = migrate(name);
  assert.equal(result.status, 0, 'migration failed');
  const pool = new pg.Pool({ ...config(name), max: 4 });
  // A second pool: a connection of its own, so a read through it is a read of
  // committed state rather than of a transaction that is still open.
  const verifier = new pg.Pool({ ...config(name), max: 2 });
  try {
    let users = 0;
    /** @param {string} handle */
    const addUser = async (handle) => {
      users += 1;
      const { rows } = await verifier.query(
        `INSERT INTO public.users (idp_subject, handle, email)
         VALUES ($1, $2, $3) RETURNING id`,
        [`subject-${users}`, handle, `${handle}@example.invalid`],
      );
      return rows[0].id;
    };
    await run({
      pool,
      verifier,
      name,
      user: await addUser('alice'),
      other: await addUser('bob'),
    });
  } finally {
    await pool.end();
    await verifier.end();
    await admin.end();
  }
}

/**
 * The real pool, with the `n`th query of every `connect()` failing — so a test
 * can break the second statement of the create transaction and watch the first
 * one roll back.
 * @param {pg.Pool} pool @param {number} nth
 */
function poolThatFailsQuery(pool, nth) {
  let count = 0;
  return {
    /** @param {string} text @param {unknown[]} [values] */
    query: (text, values) => pool.query(text, values),
    async connect() {
      const client = await pool.connect();
      return {
        /** @param {string} text @param {unknown[]} [values] */
        async query(text, values) {
          count += 1;
          if (count === nth) {
            throw Object.assign(new Error('injected failure'), {
              code: '08006',
            });
          }
          return client.query(text, values);
        },
        release: () => client.release(),
      };
    },
  };
}

/** A blob with every byte value in it, so a bytea round-trip cannot be lossy. */
const envelopeBytes = () =>
  Buffer.from(Array.from({ length: 200 }, (_value, index) => index % 256));

test('the version column is the integer the concurrency token needs', async () => {
  await withDatabase(async ({ verifier }) => {
    const column = (
      await verifier.query(`SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'calendars'
          AND column_name = 'version'`)
    ).rows[0];
    assert.deepEqual(column, {
      data_type: 'integer',
      is_nullable: 'NO',
      column_default: '1',
    });
    const constraints = (
      await verifier.query(`SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'public.calendars'::regclass AND contype = 'c'
        ORDER BY conname`)
    ).rows;
    assert.deepEqual(
      constraints.map((row) => row.conname),
      [
        'calendars_meta_envelope_check',
        'calendars_mode_private_only_check',
        'calendars_version_check',
      ],
    );
    assert.equal(
      constraints.find((row) => row.conname === 'calendars_version_check')
        ?.definition,
      'CHECK ((version >= 1))',
    );
  });
});

test('createPrivate commits the calendar and the owner membership before it returns', async () => {
  await withDatabase(async ({ pool, verifier, user }) => {
    const calendars = createCalendarStore(pool);
    const id = randomUUID();
    const metaEnvelope = envelopeBytes();
    const row = await calendars.createPrivate({
      id,
      ownerId: user,
      href: `/calendars/${user}/${id}/`,
      metaEnvelope,
      // The largest epoch `calendars.meta_epoch` holds (E04's `integer`).
      metaEpoch: 2_147_483_647,
    });
    assert.equal(row.id, id);
    assert.equal(row.ownerId, user);
    assert.equal(row.mode, 'private');
    assert.equal(row.role, 'owner');
    assert.equal(row.version, 1);
    assert.equal(row.metaEpoch, 2_147_483_647);
    // The envelope is stored and read back byte for byte (D-18, INV-07).
    assert.equal(row.metaEnvelope, metaEnvelope.toString('base64'));
    assert.match(row.createdAt, /^\d{4}-\d{2}-\d{2}T/);

    // A different connection sees both rows: the transaction committed.
    const committed = await verifier.query(
      'SELECT id, caldav_href, meta_envelope FROM public.calendars WHERE id = $1',
      [id],
    );
    assert.equal(committed.rows.length, 1);
    assert.equal(committed.rows[0].caldav_href, `/calendars/${user}/${id}/`);
    assert.deepEqual(
      Buffer.from(committed.rows[0].meta_envelope),
      metaEnvelope,
    );
    const membership = await verifier.query(
      'SELECT user_id, role FROM public.calendar_members WHERE calendar_id = $1',
      [id],
    );
    assert.deepEqual(membership.rows, [{ user_id: user, role: 'owner' }]);
  });
});

test('a create whose membership insert fails leaves no calendar row behind', async () => {
  await withDatabase(async ({ pool, verifier, user }) => {
    // BEGIN, INSERT calendars, INSERT calendar_members: the third query fails,
    // and the rollback has to take the first one with it.
    const calendars = createCalendarStore(poolThatFailsQuery(pool, 3));
    const id = randomUUID();
    await assert.rejects(
      calendars.createPrivate({
        id,
        ownerId: user,
        href: `/calendars/${user}/${id}/`,
        metaEnvelope: envelopeBytes(),
        metaEpoch: 1,
      }),
      { message: 'injected failure' },
    );
    for (const table of ['public.calendars', 'public.calendar_members']) {
      const { rows } = await verifier.query(
        `SELECT count(*)::int AS n FROM ${table}`,
      );
      assert.equal(rows[0].n, 0, `${table} kept a row`);
    }
  });
});

test('the membership join hides calendars the caller is not in', async () => {
  await withDatabase(async ({ pool, user, other }) => {
    const calendars = createCalendarStore(pool);
    const mine = randomUUID();
    const theirs = randomUUID();
    await calendars.createPrivate({
      id: mine,
      ownerId: user,
      href: `/calendars/${user}/${mine}/`,
      metaEnvelope: envelopeBytes(),
      metaEpoch: 1,
    });
    await calendars.createPrivate({
      id: theirs,
      ownerId: other,
      href: `/calendars/${other}/${theirs}/`,
      metaEnvelope: envelopeBytes(),
      metaEpoch: 1,
    });
    await pool.query(
      `INSERT INTO public.calendar_members (calendar_id, user_id, role)
       VALUES ($1, $2, 'viewer')`,
      [theirs, user],
    );

    const mineList = await calendars.listForMember(user);
    assert.deepEqual(
      mineList.map((/** @type {any} */ row) => [row.id, row.role]).sort(),
      [
        [mine, 'owner'],
        [theirs, 'viewer'],
      ].sort(),
    );
    const otherList = await calendars.listForMember(other);
    assert.deepEqual(
      otherList.map((/** @type {any} */ row) => [row.id, row.role]),
      [[theirs, 'owner']],
    );
    assert.equal(await calendars.findMembership(mine, other), undefined);
    // A membership this user does not have is undefined, exactly like an id
    // that exists nowhere (the routes answer both as one 404).
    assert.equal(
      await calendars.findMembership(theirs, randomUUID()),
      undefined,
    );
    assert.equal(await calendars.findMembership(randomUUID(), user), undefined);
  });
});

test('the version moves only while the expected version still matches', async () => {
  await withDatabase(async ({ pool, verifier, user }) => {
    const calendars = createCalendarStore(pool);
    const id = randomUUID();
    const created = await calendars.createPrivate({
      id,
      ownerId: user,
      href: `/calendars/${user}/${id}/`,
      metaEnvelope: envelopeBytes(),
      metaEpoch: 1,
    });
    const replacement = Buffer.from('second envelope, opaque to the API');
    const updated = await calendars.replaceMeta({
      calendarId: id,
      expectedVersion: created.version,
      metaEnvelope: replacement,
      metaEpoch: 2,
    });
    assert.equal(updated?.version, 2);
    assert.equal(updated?.metaEnvelope, replacement.toString('base64'));
    assert.equal(updated?.metaEpoch, 2);
    assert.ok(
      String(updated?.updatedAt) >= String(created.updatedAt),
      'updated_at must not go backwards',
    );

    // The losing writer: the version it read is gone, so nothing is written.
    const lost = await calendars.replaceMeta({
      calendarId: id,
      expectedVersion: created.version,
      metaEnvelope: Buffer.from('the loser'),
      metaEpoch: 3,
    });
    assert.equal(lost, undefined);
    const committed = await verifier.query(
      'SELECT version, meta_epoch, meta_envelope FROM public.calendars WHERE id = $1',
      [id],
    );
    assert.equal(committed.rows[0].version, 2);
    assert.equal(committed.rows[0].meta_epoch, 2);
    assert.deepEqual(
      Buffer.from(committed.rows[0].meta_envelope),
      replacement,
      "the loser's envelope must not be stored",
    );
  });
});

test('remove deletes the calendar and cascades to its membership rows', async () => {
  await withDatabase(async ({ pool, verifier, user, other }) => {
    const calendars = createCalendarStore(pool);
    const id = randomUUID();
    await calendars.createPrivate({
      id,
      ownerId: user,
      href: `/calendars/${user}/${id}/`,
      metaEnvelope: envelopeBytes(),
      metaEpoch: 1,
    });
    await pool.query(
      `INSERT INTO public.calendar_members (calendar_id, user_id, role)
       VALUES ($1, $2, 'editor')`,
      [id, other],
    );
    assert.equal(await calendars.remove(id), true);
    assert.equal(
      (await verifier.query('SELECT count(*)::int AS n FROM public.calendars'))
        .rows[0].n,
      0,
    );
    assert.equal(
      (
        await verifier.query(
          'SELECT count(*)::int AS n FROM public.calendar_members',
        )
      ).rows[0].n,
      0,
      'the membership rows cascade',
    );
    // A retry of a delete that already happened is not an error state: the
    // route answers 204 either way.
    assert.equal(await calendars.remove(id), false);
  });
});
