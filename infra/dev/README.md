# `infra/dev/` — the local stack

What `make dev` starts, and what `make seed` loads into it. Owned by
[E02-R03](../../docs/epics/E02-repo-tooling-ci.md); production deploy lives in
`infra/prod/` (E08).

```sh
make dev        # start the stack and wait until it is healthy
make seed       # load infra/dev/seed/ (idempotent; starts the stack if needed)
make dev-logs   # follow the logs
make dev-down   # stop it, keeping the volumes
make dev-reset  # stop it and delete the volumes (all local data)
```

## What runs

| Service | Image | Purpose | Reachable at |
|---|---|---|---|
| `postgres` | `postgres:18-alpine` | every durable state, in one cluster (D-11): the `caldav` database and Zitadel's | internal, `postgres:5432` |
| `zitadel-api` | `ghcr.io/zitadel/zitadel:v4.16.0` | the identity provider: OIDC, JWT, the console (D-03, ADR 0004) | `https://auth.<domain>:<port>/` |
| `zitadel-login` | `ghcr.io/zitadel/zitadel-login:v4.16.0` | Zitadel v4's login UI, its own container | `https://auth.<domain>:<port>/ui/v2/login/` |
| `mailpit` | `axllent/mailpit:v1.31.4` | the SMTP sink invitations and mail land in (E03-R06, E05) | `https://mailpit.<domain>:<port>/`, SMTP on the internal `mailpit:1025` |
| `caldav` | built from [`server/caldav/`](../../server/caldav/) | the CalDAV service (D-02); public host answers `401` except `/healthz` | `https://caldav.<domain>:<port>/` |
| `api` | built from [`server/api/`](../../server/api/) | the REST facade for our own clients (D-01) | `https://api.<domain>:<port>/` |
| `caddy` | `caddy:2.11-alpine` | the only published port; terminates TLS with its local CA | — |
| `seed` | `node:24-alpine` | one-shot, profile `seed`: `make seed` | — |
| `zitadel-config` | Node + pinned OpenTofu | one-shot apply/plan/token, profile `seed` (E02-R09) | — |

`<domain>` is `CALFLEX_DEV_DOMAIN` (`localhost`) and `<port>` is
`CALFLEX_HTTPS_PORT` (`8443`). `*.localhost` is reserved for loopback
(RFC 6761), so these names need no `/etc/hosts` entry. If a machine's resolver
ignores that (plain glibc without systemd-resolved), resolve them by hand:
`curl --resolve caldav.localhost:8443:127.0.0.1 …`.

[`infra/dev/.env.example`](.env.example) documents every setting; the compose
file carries the same defaults, so **`make dev` needs no `.env` at all**. Copy
it to `infra/dev/.env` to change one — that file is gitignored, and the values
in it are development placeholders, never secrets.

## Rootless, no sysctls

The stack runs under **rootless Podman** via `podman compose`, which hands the
file to the docker-compose binary over the user's Podman socket. There is no
Docker daemon, nothing runs as root on the host, and nothing writes a sysctl
(`docs/02-technology-choices.md` § Runtime layout):

- Caddy publishes one port, 8443 by default. Rootless containers cannot bind
  below 1024 without `net.ipv4.ip_unprivileged_port_start`, and the local stack
  changes no sysctls, so the local stack never uses 443. The container port
  stays 8443 whatever `CALFLEX_HTTPS_PORT` says: only the forwarding changes,
  and the host matchers in the Caddyfile ignore the port, so the URLs keep
  working.
- Every container has a memory limit (ADR 0004), Postgres included.
- Caddy issues every certificate from its own local CA. Nothing here talks to
  Let's Encrypt; the production Caddyfile pins `acme_ca` (E08).
- Only `zitadel-api` runs as uid 0 *inside* its container, and the reason is the
  bootstrap volume, not upstream: rootless Podman creates the
  `zitadel-bootstrap` volume owned by the container uid 0, and only that uid can
  create the two personal-access-token files in it on a fresh volume. Under
  rootless Podman that uid is the unprivileged user's subuid, not root on the
  host. Drop `user: "0"` from `zitadel-api` when a permission model that
  survives the bootstrap exists (E08).
- `zitadel-login` runs as its image's own user (`nextjs`, uid 1001). The core
  writes both PAT files mode 0644, so the login container reads
  `login-client.pat` from the read-only mount with no extra privilege and no
  error.

To trust the local CA on the host:

```sh
CA="$(podman volume inspect --format '{{.Mountpoint}}' calendar-flex-dev_caddy-data)"
curl --cacert "$CA/caddy/pki/authorities/local/root.crt" https://caldav.localhost:8443/
```

