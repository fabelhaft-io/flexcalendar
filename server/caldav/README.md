# `server/caldav/` — CalDAV service

The production CalDAV (RFC 4791) server, and the source of truth for every
event (CLAUDE.md). Stock calendar apps talk to this service directly.

- **Owning epic:** [E03 — CalDAV service](../../docs/epics/E03-caldav-service.md).
- **What belongs here:** the PHP 8.4 service that embeds **SabreDAV 4.7+** as a
  library, with Composer for dependencies and Postgres through PDO as the
  storage backend (D-02, `docs/02-technology-choices.md`). Our code lives in
  SabreDAV plugins and backends — never patch vendor code, so an upstream
  release stays a Composer bump. Custom auth (D-04 per-device app passwords,
  D-05 delegated principal), the mode-aware write guard and the change outbox
  are built as plugins and backends here.
- **Related epics:** [E04](../../docs/epics/E04-data-model.md) owns the Postgres
  schema; [E06](../../docs/epics/E06-sharing-feeds-onboarding.md) adds sharing,
  feeds and onboarding on top of this service.
- **Not here:** client code, and any content-crypto dependency — the service
  never decrypts (INV-07).
- The Phase 0 Radicale spike lives in
  [`infra/spike/`](../../infra/README.md), not here.
