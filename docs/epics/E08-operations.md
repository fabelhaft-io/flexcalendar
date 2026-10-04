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
- Notes: production is an 8 GB host, staging 4 GB (`02` § Sizing and cost). Order whichever 8 GB line Hetzner has available (CPX32, or CAX21 if the cost-optimised lines return); the stack is arch-neutral. Also create the two backup buckets for R04, at two different providers.

### E08-R02 · Production deploy as code   `agent`
`infra/prod/` MUST deploy Caddy (automatic ACME TLS on 443), the CalDAV service, the API, workers, the IdP and Postgres from one command, with secrets from the environment. The deployment is Docker Compose with images built in CI and pinned by digest; no Kubernetes (`02` § Runtime layout).
- Accept: a clean VPS reaches a working deployment with `make deploy ENV=staging`; SSL Labs grade A; HSTS on.

### E08-R03 · Staging environment   `agent`
A staging environment MUST mirror production on its own hostname, so device tests (E15) don't touch production data.

### E08-R04 · Backups from day one   `agent` + `human`
Postgres (CalDAV objects, sidecar, metadata, and the IdP's database) MUST be backed up with pgBackRest: continuous WAL archiving with `archive_timeout = 60s` plus nightly backups, encrypted client-side and kept for 30 days, in **two repositories at two providers**. Repository 1 is Hetzner Object Storage in a different location from the server, with Object Lock. Repository 2 is a second EU object store whose credentials can write but not delete. The details are in `02` § Backups and recovery.
- Accept:
  - archiving to both repositories is continuous, and `pgbackrest check` passes for each;
  - deleting a backup with the host's credentials fails in both repositories;
  - a weekly automated job restores the latest backup into a throwaway instance, runs `pg_amcheck`, row counts and a sample CalDAV `GET`, then destroys the instance. It never restores into staging;
  - `human` signs off a **restore drill** into a fresh instance, with a documented RPO ≤ 5 min and RTO ≤ 1 h, before M1 and quarterly after that.
- Notes: Private calendar backups are ciphertext. They protect against our failures, not against user key loss (`04` Phase 1). Before Phase 7 there is no escrow, so this matters from M1. The secrets outside Postgres (`02` § Backups and recovery) are backed up through the secret store, not here. Hetzner server backups speed up a rebuild but don't count toward this requirement.

### E08-R05 · Observability   `agent`
Structured JSON logs, Prometheus metrics (request rate/latency/errors per service, poller lag, push failures, backup age), error reporting (Sentry or self-hosted GlitchTip) and uptime probes on `/.well-known/caldav` and the API health endpoint.
- Accept: alerts fire for backup age > 26 h, WAL archive lag > 5 min, last successful restore check > 8 d, certificate expiry < 14 d, 5xx rate > 1 %, poller lag > 2 min; no event content is sent to the error reporter (scrubbing test).

### E08-R06 · Outbound mail   `agent` + `human`
SMTP relay (SES or Postmark) with SPF, DKIM and DMARC, used by invites, iMIP (E03-R06) and security notifications (E14).
- Accept: mail-tester score ≥ 9/10; `human` sets the DNS records.

### E08-R07 · Runbook   `agent`
`docs/runbook.md` MUST cover deploy, rollback, restore, certificate failure, secret rotation, the IdP upgrade (R08) and "the CalDAV service is down".

### E08-R08 · IdP upgrade cadence   `agent`
Keycloak has no LTS: it ships four minor releases a year, and only the newest gets security fixes (`02` § Runtime layout). Production MUST run the current minor release within 30 days of its release. The realm configuration MUST live in the repository as code (keycloak-config-cli or the Terraform provider) and be applied on deploy. There are no custom SPIs, and themes are CSS only.
- Accept: a CI job fails when the deployed minor release is more than 30 days behind the latest; an upgrade is rehearsed on staging, including sign-in from the Android app, before production; tearing down staging's IdP and re-applying the realm from code gives an identical realm.

### E08-R09 · KMS key protection (Phase 7)   `human` + `agent`
The Tier 1 escrow key (D-10, E14-R01) MUST be protected against deletion and loss. An IAM policy denies `ScheduleKeyDeletion` and `DisableKey` to every principal except a break-glass role. The deletion waiting period is set to 30 days. A multi-Region replica key in a second EU region is created, or its absence is recorded as an accepted risk.
- Accept: a test with the release service's role and the deploy role shows that both are denied deletion; a CloudTrail alert fires on any `ScheduleKeyDeletion` attempt.
- Notes: losing this key loses every Tier 1 escrow copy, and no Postgres backup can restore them.
