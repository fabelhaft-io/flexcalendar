# `server/api/` — API service

The thin REST facade that the project's own clients use. Stock apps bypass it
and hit CalDAV directly (CLAUDE.md).

- **Owning epic:** [E05 — API core](../../docs/epics/E05-api-core.md).
- **What belongs here:** the Node 24 LTS + TypeScript service on **Fastify**
  (D-01, `docs/02-technology-choices.md`), and the only place recurrence is
  expanded — with **`ical.js`**, never hand-rolled (ADR 0002, INV-05). It
  reaches CalDAV as the user through the HMAC-signed delegated principal of
  D-05 and validates Zitadel JWTs against JWKS (D-03).
- **Related epics:** [E07](../../docs/epics/E07-change-fanout.md) adds the push
  fan-out worker (data-only change pings, INV-06);
  [E06](../../docs/epics/E06-sharing-feeds-onboarding.md) adds sharing, feeds
  and onboarding; [E13](../../docs/epics/E13-private-mode.md) adds the Private
  write path. It stores raw iCalendar objects and envelope ciphertext only, and
  never decrypts (INV-01, INV-07).
- **Local stack
  ([E02-R03](../../docs/epics/E02-repo-tooling-ci.md)):** the `api` service of
  [`infra/dev/compose.yaml`](../../infra/dev/compose.yaml) is built from the
  [`Dockerfile`](Dockerfile) here and runs [`src/server.mjs`](src/server.mjs).
  It answers `GET /healthz`, `GET /me` and the calendars routes below, and
  nothing but the readiness probe is reachable without an access token.
