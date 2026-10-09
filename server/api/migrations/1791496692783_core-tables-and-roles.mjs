/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF (SELECT count(*) FROM pg_roles WHERE rolname IN
          ('calflex_migrate', 'calflex_api', 'calflex_caldav')) <> 3 THEN
        RAISE EXCEPTION 'Missing service roles: run infra/dev/postgres/initdb/20-roles.sql (fresh dev stack: make dev-reset)';
      END IF;
    END $$;

    CREATE TABLE public.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      idp_subject text NOT NULL UNIQUE,
      handle text NOT NULL,
      email text NOT NULL
    );
    CREATE UNIQUE INDEX users_handle_unique ON public.users (lower(handle));
    CREATE UNIQUE INDEX users_email_unique ON public.users (lower(email));

    CREATE TABLE public.calendars (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id uuid NOT NULL REFERENCES public.users(id),
      mode text NOT NULL,
      caldav_href text NOT NULL UNIQUE,
      meta_envelope bytea,
      meta_epoch integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT calendars_meta_envelope_check CHECK
        ((mode = 'private') = (meta_envelope IS NOT NULL))
    );
    -- E04-R03 converts mode to an enum and adds the Phase 1 private-only gate.
    CREATE TABLE public.calendar_members (
      calendar_id uuid NOT NULL REFERENCES public.calendars(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES public.users(id),
      role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
      PRIMARY KEY (calendar_id, user_id)
    );
    CREATE TABLE public.invitations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      calendar_id uuid NOT NULL REFERENCES public.calendars(id) ON DELETE CASCADE,
      token_hash bytea NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz
    );
    CREATE TABLE public.device_credentials (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES public.users(id),
      label text NOT NULL,
      argon2id_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz,
      revoked_at timestamptz
    );
    CREATE TABLE public.feed_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      calendar_id uuid NOT NULL REFERENCES public.calendars(id) ON DELETE CASCADE,
      variant text NOT NULL CHECK (variant IN ('full', 'busy')),
      token_hash bytea NOT NULL UNIQUE,
      revoked_at timestamptz
    );
    CREATE TABLE public.push_devices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES public.users(id),
      platform text NOT NULL,
      fcm_token text NOT NULL UNIQUE
    );
    CREATE TABLE public.device_links (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES public.users(id),
      ephemeral_public_key bytea NOT NULL,
      sealed_blob bytea,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz
    );
    CREATE TABLE public.audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      at timestamptz NOT NULL DEFAULT now(),
      actor_id uuid REFERENCES public.users(id),
      action text NOT NULL,
      subject text NOT NULL,
      detail jsonb NOT NULL DEFAULT '{}'
    );
    COMMENT ON TABLE public.audit_log IS
      'Append-only for service roles. Operational metadata only; never event content or envelope bytes.';
    CREATE TABLE public.caldav_changes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      calendar_id uuid NOT NULL REFERENCES public.calendars(id) ON DELETE CASCADE,
      sync_token bigint NOT NULL,
      uid text NOT NULL,
      change_type text NOT NULL CHECK (change_type IN ('created', 'updated', 'deleted'))
    );
    CREATE INDEX caldav_changes_sync ON public.caldav_changes (calendar_id, sync_token);
    CREATE TABLE public.delegation_nonces (
      nonce text PRIMARY KEY,
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX delegation_nonces_expiry ON public.delegation_nonces (expires_at);

    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO calflex_api, calflex_caldav;
    REVOKE ALL ON SCHEMA sabredav FROM PUBLIC, calflex_api;
    GRANT USAGE ON SCHEMA sabredav TO calflex_caldav;
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      public.users, public.calendars, public.calendar_members,
      public.invitations, public.device_credentials, public.feed_tokens,
      public.push_devices, public.device_links TO calflex_api;
    -- API reads the CalDAV-written outbox only; E07 adds its worker grants.
    -- The CalDAV replay store delegation_nonces grants nothing to the API.
    GRANT SELECT ON public.caldav_changes TO calflex_api;
    GRANT SELECT, INSERT ON public.audit_log TO calflex_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA sabredav TO calflex_caldav;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA sabredav TO calflex_caldav;
    ALTER DEFAULT PRIVILEGES FOR ROLE calflex_migrate IN SCHEMA sabredav
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO calflex_caldav;
    ALTER DEFAULT PRIVILEGES FOR ROLE calflex_migrate IN SCHEMA sabredav
      GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO calflex_caldav;
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      public.caldav_changes, public.delegation_nonces TO calflex_caldav;
    GRANT SELECT ON public.users, public.calendars, public.calendar_members TO calflex_caldav;
    GRANT UPDATE (last_used_at) ON public.device_credentials TO calflex_caldav;
  `);
};

// DESTRUCTIVE: dev/test only; production rollback restores a backup.
/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.sql(`
    ALTER DEFAULT PRIVILEGES FOR ROLE calflex_migrate IN SCHEMA sabredav
      REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM calflex_caldav;
    ALTER DEFAULT PRIVILEGES FOR ROLE calflex_migrate IN SCHEMA sabredav
      REVOKE USAGE, SELECT, UPDATE ON SEQUENCES FROM calflex_caldav;
    REVOKE ALL ON ALL TABLES IN SCHEMA sabredav FROM calflex_caldav;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA sabredav FROM calflex_caldav;
    REVOKE USAGE ON SCHEMA sabredav FROM calflex_caldav;
    REVOKE USAGE ON SCHEMA public FROM calflex_api, calflex_caldav;
    DROP TABLE public.delegation_nonces, public.caldav_changes, public.audit_log,
      public.device_links, public.push_devices, public.feed_tokens,
      public.device_credentials, public.invitations, public.calendar_members,
      public.calendars, public.users;
    -- Do not restore PUBLIC CREATE/USAGE: rollback must not reopen schema access.
  `);
};
