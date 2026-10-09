/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TYPE public.calendar_mode AS ENUM ('private', 'shared', 'published');
    ALTER TABLE public.calendars DROP CONSTRAINT calendars_meta_envelope_check;
    ALTER TABLE public.calendars ALTER COLUMN mode TYPE public.calendar_mode
      USING mode::public.calendar_mode;
    ALTER TABLE public.calendars ADD CONSTRAINT calendars_meta_envelope_check
      CHECK ((mode = 'private') = (meta_envelope IS NOT NULL));
    -- Phase 4: the named migration shipping with E13-R06 must lift only this gate:
    -- ALTER TABLE public.calendars DROP CONSTRAINT calendars_mode_private_only_check;
    ALTER TABLE public.calendars ADD CONSTRAINT calendars_mode_private_only_check
      CHECK (mode = 'private');
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE public.calendars DROP CONSTRAINT calendars_mode_private_only_check;
    ALTER TABLE public.calendars DROP CONSTRAINT calendars_meta_envelope_check;
    ALTER TABLE public.calendars ALTER COLUMN mode TYPE text USING mode::text;
    DROP TYPE public.calendar_mode;
    ALTER TABLE public.calendars ADD CONSTRAINT calendars_meta_envelope_check
      CHECK ((mode = 'private') = (meta_envelope IS NOT NULL));
  `);
};
