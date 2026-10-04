# E03 — CalDAV service (SabreDAV)

| | |
|---|---|
| Phase | 1 (R01, R02, R04, R08, R09, R10); 4 (R03, R05, R06, R07), per ADR 0003 |
| Status | Blocked on D-02, D-05 (Phase 1 reqs); D-04 and M0 (Phase 4 reqs) |
| Executor | `agent+review` (auth and ACL work), `agent` otherwise |
| Depends on | E02, D-02, D-04, D-05 |
| Spec | `01-architecture.md` § Storage, `03`, ADR 0001 § Effect on the CalDAV rule |

## Goal

A production CalDAV server, and the source of truth for every event, that stock apps and our API both use. Stock-app-visible behaviour lives here (CLAUDE.md).

## Out of scope

Push (E07), the REST facade (E05), `VTODO` and `VFREEBUSY` (deferred in `04`).

## Requirements

### E03-R01 · SabreDAV service skeleton   `agent`
`server/caldav` MUST serve CalDAV (RFC 4791) with the SabreDAV CalDAV, ACL, Sync (RFC 6578) and PropertyStorage plugins, backed by Postgres through PDO.
- Accept: CalDAVTester or `caldav-server-tester` basic suite passes against the local stack; `sync-collection` returns a changing token after a `PUT`.

### E03-R02 · Discovery   `agent`
`/.well-known/caldav` MUST redirect to the context path, and `current-user-principal`, `calendar-home-set` and `principal-URL` MUST resolve for an authenticated user.
- Accept: an integration test runs the iOS discovery sequence (PROPFIND on `/`, then principal, then home set) and gets the expected hrefs.
- Notes: fold in E01-R06 quirks once M0 is reached. Discovery for our own app doesn't wait for it.

### E03-R03 · Device app-password auth backend   `agent+review`
Per D-04, a SabreDAV auth backend MUST check HTTP Basic credentials `(account_handle, app_password)` against Argon2id hashes in the `device_credentials` table (E04). It MUST reject revoked credentials and record `last_used_at`.
- Accept: valid → 207; wrong or revoked → 401; timing does not reveal whether the handle exists (constant-work verify with a dummy hash); rate limit of 10 failures/min per handle and per IP.

### E03-R04 · Delegated service auth for the API   `agent+review`
Per D-05, SabreDAV MUST accept an HMAC-SHA256-signed `X-Calflex-Principal` header (principal, timestamp, nonce), only on the internal listener, and act as that principal.
- Accept: the header is rejected on the public listener, when the timestamp is more than 60 s off, and when a nonce is replayed; a test proves the public vhost ignores the header entirely.

### E03-R05 · Apple calendar-sharing extensions   `agent`
The SabreDAV `Sharing` and `Notifications` plugins MUST be enabled so Apple Calendar's "Add Person…" works on Shared calendars. The share state is written by the API (E06-R03), not by clients.
- Accept: `CS:invite` and `CS:shared-url` properties appear on a shared collection; E15 device check passes.
- Notes: sharing initiated from Apple Calendar must be reconciled back into the API model or rejected; see E06-R03.

### E03-R06 · iMIP scheduling for Shared calendars   `agent`
The SabreDAV scheduling plugins (CalDAV-Schedule, RFC 6638) and IMip MUST send invitations through the SMTP relay configured in E08-R06.
- Accept: in the local stack, creating a Shared event with an external `ATTENDEE` produces an iMIP mail in Mailpit with a valid `METHOD:REQUEST` attachment; Private calendars never trigger scheduling (ADR 0001 § Consequences).

### E03-R07 · Private collections hidden from stock-app credentials   `agent+review`
Calendars with `mode = private` MUST NOT appear in, or be readable through, any request authenticated with a device app password, including PROPFIND on the home set, REPORT, GET and `sync-collection` (INV-08).
- Accept: an integration test creates a Private and a Shared calendar for one user; the device credential sees only the Shared one; direct GET on the Private href → 404, never 403, so its existence isn't leaked.

### E03-R08 · ACLs follow the API sharing model   `agent+review`
Collection ACLs MUST be derived from the `calendar_members` table (E04). They are never edited independently: the API is the source of truth for permissions (`05` risk 6).
- Accept: changing a member's role through the API changes CalDAV access within one request; a direct `ACL` method from a client is rejected with 403.

### E03-R09 · Mode-aware write guard   `agent`
The server MUST reject writes to a Private calendar that carry content properties (`SUMMARY`, `DESCRIPTION`, `LOCATION`, `ATTENDEE`, `ORGANIZER`, `ATTACH`, `COMMENT`, a non-generic `VALARM` `DESCRIPTION`) in the skeleton.
- Accept: a PUT with `SUMMARY` to a Private collection → 403 with a precondition element; the allowed skeleton list matches ADR 0001 plus the D-06 `X-CALFLEX-ENVELOPE-SHA256`.
- Notes: this is the server-side backstop that keeps a buggy client from leaking plaintext. It is on the critical path to M1, because every v1 calendar is Private.

### E03-R10 · Change hook   `agent`
Every successful write MUST append `(calendar_id, sync_token, uid, change_type)` to a `caldav_changes` outbox read by E07.
- Accept: the outbox row is written in the same transaction as the calendar object; a test kills the process between the two writes and finds neither or both.