## The seed

`make seed` runs [`seed/seed.mjs`](seed/seed.mjs) inside the stack. It loads
[`seed/users.json`](seed/users.json) into Zitadel through its v1 Management API
and authenticates with a personal access token that Zitadel writes when the
instance is first created (the `calflex-seed` machine user configured in the
compose file, PAT in the shared volume). It needs no tooling on the host.

It reaches Zitadel through Caddy — the same TLS-terminating edge the developer
uses — on Caddy's **container** port, 8443, which does not move when
`CALFLEX_HTTPS_PORT` changes; it presents the *published* authority in the `Host`
header, because Zitadel resolves its instance from the request's Host. The two
are separate knobs (`CALFLEX_SEED_BASE_URL`, `CALFLEX_SEED_HOST`), so `make seed`
works whatever port the stack publishes. TLS is verified against Caddy's local
CA, mounted read-only into the one-shot container.

- **Idempotent.** A user whose email already exists is skipped, a lost race
  (`ALREADY_EXISTS`) counts as success, and a second `make seed` creates
  nothing.
- **Self-checking.** The run finishes by reading every seeded user back out of
  Zitadel and exits non-zero if one is missing, so "it loaded the seed" is not
  taken on trust.
- **Two test users**, `alice` and `bob` (`alice@example.test`,
  `bob@example.test`), so later requirements can seed calendars and events for
  them. Add more by editing `seed/users.json`.
- **No calendars or events yet.** Every calendar is Private until Phase 4
  (E04-R03), so seeded events are skeletons with no content properties
  (E03-R09, INV-01). Adding calendars and events to the seed belongs to later
  requirements.
- The password of the seeded users is `CALFLEX_SEED_PASSWORD`
  (`Development1!`), and the Zitadel admin is `CALFLEX_ZITADEL_ADMIN_USER` /
  `CALFLEX_ZITADEL_ADMIN_PASSWORD` in `.env.example` — both development-only.

This seed is the stack's own. It does not depend on the Phase 0 spike;
E01-R02's script and fixtures belong to the spike's Radicale server and to the
E15 corpus.

## The API and its audience

`api` runs the Fastify facade of E05-R01. `GET /healthz` answers without a
database, an IdP or a token; **every other route — unknown ones included —
needs `Authorization: Bearer <JWT>`** from Zitadel and is refused with `401`
without one. The only product route so far is `GET /me`, which maps the
token's `sub` to a `users` row and creates it on first sight from Zitadel's
userinfo (`handle` = `preferred_username`, `email` = `email`, both only when
`email_verified` is true). For the seeded users `preferred_username` is the
plain login name — `alice`, not `alice@example.test` — so a first `GET /me`
for `alice` answers `handle: "alice"`, `email: "alice@example.test"`.

Run `make migrate` before the first `GET /me`: `users` comes from the API's own
migrations (E04-R01) and `make dev` does not apply them. Without them the route
fails against a missing table instead of creating a row.

The audience such a token must carry is the Zitadel **project ID**, which only
`zitadel-config apply` knows. It therefore travels through the named volume
`oidc-config`: `apply` writes the ID into `/oidc/audience` (atomically, mode
0644) and `api` mounts the same volume read-only and reads the trimmed first
line. Until `make seed` has run, every protected request is `503` — never
accepted — and the API picks the file up without a restart once it appears.
`CALFLEX_OIDC_AUDIENCE` overrides the file when set.

An IdP outage does not lock the API out: validated keys are cached for ten
minutes, and a rotated key is picked up from the JWKS without a restart.

A token from `make token USER=alice` is a real access token whose Zitadel
session lives for five minutes, so send the first-sight request for a subject
that has no row yet inside that window; a subject that already has a `users`
row never calls userinfo at all. See
[the Zitadel configuration](../zitadel/README.md) for what the helper does.

## Checking this directory

```sh
make check-stack   # static: the definition of the stack, no runtime needed
make test-seed     # the seed program, against a stub Zitadel, no containers
```

`make check-stack` is the part of this directory that CI can run: it checks
that the stack contains every component the requirement names, that nothing
needs root, a daemon or a sysctl, that every published port is above 1024, that
every container has a memory limit, that `.env.example` documents every
variable the compose file interpolates, that the Caddyfile's upstreams are
compose services on the ports they expose, and that the Makefile keeps the
entry points the acceptance criteria name. `make test-seed` covers the seed's
payloads, its idempotency and its read-back check.

What neither can cover — a running stack — has to be run by a human with
rootless Podman:

