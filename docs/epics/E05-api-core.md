# E05 — API core: auth, events, recurrence

| | |
|---|---|
| Phase | 1 (R01–R05, R08–R10); 3 (R07); 4 (R06), per ADR 0003 |
| Status | In progress: R01 ([PR #51](https://github.com/fabelhaft-io/flexcalendar/pull/51)), R02 ([PR #53](https://github.com/fabelhaft-io/flexcalendar/pull/53)), R10 ([PR #66](https://github.com/fabelhaft-io/flexcalendar/pull/66)), R03 ([PR #73](https://github.com/fabelhaft-io/flexcalendar/pull/73)), R04 ([PR #75](https://github.com/fabelhaft-io/flexcalendar/pull/75)) and R08 ([PR #77](https://github.com/fabelhaft-io/flexcalendar/pull/77)) Done, 2026-10-11; R09 ([PR #79](https://github.com/fabelhaft-io/flexcalendar/pull/79)) Done, 2026-10-12; R05 follows, the rest follow R01 and R02. R07 also waits for E13-R02 |
| Executor | `agent` (`agent+review` for R01) |
| Depends on | E02-R03, E02-R07, E02-R09, E03-R01, E04; D-01, D-03, D-05, D-18 |
| Spec | `01-architecture.md` § API layer, `02` § Backend and § Recurrence, ADR 0002 |

## Goal

A thin Fastify service that fronts CalDAV for our own clients. It owns auth, it is the single `ical.js` authority for recurrence, and it serves events in a form both web and mobile can cache.

Every endpoint is defined in `spec/openapi.yaml` first, and the Fastify route schemas are generated from it or validated against it (E02-R07). Until Phase 4 every calendar is Private, so the events written in Phase 1 are skeletons that pass the E03-R09 allow-list. Tests that need a sealed envelope use an opaque blob with a valid header (`spec/crypto.md`), because the API never opens one.

## Requirements

### E05-R01 · OIDC bearer auth   `agent+review`
Every endpoint except health MUST require an access token from the D-03 IdP, validated against its JWKS (issuer, audience, expiry, algorithm allow-list). The token's `sub` maps to a `users` row, created on first sight.
- Accept: a token for a seeded user from the E02-R09 helper → 200, and the first request creates that user's `users` row.
- Accept: each of these → 401: an expired token, a wrong-audience token, an `alg:none` token, a token signed by an unknown key, and an opaque token. The negative tokens are signed by a key the test serves as its own JWKS, never by Zitadel.
- Accept: JWKS rotation is handled without a restart.
- Deps: E02-R09, E04-R02.
- Notes: Zitadel (ADR 0004) issues JWT access tokens only when the app registration sets the JWT token type, and puts the project ID in `aud` only when the client requests the project audience scope. Both are in the Zitadel config as code (E02-R09). An opaque token reaching the API is a 401, never an introspection call.
- Notes (owner's decisions of 2026-10-10):
  - **Audience.** The expected `aud` is the Zitadel project ID. It comes from `CALFLEX_OIDC_AUDIENCE` or, when that is unset, from the file named by `CALFLEX_OIDC_AUDIENCE_FILE`, which `zitadel-config apply` writes in the local stack. With neither, the API answers 503 to everything except health.
  - **First sight.** Zitadel's access token carries `sub` and no profile claims, but `users.handle` and `users.email` are required. When a valid token's `sub` has no row, the API calls the issuer's userinfo endpoint once with that token and takes `preferred_username` as the handle and `email` as the e-mail, refusing an unverified one. The clients request the `email` scope.
  - **Endpoint.** The Accept needs an authenticated 200, so this requirement defines `GET /me` (the caller's `id`, `handle`, `email`).

### E05-R02 · CalDAV client adapter   `agent`
All CalDAV access MUST go through one module built on `tsdav` (or raw `fetch` where `tsdav` lacks a report). It authenticates on the CalDAV service's internal listener with D-05 delegation and signs the `X-Calflex-Principal` header exactly as E03-R01 defines it, with the first key in `CALFLEX_DELEGATION_KEYS`. No other module talks to CalDAV. `CALFLEX_CALDAV_ORIGIN` in `infra/dev/compose.yaml`, which E02-R03 pointed at the public `https://caldav.localhost` URL, moves to the internal listener.
- Accept: a lint rule forbids importing `tsdav` outside the adapter.
- Accept: a fixed signing vector (key, method, target, `p`, `t`, `n` → `s`) passes here and in E03-R01's tests.
- Accept: integration tests against the local stack read and write as two different seeded users.
- Deps: E03-R01, E05-R01.

### E05-R03 · Calendars API   `agent`
The API MUST list, create, rename, recolour and delete calendars. Create requires an explicit `mode`, with no default (ADR 0001 § Decision). Until Phase 4 only `private` is accepted (ADR 0003), and `published` is created through E06-R06.

For a Private calendar, the name and colour exist only inside the calendar-metadata envelope that the client seals (D-18, `spec/crypto.md`):
- **Create** takes `metaEnvelope` and `metaEpoch`. The API checks only the envelope's header and size, and stores it opaquely in `calendars.meta_envelope`. The CalDAV collection gets the fixed display name `Private calendar` (E03-R09).
- **Rename and recolour** replace the envelope, with an `If-Match` on the calendar's version.
- A plaintext `name` or `color` field on a Private calendar → 422.

From Phase 4, Shared calendars take plaintext `name` and `color`, which are written to CalDAV `displayname` and `calendar-color`.
- Accept: each of these → 422:
  - a POST without `mode`;
  - a Private POST without `metaEnvelope`;
  - a Private POST with an envelope whose header is invalid or that is larger than 4 KiB;
  - a Private POST with a plaintext `name`.
- Accept: the CalDAV collection, the `calendars` row and the owner's `calendar_members` row are created together, with compensation when any step fails. Delete removes the collection and the calendar's rows.
- Accept: calendar IDs, and therefore collection hrefs, are UUIDv4 (INV-03), tested on the create path.
- Deps: E05-R02, E04-R03.

### E05-R04 · Event CRUD with ETag preconditions   `agent`
The API MUST create, read, update and delete events. Writes carry `If-Match` (update/delete) or `If-None-Match: *` (create) through to CalDAV. Responses include `uid`, `etag`, the raw iCalendar text `ical`, and a parsed convenience view.
- Accept: a concurrent update → 412 with the current representation; created `UID`s are UUIDv4 (INV-03), tested on the create path.
- Accept: a write the E03-R09 guard rejects reaches the client as problem+json (R10), and the error doesn't echo the rejected value.
- Accept: the read-modify-write module (`ical.js` parse, patch, serialise) preserves every property, parameter and component it doesn't understand (INV-02), shown by a unit test over the E15-R01 corpus.
  - The end-to-end INV-02 test through the API runs in Phase 4 on a Shared calendar: the guard rejects unknown properties on Private calendars by design.
- Deps: E05-R02, E05-R03.
- Notes: returning raw `ical` + `etag` is what lets the Drift cache store the canonical record (`02` § Offline cache). For Private calendars the `ical` is the skeleton; content comes from the sidecar (E13-R02).

### E05-R05 · Windowed occurrence expansion   `agent`
`GET /calendars/{id}/occurrences?from&to&tz` MUST return the expanded instances in the window, computed with `ical.js` from the masters and overrides, each tagged with master `uid`, `recurrenceId`, and whether it is an override.
- Accept: the API runs the E15-R02 DST table and the E15-R03 `RRULE` corpus and produces their expected results; window boundaries are inclusive-exclusive and correct for all-day events.
- Deps: E05-R04, E15-R02, E15-R03.

### E05-R06 · Recurring-edit intents (Shared calendars, Phase 4)   `agent`
`POST /events/{uid}/intents` MUST accept `{scope: this|thisAndFollowing|all, recurrenceId, patch}` and apply it with `ical.js`:
- `this` → an override `VEVENT` with `RECURRENCE-ID`, or an `EXDATE` for delete.
- `thisAndFollowing` → `UNTIL` on the old master plus a new master with a new UUIDv4 `UID` and `RELATED-TO` to the original.
- `all` → edit the master, moving overrides consistently.
- Accept: the result round-trips through the E15 corpus and matches the stock-app-authored fixtures of the same edit (captured by E15-R04); `SEQUENCE` is incremented as RFC 5546 requires.
- Deps: E05-R07.

### E05-R07 · Recurring-edit intents (Private calendars, two-step)   `agent`
Per D-07, for Private calendars the intent endpoint MUST return a **plan** (the new skeletons, with the `uid`/`recurrenceId` whose envelope must be re-sealed) without committing it. `POST /events/{uid}/intents/{planId}/commit` then takes the plan ID plus one envelope per affected skeleton and commits them atomically with `If-Match`.
- Accept: commit with a missing or stale envelope → 409; the plan expires after 5 min; the server never sees plaintext.
- Notes: this is the **first** recurring-edit path built (Phase 3). Build the `ical.js` plan engine so R06 in Phase 4 reuses it and only skips the re-seal step.
- Deps: E13-R02

### E05-R08 · Delta endpoint   `agent`
`GET /calendars/{id}/changes?since=<syncToken>` MUST proxy `sync-collection` and return changed and deleted `uid`s with ETags and a new token. A token that SabreDAV rejects (unknown, malformed, or from another collection) → 410, which tells the client to reload fully.
- Accept: an integration test covers a create, an update and a delete between two tokens, and each kind of rejected token → 410.
- Deps: E05-R04.
- Notes: E07 pings, the mobile app (Phase 3) and the web client (Phase 5) all use it.

### E05-R09 · Timezone handling   `agent`
The API MUST accept and emit IANA `TZID`s only, embed a `VTIMEZONE` for every `TZID` it writes, and reject Windows or unknown zone names on input with a clear error, except where the round-trip preserves them untouched (INV-02).
- Accept: fixtures with Microsoft zone names (hand-written in E15-R01 until captured ones arrive in Phase 4) survive a read-modify-write that doesn't touch time fields. A skeleton with an embedded `VTIMEZONE` passes the E03-R09 guard.
- Deps: E05-R04.

### E05-R10 · Error model and observability hooks   `agent`
Errors MUST use RFC 9457 problem+json. Every request logs a correlation ID that is passed to CalDAV, and no event content is logged (applies to all modes).
- Accept: the API integration suite sends marker values in rejected content properties, in envelope bytes and in request bodies; a scan of the API and CalDAV logs afterwards finds none of them.
- Deps: E05-R01.
