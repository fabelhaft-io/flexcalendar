// --- E05-R01 test support: an in-memory `users` store ------------------------
//
// It mirrors the two constraints `public.users` has: `idp_subject` is unique,
// and `lower(handle)`/`lower(email)` are unique. A duplicate is reported the
// way Postgres reports it (`code: '23505'`), so the route's 409 path is real
// code under test rather than a stub that always succeeds.
//
// Unlike the real table this store is mutable state the API changes: a second
// request must find the row the first one created, which is what makes "the
// first request creates the row" an assertion and not a tautology.

import { randomUUID } from 'node:crypto';

/**
 * @param {{subject: string, handle: string, email: string}[]} [seed]
 */
export function createMemoryStore(seed = []) {
  const users = seed.map((user) => ({ id: randomUUID(), ...user }));
  /** @param {'handle' | 'email'} field @param {string} value */
  const taken = (field, value) =>
    users.some((user) => user[field].toLowerCase() === value.toLowerCase());
  /** @param {{subject: string, handle: string, email: string}} user */
  const row = (user) => ({
    id: user.id,
    handle: user.handle,
    email: user.email,
  });

  return {
    users,
    /** @param {string} subject */
    async findBySubject(subject) {
      const user = users.find((candidate) => candidate.subject === subject);
      return user ? row(user) : undefined;
    },
    /** @param {{subject: string, handle: string, email: string}} profile */
    async createFirstSight({ subject, handle, email }) {
      const existing = users.find((candidate) => candidate.subject === subject);
      if (existing) return row(existing);
      if (taken('handle', handle) || taken('email', email)) {
        throw Object.assign(
          new Error('duplicate key value violates unique constraint'),
          { code: '23505' },
        );
      }
      const created = { id: randomUUID(), subject, handle, email };
      users.push(created);
      return row(created);
    },
  };
}
