# E08 — Hosting, TLS, backups, observability, mail

| | |
|---|---|
| Phase | 1, then continuous |
| Status | Blocked on D-10, D-11 |
| Executor | `human` (accounts, DNS, money) + `agent` (config as code) |
| Depends on | E02 |
| Spec | `02` § Hosting, `05` risks 7, 8 and 11, CLAUDE.md risk 8 ("events lost = product dead") |

## Goal

A calendar that goes down makes people miss meetings, and one that loses data ends the product. Ops therefore starts in Phase 1, not Phase 6 (D-11).

## Requirements

### E08-R01 · Accounts and DNS   `human`
Create the VPS, DNS zone, Apple Developer account, Firebase project, SMTP provider and (Phase 5) KMS accounts. Put credentials in the secret store.

### E08-R02 · Production deploy as code   `agent`
`infra/prod/` MUST deploy Caddy (automatic ACME TLS on 443), the CalDAV service, the API, workers, the IdP and Postgres from one command, with secrets from the environment.
- Accept: a clean VPS reaches a working deployment with `make deploy ENV=staging`; SSL Labs grade A; HSTS on.

### E08-R03 · Staging environment   `agent`
A staging environment MUST mirror production on its own hostname, so device tests (E15) don't touch production data.

### E08-R04 · Backups from day one   `agent` + `human`
Postgres (CalDAV objects, sidecar, metadata) MUST be backed up with continuous WAL archiving plus nightly base backups to off-site object storage, encrypted and kept for 30 days.
- Accept: `human` signs off a **restore drill** into a fresh instance, with a documented RPO ≤ 5 min and RTO ≤ 1 h, before M1 and quarterly after that.
- Notes: Private calendar backups are ciphertext. They protect against our failures, not against user key loss (`04` Phase 6).

### E08-R05 · Observability   `agent`
Structured JSON logs, Prometheus metrics (request rate/latency/errors per service, poller lag, push failures, backup age), error reporting (Sentry or self-hosted GlitchTip) and uptime probes on `/.well-known/caldav` and the API health endpoint.
- Accept: alerts fire for backup age > 26 h, certificate expiry < 14 d, 5xx rate > 1 %, poller lag > 2 min; no event content is sent to the error reporter (scrubbing test).

### E08-R06 · Outbound mail   `agent` + `human`
SMTP relay (SES or Postmark) with SPF, DKIM and DMARC, used by invites, iMIP (E03-R06) and security notifications (E14).
- Accept: mail-tester score ≥ 9/10; `human` sets the DNS records.

### E08-R07 · Runbook   `agent`
`docs/runbook.md` MUST cover deploy, rollback, restore, certificate failure, secret rotation and "the CalDAV service is down".
