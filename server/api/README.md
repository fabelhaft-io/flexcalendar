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
  It answers `GET /healthz` and `GET /me`, and nothing but the readiness probe
  is reachable without an access token.
- **OIDC bearer auth (E05-R01):** see [Authentication](#authentication). The
  service never decrypts and stores no event content.
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
body. The one extension member is `property`: the offending property name a
Private-skeleton write was refused for (`SUMMARY`, `X-CALFLEX-ENVELOPE-SHA256`,
`UNLISTED`), never its value — and only because the CalDAV adapter already
reduced it to that name (E03-R09). A validation failure is a `bad-request` with
no `detail`; a `pg` unique violation never echoes the e-mail address it names.

| `type` (after `/problems/`) | Status | Meaning |
|---|---|---|
| `bad-request` | 400 | A malformed or schema-refused request body |
| `unauthorized` | 401 | Missing, malformed, expired or unverifiable token |
| `forbidden` | 403 | The issuer reports the e-mail as unverified |
| `private-skeleton-only` | 403 | A Private write carried content; the `property` member names it |
| `unmapped-collection` | 403 | The collection has no `calendars` row |
| `not-found` | 404 | No such resource, path or method |
| `method-not-allowed` | 405 | The method is not allowed on the path |
| `conflict` | 409 | The handle or e-mail address is already taken |
| `gone` | 410 | The resource is gone |
| `precondition-failed` | 412 | An `If-Match`/`If-None-Match` precondition failed |
| `payload-too-large` | 413 | The body exceeds the service's limit |
| `unsupported-media-type` | 415 | The body's media type is not accepted |
| `invalid-input` | 422 | Input refused by a write path's own rules (E05-R04) |
| `rate-limited` | 429 | Over `CALFLEX_RATE_LIMIT_MAX`; `Retry-After` is set |
| `internal-error` | 500 | Ours to fix; the body says nothing more |
| `bad-gateway` | 502 | CalDAV or the IdP could not be read |
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
property and never the value.
