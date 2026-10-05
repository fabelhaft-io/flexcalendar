# E08 — Hosting, TLS, backups, observability, mail

| | |
|---|---|
| Phase | 1, then continuous. R06 (mail) in Phase 4; the KMS part of R01 and R09 in Phase 7; error reporting in Phase 8 (`04`) |
| Status | R01 in progress (`human`). R02 waits for E02-R03, E02-R06 and E02-R09; R03 for R02; R04 for R02 and R01's buckets; R05 for R02; R07 for R02–R05 |
| Executor | `human` (accounts, DNS, money) + `agent` (config as code) |
| Depends on | E02-R03, E02-R06, E02-R09; D-10, D-11, D-19, D-20 |
| Spec | `02` § Hosting (sizing, runtime layout, backups), `05` risks 7, 8 and 11, CLAUDE.md risk 8 ("events lost = product dead") |

## Goal

A calendar that goes down makes people miss meetings, and one that loses data ends the product. Ops therefore starts in Phase 1, not in the polish phase (D-11).

## Who runs what

Agents write the code. They never deploy and never call a cloud API (`agent-team/src/prompts/guardrails.md`). Acceptance criteria that need real infrastructure (a fresh VPS, staging, the backup buckets, SSL Labs) are executed by the coordinator **against staging only**, using the secrets from the password manager. The results are recorded in `docs/reviews/<ID>.md` (D-20). Production deploys, and anything touching production data, are done by the owner.

## Requirements

### E08-R01 · Accounts and DNS   `human`
Create the VPS and DNS zone (Phase 1); the Firebase project, SMTP provider and Apple Developer account (Phase 4, the last for `.mobileconfig` signing); and the KMS account (Phase 7). Put credentials in the secret store: a password manager with a CLI (D-19). Name it in the runbook (R07).
- Progress (2026-10-04): domain `flexcalendar.de` registered, DNS at IONOS, CAA limited to Let's Encrypt with no wildcards; production VPS up at 2.28.77.197, with `api`, `auth` and `caldav` A records pointing at it. Still open for Phase 1: the two backup buckets, the staging Primary IP and its DNS records, SSH hardening (key-only login for `deploy`, no root login, no passwords), opening ports 80 and 443, and the rootless Podman host setup from R02. Also for Phase 1: an ntfy topic for alerts, and an account at a hosted uptime-probe service that notifies it (D-19, R05).
- Notes: production is one 4 GB host without Hetzner server backups (`02` § Sizing and cost, ADR 0004). Order whichever 4 GB line Hetzner has cheapest and available (CPX22, or CAX11 if the cost-optimised lines return); the stack is arch-neutral. Staging is not ordered by hand; R03 creates it on demand. Also create the two backup buckets for R04, at two pay-per-GB providers, neither of them Hetzner.

