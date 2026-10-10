import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import pg from 'pg';
import { config, fresh, migrate } from './support/postgres.mjs';

const tables = ['user_keys', 'user_key_wraps', 'calendar_keys'];
const publicKey = Buffer.alloc(32, 1);
const identityKey = Buffer.alloc(32, 2);
const blob = Buffer.alloc(80, 3);

/** @param {pg.Client} client @param {string} sql @param {unknown[]} [values] */
async function query(client, sql, values = []) {
  try {
    return await client.query(sql, values);
  } catch (error) {
    // Postgres error.detail contains the entire failed row, including blobs.
    throw Object.assign(new Error('Key material query failed'), {
      code: error instanceof Error && 'code' in error ? error.code : undefined,
      constraint:
        error instanceof Error && 'constraint' in error
          ? error.constraint
          : undefined,
    });
  }
}

/** @param {pg.Client} client @param {string} user @param {Buffer} [x] @param {Buffer} [ed] */
const keys = (client, user, x = publicKey, ed = identityKey) =>
  query(
    client,
    `INSERT INTO public.user_keys (user_id, x25519_public_key, ed25519_public_key) VALUES ($1, $2, $3)`,
    [user, x, ed],
  );

/** @param {pg.Client} client @param {string} user @param {string} kind @param {Buffer} [bytes] */
const wrap = (client, user, kind, bytes = blob) =>
  query(
    client,
    `INSERT INTO public.user_key_wraps (user_id, kind, wrapped_private_keys) VALUES ($1, $2, $3)`,
    [user, kind, bytes],
  );

/** @param {pg.Client} client @param {string} calendar @param {string} user @param {number} [epoch] @param {Buffer} [bytes] */
const record = (client, calendar, user, epoch = 1, bytes = blob) =>
  query(
    client,
    `INSERT INTO public.calendar_keys (calendar_id, epoch, user_id, record) VALUES ($1, $2, $3, $4)`,
    [calendar, epoch, user, bytes],
  );

/** @param {pg.Client} client */
async function user(client) {
  return (
    await client.query(
      `INSERT INTO public.users (idp_subject, handle, email) VALUES ($1, 'Handle', 'test@example.invalid') RETURNING id`,
      [randomUUID()],
    )
  ).rows[0].id;
}

/** @param {(client: pg.Client, name: string) => Promise<void>} run @param {string[]} [direction] */
async function withKeys(run, direction) {
  const { name, client } = await fresh();
  try {
    assert.equal(migrate(name, direction).status, 0, 'migration failed');
    await run(client, name);
  } finally {
    await client.end();
  }
}

/** @param {pg.Client} client @param {string} owner */
async function calendar(client, owner) {
  return (
    await client.query(
      `INSERT INTO public.calendars (owner_id, mode, caldav_href, meta_envelope, meta_epoch) VALUES ($1, 'private', '/test/', decode('01', 'hex'), 1) RETURNING id`,
      [owner],
    )
  ).rows[0].id;
}

/** @param {pg.Client} client @param {string} calendarId @param {string} userId */
async function member(client, calendarId, userId) {
  await client.query(
    `INSERT INTO public.calendar_members (calendar_id, user_id, role) VALUES ($1, $2, 'viewer')`,
    [calendarId, userId],
  );
}

