# E08 — Hosting, TLS, backups, observability, mail

| | |
|---|---|
| Phase | 1, then continuous. R06 (mail) in Phase 4; the KMS part of R01 and R09 in Phase 7 |
| Status | Ready: R01 (`human`: VPS and DNS). R02 onwards blocked on E02 |
| Executor | `human` (accounts, DNS, money) + `agent` (config as code) |
| Depends on | E02 |
| Spec | `02` § Hosting (sizing, runtime layout, backups), `05` risks 7, 8 and 11, CLAUDE.md risk 8 ("events lost = product dead") |

## Goal

A calendar that goes down makes people miss meetings, and one that loses data ends the product. Ops therefore starts in Phase 1, not in the polish phase (D-11).

## Requirements

### E08-R01 · Accounts and DNS   `human`
Create the VPS and DNS zone (Phase 1); the Firebase project, SMTP provider and Apple Developer account (Phase 4, the last for `.mobileconfig` signing); and the KMS account (Phase 7). Put credentials in the secret store.
- Progress (2026-10-04): domain `flexcalendar.de` registered, DNS at IONOS, CAA limited to Let's Encrypt with no wildcards; production VPS up at 2.28.77.197, with `api`, `auth` and `caldav` A records pointing at it. Still open for Phase 1: the two backup buckets, the staging Primary IP and its DNS records, SSH hardening (key-only login for `deploy`, no root login, no passwords), opening ports 80 and 443, and the rootless Podman host setup from R02.
- Notes: production is one 4 GB host without Hetzner server backups (`02` § Sizing and cost, ADR 0004). Order whichever 4 GB line Hetzner has cheapest and available (CPX22, or CAX11 if the cost-optimised lines return); the stack is arch-neutral. Staging is not ordered by hand; R03 creates it on demand. Also create the two backup buckets for R04, at two pay-per-GB providers, neither of them Hetzner.

