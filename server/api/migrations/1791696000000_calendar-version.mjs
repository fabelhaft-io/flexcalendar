/**
 * E05-R03: the optimistic-concurrency version of a calendar.
 *
 * `calendars` had no version column (E04), and E05-R03's `PATCH /calendars/{id}`
 * needs one: the client's `If-Match` carries the version it read, and the
 * update is conditional on it, so two renames cannot silently overwrite each
 * other. `ETag: "<version>"` is the same number.
 *
 * The default of 1 is what a row created before this migration keeps, so the
 * column is never null and every update can be `version = version + 1` in the
 * statement that writes the row.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE public.calendars
      ADD COLUMN version integer NOT NULL DEFAULT 1;
    ALTER TABLE public.calendars
      ADD CONSTRAINT calendars_version_check CHECK (version >= 1);
  `);
};

// DESTRUCTIVE: dev/test only; production rollback restores a backup.
/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE public.calendars DROP CONSTRAINT calendars_version_check;
    ALTER TABLE public.calendars DROP COLUMN version;
  `);
};
