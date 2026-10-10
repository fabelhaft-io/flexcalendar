/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE public.user_keys (
      user_id uuid PRIMARY KEY REFERENCES public.users(id),
      x25519_public_key bytea NOT NULL,
      ed25519_public_key bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT user_keys_x25519_length_check
        CHECK (octet_length(x25519_public_key) = 32),
      CONSTRAINT user_keys_ed25519_length_check
        CHECK (octet_length(ed25519_public_key) = 32)
    );
    CREATE TABLE public.user_key_wraps (
      user_id uuid NOT NULL REFERENCES public.user_keys(user_id),
      kind text NOT NULL,
      wrapped_private_keys bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, kind),
      CONSTRAINT user_key_wraps_kind_check
        CHECK (kind IN ('recovery_code', 'escrow')),
      CONSTRAINT user_key_wraps_no_escrow_check CHECK (kind <> 'escrow'),
      CONSTRAINT user_key_wraps_nonempty_check
        CHECK (octet_length(wrapped_private_keys) > 0)
    );
    CREATE TABLE public.calendar_keys (
      calendar_id uuid NOT NULL,
      epoch integer NOT NULL,
      user_id uuid NOT NULL REFERENCES public.user_keys(user_id),
      record bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (calendar_id, epoch, user_id),
      FOREIGN KEY (calendar_id, user_id)
        REFERENCES public.calendar_members(calendar_id, user_id) ON DELETE CASCADE,
      CONSTRAINT calendar_keys_nonempty_check CHECK (octet_length(record) > 0)
    );
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      public.user_keys, public.user_key_wraps, public.calendar_keys TO calflex_api;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE public.calendar_keys;
    DROP TABLE public.user_key_wraps;
    DROP TABLE public.user_keys;
  `);
};
