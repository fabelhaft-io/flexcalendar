# E04 — Relational data model and migrations

| | |
|---|---|
| Phase | 1 |
| Status | Ready: R01. Then R02, then R03–R06 |
| Executor | `agent` |
| Depends on | E02-R03; D-02, D-06, D-17, D-18, D-19 |
| Spec | `04` Phase 1, ADR 0001, ADR 0003 |

## Goal

The Postgres schema for everything that is not event content. Private mode is live from Phase 3 (ADR 0003), so the envelope and key tables are used from v1, not just reserved.

PostgreSQL 18 (D-19). Every table, SabreDAV's included, is created by one migration chain in `server/api`.

## Requirements

### E04-R01 · Migration tooling   `agent`
Schema changes MUST go through one migration tool, owned by the API (for example `node-pg-migrate` or Drizzle migrations). SabreDAV's tables are created from the PostgreSQL scripts of the `sabre/dav` 4.7.x release that E03-R01 locks, imported into the same chain.
- Moves the local stack from `postgres:17-alpine`, which E02-R03 shipped, to PostgreSQL 18 (D-19). The postgres:18 image keeps its data under a versioned directory, so the volume mounts `/var/lib/postgresql` rather than `…/data`. A volume created by 17 needs `make dev-reset`.
- Accept: `make migrate` creates the schema on a fresh database and is idempotent; every migration has a down or is documented as irreversible; it runs in `make verify` against a fresh database.
- Accept: from the first production deploy on, CI also migrates a copy of the last released schema.
- Deps: E02-R03.

### E04-R02 · Core tables and roles   `agent`
The schema MUST contain:
- `users`: IdP subject, handle, email.
- `calendars`: id, owner, **`mode`**, CalDAV href, `meta_envelope bytea`, `meta_epoch`, created/updated. **No name or colour column** (D-18):
  - a Private calendar's name and colour are in `meta_envelope`, sealed by the client under the calendar's key and stored opaquely; it is required when `mode = private`;
  - a Shared or Published calendar's name and colour live in CalDAV (`displayname`, `calendar-color`), where stock apps read them; `meta_envelope` is NULL.
- `calendar_members`: calendar, user, role `owner|editor|viewer`.
- `invitations`: a hashed token, used for both link/QR (E06-R09) and email (E06-R01) invites.
- `device_credentials`: user, label, Argon2id hash, created, last_used, revoked. First written in Phase 4.
- `feed_tokens`: calendar, variant `full|busy`, token hash, revoked. First written in Phase 4.
- `push_devices`: user, platform, FCM token.
- `device_links`: user, ephemeral public key, sealed blob, `expires_at`, `consumed_at`. This is the E14-R08 rendezvous.
- `audit_log`: append-only.
- `caldav_changes`: the outbox E03-R10 writes and E07 reads (`calendar_id`, sync token, `uid`, `change_type`).
- `delegation_nonces`: the D-05 replay store E03-R01 uses (nonce, primary key; `expires_at`).

Three database roles:
- `calflex_migrate` owns the schema and runs migrations.
- `calflex_api` gets DML on the API's tables, but only `INSERT` and `SELECT` on `audit_log`, and nothing on SabreDAV's tables. The API reaches CalDAV data only through the CalDAV service.
- `calflex_caldav` gets DML on SabreDAV's tables, `caldav_changes` and `delegation_nonces`. It gets `SELECT` on `users`, `calendars` and `calendar_members`, plus `UPDATE (last_used_at)` on `device_credentials` from Phase 4.

Zitadel keeps its own database and role in the same cluster (ADR 0004). The local stack's services stop using the shared `caldav` bootstrap login that E02-R03 configured: the API connects as `calflex_api` and the CalDAV service as `calflex_caldav`, with dev-only defaults in `infra/dev/.env.example`.
- Accept: FKs and unique constraints are in place; a test connects as each role and checks the grants above, including that `calflex_api` can't `UPDATE` or `DELETE` `audit_log` rows; inserting a Private calendar without `meta_envelope` fails.
- Deps: E04-R01.

### E04-R03 · Mode column   `agent`
`calendars.mode` MUST be an enum `private|shared|published`, with a check constraint that allows only `private` until the Phase 4 migration lifts it (ADR 0003: the inverse of ADR 0001's original reservation).
- Accept: inserting `shared` fails before Phase 4; the check is dropped by a named migration that ships with E13-R06.
- Deps: E04-R02.

### E04-R04 · Sidecar envelope table   `agent`
The table `event_envelopes (calendar_id, uid, recurrence_id NULL, envelope_sha256, epoch, envelope bytea, created_at)` MUST exist. Its unique key is `(calendar_id, uid, recurrence_id, envelope_sha256)` per D-06, with `NULLS NOT DISTINCT` on `recurrence_id`. E13-R02 writes it from Phase 3. Two encodings are pinned here, and E12-R01 uses the same ones in the AAD and the skeleton:
- **`envelope_sha256`** is `bytea`, 32 bytes: the SHA-256 of the complete envelope bytes. The skeleton's `X-CALFLEX-ENVELOPE-SHA256` carries the same value as 64 lowercase hex digits.
- **`recurrence_id`** is `text`: NULL for the master. For an override it is the `RECURRENCE-ID` as an instant:
  - a `DATE-TIME` with a `TZID` is converted to UTC and written `YYYYMMDDTHHMMSSZ`;
  - a `DATE` value is written `YYYYMMDD`.

  RFC 5545 matches overrides by instant, so one occurrence always gets one key, whichever way its `RECURRENCE-ID` was written.
- Accept: the migration exists; a test inserts an override and a master with the same `uid` and reads each back by its own `recurrence_id`; a test shows that two spellings of the same instant (UTC, and a `TZID` form) map to one key.
- Deps: E04-R02.
- Notes: getting `recurrence_id` wrong makes an edited occurrence show the master's title (ADR 0001).

### E04-R05 · Member key material   `agent`
Tables `user_keys` (user, X25519 public key, Ed25519 identity public key, wrapped private key copies by kind `recovery_code|escrow`) and `calendar_keys` (calendar, epoch, member, sealed and signed CCK record) MUST exist in Phase 1. Per D-17 there is **no `password` kind**: nothing is wrapped under a key derived from the login password. Blobs are stored opaquely, in the formats of `spec/crypto.md` (E12-R01).
- Accept: the schema matches the ADR 0001 key diagram as amended by D-17; an `escrow` row can't be inserted before Phase 7 (check constraint dropped by E14-R01).
- Deps: E04-R02.

### E04-R06 · UUIDv4 identifiers in the schema   `agent`
Every ID the database generates MUST be a random UUIDv4 (INV-03, `gen_random_uuid()`).
- Accept: every generated ID column defaults to `gen_random_uuid()`. A check script rejects `uuidv7()`, `uuid_generate_v1*`, `uuid_generate_v5` and other non-v4 generators anywhere in `server/` and `apps/`. It fails on a deliberately bad fixture, and it joins the invariant checks in `make verify` (E02-R05).
- Deps: E04-R02.
- Notes: IDs generated in code (event `UID`s, calendar IDs used in CalDAV hrefs) are tested on their create paths by E05-R03 and E05-R04. Hrefs never contain a name (E03 § Layout).
