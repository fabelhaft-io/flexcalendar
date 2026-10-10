/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE public.event_envelopes (
      calendar_id uuid NOT NULL REFERENCES public.calendars(id) ON DELETE CASCADE,
      uid text NOT NULL,
      recurrence_id text,
      envelope_sha256 bytea NOT NULL,
      epoch integer NOT NULL,
      envelope bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT event_envelopes_key UNIQUE NULLS NOT DISTINCT
        (calendar_id, uid, recurrence_id, envelope_sha256),
      CONSTRAINT event_envelopes_sha256_length_check
        CHECK (octet_length(envelope_sha256) = 32),
      CONSTRAINT event_envelopes_recurrence_id_check
        CHECK (recurrence_id ~ '^[0-9]{8}(T[0-9]{6}Z)?$')
    );
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_envelopes TO calflex_api;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.sql('DROP TABLE public.event_envelopes;');
};