test('key tables have pinned types, required columns and only timestamp defaults', async () => {
  await withKeys(async (client) => {
    const layouts = {
      user_keys: [
        ['user_id', 'uuid'],
        ['x25519_public_key', 'bytea'],
        ['ed25519_public_key', 'bytea'],
      ],
      user_key_wraps: [
        ['user_id', 'uuid'],
        ['kind', 'text'],
        ['wrapped_private_keys', 'bytea'],
      ],
      calendar_keys: [
        ['calendar_id', 'uuid'],
        ['epoch', 'integer'],
        ['user_id', 'uuid'],
        ['record', 'bytea'],
      ],
    };
    for (const [table, columns] of Object.entries(layouts)) {
      const rows = (
        await client.query(
          `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
          [table],
        )
      ).rows;
      assert.deepEqual(
        rows,
        [...columns, ['created_at', 'timestamp with time zone']].map(
          ([column_name, data_type]) => ({
            column_name,
            data_type,
            is_nullable: 'NO',
            column_default: column_name === 'created_at' ? 'now()' : null,
          }),
        ),
      );
    }
  });
});

test('user keys are one 32-byte public pair per existing user', async () => {
  await withKeys(async (client) => {
    const id = await user(client);
    for (const size of [31, 33]) {
      await assert.rejects(keys(client, id, Buffer.alloc(size)), {
        code: '23514',
        constraint: 'user_keys_x25519_length_check',
      });
      await assert.rejects(keys(client, id, publicKey, Buffer.alloc(size)), {
        code: '23514',
        constraint: 'user_keys_ed25519_length_check',
      });
    }
    await keys(client, id);
    const row = (
      await client.query('SELECT * FROM public.user_keys WHERE user_id = $1', [
        id,
      ])
    ).rows[0];
    assert.ok(
      row.x25519_public_key.equals(publicKey),
      'X25519 bytes round trip',
    );
    assert.ok(
      row.ed25519_public_key.equals(identityKey),
      'Ed25519 bytes round trip',
    );
    assert.ok(row.created_at instanceof Date);
    await assert.rejects(keys(client, id), { code: '23505' });
    await assert.rejects(keys(client, randomUUID()), { code: '23503' });
  });
});

test('wrap kinds exclude passwords and escrow stays gated until Phase 7', async () => {
  await withKeys(async (client) => {
    const id = await user(client);
    await keys(client, id);
    await wrap(client, id, 'recovery_code');
    const row = (
      await client.query(
        'SELECT * FROM public.user_key_wraps WHERE user_id = $1',
        [id],
      )
    ).rows[0];
    assert.ok(
      row.wrapped_private_keys.equals(blob),
      'wrapped bytes round trip',
    );
    assert.ok(row.created_at instanceof Date);
    await assert.rejects(wrap(client, id, 'recovery_code'), { code: '23505' });
    await assert.rejects(wrap(client, id, 'escrow'), {
      code: '23514',
      constraint: 'user_key_wraps_no_escrow_check',
    });
    for (const kind of ['password', '']) {
      await assert.rejects(wrap(client, id, kind), {
        code: '23514',
        constraint: 'user_key_wraps_kind_check',
      });
    }
    const other = await user(client);
    await keys(client, other);
    await assert.rejects(
      wrap(client, other, 'recovery_code', Buffer.alloc(0)),
      { code: '23514', constraint: 'user_key_wraps_nonempty_check' },
    );
    await assert.rejects(wrap(client, await user(client), 'recovery_code'), {
      code: '23503',
    });
    await client.query(
      'ALTER TABLE public.user_key_wraps DROP CONSTRAINT user_key_wraps_no_escrow_check',
    );
    await wrap(client, id, 'escrow');
    await assert.rejects(wrap(client, id, 'password'), {
      code: '23514',
      constraint: 'user_key_wraps_kind_check',
    });
    assert.deepEqual(
      (
        await client.query(
          'SELECT kind FROM public.user_key_wraps WHERE user_id = $1 ORDER BY kind',
          [id],
        )
      ).rows.map((row) => row.kind),
      ['escrow', 'recovery_code'],
    );
  });
});

test('CCK records belong to key-capable members and cascade with membership and calendar', async () => {
  await withKeys(async (client) => {
    const first = await user(client);
    const second = await user(client);
    const outsider = await user(client);
    const noKeys = await user(client);
    for (const id of [first, second, outsider]) await keys(client, id);
    const cal = await calendar(client, first);
    for (const id of [first, second, noKeys]) await member(client, cal, id);
    await record(client, cal, first);
    const row = (
      await client.query(
        'SELECT * FROM public.calendar_keys WHERE calendar_id = $1 AND user_id = $2',
        [cal, first],
      )
    ).rows[0];
    assert.ok(row.record.equals(blob), 'sealed signed record bytes round trip');
    assert.ok(row.created_at instanceof Date);
    await assert.rejects(record(client, cal, first), { code: '23505' });
    await record(client, cal, first, 2);
    await record(client, cal, second);
    await assert.rejects(record(client, cal, outsider), { code: '23503' });
    await assert.rejects(record(client, cal, noKeys), { code: '23503' });
    await assert.rejects(record(client, cal, second, 2, Buffer.alloc(0)), {
      code: '23514',
      constraint: 'calendar_keys_nonempty_check',
    });
    assert.equal(
      (
        await client.query(
          'SELECT count(*)::int AS n FROM public.calendar_keys',
        )
      ).rows[0].n,
      3,
    );
    await client.query(
      'DELETE FROM public.calendar_members WHERE calendar_id = $1 AND user_id = $2',
      [cal, first],
    );
    assert.deepEqual(
      (await client.query('SELECT user_id, epoch FROM public.calendar_keys'))
        .rows,
      [{ user_id: second, epoch: 1 }],
    );
    await client.query('DELETE FROM public.calendars WHERE id = $1', [cal]);
    assert.equal(
      (
        await client.query(
          'SELECT count(*)::int AS n FROM public.calendar_keys',
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await client.query('SELECT count(*)::int AS n FROM public.user_keys'))
        .rows[0].n,
      3,
    );
  });
});

test('only the API service has DML access to key material; PUBLIC has no grants', async () => {
  await withKeys(async (owner, name) => {
    for (const role of ['calflex_api', 'calflex_caldav']) {
      const client = new pg.Client(config(name, role));
      try {
        await client.connect();
        for (const table of tables) {
          const full = `public.${table}`;
          for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
            assert.equal(
              (
                await owner.query(
                  'SELECT has_table_privilege($1, $2, $3) AS allowed',
                  [role, full, privilege],
                )
              ).rows[0].allowed,
              role === 'calflex_api',
            );
            assert.equal(
              (
                await owner.query(
                  'SELECT has_table_privilege($1, $2, $3) AS allowed',
                  ['public', full, privilege],
                )
              ).rows[0].allowed,
              false,
            );
          }
          for (const sql of [
            `SELECT * FROM ${full}`,
            `INSERT INTO ${full} SELECT * FROM ${full} WHERE false`,
            `UPDATE ${full} SET user_id = user_id WHERE false`,
            `DELETE FROM ${full} WHERE false`,
          ]) {
            if (role === 'calflex_api') await query(client, sql);
            else await assert.rejects(query(client, sql), { code: '42501' });
          }
        }
      } finally {
        await client.end();
      }
    }
    // An otherwise unprivileged role with schema USAGE exercises PUBLIC's
    // table-level denials, rather than failing at the schema boundary.
    const admin = new pg.Client(config(name, 'postgres'));
    const probe = `public_probe_${name}`;
    try {
      await admin.connect();
      await admin.query(`CREATE ROLE ${probe} NOLOGIN`);
      await admin.query(`GRANT USAGE ON SCHEMA public TO ${probe}`);
      await admin.query(`SET ROLE ${probe}`);
      for (const table of tables) {
        const full = `public.${table}`;
        for (const sql of [
          `SELECT * FROM ${full}`,
          `INSERT INTO ${full} SELECT * FROM ${full} WHERE false`,
          `UPDATE ${full} SET user_id = user_id WHERE false`,
          `DELETE FROM ${full} WHERE false`,
        ])
          await assert.rejects(query(admin, sql), { code: '42501' });
      }
    } finally {
      await admin.query('RESET ROLE');
      await admin.query(`DROP OWNED BY ${probe}`);
      await admin.query(`DROP ROLE ${probe}`);
      await admin.end();
    }
  });
});

test('member-key down touches no other tables and up restores usable key tables', async () => {
  const migrations = readdirSync(new URL('../migrations/', import.meta.url))
    .filter((file) => file.endsWith('.mjs'))
    .sort();
  const position = migrations.indexOf('1791656409006_member-keys.mjs');
  assert.ok(position >= 0, 'member-key migration exists');
  await withKeys(
    async (client, name) => {
      const id = await user(client);
      await keys(client, id);
      await wrap(client, id, 'recovery_code');
      const cal = await calendar(client, id);
      await member(client, cal, id);
      await record(client, cal, id);
      const inventory = async () =>
        (
          await client.query(
            `SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('public', 'sabredav') AND tablename NOT IN ('user_keys', 'user_key_wraps', 'calendar_keys') ORDER BY schemaname, tablename`,
          )
        ).rows;
      const before = await inventory();
      assert.equal(
        migrate(name, ['down', '1']).status,
        0,
        'down migration failed',
      );
      for (const table of tables) {
        assert.equal(
          (
            await client.query('SELECT to_regclass($1) AS name', [
              `public.${table}`,
            ])
          ).rows[0].name,
          null,
        );
      }
      assert.deepEqual(await inventory(), before);
      assert.equal(
        (
          await client.query(
            'SELECT count(*)::int AS n FROM public.calendar_members WHERE calendar_id = $1 AND user_id = $2',
            [cal, id],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(migrate(name, ['up', '1']).status, 0, 'up migration failed');
      await keys(client, id);
      await wrap(client, id, 'recovery_code');
      await record(client, cal, id);
    },
    ['up', String(position + 1)],
  );
});
