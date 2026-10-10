import assert from 'node:assert/strict';
import { test } from 'node:test';
import ICAL from 'ical.js';
import { fresh, migrate } from './support/postgres.mjs';
import { recurrenceKey } from '../src/recurrence-key.mjs';

/** @param {(client: import('pg').Client, calendar: string, name: string) => Promise<void>} run */
async function withEnvelopes(run) {
  const { name, client } = await fresh();
  try {
    assert.equal(migrate(name).status, 0, 'migration failed');
    const user = (
      await client.query(`INSERT INTO public.users (idp_subject, handle, email)
        VALUES ('subject', 'Handle', 'test@example.invalid') RETURNING id`)
    ).rows[0].id;
    const calendar = (
      await client.query(
        `INSERT INTO public.calendars (owner_id, mode, caldav_href, meta_envelope, meta_epoch)
        VALUES ($1, 'private', '/test/', decode('01', 'hex'), 1) RETURNING id`,
        [user],
      )
    ).rows[0].id;
    await run(client, calendar, name);
  } finally {
    await client.end();
  }
}

// Arbitrary stock-app UID: it must not be constrained to UUID syntax.
const uid = 'stock-app-uid@example.invalid';
const hash = Buffer.alloc(32, 1);
const envelope = Buffer.alloc(48, 7);
/**
 * @param {import('pg').Client} client
 * @param {string} calendar
 * @param {string | null} recurrence
 * @param {Buffer} [digest]
 */
function insert(client, calendar, recurrence, digest = hash) {
  return client
    .query(
      `INSERT INTO public.event_envelopes
      (calendar_id, uid, recurrence_id, envelope_sha256, epoch, envelope)
      VALUES ($1, $2, $3, $4, 1, $5)`,
      [calendar, uid, recurrence, digest, envelope],
    )
    .catch((error) => {
      // Postgres check failures include the entire row in error.detail. Keep
      // only diagnostic identifiers so failed assertions cannot log ciphertext.
      throw Object.assign(new Error('Envelope insert failed'), {
        code: error.code,
        constraint: error.constraint,
      });
    });
}

/** @param {string} line */
function key(line) {
  const calendar = new ICAL.Component(
    ICAL.parse(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VTIMEZONE',
        'TZID:Europe/Berlin',
        'BEGIN:STANDARD',
        'DTSTART:19701025T030000',
        'TZOFFSETFROM:+0200',
        'TZOFFSETTO:+0100',
        'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
        'END:STANDARD',
        'BEGIN:DAYLIGHT',
        'DTSTART:19700329T020000',
        'TZOFFSETFROM:+0100',
        'TZOFFSETTO:+0200',
        'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
        'END:DAYLIGHT',
        'END:VTIMEZONE',
        'BEGIN:VEVENT',
        line,
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
    ),
  );
  const event = calendar.getFirstSubcomponent('vevent');
  assert.ok(event);
  const property = event.getFirstProperty('recurrence-id');
  assert.ok(property);
  return recurrenceKey(property);
}

test('master and override with one UID are read by their own recurrence identity', async () => {
  await withEnvelopes(async (client, calendar) => {
    const override = key('RECURRENCE-ID:20261012T080000Z');
    await insert(client, calendar, null);
    await insert(client, calendar, override);
    for (const recurrence of [null, override]) {
      const { rows } = await client.query(
        `SELECT recurrence_id, envelope_sha256, epoch, envelope, created_at
        FROM public.event_envelopes WHERE calendar_id = $1 AND uid = $2
        AND recurrence_id IS NOT DISTINCT FROM $3 AND envelope_sha256 = $4`,
        [calendar, uid, recurrence, hash],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].recurrence_id, recurrence);
      // Never print envelope bytes in assertion failures.
      assert.ok(rows[0].envelope.equals(envelope), 'opaque bytes round trip');
      assert.ok(
        rows[0].envelope_sha256.equals(hash),
        'digest bytes round trip',
      );
      assert.equal(rows[0].epoch, 1);
      assert.ok(rows[0].created_at instanceof Date);
    }
  });
});

test('NULL masters are unique per hash, but new hashes coexist until garbage collection', async () => {
  await withEnvelopes(async (client, calendar) => {
    await insert(client, calendar, null);
    await assert.rejects(insert(client, calendar, null), {
      code: '23505',
      constraint: 'event_envelopes_key',
    });
    await insert(client, calendar, null, Buffer.alloc(32, 2));
    assert.equal(
      (
        await client.query(
          'SELECT count(*)::int AS n FROM public.event_envelopes',
        )
      ).rows[0].n,
      2,
    );
  });
});

test('UTC and TZID representations collide on the same override key', async () => {
  await withEnvelopes(async (client, calendar) => {
    const utc = key('RECURRENCE-ID:20261012T080000Z');
    const zoned = key('RECURRENCE-ID;TZID=Europe/Berlin:20261012T100000');
    assert.equal(utc, '20261012T080000Z');
    assert.equal(zoned, utc);
    await insert(client, calendar, utc);
    await assert.rejects(insert(client, calendar, zoned), {
      code: '23505',
      constraint: 'event_envelopes_key',
    });
  });
});

test('hash length and recurrence encodings are enforced by named checks', async () => {
  await withEnvelopes(async (client, calendar) => {
    for (const length of [31, 33]) {
      await assert.rejects(
        insert(client, calendar, null, Buffer.alloc(length)),
        {
          code: '23514',
          constraint: 'event_envelopes_sha256_length_check',
        },
      );
    }
    for (const invalid of [
      '20261012T100000',
      '20261012t080000z',
      '2026-10-12',
    ]) {
      await assert.rejects(insert(client, calendar, invalid), {
        code: '23514',
        constraint: 'event_envelopes_recurrence_id_check',
      });
    }
    await insert(client, calendar, key('RECURRENCE-ID;VALUE=DATE:20261012'));
  });
});

test('calendar deletion cascades to all envelope versions and overrides', async () => {
  await withEnvelopes(async (client, calendar) => {
    await insert(client, calendar, null);
    await insert(client, calendar, null, Buffer.alloc(32, 2));
    await insert(client, calendar, '20261012T080000Z');
    await client.query('DELETE FROM public.calendars WHERE id = $1', [
      calendar,
    ]);
    assert.equal(
      (
        await client.query(
          'SELECT count(*)::int AS n FROM public.event_envelopes',
        )
      ).rows[0].n,
      0,
    );
  });
});

test('down removes only the sidecar table and up restores a usable table', async () => {
  await withEnvelopes(async (client, calendar, name) => {
    await insert(client, calendar, null);
    assert.equal(
      migrate(name, ['down', '1']).status,
      0,
      'down migration failed',
    );
    assert.equal(
      (
        await client.query(
          "SELECT to_regclass('public.event_envelopes') AS table_name",
        )
      ).rows[0].table_name,
      null,
    );
    assert.equal(migrate(name).status, 0, 'up migration failed');
    await insert(client, calendar, null);
    assert.equal(
      (
        await client.query(
          'SELECT count(*)::int AS n FROM public.event_envelopes',
        )
      ).rows[0].n,
      1,
    );
  });
});