```sh
make dev
curl --cacert "$(podman volume inspect --format '{{.Mountpoint}}' calendar-flex-dev_caddy-data)/caddy/pki/authorities/local/root.crt" \
     https://caldav.localhost:8443/healthz
curl … https://api.localhost:8443/healthz
make seed && make seed     # the second run must create nothing

# With a seeded stack, prove the audience handshake end to end:
make migrate              # `users` exists only after the API's migrations
TOKEN=$(make token USER=alice)
curl --cacert "$(podman volume inspect --format '{{.Mountpoint}}' calendar-flex-dev_caddy-data)/caddy/pki/authorities/local/root.crt" \
     -H "Authorization: Bearer $TOKEN" https://api.localhost:8443/me
# → 200 with { id, handle, email }; a second call must not create a second row.
# A garbage token → 401. Before `make seed` → 503.

E02-R09 adds a containerized OpenTofu apply after the user seed, and a separate
non-production token helper. See [the configuration and review protocol](../zitadel/README.md).

## API-owned migrations (E04-R01)

Run `make migrate` to start only Postgres and apply pending migrations through
`node-pg-migrate` 9.0.0 in the API image. Repeating it is a no-op. Optionally
set `CALFLEX_MIGRATE_DATABASE_URL` in the environment; never log that URL.
`make migrate-down` reverses one migration and **destroys its data**; this is
for development only. Production rollback is a backup restore (E08-R04).

PostgreSQL 18 stores data under `/var/lib/postgresql/18/docker`; the volume
mount is `/var/lib/postgresql`. A volume created by 17 needs `make dev-reset`
(**deletes all local data**) before starting 18; this is not an upgrade tool.
Existing PostgreSQL 18 volumes from before E04-R02 also need `make dev-reset`
to run `postgres/initdb/20-roles.sql`. Changing a password variable does not
change an existing role: the bootstrap runs only on an empty volume.

The bootstrap creates three plain LOGIN roles (no superuser, CREATEDB or
CREATEROLE). `calflex_migrate` owns the database and the `public` and `sabredav`
schemas and runs migrations without CREATEROLE. The API uses `calflex_api`
(public-table DML except audit INSERT/SELECT only, `caldav_changes` SELECT
only, no `delegation_nonces` or SabreDAV access); CalDAV uses
`calflex_caldav` (SabreDAV DML, outbox/replay-store DML, membership reads and
only `device_credentials.last_used_at` updates). Their dev-only passwords are
`CALFLEX_MIGRATE_PASSWORD`, `CALFLEX_API_PASSWORD`, and
`CALFLEX_CALDAV_PASSWORD`; defaults are in `.env.example`. URI-encode passwords
in connection URLs. Roles are provisioned by bootstrap, never migrations.
Zitadel and its configuration runner still use the separate `zitadel` database
and the bootstrap login locally, a superuser. A role of its own is E08-R10 (an
evaluation of the options first, then the implementation).

E04-R02 stores calendar metadata opaquely and creates no name/colour columns.
The metadata-envelope check requires it exactly for Private calendars. The
text mode column deliberately waits for E04-R03's enum/private-only check;
these database tables are not a mode-creating API. Reserved credentials and
feed/push tables have no Phase 1 writer. Audit details must contain operational
metadata only, never event content or envelope bytes.

Schema changes belong only in `server/api/migrations/<unix-ms>_<slug>.mjs`
(or `.sql` with Up/Down Migration sections). Every migration must have a down,
or export `down = false` with a comment explaining why. SabreDAV's two SQL
scripts are pristine upstream copies in `server/api/sabredav/`; their record
pins the tag, commit, URLs and hashes. Never format or edit the vendored SQL.
Only calendars and property storage are imported, into `sabredav`; no default
admin account, users, principals, addressbooks or locks are imported.

`make verify` runs API component tests against their own disposable Postgres 18
container, independent of the local stack. From the first production release,
CI must also migrate a copy of the last released schema (E08 follow-up).

### Delegated CalDAV (E03-R01)

`caldav:8080` is the public denial/liveness listener. The API uses
`http://caldav-internal:8081` on the dedicated `delegation` network, bound to
`172.30.91.2` (subnet `172.30.91.0/24`). If that subnet conflicts with your local
networks, update both Compose IPAM/static address and `server/caldav/Caddyfile`
and the structural checks together. Never publish 8081 or route it via Caddy.
`CALFLEX_DELEGATION_KEYS` has a development-only default; production injects
rotatable keys from the secret store, never reuses this value.

`make test-caldav` applies migrations and runs the profile `test` service built
from the PHPUnit image stage, then checks CalDAV logs for leakage. Run twice
against the local stack; `composer test` intentionally runs host unit tests only.
