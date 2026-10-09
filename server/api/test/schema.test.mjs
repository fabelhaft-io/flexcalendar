import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { config, fresh, migrate } from './support/postgres.mjs';

const apiTables = [
  'users',
  'calendars',
  'calendar_members',
  'invitations',
  'device_credentials',
  'feed_tokens',
  'push_devices',
  'device_links',
  'audit_log',
  'caldav_changes',
  'delegation_nonces',
];
const sabreTables = [
  'calendars',
  'calendarinstances',
  'calendarobjects',
  'calendarsubscriptions',
  'calendarchanges',
  'schedulingobjects',
  'propertystorage',
];
/** @param {pg.Client} client @param {string} sql @param {string} code */
async function rejects(client, sql, code) {
  await assert.rejects(client.query(sql), { code });
}

/** @param {(client: pg.Client, name: string) => Promise<void>} run */
async function withSchema(run) {
  const { name, client } = await fresh();
  try {
    const result = migrate(name);
    // Avoid logging database output: it may contain SQL values on failure.
    assert.equal(result.status, 0, 'migration failed');
    await run(client, name);
  } finally {
    await client.end();
  }
}

/** @param {pg.Client} client */
async function seed(client) {
  const user = (
    await client.query(`INSERT INTO public.users
    (idp_subject, handle, email) VALUES ('subject', 'Handle', 'test@example.invalid') RETURNING id`)
  ).rows[0].id;
  const calendar = (
    await client.query(
      `INSERT INTO public.calendars
    (owner_id, mode, caldav_href, meta_envelope, meta_epoch)
    VALUES ($1, 'private', '/test/', decode('01','hex'), 1) RETURNING id`,
      [user],
    )
  ).rows[0].id;
  return { user, calendar };
}

