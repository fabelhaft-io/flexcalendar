# E04 — Relational data model and migrations

| | |
|---|---|
| Phase | 1 |
| Status | Blocked on D-02, D-06 |
| Executor | `agent` |
| Depends on | E02, D-02, D-06 |
| Spec | `04` Phase 1 § Structural reservations, ADR 0001 |

## Goal

The Postgres schema for everything that is not event content, plus the three reservations ADR 0001 requires in Phase 1 so that Phase 5 needs no migration of existing data.

## Requirements

### E04-R01 · Migration tooling   `agent`
Schema changes MUST go through one migration tool, owned by the API (for example `node-pg-migrate` or Drizzle migrations), run in CI against a fresh database and against the previous release's schema.
- Accept: `make migrate` is idempotent; every migration has a down or is documented as irreversible.
- Notes: SabreDAV's own tables are created by its SQL scripts, imported into the same migration chain.

### E04-R02 · Core tables   `agent`
The schema MUST contain `users` (IdP subject, handle, email), `calendars` (id, owner, display name, color, **`mode`**, caldav href, created/updated), `calendar_members` (calendar, user, role `owner|editor|viewer`), `invitations`, `device_credentials` (user, label, Argon2id hash, created, last_used, revoked), `feed_tokens` (calendar, variant `full|busy`, token hash, revoked), `push_devices` (user, platform, FCM token), `audit_log` (append-only).
- Accept: FKs and unique constraints are in place; `audit_log` has no UPDATE/DELETE grant for the application role.

### E04-R03 · Mode column reservation   `agent`
`calendars.mode` MUST be an enum `private|shared|published`, with a check constraint that allows only `shared|published` until the Phase 5 migration lifts it.
- Accept: inserting `private` fails before E13-R01; the check is dropped by a named migration in E13.

### E04-R04 · Sidecar envelope table reservation   `agent`
The table `event_envelopes (calendar_id, uid, recurrence_id NULL, envelope_sha256, epoch, envelope bytea, created_at)` MUST exist and stay empty until Phase 5. Its unique key is `(calendar_id, uid, recurrence_id, envelope_sha256)` per D-06, with `NULLS NOT DISTINCT` on `recurrence_id`.
- Accept: the migration exists; a CI check asserts zero rows before E13 lands.
- Notes: getting `recurrence_id` wrong makes an edited occurrence show the master's title (ADR 0001).

### E04-R05 · Member key material reservation   `agent`
Tables `user_keys` (user, public key, wrapped private key copies by kind `password|recovery_code|escrow`) and `calendar_keys` (calendar, epoch, member, sealed CCK) MUST exist, empty, in Phase 1.
- Accept: the schema matches the ADR 0001 key diagram; no application code writes them before E12/E13.

### E04-R06 · UUIDv4 identifiers   `agent`
Every ID we generate (row IDs, event `UID`s, calendar slugs in CalDAV hrefs) MUST be random UUIDv4 (INV-03). Calendar hrefs MUST NOT contain the display name.
- Accept: a unit test on every create path; a grep check rejects `uuidv5`, and name-derived hrefs.
