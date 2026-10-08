import { readVerifiedScript } from '../sabredav/verify.mjs';

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  const script = readVerifiedScript('pgsql.propertystorage.sql');
  pgm.sql("SELECT set_config('search_path', 'sabredav', true)");
  pgm.sql(script);
  pgm.sql("SELECT set_config('search_path', 'public', true)");
};

// DESTRUCTIVE: removes stored DAV properties. Dev/test only, not production.
/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.dropTable({ schema: 'sabredav', name: 'propertystorage' });
};