test('each login has exactly its table and schema grants; audit is append-only', async () => {
  await withSchema(async (owner, name) => {
    const { user } = await seed(owner);
    await owner.query(
      `INSERT INTO public.device_credentials (user_id, label, argon2id_hash)
      VALUES ($1, 'test device', 'test hash')`,
      [user],
    );
    for (const role of ['calflex_migrate', 'calflex_api', 'calflex_caldav']) {
      const client = new pg.Client(config(name, role));
      try {
        await client.connect();
        const flags = (
          await client.query(`SELECT rolsuper, rolcreatedb, rolcreaterole
          FROM pg_roles WHERE rolname = current_user`)
        ).rows[0];
        assert.deepEqual(flags, {
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
        });
        for (const schema of ['public', 'sabredav']) {
          const grants = (
            await client.query(
              `SELECT
              has_schema_privilege($1, $2, 'USAGE') AS usage,
              has_schema_privilege($1, $2, 'CREATE') AS create`,
              [role, schema],
            )
          ).rows[0];
          assert.deepEqual(grants, {
            usage: role !== 'calflex_api' || schema === 'public',
            create: role === 'calflex_migrate',
          });
          const ddl = `CREATE TABLE ${schema}.grant_probe (id uuid)`;
          if (role === 'calflex_migrate') {
            await client.query(ddl);
            await client.query(`DROP TABLE ${schema}.grant_probe`);
          } else {
            await rejects(client, ddl, '42501');
          }
        }
        for (const [schema, tables] of [
          ['public', apiTables],
          ['sabredav', sabreTables],
        ]) {
          for (const table of tables) {
            const full = `${schema}.${table}`;
            const fullDml =
              role === 'calflex_migrate' ||
              (role === 'calflex_api' &&
                schema === 'public' &&
                !['audit_log', 'caldav_changes', 'delegation_nonces'].includes(
                  table,
                )) ||
              (role === 'calflex_caldav' &&
                (schema === 'sabredav' ||
                  ['caldav_changes', 'delegation_nonces'].includes(table)));
            const read =
              fullDml ||
              (role === 'calflex_api' &&
                ['audit_log', 'caldav_changes'].includes(table)) ||
              (role === 'calflex_caldav' &&
                schema === 'public' &&
                ['users', 'calendars', 'calendar_members'].includes(table));
            const insert =
              fullDml || (role === 'calflex_api' && table === 'audit_log');
            const columns = (
              await owner.query(
                `SELECT column_name FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
                [schema, table],
              )
            ).rows;
            const column = columns[0].column_name;
            const statements = [
              [read, `SELECT * FROM ${full}`],
              [insert, `INSERT INTO ${full} SELECT * FROM ${full} WHERE false`],
              [fullDml, `UPDATE ${full} SET ${column} = ${column} WHERE false`],
              [fullDml, `DELETE FROM ${full} WHERE false`],
              [role === 'calflex_migrate', `TRUNCATE ${full} CASCADE`],
            ];
            // TRUNCATE's positive path would mutate seed data: metadata confirms
            // ownership; service denials are executed, not inferred.
            for (const [allowed, sql] of statements.slice(0, 4)) {
              if (allowed) await client.query(String(sql));
              else await rejects(client, String(sql), '42501');
            }
            if (role !== 'calflex_migrate')
              await rejects(client, String(statements[4][1]), '42501');
            const grants = (
              await owner.query(
                `SELECT
              has_table_privilege($1, $2, 'SELECT') AS read,
              has_table_privilege($1, $2, 'INSERT') AS insert,
              has_table_privilege($1, $2, 'UPDATE') AS update,
              has_table_privilege($1, $2, 'DELETE') AS delete`,
                [role, full],
              )
            ).rows[0];
            assert.deepEqual(grants, {
              read,
              insert,
              update: fullDml,
              delete: fullDml,
            });
          }
        }
        if (role === 'calflex_api') {
          await client.query(
            `INSERT INTO public.audit_log (action, subject) VALUES ('test', 'test')`,
          );
          await rejects(
            client,
            `UPDATE public.audit_log SET action = 'changed'`,
            '42501',
          );
          await rejects(client, 'DELETE FROM public.audit_log', '42501');
          assert.equal(
            (
              await client.query(
                'SELECT count(*)::int AS n FROM public.audit_log',
              )
            ).rows[0].n,
            1,
          );
        }
        if (role === 'calflex_caldav') {
          // No WHERE / RETURNING: only the updated column is granted, not SELECT.
          const updated = await client.query(
            'UPDATE public.device_credentials SET last_used_at = now()',
          );
          assert.equal(updated.rowCount, 1);
          await rejects(
            client,
            "UPDATE public.device_credentials SET label = 'changed'",
            '42501',
          );
          // Actual serial INSERT exercises the SabreDAV sequence grants.
          await client.query('INSERT INTO sabredav.calendars DEFAULT VALUES');
        }
      } finally {
        await client.end();
      }
    }
    // Future SabreDAV additions inherit grants; API must remain excluded.
    await owner.query(
      'CREATE TABLE sabredav.future_grant_probe (id uuid DEFAULT gen_random_uuid())',
    );
    await owner.query('CREATE SEQUENCE sabredav.future_sequence_probe');
    for (const role of ['calflex_api', 'calflex_caldav']) {
      const client = new pg.Client(config(name, role));
      try {
        await client.connect();
        for (const sql of [
          'INSERT INTO sabredav.future_grant_probe DEFAULT VALUES',
          "SELECT nextval('sabredav.future_sequence_probe')",
          "SELECT currval('sabredav.future_sequence_probe')",
          "SELECT setval('sabredav.future_sequence_probe', 3)",
        ]) {
          if (role === 'calflex_caldav') await client.query(sql);
          else await rejects(client, sql, '42501');
        }
      } finally {
        await client.end();
      }
    }
    await owner.query('DROP TABLE sabredav.future_grant_probe');
    await owner.query('DROP SEQUENCE sabredav.future_sequence_probe');
    const owners = (
      await owner.query(`SELECT DISTINCT tableowner FROM pg_tables
      WHERE schemaname IN ('public', 'sabredav')`)
    ).rows;
    assert.deepEqual(owners, [{ tableowner: 'calflex_migrate' }]);
    const schemas = (
      await owner.query(`SELECT nspname, pg_get_userbyid(nspowner) AS owner
      FROM pg_namespace WHERE nspname IN ('public', 'sabredav') ORDER BY nspname`)
    ).rows;
    assert.deepEqual(schemas, [
      { nspname: 'public', owner: 'calflex_migrate' },
      { nspname: 'sabredav', owner: 'calflex_migrate' },
    ]);
    const lastUsed = (
      await owner.query('SELECT last_used_at FROM public.device_credentials')
    ).rows[0].last_used_at;
    assert.ok(lastUsed instanceof Date);
  });
});

test('calendar mode is an explicit ordered enum with a private-only Phase 1 gate', async () => {
  await withSchema(async (client) => {
    const column = (
      await client.query(`SELECT udt_schema, udt_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'calendars' AND column_name = 'mode'`)
    ).rows[0];
    assert.deepEqual(column, {
      udt_schema: 'public',
      udt_name: 'calendar_mode',
      is_nullable: 'NO',
      column_default: null,
    });
    assert.deepEqual(
      (
        await client.query(`SELECT enumlabel FROM pg_enum
          WHERE enumtypid = 'public.calendar_mode'::regtype ORDER BY enumsortorder`)
      ).rows.map((row) => row.enumlabel),
      ['private', 'shared', 'published'],
    );
    const { user } = await seed(client);
    for (const mode of ['shared', 'published']) {
      await assert.rejects(
        client.query(
          `INSERT INTO public.calendars (owner_id, mode, caldav_href, meta_epoch)
          VALUES ($1, $2, $3, 1)`,
          [user, mode, `/${mode}/`],
        ),
        { code: '23514', constraint: 'calendars_mode_private_only_check' },
      );
    }
    await rejects(
      client,
      `INSERT INTO public.calendars (owner_id, mode, caldav_href, meta_epoch)
      VALUES ('${user}', 'bogus', '/unknown/', 1)`,
      '22P02',
    );
    await assert.rejects(
      client.query(
        `INSERT INTO public.calendars (owner_id, mode, caldav_href, meta_epoch)
        VALUES ($1, 'private', '/missing-envelope/', 1)`,
        [user],
      ),
      { code: '23514', constraint: 'calendars_meta_envelope_check' },
    );
    const check = (
      await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'public.calendars'::regclass
        AND conname = 'calendars_meta_envelope_check' AND contype = 'c'`)
    ).rows[0].definition;
    assert.equal(
      check,
      "CHECK (((mode = 'private'::calendar_mode) = (meta_envelope IS NOT NULL)))",
    );
  });
});

test('lifting only the Phase 1 gate preserves metadata envelope enforcement', async () => {
  await withSchema(async (client) => {
    const { user } = await seed(client);
    await client.query(
      'ALTER TABLE public.calendars DROP CONSTRAINT calendars_mode_private_only_check',
    );
    await client.query(
      `INSERT INTO public.calendars (owner_id, mode, caldav_href, meta_epoch)
      VALUES ($1, 'shared', '/shared/', 1)`,
      [user],
    );
    for (const values of ["'shared', decode('01','hex')", "'private', NULL"]) {
      await assert.rejects(
        client.query(
          `INSERT INTO public.calendars (owner_id, mode, meta_envelope, caldav_href, meta_epoch)
          VALUES ($1, ${values}, '/invalid/', 1)`,
          [user],
        ),
        { code: '23514', constraint: 'calendars_meta_envelope_check' },
      );
    }
  });
});

test('API role can use the mode enum but cannot bypass the private-only gate', async () => {
  await withSchema(async (owner, name) => {
    const { user } = await seed(owner);
    const client = new pg.Client(config(name, 'calflex_api'));
    try {
      await client.connect();
      const inserted = await client.query(
        `INSERT INTO public.calendars (owner_id, mode, meta_envelope, caldav_href, meta_epoch)
        VALUES ($1, 'private', decode('01','hex'), '/api/', 1) RETURNING mode`,
        [user],
      );
      assert.equal(inserted.rows[0].mode, 'private');
      await assert.rejects(
        client.query(
          `INSERT INTO public.calendars (owner_id, mode, caldav_href, meta_epoch)
          VALUES ($1, 'shared', '/api-shared/', 1)`,
          [user],
        ),
        { code: '23514', constraint: 'calendars_mode_private_only_check' },
      );
    } finally {
      await client.end();
    }
  });
});

test('mode conversion preserves existing data and reverses to the original text check', async () => {
  const { name, client } = await fresh();
  try {
    assert.equal(
      migrate(name, ['up', '3']).status,
      0,
      'previous migrations failed',
    );
    const { calendar } = await seed(client);
    assert.equal(migrate(name).status, 0, 'mode migration failed');
    const readCalendar = async () =>
      (
        await client.query(
          `SELECT mode, meta_epoch, meta_envelope = decode('01','hex') AS envelope_preserved
          FROM public.calendars WHERE id = $1`,
          [calendar],
        )
      ).rows[0];
    const expected = {
      mode: 'private',
      meta_epoch: 1,
      envelope_preserved: true,
    };
    assert.deepEqual(await readCalendar(), expected);
    assert.equal(
      migrate(name, ['down', '1']).status,
      0,
      'mode rollback failed',
    );
    assert.equal(
      (
        await client.query(`SELECT data_type FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'calendars' AND column_name = 'mode'`)
      ).rows[0].data_type,
      'text',
    );
    assert.deepEqual(
      (
        await client.query(`SELECT conname, pg_get_constraintdef(oid) AS definition
          FROM pg_constraint WHERE conrelid = 'public.calendars'::regclass
          AND contype = 'c' ORDER BY conname`)
      ).rows,
      [
        {
          conname: 'calendars_meta_envelope_check',
          definition:
            "CHECK (((mode = 'private'::text) = (meta_envelope IS NOT NULL)))",
        },
      ],
    );
    assert.equal(
      (await client.query("SELECT to_regtype('public.calendar_mode') AS type"))
        .rows[0].type,
      null,
    );
    assert.deepEqual(await readCalendar(), expected);
    assert.equal(migrate(name).status, 0, 'mode reapplication failed');
    assert.equal(
      (
        await client.query(`SELECT udt_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'calendars' AND column_name = 'mode'`)
      ).rows[0].udt_name,
      'calendar_mode',
    );
    assert.deepEqual(await readCalendar(), expected);
  } finally {
    await client.end();
  }
});

test('metadata envelope consistency, explicit mode, unique values and foreign keys', async () => {
  await withSchema(async (client) => {
    await client.query(
      'ALTER TABLE public.calendars DROP CONSTRAINT calendars_mode_private_only_check',
    );
    const { user, calendar } = await seed(client);
    for (const values of [
      "'private', NULL",
      "'shared', decode('01','hex')",
      "'published', decode('01','hex')",
    ]) {
      await rejects(
        client,
        `INSERT INTO public.calendars
        (owner_id, mode, meta_envelope, caldav_href, meta_epoch)
        VALUES ('${user}', ${values}, '/invalid/', 1)`,
        '23514',
      );
    }
    await rejects(
      client,
      `INSERT INTO public.calendars (owner_id, caldav_href, meta_epoch)
      VALUES ('${user}', '/missing-mode/', 1)`,
      '23502',
    );
    for (const mode of ['shared', 'published']) {
      await client.query(
        `INSERT INTO public.calendars (owner_id, mode, caldav_href, meta_epoch)
        VALUES ($1, $2, $3, 1)`,
        [user, mode, `/${mode}/`],
      );
    }
    for (const values of [
      "'subject', 'other', 'other@example.invalid'",
      "'other', 'HANDLE', 'other@example.invalid'",
      "'other', 'other', 'TEST@EXAMPLE.INVALID'",
    ]) {
      await rejects(
        client,
        `INSERT INTO public.users (idp_subject, handle, email) VALUES (${values})`,
        '23505',
      );
    }
    await rejects(
      client,
      `INSERT INTO public.calendars (owner_id, mode, caldav_href, meta_epoch)
      VALUES ('${user}', 'shared', '/test/', 1)`,
      '23505',
    );
    await rejects(
      client,
      `INSERT INTO public.calendar_members VALUES ('${calendar}', gen_random_uuid(), 'viewer')`,
      '23503',
    );
    await rejects(
      client,
      `INSERT INTO public.calendar_members VALUES ('${calendar}', '${user}', 'invalid')`,
      '23514',
    );
    const expectedFks = {
      calendars: ['owner_id'],
      calendar_members: ['calendar_id', 'user_id'],
      invitations: ['calendar_id'],
      device_credentials: ['user_id'],
      feed_tokens: ['calendar_id'],
      push_devices: ['user_id'],
      device_links: ['user_id'],
      audit_log: ['actor_id'],
      caldav_changes: ['calendar_id'],
    };
    for (const [table, columns] of Object.entries(expectedFks)) {
      const fks = (
        await client.query(
          `SELECT a.attname AS column, c.confrelid::regclass::text AS target
        FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.conrelid = $1::regclass AND c.contype = 'f' ORDER BY a.attname`,
          [`public.${table}`],
        )
      ).rows;
      assert.deepEqual(
        fks,
        columns.map((column) => ({
          column,
          target: column === 'calendar_id' ? 'calendars' : 'users',
        })),
      );
    }
    for (const table of apiTables) {
      const constraints = (
        await client.query(
          `SELECT contype FROM pg_constraint WHERE conrelid = $1::regclass`,
          [`public.${table}`],
        )
      ).rows;
      assert.ok(
        constraints.some((row) => row.contype === 'p'),
        `${table} has a primary key`,
      );
      if (
        [
          'invitations',
          'feed_tokens',
          'push_devices',
          'calendars',
          'users',
        ].includes(table)
      ) {
        assert.ok(
          constraints.some((row) => row.contype === 'u'),
          `${table} has its unique constraint`,
        );
      }
    }
    const ids = (
      await client.query(`SELECT table_name, data_type, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'id' AND table_name <> 'pgmigrations' ORDER BY table_name`)
    ).rows;
    assert.equal(ids.length, 9);
    for (const id of ids) {
      assert.equal(id.data_type, 'uuid');
      assert.equal(id.column_default, 'gen_random_uuid()');
    }
    assert.match(
      user,
      /^[0-9a-f-]{14}4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const columns = (
      await client.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'calendars'`)
    ).rows.map((row) => row.column_name);
    assert.ok(!columns.some((column) => /name|colou?r/.test(column)));
  });
});

test('calendar deletion cascades and the whole chain goes down and up as migration owner', async () => {
  await withSchema(async (client, name) => {
    const { user, calendar } = await seed(client);
    await client.query(
      'INSERT INTO public.calendar_members VALUES ($1, $2, $3)',
      [calendar, user, 'owner'],
    );
    await client.query(
      `INSERT INTO public.invitations (calendar_id, token_hash, expires_at)
      VALUES ($1, decode('01','hex'), now())`,
      [calendar],
    );
    await client.query(
      `INSERT INTO public.feed_tokens (calendar_id, variant, token_hash)
      VALUES ($1, 'busy', decode('01','hex'))`,
      [calendar],
    );
    await client.query(
      `INSERT INTO public.caldav_changes (calendar_id, sync_token, uid, change_type)
      VALUES ($1, 1, gen_random_uuid()::text, 'created')`,
      [calendar],
    );
    await rejects(
      client,
      `INSERT INTO public.calendar_members VALUES ('${calendar}', '${user}', 'viewer')`,
      '23505',
    );
    await rejects(
      client,
      `INSERT INTO public.invitations (calendar_id, token_hash, expires_at)
      VALUES ('${calendar}', decode('01','hex'), now())`,
      '23505',
    );
    await rejects(
      client,
      `INSERT INTO public.feed_tokens (calendar_id, variant, token_hash)
      VALUES ('${calendar}', 'full', decode('01','hex'))`,
      '23505',
    );
    await rejects(
      client,
      `INSERT INTO public.feed_tokens (calendar_id, variant, token_hash)
      VALUES ('${calendar}', 'invalid', decode('02','hex'))`,
      '23514',
    );
    await rejects(
      client,
      `INSERT INTO public.caldav_changes (calendar_id, sync_token, uid, change_type)
      VALUES ('${calendar}', 2, gen_random_uuid()::text, 'invalid')`,
      '23514',
    );
    await client.query('DELETE FROM public.calendars WHERE id = $1', [
      calendar,
    ]);
    for (const table of [
      'calendar_members',
      'invitations',
      'feed_tokens',
      'caldav_changes',
    ]) {
      assert.equal(
        (await client.query(`SELECT count(*)::int AS n FROM public.${table}`))
          .rows[0].n,
        0,
      );
    }
    assert.equal(migrate(name, ['down', '0']).status, 0);
    assert.deepEqual(
      (
        await client.query(
          `SELECT tablename FROM pg_tables WHERE schemaname IN ('public', 'sabredav')`,
        )
      ).rows,
      [{ tablename: 'pgmigrations' }],
    );
    assert.equal(
      (await client.query('SELECT count(*)::int AS n FROM public.pgmigrations'))
        .rows[0].n,
      0,
    );
    assert.equal(migrate(name).status, 0);
    await seed(client);
  });
});
