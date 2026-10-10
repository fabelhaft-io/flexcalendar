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
  [`Dockerfile`](Dockerfile) here and runs [`src/server.mjs`](src/server.mjs),
  a skeleton that answers `GET /healthz` and `GET /` and returns `501`
  everywhere else. It touches no database, no Zitadel endpoint and no event
  data; E05-R01 replaces it with the real service.
- **Toolchain pins**
  ([E02-R02](../../docs/epics/E02-repo-tooling-ci.md)): this package's
  [`package.json`](package.json) pins Node 24 through `engines`, and the
  workspace root requires Node 24 from 24.17.0 on (`.nvmrc` installs the
  newest Node 24; `devEngines` accepts any 24.x from 24.17.0) and pins pnpm
  (`packageManager`, via corepack). Add dependencies with
  `corepack pnpm add --filter @calendar-flex/api …` so `pnpm-lock.yaml` stays the
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
- **Not here:** CalDAV storage (that is `../caldav/`) and any client code.