### E08-R02 · Production deploy as code   `agent`
`infra/prod/` MUST deploy Caddy (automatic ACME TLS on 443), the CalDAV service, the API, workers, Zitadel with its login UI, and PostgreSQL 18 from one command, using the services that exist when it runs. The deployment is a Compose file run by rootless Podman as the `deploy` user, under a systemd user unit; no Docker daemon and no Kubernetes (`02` § Runtime layout).
- **Images** are built in CI (E02-R06), pushed to GHCR and pinned by digest (D-19). The host pulls them with a read-only token.
- **Secrets** come from the environment only. `make deploy` reads them through the password manager's CLI, so no secret file is written to the repo or left on the person's disk. `infra/prod/.env.example` lists every variable.
- **Zitadel** is configured by applying the E02-R09 OpenTofu code.
- Accept, executed by the coordinator on staging (D-20): a clean VPS reaches a working deployment with `make deploy ENV=staging`; SSL Labs grade A; HSTS on.
- Accept: the Caddyfile pins `acme_ca https://acme-v02.api.letsencrypt.org/directory` as a global option, so no other CA is ever tried (the CAA records for `flexcalendar.de` allow only Let's Encrypt, `02` § Hosting); a CI check fails on a deployable Caddyfile without the pin, or with a wildcard site address.
- Accept, on staging: host setup is code and idempotent: it sets `net.ipv4.ip_unprivileged_port_start=80`, enables linger for `deploy`, and installs the systemd user unit; after a reboot the stack comes back without anyone logging in; `podman info` as `deploy` shows the memory controller, and a container's memory limit is enforced; Caddy logs the real client IP, not a gateway address.
- Accept, on staging: the host accepts SSH by key only, for the `deploy` user only; the firewall opens 22, 80 and 443 and nothing else; Postgres and the internal CalDAV listener (D-05) are not reachable from outside.

### E08-R03 · Staging environment   `agent`
A staging environment MUST mirror production on its own hostname, so device tests (E15) don't touch production data. It is created on demand and deleted after use (ADR 0004), not run permanently.
- Accept, executed by the coordinator (D-20): `make staging-up` builds staging from a blank VPS, with the IdP configuration (E02-R09) and seed data applied from code, and `make staging-down` deletes the VPS; a CI job can run both around an integration test run.
- Deps: E08-R02.
- Notes: the Hetzner API token is in the password manager and, for the CI job, in a GitHub Actions secret. Staging gets a reserved Hetzner Primary IP (about €0.50/month) that survives `staging-down`, so its DNS records under `staging.flexcalendar.de` never change and no DNS API is needed. Each fresh staging VPS requests new certificates, and Let's Encrypt allows only 5 certificates for the same set of names per 7 days. `staging-up` therefore either restores Caddy's certificate storage from the previous run or issues one certificate per hostname, and `staging-down` saves it.

### E08-R04 · Backups from day one   `agent` + `human`
Postgres (CalDAV objects, sidecar, metadata, and the IdP's database) MUST be backed up with pgBackRest: continuous WAL archiving with `archive_timeout = 60s` plus nightly backups, encrypted client-side and kept for 30 days, in **two repositories at two providers**. Both repositories are pay-per-GB EU object stores at two providers other than Hetzner (ADR 0004), with Object Lock and host credentials that can write but not delete. The details are in `02` § Backups and recovery.
- Accept, executed by the coordinator against staging and the real buckets (D-20):
  - archiving to both repositories is continuous, and `pgbackrest check` passes for each;
  - deleting a backup with the host's credentials fails in both repositories;
  - a weekly automated job restores the latest backup into a throwaway instance, runs `pg_amcheck`, row counts and a sample CalDAV `GET`, then destroys the instance. It never restores into staging;
  - `human` signs off a **restore drill** that starts from a blank VPS (there are no server backups to shortcut it), with a documented RPO ≤ 5 min and RTO ≤ 1 h, before M1 and quarterly after that.
- Deps: E08-R02; the buckets from R01.
- Notes: staging archives to its own pgBackRest stanza under its own prefix, with its own credentials, so a staging check never reads or writes production's backups.
- Notes: Private calendar backups are ciphertext. They protect against our failures, not against user key loss (`04` Phase 1). Before Phase 7 there is no escrow, so this matters from M1. The secrets outside Postgres (`02` § Backups and recovery) are backed up through the secret store, not here. Hetzner server backups are not used (ADR 0004).

### E08-R05 · Observability   `agent`
Phase 1 needs:
- structured JSON logs;
- Prometheus metrics: request rate, latency and errors per service, and backup age; poller lag and push failures from Phase 4;
- Alertmanager delivering to an **ntfy** topic (D-19), because there is no SMTP before Phase 4;
- uptime probes on the API health endpoint and, from Phase 4, `/.well-known/caldav`. The probes run from a hosted service outside our host, so they still fire when the host is down, and notify the same ntfy topic.

Every monitoring container has a memory limit that fits the 4 GB budget (ADR 0004). An error reporter is not part of Phase 1: `04` puts "error reporting with content scrubbing" in Phase 8.
- Accept: `promtool test rules` proves that alerts fire for each of these, and stay quiet just below the threshold:
  - backup age > 26 h;
  - WAL archive lag > 5 min;
  - last successful restore check > 8 d;
  - certificate expiry < 14 d;
  - 5xx rate > 1 %;
  - host memory available < 10 % for 10 min (the host is 4 GB, ADR 0004);
  - from Phase 4, poller lag > 2 min.
- Accept: on staging, the coordinator sees a test alert and a probe failure arrive at the ntfy topic (D-20).
- Accept: no log line contains event content (E05-R10's marker scan also runs over the shipped logs).
- Deps: E08-R02.

### E08-R06 · Outbound mail   `agent` + `human`
SMTP relay (SES or Postmark) with SPF, DKIM and DMARC, used by invites, iMIP (E03-R06) and security notifications (E14).
- Accept: mail-tester score ≥ 9/10; `human` sets the DNS records.

### E08-R07 · Runbook   `agent`
`docs/runbook.md` MUST cover deploy, rollback, restore, certificate failure, secret rotation (including the D-05 delegation keys), the IdP upgrade (R08), "the CalDAV service is down", and where alerts arrive (ntfy) and who receives them. It names the password manager that holds the secrets (D-19).
- Deps: E08-R02, E08-R04, E08-R05.

### E08-R08 · IdP upgrade cadence   `agent`
Zitadel (D-03, ADR 0004) ships a major release about every quarter, each supported for roughly six months, with security fixes backported as needed (`02` § Runtime layout). Production MUST run a supported major, and MUST pick up patch releases within 14 days. The instance configuration is code since E02-R09 and is re-applied on every upgrade.
- Accept: a CI job fails when the deployed major is within 30 days of its end of support, or when a patch release is more than 14 days old and not deployed.
- Accept: a deploy check fails if the login UI container is missing or `/ui/v2/login` does not answer.
- Accept: the coordinator rehearses an upgrade on staging before production (D-20). Sign-in is checked with `make token`, and from Phase 3 also from the Android app.
- Deps: E02-R09, E08-R03.

### E08-R09 · KMS key protection (Phase 7)   `human` + `agent`
The Tier 1 escrow key (D-10, E14-R01) MUST be protected against deletion and loss. An IAM policy denies `ScheduleKeyDeletion` and `DisableKey` to every principal except a break-glass role. The deletion waiting period is set to 30 days. A multi-Region replica key in a second EU region is created, or its absence is recorded as an accepted risk.
- Accept: a test with the release service's role and the deploy role shows that both are denied deletion; a CloudTrail alert fires on any `ScheduleKeyDeletion` attempt.
- Notes: losing this key loses every Tier 1 escrow copy, and no Postgres backup can restore them.
