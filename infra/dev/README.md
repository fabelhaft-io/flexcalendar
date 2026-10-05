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
| `postgres` | `postgres:17-alpine` | every durable state, in one cluster (D-11): the `caldav` database and Zitadel's | internal, `postgres:5432` |
| `zitadel-api` | `ghcr.io/zitadel/zitadel:v4.16.0` | the identity provider: OIDC, JWT, the console (D-03, ADR 0004) | `https://auth.<domain>:<port>/` |
| `zitadel-login` | `ghcr.io/zitadel/zitadel-login:v4.16.0` | Zitadel v4's login UI, its own container | `https://auth.<domain>:<port>/ui/v2/login/` |
| `mailpit` | `axllent/mailpit:v1.31.4` | the SMTP sink invitations and mail land in (E03-R06, E05) | `https://mailpit.<domain>:<port>/`, SMTP on the internal `mailpit:1025` |
| `caldav` | built from [`server/caldav/`](../../server/caldav/) | the CalDAV service (D-02) | `https://caldav.<domain>:<port>/` |
| `api` | built from [`server/api/`](../../server/api/) | the REST facade for our own clients (D-01) | `https://api.<domain>:<port>/` |
| `caddy` | `caddy:2.11-alpine` | the only published port; terminates TLS with its local CA | — |
| `seed` | `node:24-alpine` | one-shot, profile `seed`: `make seed` | — |

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
- `zitadel-api` and `zitadel-login` run as uid 0 *inside* their containers, as
  upstream asks: they write the bootstrap tokens into a shared volume. Under
  rootless Podman that is the unprivileged user's subuid, not root on the host.

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
  (E03-R09, INV-01). That seeding belongs to E04.
- The password of the seeded users is `CALFLEX_SEED_PASSWORD`
  (`Password1!`), and the Zitadel admin is `CALFLEX_ZITADEL_ADMIN_USER` /
  `CALFLEX_ZITADEL_ADMIN_PASSWORD` in `.env.example` — both development-only.

This seed is the stack's own. It does not depend on the Phase 0 spike;
E01-R02's script and fixtures belong to the spike's Radicale server and to the
E15 corpus.

## Placeholders until their epics land

`caldav` and `api` run **skeletons**, so the stack, its URLs and its TLS are
real from day one:

| Container | Today | Replaced by |
|---|---|---|
| `caldav` (PHP 8.4, `php -S` in the image) | `GET /healthz` and `GET /` answer; every other method is a deliberate `501` | E03-R01 (SabreDAV, a real SAPI, `composer install`) |
| `api` (Node 24, Fastify) | `GET /healthz` and `GET /` answer; every other route is a `501` | E05-R01 (the REST facade over CalDAV) |

Neither skeleton touches Postgres, Zitadel or event data, and neither is asked
to: they exist so that Caddy's routing, the certificates and the URLs can be
exercised before the services arrive.

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
```