### E08-R02 · Production deploy as code   `agent`
`infra/prod/` MUST deploy Caddy (automatic ACME TLS on 443), the CalDAV service, the API, workers, the IdP and Postgres from one command, with secrets from the environment. The deployment is a Compose file run by rootless Podman as the `deploy` user, under a systemd user unit, with images built in CI and pinned by digest; no Docker daemon and no Kubernetes (`02` § Runtime layout).
- Accept: a clean VPS reaches a working deployment with `make deploy ENV=staging`; SSL Labs grade A; HSTS on.
- Accept: the Caddyfile pins `acme_ca https://acme-v02.api.letsencrypt.org/directory` as a global option, so no other CA is ever tried (the CAA records for `flexcalendar.de` allow only Let's Encrypt, `02` § Hosting); a CI check fails on a deployable Caddyfile without the pin, or with a wildcard site address.
- Accept: host setup is code and idempotent: it sets `net.ipv4.ip_unprivileged_port_start=80`, enables linger for `deploy`, and installs the systemd user unit; after a reboot the stack comes back without anyone logging in; `podman info` as `deploy` shows the memory controller, and a container's memory limit is enforced; Caddy logs the real client IP, not a gateway address.
- Accept: the host accepts SSH by key only, for the `deploy` user only; the firewall opens 22, 80 and 443 and nothing else; Postgres and the internal CalDAV listener (D-05) are not reachable from outside.

### E08-R03 · Staging environment   `agent`
A staging environment MUST mirror production on its own hostname, so device tests (E15) don't touch production data. It is created on demand and deleted after use (ADR 0004), not run permanently.
- Accept: `make staging-up` builds staging from a blank VPS, with the IdP configuration and seed data applied from code, and `make staging-down` deletes the VPS; a CI job can run both around an integration test run.
- Notes: staging gets a reserved Hetzner Primary IP (about €0.50/month) that survives `staging-down`, so its DNS records under `staging.flexcalendar.de` never change and no DNS API is needed. Each fresh staging VPS requests new certificates, and Let's Encrypt allows only 5 certificates for the same set of names per 7 days. `staging-up` therefore either restores Caddy's certificate storage from the previous run or issues one certificate per hostname, and `staging-down` saves it.

### E08-R04 · Backups from day one   `agent` + `human`
Postgres (CalDAV objects, sidecar, metadata, and the IdP's database) MUST be backed up with pgBackRest: continuous WAL archiving with `archive_timeout = 60s` plus nightly backups, encrypted client-side and kept for 30 days, in **two repositories at two providers**. Both repositories are pay-per-GB EU object stores at two providers other than Hetzner (ADR 0004), with Object Lock and host credentials that can write but not delete. The details are in `02` § Backups and recovery.
- Accept:
  - archiving to both repositories is continuous, and `pgbackrest check` passes for each;
  - deleting a backup with the host's credentials fails in both repositories;
  - a weekly automated job restores the latest backup into a throwaway instance, runs `pg_amcheck`, row counts and a sample CalDAV `GET`, then destroys the instance. It never restores into staging;
  - `human` signs off a **restore drill** that starts from a blank VPS (there are no server backups to shortcut it), with a documented RPO ≤ 5 min and RTO ≤ 1 h, before M1 and quarterly after that.
- Notes: Private calendar backups are ciphertext. They protect against our failures, not against user key loss (`04` Phase 1). Before Phase 7 there is no escrow, so this matters from M1. The secrets outside Postgres (`02` § Backups and recovery) are backed up through the secret store, not here. Hetzner server backups are not used (ADR 0004).

### E08-R05 · Observability   `agent`
Structured JSON logs, Prometheus metrics (request rate/latency/errors per service, poller lag, push failures, backup age), error reporting (Sentry or self-hosted GlitchTip) and uptime probes on `/.well-known/caldav` and the API health endpoint.
- Accept: alerts fire for backup age > 26 h, WAL archive lag > 5 min, last successful restore check > 8 d, certificate expiry < 14 d, 5xx rate > 1 %, poller lag > 2 min, host memory available < 10 % for 10 min (the host is 4 GB, ADR 0004); no event content is sent to the error reporter (scrubbing test).

### E08-R06 · Outbound mail   `agent` + `human`
SMTP relay (SES or Postmark) with SPF, DKIM and DMARC, used by invites, iMIP (E03-R06) and security notifications (E14).
- Accept: mail-tester score ≥ 9/10; `human` sets the DNS records.

### E08-R07 · Runbook   `agent`
`docs/runbook.md` MUST cover deploy, rollback, restore, certificate failure, secret rotation, the IdP upgrade (R08) and "the CalDAV service is down".

### E08-R08 · IdP upgrade cadence   `agent`
Zitadel (D-03, ADR 0004) ships a major release about every quarter, each supported for roughly six months, with security fixes backported as needed (`02` § Runtime layout). Production MUST run a supported major, and MUST pick up patch releases within 14 days. The instance configuration (organisation, project, app registrations with JWT access tokens, login and password policies, self-registration off) MUST live in the repository as code with the Zitadel Terraform provider and be applied on deploy. No custom actions that hold logic, and branding by settings only.
- Accept: a CI job fails when the deployed major is within 30 days of its end of support, or a patch release is more than 14 days old and not deployed; an upgrade is rehearsed on staging, including sign-in from the Android app, before production; tearing down staging's IdP and re-applying the configuration from code gives an identical instance; a deploy check fails if the login UI container is missing or `/ui/v2/login` does not answer.

### E08-R09 · KMS key protection (Phase 7)   `human` + `agent`
The Tier 1 escrow key (D-10, E14-R01) MUST be protected against deletion and loss. An IAM policy denies `ScheduleKeyDeletion` and `DisableKey` to every principal except a break-glass role. The deletion waiting period is set to 30 days. A multi-Region replica key in a second EU region is created, or its absence is recorded as an accepted risk.
- Accept: a test with the release service's role and the deploy role shows that both are denied deletion; a CloudTrail alert fires on any `ScheduleKeyDeletion` attempt.
- Notes: losing this key loses every Tier 1 escrow copy, and no Postgres backup can restore them.
