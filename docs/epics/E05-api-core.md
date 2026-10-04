# E05 — API core: auth, events, recurrence

| | |
|---|---|
| Phase | 1–2 |
| Status | Blocked on D-01, D-03, D-05 |
| Executor | `agent` (`agent+review` for R01) |
| Depends on | E03, E04 |
| Spec | `01-architecture.md` § API layer, `02` § Backend and § Recurrence, ADR 0002 |

## Goal

A thin Fastify service that fronts CalDAV for our own clients. It owns auth, it is the single `ical.js` authority for recurrence, and it serves events in a form both web and mobile can cache.

## Requirements

### E05-R01 · OIDC bearer auth   `agent+review`
Every endpoint except health MUST require an access token from the D-03 IdP, validated against its JWKS (issuer, audience, expiry, algorithm allow-list). The token's `sub` maps to a `users` row, created on first sight.
- Accept: expired, wrong-audience and `alg:none` tokens → 401; JWKS rotation handled without restart.

### E05-R02 · CalDAV client adapter   `agent`
All CalDAV access MUST go through one module built on `tsdav` (or raw `fetch` where `tsdav` lacks a report), authenticating with D-05 delegated identity. No other module talks to CalDAV.
- Accept: a lint rule forbids importing `tsdav` outside the adapter; integration tests run against the local stack.

### E05-R03 · Calendars API   `agent`
The API MUST list, create, rename, recolor and delete calendars. Create requires an explicit `mode`, with no default (ADR 0001 § Decision); until Phase 5 only `shared` is accepted, and `published` is created through E06-R06.
- Accept: POST without `mode` → 422; the CalDAV collection and `calendars` row are created together, with compensation on failure.

### E05-R04 · Event CRUD with ETag preconditions   `agent`
The API MUST create, read, update and delete events. Writes carry `If-Match` (update/delete) or `If-None-Match: *` (create) through to CalDAV. Responses include `uid`, `etag`, the raw iCalendar text `ical`, and a parsed convenience view.
- Accept: a concurrent update → 412 with the current representation; round-trip preserves unknown properties (INV-02); created `UID`s are UUIDv4 (INV-03).
- Notes: returning raw `ical` + `etag` is what lets the Drift cache store the canonical record (`02` § Offline cache).

### E05-R05 · Windowed occurrence expansion   `agent`
`GET /calendars/{id}/occurrences?from&to&tz` MUST return the expanded instances in the window, computed with `ical.js` from the masters and overrides, each tagged with master `uid`, `recurrenceId`, and whether it is an override.
- Accept: passes the E15-R02 DST matrix and the RRULE corpus (E15-R03); window boundaries are inclusive-exclusive and correct for all-day events.

### E05-R06 · Recurring-edit intents (Shared calendars)   `agent`
`POST /events/{uid}/intents` MUST accept `{scope: this|thisAndFollowing|all, recurrenceId, patch}` and apply it with `ical.js`:
- `this` → an override `VEVENT` with `RECURRENCE-ID`, or an `EXDATE` for delete.
- `thisAndFollowing` → `UNTIL` on the old master plus a new master with a new UUIDv4 `UID` and `RELATED-TO` to the original.
- `all` → edit the master, moving overrides consistently.
- Accept: the result round-trips through the E15 corpus and matches the stock-app-authored fixtures of the same edit; `SEQUENCE` is incremented as RFC 5546 requires.

### E05-R07 · Recurring-edit intents (Private calendars, two-step)   `agent`
Per D-07, for Private calendars the intent endpoint MUST return a **plan** (the new skeletons, with the `uid`/`recurrenceId` whose envelope must be re-sealed) without committing it. `POST /events/{uid}/intents/{planId}/commit` then takes the plan ID plus one envelope per affected skeleton and commits them atomically with `If-Match`.
- Accept: commit with a missing or stale envelope → 409; the plan expires after 5 min; the server never sees plaintext.
- Deps: E13-R02

### E05-R08 · Delta endpoint   `agent`
`GET /calendars/{id}/changes?since=<syncToken>` MUST proxy `sync-collection` and return changed and deleted `uid`s with ETags and a new token. An invalid or expired token → 410, which tells the client to reload fully.
- Accept: used by E07 pings, the web client and the mobile app; tested across token expiry.

### E05-R09 · Timezone handling   `agent`
The API MUST accept and emit IANA `TZID`s only, embed a `VTIMEZONE` for every `TZID` it writes, and reject Windows or unknown zone names on input with a clear error, except where the round-trip preserves them untouched (INV-02).
- Accept: fixtures with Microsoft zone names from stock apps survive a read-modify-write that doesn't touch time fields.

### E05-R10 · Error model and observability hooks   `agent`
Errors MUST use RFC 9457 problem+json. Every request logs a correlation ID that is passed to CalDAV, and no event content is logged (applies to all modes).
- Accept: a log-scan test during the E15 run finds no fixture `SUMMARY` values in API logs.
