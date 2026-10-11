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
  service never decrypts and stores no event content, and it logs nothing yet:
  no token, header, claim or userinfo field reaches a log line, an error
  message or a response body.
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
  with `Retry-After` and the fixed body `{"error":"rate_limited"}` — no
  counter, address or key. The API's error handler passes that body through
  instead of `request_failed`. `GET`/`HEAD /healthz` is allow-listed, so a
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
- **Refusals.** Every authentication failure is the same 401: fixed body
  `{"error":"unauthorized"}`, `WWW-Authenticate: Bearer`, `Cache-Control:
  no-store`, and no reason code anywhere. A userinfo failure is 502, an
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
| `CALFLEX_RATE_LIMIT_MAX` | Requests allowed per client address and window. Whole number ≥ 1, default `300`. |
| `CALFLEX_RATE_LIMIT_WINDOW_SECONDS` | Length of the rate-limit window. Whole number ≥ 1, default `60`. |
| `CALFLEX_TRUSTED_PROXY_HOPS` | How many proxies sit in front of the API, i.e. how many `X-Forwarded-For` hops are believed. Whole number ≥ 0, default `0` — the socket address is the client and `X-Forwarded-For` is ignored. `1` behind Caddy (the local stack sets it). Set too high, a client picks its own bucket with a header; left at `0` behind the proxy, every client shares Caddy's bucket. |

A rate-limit or proxy-hop value that is not a whole number at or above its
floor stops the service at startup instead of falling back to a default.

`GET /healthz` touches none of them and stays database-free.

### Tests

`node --test test/*.test.mjs`. The auth suite that needs no containers
(`test/auth.test.mjs`, `test/audience.test.mjs`, `test/contract.test.mjs`,
`test/health.test.mjs`, `test/rate-limit.test.mjs`) drives a real HTTP server
against the stub identity provider in `test/support/idp.mjs`, whose tokens are
signed by keys it serves as its own JWKS — never by Zitadel.
`test/rate-limit.test.mjs` uses `inject` with a counting verifier: it proves
the limiter's hook is counted before `verify` runs, that a new window resets
the bucket, and that `CALFLEX_TRUSTED_PROXY_HOPS` decides whether
`X-Forwarded-For` is believed. `test/auth-db.test.mjs` needs the same rootless
Podman as the migration tests, and exercises `public.users` through
`test/support/postgres.mjs`.
