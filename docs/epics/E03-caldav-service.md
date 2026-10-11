# E03 — CalDAV service (SabreDAV)

| | |
|---|---|
| Phase | 1 (R01, R02, R08, R09, R10; R04 is merged into R01); 4 (R03, R05, R06, R07), per ADR 0003 |
| Status | In progress: R01 ([PR #45](https://github.com/fabelhaft-io/flexcalendar/pull/45)) and R09 ([PR #47](https://github.com/fabelhaft-io/flexcalendar/pull/47)) Done, 2026-10-10; R10 passed review ([findings](https://github.com/fabelhaft-io/flexcalendar/blob/feat/E03-R10-change-hook/docs/reviews/E03-R10.md), [PR #50](https://github.com/fabelhaft-io/flexcalendar/pull/50)), Done once merged; R02 and R08 follow, stacked on it in that order (they edit `server/caldav`). Phase 4 reqs wait for M1 |
| Executor | `agent+review` (auth and ACL work: R01, R03, R07, R08), `agent` otherwise |
| Depends on | E02-R03, E04-R01, E04-R02; D-02, D-05, D-18; D-04 for Phase 4 |
| Spec | `01-architecture.md` § Storage, `02` § CalDAV Server and § Runtime layout, `03`, ADR 0001 § Private calendars — cryptography |

## Goal

A production CalDAV server, and the source of truth for every event, that stock apps and our API both use. Stock-app-visible behaviour lives here (CLAUDE.md).

## Out of scope

Push (E07), the REST facade (E05), `VTODO` and `VFREEBUSY` (deferred in `04`).

## Layout every requirement assumes

- **Two listeners in one service.** The *public* listener is the one Caddy routes (`caldav.localhost:8443` locally; `caldav.flexcalendar.de` from Phase 4, `02` § Hosting). The *internal* listener is reachable only on a dedicated Compose network that just the API and the CalDAV service join. Today `infra/dev/compose.yaml` puts every service on one `stack` network, so R01 adds that network. The internal listener has no published host port and no Caddy route.
- **Who authenticates where.** In Phase 1 the public listener has no auth backend, so every request there gets 401. The one exception is the `/.well-known/caldav` redirect. Device app passwords arrive in Phase 4 (R03). The internal listener accepts only D-05 delegation (R01).
- **Identity.** A principal is a `users` row (E04-R02): its URI is `principals/<users.id>`, and its calendar home is `/calendars/<users.id>/`. A calendar's collection URI is its `calendars.id`. All of these are UUIDv4 (INV-03), so no href contains a name.
- **Tables.** SabreDAV's tables come from the E04-R01 migration chain, not from the service. They live in the schema `sabredav`, because SabreDAV's `calendars` table has the name of the API's `public.calendars`. The service points the SabreDAV PDO backends at that schema (their table-name properties, such as `$calendarTableName`, or the connection's `search_path`) and qualifies its own reads as `public.…`. It connects with the `calflex_caldav` role (E04-R02), which reads `public.users`, `public.calendars` and `public.calendar_members` and never writes them.
- **Runtime.** FrankenPHP in classic mode, or nginx + php-fpm. Never FrankenPHP worker mode (`02` § Runtime layout). R01 replaces the `php -S` built-in server of the E02-R03 skeleton image. The image installs `pdo_pgsql`, which `php:8.4-cli-alpine` lacks. `sabre/dav` 4.7.1 is locked in `composer.lock`, the tag whose scripts E04-R01 imports. All our code lives in plugins and backends; vendor code is never patched.

## Requirements

### E03-R01 · SabreDAV service with delegated auth   `agent+review`
`server/caldav` MUST serve CalDAV (RFC 4791) with the SabreDAV CalDAV, ACL, Sync (RFC 6578) and PropertyStorage plugins, backed by Postgres through PDO, in the layout above. Its principal backend reads `users`.

On the internal listener it MUST authenticate every request by D-05 delegation and act as the named principal. The format is fixed here, because E05-R02 implements the other side:

```
X-Calflex-Principal: v=1; k=<key-id>; p=<users.id>; t=<unix-seconds>; n=<nonce>; s=<signature>
```

- `n` is 16 random bytes, base64url without padding.
- `s` is base64url (no padding) of `HMAC-SHA256(key[k], m)`, where `m` is the UTF-8 bytes of:

  ```
  "calflex-delegation-v1\n" + METHOD + "\n" + request-target + "\n" + p + "\n" + t + "\n" + n
  ```

  `request-target` is the path and query exactly as sent.
- The keys come from `CALFLEX_DELEGATION_KEYS`, a comma-separated list of `<key-id>:<base64 key>`. Each key is at least 32 bytes. The signer uses the first key, and the verifier accepts any key in the list, so keys can rotate. A line goes in `.env.example`. The keys are stored in the secret store (D-19).
- The signature is compared in constant time.
- A nonce is accepted once. It is recorded in `delegation_nonces` (E04-R02) by an insert that fails on a duplicate, and rows older than 120 s are pruned.

The public listener MUST NOT parse the header at all.

- Accept: an integration suite, run over the internal listener against the local stack, covers:
  - `MKCALENDAR`;
  - `PUT`/`GET`/`DELETE` with `If-None-Match: *` and `If-Match`, where a mismatch → 412;
  - `PROPFIND` depth 1 on the home;
  - a `calendar-query` time-range filter that hits an instance of a recurring event;
  - `sync-collection` returning a new token after a `PUT` and listing the change.
- Accept: a valid header acts as `p` (`current-user-principal` is `/principals/<p>/`). Each of these → 401:
  - a missing header, a malformed header, or an unknown `k`;
  - a bad signature, or a valid one replayed on another method or path;
  - `t` more than 60 s off;
  - a replayed nonce;
  - a `p` with no `users` row.
- Accept: the same valid header sent to the public listener → 401, and a malformed one there changes neither the response nor the logs. The Compose file publishes no host port for the internal listener.
- Accept: the `sabre/dav` entry in `composer.lock` has the version and the source reference (commit) that E04-R01 records for the scripts it imports, and a test fails when they differ.
- Deps: E02-R03, E04-R01, E04-R02.
- Notes: no other auth backend exists in Phase 1, for development included, so there is never a second path to remove later. List every security-relevant choice in the PR for the human approval.

### E03-R02 · Discovery   `agent`
`/.well-known/caldav` MUST redirect to the context path, and `current-user-principal`, `calendar-home-set` and `principal-URL` MUST resolve for an authenticated principal.
- Accept: an integration test on the internal listener runs the discovery sequence (PROPFIND on `/`, then the principal, then the home set) and gets the hrefs from the layout above. The redirect also works on the public listener without auth.
- Deps: E03-R01.
- Notes: Phase 4 re-runs the test on the public listener with a device app password (R03). Stock-app discovery is checked on staging by the device protocol (E15-R05).

### E03-R03 · Device app-password auth backend   `agent+review`
Per D-04, a SabreDAV auth backend on the **public** listener MUST check HTTP Basic credentials `(account_handle, app_password)` against Argon2id hashes in the `device_credentials` table (E04). It MUST reject revoked credentials and record `last_used_at`.
- Accept: valid → 207; wrong or revoked → 401; timing does not reveal whether the handle exists (constant-work verify with a dummy hash); rate limit of 10 failures/min per handle and per IP.

### E03-R04 · Delegated service auth for the API
Merged into E03-R01 on 2026-10-05, so that the service has exactly one auth path from its first commit. The ID is kept so that older references resolve.

### E03-R05 · Apple calendar-sharing extensions   `agent`
The SabreDAV `Sharing` and `Notifications` plugins MUST be enabled so Apple Calendar's "Add Person…" works on Shared calendars. The share state is written by the API (E06-R03), not by clients.
- Accept: `CS:invite` and `CS:shared-url` properties appear on a shared collection; E15 device check passes.
- Notes: the sharing backend presents the membership from `calendar_members` (R08); there is no second copy in `calendarinstances`. Sharing initiated from Apple Calendar must be reconciled back into the API model or rejected; see E06-R03.

### E03-R06 · iMIP scheduling for Shared calendars   `agent`
The SabreDAV scheduling plugins (CalDAV-Schedule, RFC 6638) and IMip MUST send invitations through the SMTP relay configured in E08-R06.
- Accept: in the local stack, creating a Shared event with an external `ATTENDEE` produces an iMIP mail in Mailpit with a valid `METHOD:REQUEST` attachment; Private calendars never trigger scheduling (ADR 0001 § Consequences).

### E03-R07 · Private collections hidden from stock-app credentials   `agent+review`
Calendars with `mode = private` MUST NOT appear in, or be readable through, any request authenticated with a device app password, including PROPFIND on the home set, REPORT, GET and `sync-collection` (INV-08).
- Accept: an integration test creates a Private and a Shared calendar for one user; the device credential sees only the Shared one; direct GET on the Private href → 404, never 403, so its existence isn't leaked.

### E03-R08 · Access follows the API's membership table   `agent+review`
Access to calendar collections MUST be derived from `calendar_members` (E04-R02), which the service reads directly at request time. SabreDAV's `calendarinstances` table holds no membership copy, so there is nothing to keep in sync.
- A member's calendar home lists every calendar they belong to, at `/calendars/<member users.id>/<calendars.id>/`.
- Roles map to privileges:
  - `viewer`: read;
  - `editor`: read, plus writing and deleting calendar objects;
  - `owner`: editor, plus collection properties and deleting the collection.
- Permissions never change through CalDAV, because the API is their source of truth (`05` risk 6). The `ACL` method and SabreDAV share requests are rejected.

- Accept: an integration test changes `calendar_members` rows directly, as the API will once E06 exists. The next CalDAV request reflects each change:
  - a viewer's `PUT` → 403;
  - an editor's `PUT` → 201;
  - a removed member no longer sees the calendar in their home, and a `GET` on any of its hrefs → 404, never 403.
- Accept: `ACL` → 403; a `share-resource` `POST` → 403 until R05 reconciles shares in Phase 4.
- Deps: E03-R01, E04-R02.

### E03-R09 · Mode-aware write guard   `agent`
Writes to a Private calendar MUST pass an **allow-list**. Anything not listed is rejected, so a property no one anticipated can't leak plaintext. The guard reads the mode from `calendars.mode` (E04-R03). It applies to calendar-object `PUT`s and to `MKCALENDAR`/`PROPPATCH` on Private collections.

| Where | Allowed |
|---|---|
| `VCALENDAR` | `VERSION`, `PRODID`, `CALSCALE` (`GREGORIAN` only); components `VEVENT` and `VTIMEZONE` only |
| `VTIMEZONE` | `TZID`, `LAST-MODIFIED`, `TZURL`, `X-LIC-LOCATION`; `STANDARD`/`DAYLIGHT` with `DTSTART`, `TZOFFSETFROM`, `TZOFFSETTO`, `RRULE`, `RDATE`, `TZNAME` |
| `VEVENT` | `UID`, `DTSTAMP`, `DTSTART`, `DTEND` or `DURATION`, `RRULE`, `RDATE`, `EXDATE`, `RECURRENCE-ID`, `SEQUENCE`, `CREATED`, `LAST-MODIFIED`, `X-CALFLEX-ENVELOPE-SHA256` (**required**, exactly 64 lowercase hex digits, D-06), `VALARM` |
| `VALARM` | `ACTION` (`DISPLAY` or `AUDIO`), `TRIGGER`, `REPEAT`, `DURATION`, `UID`, and `DESCRIPTION` with the exact value `Reminder` (D-08) |
| Parameters | `TZID`, `VALUE`, `RANGE` (on `RECURRENCE-ID`), `RELATED` (on `TRIGGER`). Nothing else, `X-` parameters included |
| Collection properties | `DAV:displayname` with the fixed value `Private calendar`, set by the API. The real name and colour are in the encrypted calendar metadata (D-18). `calendar-description`, `calendar-color` and every other dead property are rejected |

The `VEVENT` row is ADR 0001's skeleton plus the structural properties RFC 5545 requires or allows in their place. Changing the table is an ADR 0001 amendment.

A rejection is a 403 with the precondition `<cf:private-skeleton-only xmlns:cf="https://flexcalendar.de/ns/caldav"/>`. It names the offending property or parameter but never its value. Nothing from the rejected body is logged.
- Accept: a table-driven test shows that:
  - every allowed item is accepted;
  - each of these is rejected with the precondition: `SUMMARY`, `DESCRIPTION`, `LOCATION`, `ATTENDEE`, `ORGANIZER`, `ATTACH`, `COMMENT`, `CATEGORIES`, `URL`, `CONTACT`, `RESOURCES`, `GEO`, `CLASS`, `STATUS`, `X-APPLE-STRUCTURED-LOCATION`, an `X-` parameter, a `VALARM` `DESCRIPTION` other than `Reminder`, a `VTODO`, a missing or malformed envelope hash, a `PROPPATCH` of `calendar-color`, and a `MKCALENDAR` with any other display name.
- Accept: a marker string placed in each rejected value appears in no response body and no log line.
- Deps: E03-R01, E04-R03.
- Notes: this is the server-side backstop that keeps a buggy client from leaking plaintext. It is on the critical path to M1, because every v1 calendar is Private.

### E03-R10 · Change hook   `agent`
Every successful create, update or delete of a calendar object MUST append a row to `caldav_changes` (E04-R02):
- `calendar_id`: the API's `calendars.id`, not SabreDAV's integer ID;
- the sync token SabreDAV assigned to the change;
- the object's `UID`;
- `change_type`: `created`, `updated` or `deleted`.

The row is written in the same transaction as the object and SabreDAV's own `calendarchanges` row.
- Accept: a test kills the process between the object write and the outbox write and finds neither or both. The outbox row carries the token that `sync-collection` reports for the change.
- Deps: E03-R01, E04-R02.
- Notes: E07 consumes the outbox from Phase 4; until then it only grows, which at our size doesn't matter.
