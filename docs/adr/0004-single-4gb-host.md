# ADR 0004 — One 4 GB host: Zitadel instead of Keycloak, staging on demand

- **Status**: Accepted
- **Date**: 2026-10-04
- **Amends**: D-03 (identity provider), D-10 (hosting) in [`06-implementation-backlog.md`](../06-implementation-backlog.md)
- **Relates to**: [`02-technology-choices.md`](../02-technology-choices.md) § Hosting (sizing, runtime layout, backups), [`04-implementation-phases.md`](../04-implementation-phases.md) Phase 1, epics E02, E05, E08

## Context

calendar-flex is a side project. The plan in `02` § Sizing and cost puts it at about €70/month until M1, of which production alone is about €42: an 8 GB CPX32 (€35.49) plus Hetzner server backups (about €7). Staging, a permanent 4 GB twin, is another €19.50.

The 8 GB host exists for one reason. `02` says the stack fits in 4 GB *except* for Keycloak, which needs 1–1.5 GB on its own. Without it, the rest is about 1.5–2 GB: Postgres around 1 GB, SabreDAV and the API a few hundred MB each, Caddy and the monitoring agents. Hetzner's June 2026 repricing made the gap between 4 GB (CPX22, €19.49) and 8 GB (CPX32, €35.49) €16/month.

Two more items cost money without buying anything the plan relies on:

- **Hetzner server backups.** `02` already says they "are never the data backup"; pgBackRest is. With deploy-as-code (E08-R02), a rebuild needs a fresh VPS and a restore, not a disk image.
- **A staging server running 24/7.** It's used for device tests and pre-deploy rehearsals, a few hours a month. Hetzner bills by the hour, and `02` already notes that staging is cheaper deleted than stopped.

And one repository choice is priced for scale we won't reach: Hetzner Object Storage's €6.49 minimum covers 1 TB, while our backups are a few GB.

