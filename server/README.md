# `server/` — server-side services

Backend services, one directory per deployable service. There is no client code
here, and neither service links a content-crypto library: the server never
decrypts (INV-07, `docs/06-implementation-backlog.md`).

| Directory | What belongs there | Owning epic |
|---|---|---|
| `caldav/` | PHP 8.4 + SabreDAV 4.7+ CalDAV service, Composer, Postgres PDO backend (D-02) | [E03](../docs/epics/E03-caldav-service.md); storage schema in [E04](../docs/epics/E04-data-model.md) |
| `api/` | Node 24 LTS + TypeScript + Fastify REST facade over CalDAV (D-01) | [E05](../docs/epics/E05-api-core.md); push fan-out in [E07](../docs/epics/E07-change-fanout.md) |

Each service keeps its own dependency manifest (`composer.json` / `package.json`).
The layout itself is owned by [E02-R01](../docs/epics/E02-repo-tooling-ci.md) and
fixed by D-09; changing it needs an amendment to that decision.
