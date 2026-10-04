# E04 — Relational data model and migrations

| | |
|---|---|
| Phase | 1 |
| Status | Blocked on E02 |
| Executor | `agent` |
| Depends on | E02, D-02, D-06, D-17 |
| Spec | `04` Phase 1, ADR 0001, ADR 0003 |

## Goal

The Postgres schema for everything that is not event content. Private mode is live from Phase 3 (ADR 0003), so the envelope and key tables are used from v1, not just reserved.

## Requirements

### E04-R01 · Migration tooling   `agent`
Schema changes MUST go through one migration tool, owned by the API (for example `node-pg-migrate` or Drizzle migrations), run in CI against a fresh database and against the previous release's schema.
- Accept: `make migrate` is idempotent; every migration has a down or is documented as irreversible.
- Notes: SabreDAV's own tables are created by its SQL scripts, imported into the same migration chain.

### E04-R02 · Core tables   `agent`
The schema MUST contain `users` (IdP subject, handle, email), `calendars` (id, owner, display name, color, **`mode`**, caldav href, created/updated), `calendar_members` (calendar, user, role `owner|editor|viewer`), `invitations`, `device_credentials` (user, label, Argon2id hash, created, last_used, revoked), `feed_tokens` (calendar, variant `full|busy`, token hash, revoked), `push_devices` (user, platform, FCM token), `device_links` (user, ephemeral public key, sealed blob, `expires_at`, `consumed_at`; the E14-R08 rendezvous), `audit_log` (append-only). `invitations` stores a hashed token for both link/QR (E06-R09) and email (E06-R01) invites. `device_credentials` and `feed_tokens` are first written in Phase 4.
- Accept: FKs and unique constraints are in place; `audit_log` has no UPDATE/DELETE grant for the application role.

### E04-R03 · Mode column   `agent`
`calendars.mode` MUST be an enum `private|shared|published`, with a check constraint that allows only `private` until the Phase 4 migration lifts it (ADR 0003: the inverse of ADR 0001's original reservation).
- Accept: inserting `shared` fails before Phase 4; the check is dropped by a named migration that ships with E13-R06.

### E04-R04 · Sidecar envelope table   `agent`
The table `event_envelopes (calendar_id, uid, recurrence_id NULL, envelope_sha256, epoch, envelope bytea, created_at)` MUST exist. Its unique key is `(calendar_id, uid, recurrence_id, envelope_sha256)` per D-06, with `NULLS NOT DISTINCT` on `recurrence_id`. E13-R02 writes it from Phase 3.
- Accept: the migration exists; a test inserts an override and a master with the same `uid` and reads each back by its own `recurrence_id`.
- Notes: getting `recurrence_id` wrong makes an edited occurrence show the master's title (ADR 0001).

### E04-R05 · Member key material   `agent`
Tables `user_keys` (user, X25519 public key, Ed25519 identity public key, wrapped private key copies by kind `recovery_code|escrow`) and `calendar_keys` (calendar, epoch, member, sealed and signed CCK record) MUST exist in Phase 1. Per D-17 there is **no `password` kind**: nothing is wrapped under a key derived from the login password.
- Accept: the schema matches the ADR 0001 key diagram as amended by D-17; an `escrow` row can't be inserted before Phase 7 (check constraint dropped by E14-R01).

### E04-R06 · UUIDv4 identifiers   `agent`
Every ID we generate (row IDs, event `UID`s, calendar slugs in CalDAV hrefs) MUST be random UUIDv4 (INV-03). Calendar hrefs MUST NOT contain the display name.
- Accept: a unit test on every create path; a grep check rejects `uuidv5`, and name-derived hrefs.
