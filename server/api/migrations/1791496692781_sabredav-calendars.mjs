import { readVerifiedScript } from '../sabredav/verify.mjs';

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  const script = readVerifiedScript('pgsql.calendars.sql');
  pgm.createSchema('sabredav');
  pgm.sql("SELECT set_config('search_path', 'sabredav', true)");
  pgm.sql(script);
  pgm.sql("SELECT set_config('search_path', 'public', true)");
};

// DESTRUCTIVE: deletes all CalDAV data. Dev/test only; production rollback
// restores a backup (E08-R04), never invokes this down migration.
/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.dropSchema('sabredav', { cascade: true });
};
