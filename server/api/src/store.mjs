// --- E05-R01: the `users` row a token's `sub` maps to -----------------------
//
// `users` holds no event content (INV-01): an identity subject, a handle, an
// email address and its own uuid. First sight inserts with
// `ON CONFLICT (idp_subject) DO NOTHING` and then reads the row back, so two
// simultaneous first requests converge on one row instead of racing into a
// unique violation. There is no profile sync afterwards.
//
// This module is the only place that talks to `public.users`. The API role
// (`calflex_api`) already holds the DML grant (`E04-R02`).

import pg from 'pg';

/** The columns `GET /me` answers with. */
const COLUMNS = 'id, handle, email';

/**
 * The API's connection pool. `pg.Pool` emits `error` when a pooled client
 * fails while idle — a Postgres restart, a connection the network dropped.
 * An `error` event with no listener is an unhandled exception, so without one
 * the pool takes the process down with it; nothing is logged, because a pool
 * error carries host and user, and E05-R10 owns logging. The pool replaces the
 * broken client on the next query by itself.
 * @param {{connectionString?: string, connectionTimeoutMillis?: number}} [options]
 */
export function createPool({
  connectionString,
  connectionTimeoutMillis = 5000,
} = {}) {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis });
  pool.on('error', () => {});
  return pool;
}

/**
 * @param {{query: (text: string, values?: unknown[]) => Promise<{rows: any[]}>}} pool
 */
export function createUserStore(pool) {
  return {
    /**
     * @param {string} subject the token's `sub`
     * @returns {Promise<{id: string, handle: string, email: string} | undefined>}
     */
    async findBySubject(subject) {
      const { rows } = await pool.query(
        `SELECT ${COLUMNS} FROM public.users WHERE idp_subject = $1`,
        [subject],
      );
      return rows[0];
    },
    /**
     * Inserts the row for a subject seen for the first time, or returns the one
     * a concurrent request inserted a moment ago.
     * @param {{subject: string, handle: string, email: string}} profile
     * @returns {Promise<{id: string, handle: string, email: string}>}
     */
    async createFirstSight({ subject, handle, email }) {
      await pool.query(
        `INSERT INTO public.users (idp_subject, handle, email)
         VALUES ($1, $2, $3) ON CONFLICT (idp_subject) DO NOTHING`,
        [subject, handle, email],
      );
      const { rows } = await pool.query(
        `SELECT ${COLUMNS} FROM public.users WHERE idp_subject = $1`,
        [subject],
      );
      return rows[0];
    },
  };
}