- **OIDC bearer auth (E05-R01):** see [Authentication](#authentication). The
  service never decrypts and stores no event content.
- **Calendars API (E05-R03):** see [Calendars](#calendars). A Private calendar's
  name and colour exist only inside the envelope the client seals (D-18): the
  API checks its header and its size, stores it opaquely, and never opens one
  (INV-07).
- **Events API (E05-R04):** see [Events](#events). Single-object CRUD on
  `/calendars/{calendarId}/events/{uid}` with the caller's `If-Match` forwarded
  to CalDAV. Every answer carries the raw `ical` and its `ETag` — what the
  offline cache keeps — beside a parsed view, and a write that lost a race is a
  `412` carrying the representation the collection holds now.
- **Time zones (E05-R09):** see [Time zones](#time-zones-e05-r09). A time is a
  `date`, a `utc` instant or a `local` wall clock beside an IANA `TZID`, written
  with that zone's generated `VTIMEZONE`; every instant the API computes comes
  from Node's own zone database, never from `ical.js`, and no zone is registered
  in the library globally.
- **Delta endpoint (E05-R08):** see [Changes](#changes). `sync-collection` on
  `/calendars/{calendarId}/changes`, reduced to pointers: a `uid`, its `ETag` and
  whether the object is gone, beside an opaque token the API mints for that
  calendar. A token the collection never reached — malformed, another calendar's,
  or ahead of it — is the fixed `410`, which tells the client to reload fully.
- **Occurrence window (E05-R05):** see [Occurrences](#occurrences).
  `GET /calendars/{calendarId}/occurrences?from&to&tz` returns the expanded
  instances of a half-open window, computed with `ical.js` from the masters and
  their overrides and each tagged with the master `uid`, the instance's
  `recurrenceId` and whether an override defines it. An object the expansion
  cannot answer for honestly is reported in `unsupported` rather than guessed
  at.
- **Error model and observability (E05-R10):** see [Errors](#errors) and
  [Logging](#logging). Every error is an RFC 9457 problem document, every
  response carries a correlation ID, and no request-derived value — a path, a
  query, a header, a token, a body — reaches a log line or a response body.
- **Toolchain pins**
  ([E02-R02](../../docs/epics/E02-repo-tooling-ci.md)): this package's
  [`package.json`](package.json) pins Node 24 through `engines`, and the
  workspace root requires Node 24 from 24.17.0 on (`.nvmrc` installs the
  newest Node 24; `devEngines` accepts any 24.x from 24.17.0) and pins pnpm
  (`packageManager`, via corepack). Add dependencies with
  `corepack pnpm add --filter @flexcalendar/api …` so `pnpm-lock.yaml` stays the
  single source of resolved versions.
- **Migrations (E04-R01):** `make migrate` applies the API-owned files in
  `migrations/`, using `migrate.config.json`. Upstream SQL and its tag, commit
  and SHA-256 record live in `sabredav/`. `corepack pnpm test` in this package
  now requires working rootless Podman for `test/migrate.test.mjs`;
  `test/migrate-record.test.mjs` needs no containers. Migration options live in
  `migrate.config.json`: the pinned CLI reads dashed keys there, and the file
  overrides the command line. Fixtures therefore copy the config and change only
  the directory. `single-transaction` and `lock` are CLI defaults (`true`), not
  options read from this file; the rollback tests depend on these defaults.
- **Calendar mode (E04-R03):** `public.calendar_mode` reserves `private`,
  `shared`, and `published`, with no column default. Until Phase 4,
  `calendars_mode_private_only_check` permits only `private`. The named migration
  shipping with E13-R06 must run
  `ALTER TABLE public.calendars DROP CONSTRAINT calendars_mode_private_only_check`
  to lift that gate, leaving `calendars_meta_envelope_check` intact.
- **Sidecar envelopes (E04-R04):** `public.event_envelopes` stores opaque envelope
  bytes, keyed by `(calendar_id, uid, recurrence_id, envelope_sha256)` with
  `NULLS NOT DISTINCT` for master rows. The SHA-256 digest is 32-byte `bytea`
  (64 lowercase hex digits in `X-CALFLEX-ENVELOPE-SHA256`).
  [`src/recurrence-key.mjs`](src/recurrence-key.mjs) canonicalizes override
  `RECURRENCE-ID` properties with `ical.js`: `recurrence_id` is canonical text,
  not the original spelling (`YYYYMMDDTHHMMSSZ` for instants, `YYYYMMDD` for
  dates, NULL for masters). TZIDs must resolve through a supplied `VTIMEZONE`
  or the caller's `ICAL.TimezoneService`; floating or unresolved times are
  rejected rather than assigned an incorrect envelope key.
  The typecheck skips library declarations because `ical.js` 2.2.1's declarations
  do not satisfy NodeNext; our own code remains checked.
- **Member keys (E04-R05):** `public.user_keys` stores one 32-byte X25519 and
  Ed25519 public-key pair per user; `public.user_key_wraps` stores one opaque,
  non-empty wrapped private-key bundle per user and kind. Only `recovery_code`
  is allowed until E14-R01 drops `user_key_wraps_no_escrow_check` in Phase 7
  (its `down` restores the gate); the separate kind check still forbids `password`.
  `public.calendar_keys` stores opaque, non-empty sealed and signed CCK records
  per `(calendar_id, epoch, user_id)`, with the signer inside the E12-R01 record,
  not a server-side column. Members must have a `user_keys` row; membership and
  calendar deletion cascade to their CCK records, not their user keys or wraps.
  Blob formats belong to `spec/crypto.md` (E12-R01), with size limits at the API
  boundary, not here. Only `calflex_api` has service access to these three tables;
  the CalDAV service has none. No server-side crypto is added.
- **Not here:** CalDAV storage (that is `../caldav/`) and any client code.

## Authentication and rate limiting

Every route except `GET`/`HEAD /healthz` — unknown routes and unknown methods
included — goes through two global `onRequest` hooks before any route handler
runs: the rate limiter first (`src/app.mjs`), then the bearer hook
(`src/auth.mjs`). The order is the point: an unauthenticated flood is counted
before a single token is verified, and a request over its limit never reaches
the JWKS cache or the IdP.

- **Rate limit.** One in-memory bucket per client address,
  `CALFLEX_RATE_LIMIT_MAX` requests per `CALFLEX_RATE_LIMIT_WINDOW_SECONDS`
  (300 per 60 s by default), at most 10,000 keys. A refused request is `429`
  with `Retry-After` and a `rate-limited` problem document — no counter,
  address or key. `GET`/`HEAD /healthz` is allow-listed, so a
  client over its limit cannot make the container look unhealthy. On an
  unknown path the limiter runs too, because the bearer hook runs there.
  Because the limit is per client address, the API must be told where to read
  that address: `CALFLEX_TRUSTED_PROXY_HOPS`. The in-memory store is a single
  process's; a second API instance would need a shared store before it could
  enforce one limit across both.
- **The token.** Exactly one `Authorization: Bearer <JWT>` header, scheme
  case-insensitive, at most 8 KiB, three base64url segments. Nothing is read
  from the query string, and an opaque token is a 401 **before any network
  call**. `jwtVerify` then requires `RS256` only, our `iss`, our `aud` (the
  Zitadel project ID), `exp`, `nbf` and a non-empty `sub` of at most 255
  characters, with 5 s of clock tolerance.
- **Discovery and JWKS.** `CALFLEX_OIDC_BASE_URL` (default: the issuer) is
  where the three calls go; when it differs from the issuer they carry
  `Host: <issuer>`, so Zitadel still resolves its instance. Discovery's
  `issuer` must equal `CALFLEX_OIDC_ISSUER`, and `jwks_uri` and
  `userinfo_endpoint` must be same-origin with the issuer before they are
  re-rooted on the base URL. No redirects are followed, responses are capped at
  1 MiB, RSA keys only, keys cached for 10 minutes. An unknown `kid` refetches
  at most once per 30 s; with keys cached, an IdP outage does not stop
  validation. `createRemoteJWKSet` is deliberately unused: it cannot pin the
  base URL.
- **Refusals.** Every authentication failure is the same 401: the
  `unauthorized` problem document (its only per-request member is `instance`),
  `WWW-Authenticate: Bearer`, `Cache-Control: no-store`, and no reason code
  anywhere. A userinfo failure is 502, an
  unverified email 403, and a handle or email address that is taken 409; none
  of those creates a row.
- **First sight.** A valid token whose `sub` has no `users` row calls the
  issuer's `userinfo_endpoint` **once**, with the caller's own token — never on
  a 401 path, never introspection. `handle` is `preferred_username` and `email`
  is `email`, both taken verbatim (trimmed); `email_verified` must be `true`
  and userinfo's `sub` must equal the token's. The insert is `ON CONFLICT
  (idp_subject) DO NOTHING` followed by a read-back, so two simultaneous first
  requests converge on one row; a unique violation on `handle` or `email` is a
  409. There is no profile sync afterwards. Discovery's own userinfo shape is
  not overridden here: whatever Zitadel puts in `preferred_username` is the
  handle.

### Configuration

| Variable | Meaning |
|---|---|
| `CALFLEX_OIDC_ISSUER` | The `iss` every token must carry, and the identity discovery must confirm. Unset: 503 everywhere but `/healthz`. |
| `CALFLEX_OIDC_BASE_URL` | Where the IdP is reached (default: the issuer). Locally `http://zitadel-api:8080`. |
| `CALFLEX_OIDC_AUDIENCE` | The expected `aud` (the Zitadel project ID). Wins over the file. |
| `CALFLEX_OIDC_AUDIENCE_FILE` | File whose trimmed first line is the audience. Read lazily, and re-read after an audience mismatch at most once per 5 s. Neither present: 503 on every protected route, never accepted. |
| `CALFLEX_DATABASE_URL` | `public.users` for the first sight. `calflex_api`. |
| `CALFLEX_LOG_LEVEL` | The pino level of the request log: one of `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`. Default `info`; anything else stops the service at startup. |
| `CALFLEX_RATE_LIMIT_MAX` | Requests allowed per client address and window. Whole number ≥ 1, default `300`. |
| `CALFLEX_RATE_LIMIT_WINDOW_SECONDS` | Length of the rate-limit window. Whole number ≥ 1, default `60`. |
| `CALFLEX_TRUSTED_PROXY_HOPS` | How many proxies sit in front of the API, i.e. how many `X-Forwarded-For` hops are believed. Whole number ≥ 0, default `0` — the socket address is the client and `X-Forwarded-For` is ignored. `1` behind Caddy (the local stack sets it). Set too high, a client picks its own bucket with a header; left at `0` behind the proxy, every client shares Caddy's bucket. |

A rate-limit or proxy-hop value that is not a whole number at or above its
floor stops the service at startup instead of falling back to a default, and so
does a `CALFLEX_LOG_LEVEL` outside the list above.

`GET /healthz` touches none of them and stays database-free.

## Calendars

Four operations (`src/calendars.mjs`), all behind the bearer hook, all declared
in `spec/openapi.yaml` first:

| Operation | Answer |
|---|---|
| `GET /calendars` | `200` with the calendars the caller is a **member** of, oldest first |
| `POST /calendars` | `201` with `Location: /calendars/{id}` and `ETag: "<version>"` |
| `PATCH /calendars/{id}` | `200`; replaces the metadata envelope, needs `If-Match` |
| `DELETE /calendars/{id}` | `204`; removes the collection and the rows |

### Identity, roles and the envelope

- **Identity.** The caller's `users.id` comes from the one `resolveUser` in
  `src/auth.mjs` that `GET /me` uses; there is no second lookup. A new
  `calendars.id` is `crypto.randomUUID()` (INV-03) and the collection href is
  `/calendars/<ownerId>/<calendarId>/`.
- **Mode.** Create requires an explicit `mode` and has no default (ADR 0001);
  until Phase 4 only `private` is accepted (ADR 0003). `published` is created
  through E06-R06, `shared` arrives with Phase 4.
- **The envelope (D-18).** A Private calendar takes `metaEnvelope` and
  `metaEpoch` instead of `name`/`color`. `metaEnvelope` is **standard base64**
  (OpenAPI `format: byte`) of the bytes the client sealed: version `0x01`, the
  CCK epoch as a big-endian uint32, a 24-byte nonce, ciphertext, a 16-byte tag.
  The API checks only what a server without a key can — the version byte, that
  the epoch equals `metaEpoch`, the 45 bytes of fixed fields, and at most 4096
  bytes (`src/calendar-envelope.mjs`) — stores the bytes in
  `calendars.meta_envelope`, and gives the CalDAV collection the fixed display
  name `Private calendar` (E03-R09). Everything after byte 45 is opaque, and the
  envelope is never logged, echoed in a problem or decoded further (INV-07).
- **Rename and recolour** are one act: `PATCH` replaces the envelope and the
  epoch it names. It is rows-only — nothing is written to CalDAV, so the
  collection keeps its display name — and it must carry `If-Match: "<version>"`:
  a stale version is a `412`, a missing one a `428`. The version bumps in the
  same statement that writes the row, so a lost update is impossible.
- **Who may do what.** Only the owner renames, recolours or deletes. A member
  who is not the owner gets `403`; a caller who is not a member gets `404`, the
  same answer an id that exists nowhere gets (E03-R01).
- **An id that is not a UUID is that same `404`**, and the route decides it
  before the store is asked: `calendars.id` is a `uuid` column, so `not-a-uuid`
  would raise `22P02` and turn a request whose real answer is "no such calendar"
  into a `500`. Only the canonical lowercase form this API mints is accepted
  (INV-03).
- **The version** is the `version` column the E05-R03 migration adds
  (`integer NOT NULL DEFAULT 1`, `CHECK (version >= 1)`), and it is the `ETag`.

### Create and delete: which order, and what happens when a step fails

- **Create is rows first, collection second.** The CalDAV service answers `404`
  for a collection whose `calendars` row is not committed (E03-R08), so
  `POST /calendars` (1) inserts the `calendars` row and the owner's
  `calendar_members` row in one transaction and **commits**, (2) calls
  `MKCALENDAR`, and (3) if that fails, deletes the row again — the membership row
  cascades — and answers through the CalDAV mapping. A compensation that itself
  fails logs both error names and answers `500`: the row is still there, which is
  what a 5xx means here.
- **Delete is the other way round.** (1) `DELETE` the collection while the owner
  can still reach it, a CalDAV `404` counting as already gone, then (2) delete
  the rows. A failure at (2) answers `500` and leaves the collection gone, so the
  client's retry finishes the job.
- **No request-body schema, deliberately.** A body that fails Fastify's schema
  validation is a `400`, and the rules of this section must answer `422`, so the
  calendars operations declare none: they check the request's own fields, and
  every refusal is the same `422` `invalid-input` problem with a fixed body —
  never a value, never an envelope byte. A member the operation does not take is
  refused rather than ignored, so a misspelled `name` cannot look like a
  successful rename.
- **`405`, not `404`.** A known path under a method it does not register is a
  `405` with an `Allow` header, for every registered path: `src/allow.mjs`
  records Fastify's route table through `onRoute` and the not-found handler asks
  it first. An unknown path stays a `404`, without an `Allow`.
- **A CalDAV `401` is not the caller's `401`.** The bearer token was verified
  before the route ran, so a refusal from the listener means our delegation
  failed — a bad key, or a service whose database is down — and it is answered as
  a `502` like every other unreadable upstream answer. A `401` there would sign a
  correctly authenticated client out (E03-R01, `src/problem.mjs`).

## Events

Four operations (`src/events.mjs`), all behind the bearer hook, all declared in
`spec/openapi.yaml` first:

| Operation | Answer |
|---|---|
| `POST /calendars/{calendarId}/events` | `201` with `Location` and `ETag`, and the created object |
| `GET /calendars/{calendarId}/events/{uid}` | `200` with the stored object |
| `PATCH /calendars/{calendarId}/events/{uid}` | `200`; needs `If-Match`, bumps `SEQUENCE` and `DTSTAMP` |
| `DELETE /calendars/{calendarId}/events/{uid}` | `204`; needs `If-Match` |

The object's name in CalDAV is `<uid>.ics`, and `uid` is the path parameter:
only a canonical lowercase UUIDv4 can name one (INV-03), so anything else is the
`404` an unknown `uid` gets, decided before CalDAV is asked — and a `uid` over
`calendarobjects.uid`'s `VARCHAR(200)` never reaches it either (E03-R10). The
router's `maxParamLength` is raised to 200 for that reason: a `uid` of that
length gets this API's `404`, not the router's own `414` — and one longer than
that is a `404` too, from the `frameworkErrors` handler, rather than Fastify's
own body naming the path.

### What an answer carries

```json
{
  "uid": "6f1c0a2e-6a0e-4a2f-8a4b-1d3a5c7e9f01",
  "etag": "\"…\"",
  "ical": "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n…",
  "parsed": {
    "uid": "6f1c0a2e-6a0e-4a2f-8a4b-1d3a5c7e9f01",
    "start": { "utc": "20261014T090000Z" },
    "end": { "utc": "20261014T100000Z" },
    "rrule": null,
    "alarm": { "trigger": "-PT15M" },
    "sequence": 0,
    "envelopeSha256": "ef2d…"
  }
}
```

- **`ical` is the stored text, byte for byte**, and `etag` is CalDAV's — also on
  the response as `ETag`. Together they are what a client caches as the canonical
  record (`docs/02` § Offline cache). On a Private calendar the object is the
  skeleton and the content is sealed in the sidecar (E13-R02).
- **`parsed` is the master `VEVENT` and nothing else**: no content, no override
  list, no third-party property. A time is `{date}` (`YYYY-MM-DD`, all-day),
  `{utc}` (`YYYYMMDDTHHMMSSZ`) or `{local}`, with the `tzid` beside it when the
  stored property names a zone. A `TZID` time is reported as the wall clock the
  object spells — that is the stored truth (INV-02) — and gains `utc`, the
  instant that reading names, when the zone resolves. A zone the resolver cannot
  read (a Microsoft zone name, say) is reported as its wall clock and its `TZID`
  and nothing more.
- **An object with overrides** is read whole and its master is `parsed`; a
  `PATCH` of the master leaves every override component untouched (INV-02).

### Create and update: the client sends fields, the API writes the iCalendar

The body is a field set, never iCalendar: `start` (required on create), `end`,
`rrule` (create only), `alarm: {trigger}`, `envelopeSha256`, and the Phase-4
content fields `summary`, `description`, `location` and `attendees`.
`src/ical-rmw.mjs` turns those into the object with `ical.js` — the API's single
iCalendar engine (D-01, ADR 0002) — and back:

- **`UID`, `DTSTAMP`, `PRODID` are ours.** The `UID` is `crypto.randomUUID()`
  (INV-03), the `DTSTAMP` is the moment of the write in UTC, and a client can
  never send a `UID`, an `EXDATE` or a `RECURRENCE-ID` at all (INV-05): an edit
  to a recurring event is an intent (E05-R06/R07), not a rule.
- **A time is one of three forms** (E05-R09, INV-04): `{date}`, `{utc}`, or
  `{local, tzid}` — an IANA zone in its exact spelling beside the wall clock that
  zone reads. An impossible date (`2026-02-30`) is refused rather than rolled
  forward, and so is an instant that is not `YYYYMMDDTHHMMSSZ`, a `tzid` beside
  `utc` or `date` or without its `local`, and a zone that is not an IANA name in
  its exact spelling that the zone database resolves — `W. Europe Standard Time`,
  `europe/berlin` and `Mars/Olympus` are the caller's fixed `422`.
- **A `TZID` write carries its zone in the object.** The property is
  `DTSTART;TZID=Europe/Berlin:20261014T100000` — the wall clock the caller sent,
  never a converted one — and, unless the object already defines that zone, the
  generated `VTIMEZONE` is embedded beside it, in front of the events. An object
  therefore always defines the zones it uses, which is what the round-trip gate
  of E15-R01 checks and what a stock client without a zone database needs. A
  definition that is already there — a stock app's own, byte for byte — is never
  replaced (INV-02).
- **The merged object is checked, not only the members the request named.** After
  a create and after a patch, `start` and `end` must be the same value type — an
  all-day `VALUE=DATE` with a `DATE`, a `DATE-TIME` with a `DATE-TIME`
  (RFC 5545 § 3.8.2.2, INV-04) — and the end must be later than the start;
  otherwise the fixed `422`. The two clocks are compared as the instants they
  name, whatever their form, so a `Z` start beside a stored `TZID` end is
  checked too. Only a clock that names no instant this API can compute — a
  floating time, or a `TZID` the resolver cannot read — is left alone when it
  does not share its shape with the other one (INV-02), and a patch that touches
  a time field of such an object is a `422` unless it replaces **both** `start`
  and `end` with values this API can write.
- **An `rrule` is exactly the parts RFC 5545 § 3.3.10 names.** `FREQ` is required
  and first; `UNTIL`, `COUNT`, `INTERVAL`, `BYSECOND`, `BYMINUTE`, `BYHOUR`,
  `BYDAY`, `BYMONTHDAY`, `BYYEARDAY`, `BYWEEKNO`, `BYMONTH`, `BYSETPOS` and `WKST`
  are accepted, each at most once. Anything else — a misspelled part above all —
  is a `422` rather than something `ical.js` drops while the write looks
  successful. `COUNT` and `UNTIL` are mutually exclusive, and `UNTIL` has the
  value type of the start: a `DATE` (`20261015`) for an all-day rule, a UTC
  `DATE-TIME` (`20261015T090000Z`) for a timed one — a `TZID` start included,
  because a zone-referenced start takes a UTC `UNTIL` (§ 3.3.10). Two families `ical.js` 2.2.1
  expands **wrongly** are refused rather than expanded — any rule naming
  `BYWEEKNO`, and a `FREQ=YEARLY` rule whose start is 29 February
  (`spec/ical-fixtures/RULINGS.md`; neither engine may be patched here, and
  `BYWEEKNO` is never hand-rolled). Nothing else is dropped in silence either:
  `COUNT` and `INTERVAL` are positive integers, `WKST` is a weekday, and an
  `UNTIL` the library would roll forward from a date that does not exist
  (`20260230T090000Z`) is a `422`. The only part that may leave the written rule
  is one whose value is the RFC's own default (`INTERVAL=1`, `WKST=MO`).
  `test/ical-rmw.test.mjs` holds that against the whole
  `spec/ical-fixtures/rrule/` corpus: every rule it carries is accepted except
  the two `RULINGS.md` names.
- **Every value is parsed, never pasted.** An `alarm` trigger is checked against
  `ICAL.Duration`, an envelope hash against 64 lowercase hex digits, and a text
  value against the control characters `ical.js` writes through unescaped — a
  carriage return above all, which would end a content line and let a value add
  a property of its own. Nothing a client sends reaches the text verbatim.
- **`If-Match` is required** on an update and on a delete (`428` without it) and
  is forwarded to CalDAV unchanged — including a list of validators or `*`. The
  store decides whether it still matches, which is why a stale read cannot
  overwrite a newer write. An update bumps `SEQUENCE` and `DTSTAMP`
  (RFC 5545 § 3.8.7.4).
- **A `PATCH` body that names nothing is a `422`.** A patch is a change: an empty
  one would still move `SEQUENCE`, `DTSTAMP` and the `ETag`, so every other client
  would see a revision that changed nothing.
- **A `412` answers with the current representation** in the problem's `current`
  member, so the client re-reads, reapplies and retries; the request that lost
  the race is never in the body. `current` is the representation a `GET` would
  answer with, which on a Private calendar is the skeleton. SabreDAV answers
  `412` to a conditional write on an object that is not there (RFC 9110
  § 13.1.1), and the same race reaches us when an object is deleted between the
  read and the write; the re-read tells the two apart, so an object that has
  vanished is answered with the `404` an unknown `uid` gets — `test/support/`
  `caldav-store.mjs` answers a conditional `DELETE` of a missing object the way
  Sabre does for that reason.
- **`PATCH` is a read-modify-write of the stored object**: `GET`, apply, `PUT`
  with the caller's `If-Match`. Everything the change did not name — an
  override, a `VTIMEZONE`, an `X-` property, a parameter — survives it untouched
  (INV-02), which `test/ical-rmw.test.mjs` holds against the whole
  `spec/ical-fixtures/` corpus (E15-R01).
- **A Private calendar stores skeletons** (ADR 0003, E03-R09): the content fields
  are a `422` — the content is sealed in the sidecar under the CCK (D-18) — and
  `envelopeSha256` is required, because a Private `VEVENT` carries exactly one
  `X-CALFLEX-ENVELOPE-SHA256`. The write guard behind the API would refuse such a
  write anyway, and E05-R02's suite shows it doing so; a value it refuses is
  named by property only, never echoed.
- **Who may do what.** `owner` and `editor` write, `viewer` reads (`403` on a
  write), and a caller who is not a member gets the `404` an unknown calendar
  gets.

### Time zones (E05-R09)

`src/zones.mjs` is the API's one zone source: **Node's own zone database (ICU,
through `Intl.DateTimeFormat`)**, read with the same field list the E15-R02
oracle uses. There is no new dependency, and **nothing is ever registered in
`ical.js`'s global `TimezoneService`** — registering one is process-wide, so one
client could redefine `Europe/Berlin` for every request (E04-R04's note).

- **A write names an IANA zone in its exact spelling.** Case matters: ICU
  accepts `europe/berlin` and canonicalises it, so the exact-case check lives in
  `src/iana-zones.mjs` — the 597 IANA names as the tz database spells them, which
  is also where the link names a client may send come from (`Asia/Kolkata`,
  `US/Eastern`, `Asia/Calcutta`). Every accepted name is resolved through ICU as
  well, so a name the list carries and ICU cannot read is refused rather than
  used.
- **RFC 5545 § 3.3.5 form 3, from ICU's offsets.** A local reading that occurs
  twice is the **first** occurrence and one that does not occur is read with the
  offset **before** the gap. No instant this API computes comes out of `ical.js`,
  which carries no zone database and is wrong on those two single times
  (`spec/ical-fixtures/dst/README.md`); the DST table of E15-R02
  (`spec/ical-fixtures/dst/cases.json`) is the contract; its `daily-skipped`
  family is a recurrence, which the occurrences runner checks against the
  owner's ruling on RFC 5545 § 3.3.10 (`docs/02` § Recurrence).
- **The `VTIMEZONE` is generated from ICU's real transitions.** One observance
  per distinct `(TZOFFSETFROM, TZOFFSETTO)` pair, its `DTSTART`/`RDATE` values
  local readings in that pair's **from** offset (the convention RFC 5545
  § 3.6.5's own example uses), plus one observance at the window's start that
  pins the offset in force then. Nothing outside the E03-R09 allow-list is
  written — `TZID`, `X-LIC-LOCATION`, `DTSTART`, `TZOFFSETFROM`, `TZOFFSETTO`,
  `RDATE` — and `test/zones.test.mjs` reads that allow-list out of
  `../caldav/src/PrivateSkeleton.php`, so the two cannot drift.
- **What it costs.** The API's horizon is 1970-01-01 through 2100-12-31
  (`HORIZON`): every instant an event can have inside it resolves, whatever the
  event, and `Europe/Berlin` comes out as 246 `DTSTART`/`RDATE` value lines,
  5.9 KB of a stored object. A `TZID` write names a reading **inside** that
  horizon — one outside it is the same fixed `422`, because the object's own
  definition could not read the time back — and a `Z` time needs no definition,
  so it is written whatever the date. A narrower window would be smaller but would go
  stale the moment a patch moved an event, and an `RRULE` per observance is
  smaller still but re-expands through the library that is wrong on two single
  local times — a trade for E05-R05 and E15-R03 to revisit, not for this
  requirement.
- **A stored zone the resolver cannot read stays as it is** (INV-02): it is
  reported as its wall clock and its `TZID`, with no `utc`, and a patch that
  leaves the times alone keeps the object, its zone and its own `VTIMEZONE` byte
  for byte — `test/events.test.mjs` and `test/ical-rmw.test.mjs` hold the
  Microsoft fixture of E15-R01 to that.

## Occurrences

One operation (`src/occurrence-routes.mjs`, with the expansion itself in
`src/occurrences.mjs`), behind the bearer hook, declared in
`spec/openapi.yaml` first: the windowed expansion our own clients cache, and the
one place a `RRULE` becomes instances for the API.

| Operation | Answer |
|---|---|
| `GET /calendars/{calendarId}/occurrences?from&to&tz` | `200` with the occurrences of the window and the objects that were left out; `404` for a calendar the caller is not a member of; `422` for a window this API does not answer |

```json
{
  "occurrences": [
    {
      "uid": "6f1c0a2e-6a0e-4a2f-8a4b-1d3a5c7e9f01",
      "recurrenceId": { "tzid": "Europe/Berlin", "local": "20261021T100000", "utc": "20261021T080000Z" },
      "override": false,
      "start": { "utc": "20261021T080000Z", "local": "20261021T100000", "tzid": "Europe/Berlin" },
      "end": { "utc": "20261021T090000Z", "local": "20261021T110000", "tzid": "Europe/Berlin" },
      "allDay": false,
      "envelopeSha256": "ef2d…"
    }
  ],
  "unsupported": []
}
```

- **The client never expands a rule** (ADR 0002, INV-05). The instances come
  from the masters and their override `VEVENT`s, `ical.js` does the recurrence
  arithmetic on wall clocks, and every instant is computed from Node's own zone
  database (`src/zones.mjs`) — never from the library, which has no zone
  database and is wrong on a local time that does not exist or occurs twice.
- **An edit is an intent.** `recurrenceId` is the instance's *original* start in
  the form the object stores it, and it is what E05-R06/R07 send back to address
  "this occurrence". `override` says whether an override `VEVENT` defines it,
  and the master's own instance is gone from the window when one does.
- **The window is half-open**: `from` included, `to` excluded, and an instance
  is in when its interval overlaps it. Both bounds are instants in the API's own
  form (`YYYYMMDDTHHMMSSZ`), `to` later than `from`, and at most 1830 days
  apart. `tz` is the IANA zone every instant is reported in (absent: `UTC`), and
  an all-day occurrence is a `date` whose instants are that zone's midnights —
  which is why a transition day is 23, 24 or 25 hours long.
- **`from`, `to` and `tz` are the whole query.** A member the operation does not
  take, a `tz` that is not an IANA name in its exact spelling, a `from` that is
  not an instant — all one fixed `422`, sent before the store or CalDAV is
  asked, and never echoing the value that was refused.
- **A window that is too big is refused, not sliced.** More than 10 000
  occurrences in one answer is the `422` `window-too-large`: there is no
  pagination, and a client that asks for five years of a minutely rule is told
  to ask for less rather than handed a slice it cannot tell from the whole.
- **`unsupported` is not an error.** An object whose rule is one `ical.js`
  expands wrongly (`BYWEEKNO`, a yearly rule anchored on 29 February:
  `spec/ical-fixtures/RULINGS.md`), one that names a `TZID` no zone database can
  read (a Windows name a stock app wrote), and one whose expansion would not
  stop inside the API's own bound are reported by their `uid` with a `reason`
  and contribute no occurrences. The entry carries no CalDAV path: that names
  the owner's principal, and a client needs the `uid` only. The rest of the window is answered as usual; a wrong expansion is
  never invented.
- **The CalDAV read is the whole collection.** The `calendar-query` carries the
  `VCALENDAR`/`VEVENT` filters alone: a `time-range` makes the service's own
  recurrence engine expand every series it holds and fail the whole report once
  one of them passes its instance bound, so a single long series would turn every
  window into a `502`. The exact filter — the window included — is this module's.
  The answer carries a `uid`, a `recurrenceId`, two times and an envelope hash —
  never a `SUMMARY`, a description, a location or an attendee.
- **`ical.js` iterates wall clocks, on a floating copy.** The object is expanded
  with every `VTIMEZONE` and every `TZID` parameter removed, so a `Z` `RDATE` or
  `EXDATE` is rewritten to the wall clock the master's own zone reads for it and
  a `Z` `UNTIL` stops the rule at the RFC's instant — the answer is the same
  whether or not the object embeds its `VTIMEZONE`. Every instant still comes
  from `src/zones.mjs`.

## Changes

One operation (`src/changes.mjs`), behind the bearer hook, declared in
`spec/openapi.yaml` first: the delta our own clients sync from. E07's pings, the
mobile app (Phase 3) and the web client (Phase 5) all read it, and it is the one
place the API speaks WebDAV-Sync (RFC 6578).

| Operation | Answer |
|---|---|
| `GET /calendars/{calendarId}/changes?since=<token>` | `200` with the changes and the new token; `404` for a calendar the caller is not a member of; `410` for a `since` this calendar cannot be read from |

```json
{
  "token": "NmYxYzBhMmUtNmEwZS00YTJmLThhNGItMWQzYTVjN2U5ZjAxOjQ",
  "changes": [
    { "uid": "6f1c0a2e-6a0e-4a2f-8a4b-1d3a5c7e9f01", "deleted": false, "etag": "\"…\"" },
    { "uid": "0b7d1e4f-2c3a-4d5e-8f90-1234567890ab", "deleted": true }
  ]
}
```

- **The answer is pointers, never content.** No `ical`, no `parsed`, no envelope:
  a client fetches what it needs with `GET …/events/{uid}` (and windows it with
  `GET …/occurrences`, E05-R05), and a tombstone carries no `etag` at all — not
  `null`, not the last one — so a deletion cannot be mistaken for a stale copy.
- **No `since` is the initial load:** the whole collection, every object
  `deleted: false` with its `ETag`, and a token to carry into the next call. The
  client caches nothing else (`docs/02` § Offline cache).
- **One entry per object, not per write.** A create and the update that followed
  it are one changed object with its current `ETag`; a create, an update and a
  delete between two tokens answer three entries, the last a tombstone.

### The token

`token` is opaque and the client never builds one: base64url of
`<calendars.id>:<n>`, where `<n>` is the number SabreDAV reported for the last
change the client saw — the same number `public.caldav_changes.sync_token` holds
(E03-R10), so E07 and the clients can read it as "changed up to". `since` is that
same string, verbatim.

`410` is the answer that means *reload fully*, and it is the fixed problem
document with nothing of the request in it. It is sent for all three of:

- a `since` that is not in the shape above at all (including an empty value);
- a token minted for **another calendar** — checked before CalDAV is asked, so a
  client-built string never reaches the service;
- a token whose number the collection **has never reached**.

That last check is the API's own, and it has to be: SabreDAV's PDO backend
accepts any numeric token (`CalDAV\Backend\PDO::getChangesForCalendar` only runs
`calendarchanges.synctoken >= n`) and echoes it back with an empty change set,
and it does not tie a token to a collection either. Trusting it would let a
client jump past every change between the collection's real position and the
invented one. So the request is answered by asking the collection for its own
current number — a `PROPFIND` of `{DAV:}sync-token` at depth 0, one round trip,
and only when the change set came back empty (`adapter.currentSyncToken`); a
request that has something to report never pays it — and a number beyond it is
the `410`. **That `PROPFIND` can only refuse a token; it never moves the
answer's.** The number an answer carries is the one the report itself returned,
computed by SabreDAV together with the changes: the report and the read are two
requests, and a write landing between them would otherwise hand the client a
position past a change the report never mentioned. A `403` **without** a `cf:`
precondition out of `sync-collection` is SabreDAV's `InvalidSyncToken` and
becomes the same `410`; every other CalDAV failure keeps its meaning, and a
CalDAV `401` stays the `502` of E03-R01.

### The `uid` of a change

For an object the collection holds, the `uid` is the `UID` **inside** the object
(`src/ical-rmw.mjs`'s `parse` and `describe`) — the `VEVENT` is the authority
(INV-01) — falling back to the object's name without `.ics` for something this
API cannot read.

A tombstone is reported by object name, so the name is all SabreDAV gives: this
API names an object it wrote `<uid>.ics`, and a name that is a UUIDv4 therefore
carries its own answer. A stock app (Phase 4) may name an object something else,
and then only the `caldav_changes` outbox knows which `uid` the removed object
held: `CalendarStore.deletedUidsBetween` reads the deleted rows of the window
`(since, token]` (a `SELECT` the API role already holds — no grant is widened),
and the entry is named from them **only when the window holds exactly one
deletion**. Two candidates, or none, leave that entry out of the answer rather
than guess: the client misses one `uid` and reloads fully, which is cheaper than
deleting the wrong event locally. Until Phase 4 no object has such a name, so the
outbox is never queried.

Who reads: every member — `owner`, `editor` and `viewer`. A caller who is not a
member, an id outside the canonical shape and an unknown calendar are all the
same `404`, exactly as in E05-R03 and E05-R04.

## Errors

Every error the API answers with is an **RFC 9457 problem document**:
```http
Content-Type: application/problem+json
```

```json
{
  "type": "https://flexcalendar.de/problems/not-found",
  "title": "Not found",
  "status": 404,
  "instance": "urn:uuid:6f1c0a2e-6a0e-4a2f-8a4b-1d3a5c7e9f01"
}
```

`src/problem.mjs` owns the table, and it is the only place a problem is built.
`type` is stable per kind — clients switch on it; `title` is fixed copy and may
be reworded; `status` is the HTTP status, always the same value in the body and
on the status line; `instance` is `urn:uuid:<the request correlation ID>`.

**Nothing in a body is derived from the request or from an exception.** No path,
no query value, no header, no validation message, no `pg` message, no CalDAV
body. Fastify's own framework refusals are here too: an over-long path parameter
(`FST_ERR_MAX_PARAM_LENGTH`, which never names anything this API minted) and a
URL that is not a URL (`FST_ERR_BAD_URL`) are answered by the `frameworkErrors`
handler in `src/app.mjs` as the fixed `not-found` and `bad-request` problems, not
with Fastify's default body — that one carries the request path.
Two extension members exist. `property` is the offending property name a
Private-skeleton write was refused for (`SUMMARY`, `X-CALFLEX-ENVELOPE-SHA256`,
`UNLISTED`), never its value — and only because the CalDAV adapter already
reduced it to that name (E03-R09). `current` is the representation the store
holds when a write lost a race (E05-R04), which is exactly what a `GET` of that
object answers with: the stored object, never the request that lost. A validation
failure is a `bad-request` with no `detail`; a `pg` unique violation never echoes
the e-mail address it names.

| `type` (after `/problems/`) | Status | Meaning |
|---|---|---|
| `bad-request` | 400 | A malformed or schema-refused request body |
| `unauthorized` | 401 | Missing, malformed, expired or unverifiable token |
| `forbidden` | 403 | The issuer reports the e-mail as unverified, or the caller is a member of the calendar but not its owner |
| `private-skeleton-only` | 403 | A Private write carried content; the `property` member names it |
| `unmapped-collection` | 403 | The collection has no `calendars` row |
| `not-found` | 404 | No such resource or path — or a calendar the caller is not a member of, which is deliberately the same answer (E03-R01); a path parameter over the router's limit is one too |
| `method-not-allowed` | 405 | The method is not allowed on the path; `Allow` names the ones that are |
| `conflict` | 409 | The handle or e-mail address is already taken, or the `UID` a create minted is already in the collection |
| `gone` | 410 | The resource is gone |
| `precondition-failed` | 412 | An `If-Match`/`If-None-Match` precondition failed, a stale calendar version or a stale event `ETag` included; an event write carries the current representation in `current` (E05-R04), or the `not-found` above when the object is gone |
| `payload-too-large` | 413 | The body exceeds the service's limit |
| `unsupported-media-type` | 415 | The body's media type is not accepted |
| `invalid-input` | 422 | Input refused by a write path's own rules (E05-R03, E05-R04): a member the operation does not take, a value it cannot write, a rule part RFC 5545 does not name, a `start`/`end` pair the RFC forbids, or a `PATCH` that names nothing — and by the occurrence window (E05-R05): a `from`/`to`/`tz` this API does not answer, or a query member the operation does not take |
| `window-too-large` | 422 | The occurrence window would answer more than 10 000 occurrences (E05-R05); the client narrows it, and there is no pagination |
| `too-many-instances` | 422 | The object's series has more instances than a calendar collection accepts (E03-R12): the CalDAV service refuses the write with RFC 4791 § 5.3.2.1's `403` `CALDAV:max-instances` over its 50 000 bound, and an event create or update reports it as this kind; the client shortens the series |
| `precondition-required` | 428 | A write carried no `If-Match`, so there is no version to be optimistic against (E05-R03, E05-R04) |
| `rate-limited` | 429 | Over `CALFLEX_RATE_LIMIT_MAX`; `Retry-After` is set |
| `internal-error` | 500 | Ours to fix; the body says nothing more |
| `bad-gateway` | 502 | CalDAV or the IdP could not be read; a CalDAV `401` included, which is never the caller's `401` — and an event object the API cannot describe (E05-R04), an occurrence object included (E05-R05) |
| `unavailable` | 503 | Not configured, or the IdP's keys are unusable |
| `upstream-timeout` | 504 | A CalDAV call ran past its deadline |

The table is also the status normaliser: an error thrown with a status that is
not in it is answered as the 400 (or 500) that the body names, so a status line
can never disagree with the body. `spec/openapi.yaml` declares the identical
`Problem` schema; `test/contract.test.mjs` keeps the two in step, including the
content type of every response.

## Logging

`CALFLEX_LOG_LEVEL` sets the level (default `info`). One structured line is
written per response, from fixed fields only:

```json
{"level":30,"time":1791733371292,"reqId":"8f14e45f-…","method":"GET",
 "route":"/me","status":200,"durationMs":3.37,"msg":"request"}
```

`route` is the route **template** (`request.routeOptions.url`), or `unmatched`
for a request no route matched, so a path parameter or a query value is never
logged. Fastify's own request/response lines and their serializers are disabled
(`logController`, and empty `req`/`res` serializers), because they log the URL,
the client address and, on an error, `error.message`.

- **Correlation IDs.** Every request gets a UUIDv4 (`crypto.randomUUID()`,
  INV-03). An inbound `X-Request-Id` is believed only when it is already exactly
  a lowercase v4 UUID; anything else is replaced, so a header cannot inject a
  log line. It is returned on **every** response as `X-Request-Id` — the 401s
  and 429s that never reach a route included — and the CalDAV adapter sends it
  to CalDAV (`adapter.forUser(id, { requestId: request.id })`).
- **Errors.** Handled errors are logged by name and, for `pg`, by the SQLSTATE
  `code` (`{"type":"Error","code":"23505"}`) — never `message`, never `stack`,
  because a `pg` message can name a row's values. A rejected request is logged
  at `warn`, an unexpected failure at `error`; the limiter's 429 is left to the
  request line.
- **CalDAV.** The internal listener logs one access line per request —
  `caldav request <METHOD> <status> <id>` — with the method reduced to a fixed
  allow-list (`OTHER` for anything else) and the ID it was given, plus the
  existing `delegation_denied`/`delegation_error` lines with that ID appended.
  No path, query or header value. `make test-caldav` and `make test-api-caldav`
  scan both services' logs for the suites' markers (`make check-log-canaries`).

### Tests

`node --test test/*.test.mjs`. The auth suite that needs no containers
(`test/auth.test.mjs`, `test/audience.test.mjs`, `test/contract.test.mjs`,
`test/health.test.mjs`, `test/rate-limit.test.mjs`) drives a real HTTP server
against the stub identity provider in `test/support/idp.mjs`, whose tokens are
signed by keys it serves as its own JWKS — never by Zitadel.
`test/rate-limit.test.mjs` uses `inject` with a counting verifier: it proves
the limiter's hook is counted before `verify` runs, that a new window resets
the bucket, and that `CALFLEX_TRUSTED_PROXY_HOPS` decides whether
`X-Forwarded-For` is believed — including that at one trusted hop it is the
**last** `X-Forwarded-For` entry that picks the bucket, so a forged first entry
cannot. `test/auth-db.test.mjs` needs the same rootless
Podman as the migration tests, and exercises `public.users` through
`test/support/postgres.mjs`.

The E05-R03 suites split the same way. `test/calendar-envelope.test.mjs` holds
the envelope's version byte, epoch, fixed fields, 4 KiB ceiling and encoding;
`test/allow.test.mjs` holds the `405` table; `test/calendars.test.mjs` drives
the four operations through the real app against the in-memory store in
`test/support/calendar-store.mjs` and a fake adapter — every `422` rule, the
UUIDv4 id and href (INV-03), `If-Match` (428/412 and a lost update), the roles,
the compensation in both failure orders, the `405` and the hostile-exception
canary. `test/calendars-db.test.mjs` needs Podman: it holds the create
transaction, its rollback, the committed-before-`MKCALENDAR` row, the version
and the cascade against the real schema.

The E05-R04 suites need nothing but Node either. `test/ical-rmw.test.mjs` is the
read-modify-write module against the round-trip corpus of E15-R01: a no-op patch
of **every** fixture, and then a patch of a known field per fixture whose
difference set is written out (a value-only `DTSTAMP` change is exactly one
violation, a `DTSTART` change one — two for a `TZID` fixture, which also loses
the zone parameter it names, or four for the Microsoft one, whose stored zone the
resolver cannot read and which is therefore patched on both times). Two
deliberately lossy and additive round trips are
there as the control, so the suite is not one that has only ever been seen to
pass. `test/events.test.mjs` drives the four routes through the real app against
the in-memory calendar store and the CalDAV double in
`test/support/caldav-store.mjs`, which runs the **Private write guard** of
E03-R09 on every `PUT` — so a `201` is also the claim that the object the API
builds is a skeleton the guard accepts. It covers the create refusals (one fixed
`422` each, none reaching CalDAV), the roles, the UUIDv4 `UID` (INV-03), the
`If-Match` (428/412 and a lost update), the guard's refusal mapped to
`private-skeleton-only`, a collection holding an object the API cannot describe,
a series over CalDAV's recurrence bound mapped to `too-many-instances` on both a
create and a patch (E03-R12), and a canary that reaches neither a body nor a log
line. A `TZID` event goes
through create, read and patch there too — its `VTIMEZONE` embedded once, the
definition kept when a later patch names the same zone, a second one embedded
when it names another — and the Microsoft fixture shows the stored zone that
cannot be resolved surviving a patch that leaves the times alone and refusing one
that moves it halfway.
`test/integration/events.test.mjs` (inside the stack, `make test-api-caldav`)
runs the same operations against the real CalDAV service: create, read back byte
for byte, a `412` with the current representation, a patch that bumps `SEQUENCE`
and keeps the envelope hash, a delete, the same `TZID` create/read/patch against
the **live** guard (which is where "the `VTIMEZONE` this API generates is one
E03-R09 accepts" is actually proved), the live guard refusing a content
write with the property named and the marker absent, and a series over the
service's recurrence bound answering the API's `422` with the live `403`
`CALDAV:max-instances` read from the adapter behind it (E03-R12).

The E05-R09 suite needs nothing but Node: `test/zones.test.mjs` reads the DST
table of E15-R02 from the file — never a copy of it — and checks every case of
every kind it may decide, with the `daily-skipped` family left to the
occurrences runner because it is a recurrence. It holds the resolver against the two families
`ical.js` reads wrongly by requiring the library to disagree there, so a resolver
built on the library would fail; it holds the generated `VTIMEZONE` against the
library (every day of 2026 and 2027 at noon, plus three hours either side of
every transition the table names) and against the guard's allow-list, read out of
`PrivateSkeleton.php`; it holds the name table to its own claims (sorted, unique,
every name resolvable, and `europe/berlin`, `W. Europe Standard Time` and
`Factory` refused); and it checks that neither the resolver nor the generator
registers a zone in `ical.js`'s global `TimezoneService`.

The E05-R08 suites need nothing but Node either. `test/changes.test.mjs` drives
the route through the real app against the in-memory calendar store, the outbox
rows of E03-R10 and the CalDAV double, whose `sync-collection` is modelled on
SabreDAV's own — a numeric token per collection, no binding to the collection it
came from, and an ahead number **accepted** — so "a token ahead of the collection
is 410" is an assertion about the API's own check and not about a double that is
stricter than the service. It covers the initial load, the token round trip, the
create/update/delete window, every malformed and foreign token, SabreDAV's own
refusal against a `403` that carries a precondition of ours, a write landing
between the report and the `PROPFIND` that follows an empty one (the
`beforeCurrentSyncToken` hook of the double, so the answer's token is the
report's and the next poll still returns the change), the roles and the same 404s
as the other routes, a tombstone that must not carry an `etag`, the outbox-named
`uid` and the ambiguous window that leaves the entry out, and a canary that
reaches neither a body nor a log line — with the initial load, a good token and a
refused one all sent, and neither the token, nor the `<calendar id>:<n>` it
decodes to, nor the SabreDAV token behind it in the captured log.
`test/integration/changes.test.mjs` (inside the stack, `make test-api-caldav`)
runs a create, an update and a delete between two tokens against the real CalDAV
service, asserts each kind of rejected token is a `410` — with the problem bodies
held to fixed assertions on `type`, `title`, `status` and `instance`, because the
`api-test` image installs production dependencies only and the spec-parsing
`test/support/problem.mjs` cannot be imported there — and pins the premise the
API's own check rests on: the live service accepts a token ahead of the
collection and echoes it. `test/integration-imports.test.mjs` reads the imports
of every stack suite, transitively, and fails on a bare specifier that is not a
production dependency: that is how a suite the `api-test` image cannot load is
caught in the unit suite instead of at `make test-api-caldav`.

The E05-R05 suites need nothing but Node either, except the last one.
`test/occurrences.test.mjs` is the expansion module on its own: the half-open
window at both edges and one second either side of them, a zero-length instance,
an all-day day placed by the requested zone's midnights in a zone ahead of UTC
and one behind it (and Berlin's 23-hour transition day), an unbounded weekly,
monthly and all-day rule, a `DTSTART` years before the window, a multi-day event
that starts before it, an `EXDATE` and an `RDATE`, the E15-R01 skeleton with its
override, an override moved into and out of the window, one whose
`RECURRENCE-ID` names nothing, the two rule families `ical.js` expands wrongly,
the bound that reports `too-many-instances`, the § 3.3.10 ruling's reading, the
sort order, determinism, and a canary that reaches the answer from nowhere. It
also holds the reading of an object that embeds its own `VTIMEZONE` to the same
answer as one that does not: `UNTIL` equal to, one second before and one second
after an instance in five zones, a `Z` `RDATE` and a `Z` `EXDATE` on a zoned
master, one in a spring gap, an `RDATE` that repeats a rule instance, one past
`UNTIL`, a floating master's override in a non-UTC viewing zone, an all-day
event and an all-day override placed by the requested zone's midnights rather
than UTC's, and the ICU-call count of an old daily series.
`test/occurrences-dst.test.mjs` is the API's runner for E15-R02's table: every
case read from the file, built with its zone's own `VTIMEZONE` so nothing is
resolved through the library, and compared with `expected` — with `view-zone`
also holding the viewer's wall clock, `all-day` holding the day's exact window,
and `daily-skipped` holding the owner's ruling on RFC 5545 § 3.3.10 (the gap
instance kept, counted, at the offset before the gap). `test/occurrences-corpus.test.mjs`
is the API's runner for E15-R03's corpus: all 34 fixtures through the module,
normalised to the golden's form and compared with E15-R03's own helpers, with the
two families `RULINGS.md` names left out and their ruling required to name
`vobject` as the correct engine. `test/occurrences-route.test.mjs` drives the
operation through the real app against the in-memory stores: every malformed
window as the one fixed `422` before the store or CalDAV is asked, the
whole-collection `calendar-query` with no `time-range`, the default zone, all
three roles, the `unsupported` answer, the `window-too-large` refusal and the
narrower window that fits, the 404s, the `405` with `Allow`, and a canary from a
hostile store, a hostile adapter and an unreadable object that reaches neither a
body nor a log line.
`test/integration/occurrences.test.mjs` (inside the stack, `make
test-api-caldav`) creates a Berlin weekly event and a UTC daily one across the
2026-10-25 fall-back through the API and asserts the window's instants and the
viewer's wall clocks, then takes an object the API itself wrote, adds the
`EXDATE` and the override `VEVENT` its own field set never writes, puts that
through the **live** guard and reads the window that covers the override. It
also reads a decade-long daily series whose 2026 window a `time-range` report
would fail, and a calendar that also holds an hourly series from 2020, which is
`unsupported` with `too-many-instances` while the rest of the calendar is
answered.

The E05-R10 suites also need nothing but Node. `test/problem.test.mjs` holds the
problem table, the status normaliser and the CalDAV mapping (hostile body
included); `test/logging.test.mjs` drives the real app with a captured log
stream and asserts that a canary in a path, a query, a header, a token, a JSON
body, a non-JSON body, an oversized body or an unknown route reaches neither a
log line nor a response body. `test/log-scan.test.mjs` runs the real
`make check-log-canaries` target on a clean file and on a file with each marker
planted, and holds the Makefile's `CALFLEX_API_REQUEST_ID` and the integration
suite's copy of it together.
`test/integration/caldav-adapter.test.mjs` (inside the stack, `make
test-api-caldav`) sends markers through the adapter into CalDAV — a content
property, envelope bytes and a request body — and asserts the refusals name the
property and never the value. `test/integration/calendars.test.mjs` (the same
target) runs the four operations against the real CalDAV service: the collection
exists with the display name `Private calendar`, a second user sees neither the
collection nor the row, a rename leaves the collection untouched, a delete
leaves it answering `404`, and a marker inside a refused `metaEnvelope` reaches
neither a body nor a log line.