| Requirement | Status |
|---|---|
| Self-hosted IdP; the user directory never goes to a third party (D-03's reason) | **Hard** |
| OIDC + PKCE for the Flutter and web apps; TOTP and WebAuthn available for the Phase 7 step-up | **Hard** |
| All durable state in one Postgres cluster, one backup (D-11, `02` § Backups) | **Hard** |
| Two backup repositories at two providers, Object Lock, no delete credentials on the host | **Hard** |
| RPO ≤ 5 min, RTO ≤ 1 h (E08-R04) | **Hard** |
| A staging environment that mirrors production | **Hard**; running it permanently is negotiable |
| Hetzner as the VPS provider | Negotiable, unchanged here |

This ADR does not touch CalDAV, stock-app round-tripping or the privacy model. D-17 / INV-12 (the login password never feeds a key derivation) holds for any IdP.

## Decision

Run production on **one 4 GB host** and replace Keycloak with **Zitadel**. Drop Hetzner server backups, create staging only when it's needed, and put both backup repositories at pay-per-GB object stores.

### 1. Zitadel replaces Keycloak (amends D-03)

- Zitadel v4, self-hosted, as two containers: the core service (API, OIDC endpoints, console) and the separate login UI that v4 requires. Caddy routes `/ui/v2/login` to the login container and everything else to the core.
- Its data lives in its own database **in our Postgres cluster** (Zitadel supports PostgreSQL 14–18), so the one-cluster, one-backup rule is unchanged.
- Native-app OIDC with PKCE for Flutter (`flutter_appauth`) and later the web app. Self-registration off. Accounts are created by an admin or by invitation, as in `04` Phase 1.
- **Access tokens are JWTs.** Zitadel defaults some app types to opaque bearer tokens. The app registrations MUST set the JWT access-token type, so the API keeps validating locally against JWKS (E05-R01), and clients request the project audience scope so `aud` names the API.
- Configuration as code with Zitadel's Terraform provider, applied on deploy (E08-R08). No custom actions that hold logic we'd have to migrate; branding by settings only.
- License: AGPL-3.0 since v3. We run it unmodified as a separate service, so it places no obligation on our Apache-2.0 code. If we ever patch it, the patch must be published.

Memory: the core service needs about 512 MB (vendor figure), and the login UI a few hundred MB more. That's roughly half of Keycloak's footprint, which is the headroom a 4 GB host needs.

### 2. Hosting (amends D-10)

- **Production: one 4 GB VPS** (CPX22 today; a CAX11 or other 4 GB line if it's cheaper and orderable at E08-R01 time). The stack stays arch-neutral.
- **No Hetzner server backups.** pgBackRest is the backup; the restore drill proves the RTO from a fresh VPS.
- **Staging on demand.** Staging is the same 4 GB shape, created from code (`make staging-up`) for device tests, upgrade rehearsals and pre-deploy checks, and deleted afterwards (`make staging-down`). It never holds production data, so deleting it loses nothing. Its IdP configuration and seed data come from code each time.
- **Backup repositories:** two pay-per-GB S3-compatible stores in the EU, at two different providers, both with Object Lock (for example Scaleway in Paris and Backblaze B2 in Amsterdam). Everything else in `02` § Backups stands: client-side encryption, credentials that can write but not delete, 30-day retention, weekly restore check into a throwaway instance.

### Cost

| Item | €/month (list price, excl. VAT, 2026-10-04) |
|---|---|
| Production, 4 GB (CPX22) | ~19.50 |
| Primary IPv4 | ~0.50 |
| Backup repositories, two providers, a few GB each | ~0.50–1 |
| Staging, on demand (a few days of use a month) | ~1–3 |
| Throwaway restore-check instance, weekly, about an hour | < 0.50 |
| **Total until M1** | **~22–25** |

Down from about €70 in the previous plan, and from about €42 for production alone.

## Consequences

- **Upkeep doesn't drop as much as RAM does.** Zitadel ships a major version about every quarter, each supported for roughly six months, and security backports are done as needed. Upgrades stay a quarterly task, but the six-month window means a skipped quarter isn't immediately unsupported, unlike Keycloak, where only the newest minor gets fixes. E08-R08 changes accordingly.
- **Majors have been breaking.** v4 split the login UI into its own container, which leaves login silently broken if only the core is deployed. Every upgrade is rehearsed on staging, with sign-in from the Android app, before production (unchanged from E08-R08).
- **Headroom on 4 GB is real but not large.** Postgres is tuned for the box (for example `shared_buffers` around 512 MB), every container gets a memory limit in Compose, and the E08-R05 alerts gain a memory-pressure alert. If the host runs short, the fix is a resize to 8 GB, which takes minutes on Hetzner. It isn't a re-architecture.
- **Restore without a disk image.** Without server backups, every recovery is "fresh VPS, deploy, restore". That's what the E08-R04 drill already tests, so the RTO target needs no change, but the drill MUST start from a blank VPS.
- **Staging isn't always there.** Phase 1's exit criterion "integration tests pass against staging" means bringing staging up for that run. A CI job may create and destroy it; its hourly cost is a few cents.
- **Phase 7 step-up.** E14 needs a second-factor step-up at the IdP before escrow release. Zitadel supports TOTP and passkeys and reports the methods in the token; how the release service checks a fresh step-up is settled when E14 starts (open question 1).
- No change to CalDAV, the stock-app surface, the privacy modes, the phases or the risks in `05`.

## Alternatives considered

- **Keep Keycloak, cap its heap (`-Xmx512m`–`768m`) on a 4 GB host.** No decision change. **Rejected**: it leaves less headroom than Zitadel, and keeps the one-minor-only support policy.
- **Pocket ID** (passkey-only OIDC, very light, supports Postgres). **Rejected**: passkey-only sign-in is a hurdle for less technical family members, and a lost passkey becomes an admin task.
- **Auth inside the API with a library, no IdP service.** Cheapest. **Rejected**: security-critical login flows become our own code to maintain, and D-03 and E05-R01 change much more.
- **Authentik.** **Rejected**: heavier than Zitadel, so it doesn't solve the memory problem.
- **Kanidm.** Light and well designed. **Rejected**: it keeps its own database, which breaks the one-Postgres-cluster backup rule.
- **Free tiers (Oracle Cloud Always Free) or a home server.** About €0. **Rejected**: free instances can be reclaimed, and a home connection makes public 443 with a stable IP fragile. Family data and "events lost = product dead" rule both out.
- **Another VPS provider.** **Not pursued**: `02` notes that OVH and Netcup raised prices in 2026 too. Revisit if the Hetzner bill grows.

## Open questions

1. Phase 7: how the escrow release service (E14) verifies a fresh second-factor step-up from Zitadel (the `amr` claim plus `auth_time`, or a dedicated step-up flow). Settle before E14 starts; it doesn't affect Phases 1–6.
