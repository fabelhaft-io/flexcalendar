# E02 — Monorepo, tooling, CI, local stack

| | |
|---|---|
| Phase | 1 |
| Status | In progress: R01, R02, R03 and R08 Done; R04 passed review ([`reviews/E02-R04.md`](../reviews/E02-R04.md)), Done once merged; R05–R07 and R09 Ready |
| Executor | `agent` |
| Depends on | D-09 (layout), D-01/D-02 for the service skeletons, D-03 and D-19 for R09 |
| Spec | `02-technology-choices.md`, ADR 0002 |

## Goal

Give agents one repo in which every component can be built, run and verified locally with one command. Later epics assume everything here exists.

## Requirements

### E02-R01 · Repository layout   `agent`
The repo MUST follow this layout (adjust only by amending D-09):
```
server/caldav/          PHP 8.4, SabreDAV 4.7+, Composer
server/api/             Node 24 LTS, TypeScript, Fastify
apps/web/               React + Vite + TypeScript
apps/mobile/            Flutter (Dart 3); android/ holds the Kotlin sync adapter module
packages/crypto-ts/     TS crypto core (E12)
packages/crypto_dart/   Dart crypto core (E12)
packages/api-client-ts/ generated from spec/openapi.yaml
spec/openapi.yaml       API contract, source of generated clients
spec/ical-fixtures/     round-trip corpus (E15)
spec/crypto-vectors/    cross-language test vectors (E12)
infra/                  compose files, Caddyfile, deploy scripts
docs/                   unchanged
```
- Accept: the tree exists with a README per top-level directory that says what belongs there and names its owning epic.
- Notes: `apps/web/` and `packages/crypto-ts/` stay README-only until Phase 5 (ADR 0003).

### E02-R02 · Toolchain pinning   `agent`
Toolchain versions MUST be pinned: `.nvmrc`/`package.json#engines`, `pnpm` via corepack, `.fvmrc` or `pubspec` SDK constraints, `composer.json` platform, and a Gradle wrapper with a JDK version.
- Accept: a clean checkout builds with the pinned tools only; CI uses the same pins.

### E02-R03 · Local stack   `agent`
`infra/dev/compose.yaml` MUST start Postgres, the CalDAV service, the API, Zitadel with its login UI container (per D-03, ADR 0004), Mailpit for SMTP, and Caddy with a local CA. `make seed` MUST load the stack's own development seed from `infra/dev/seed/`: at least two test users in Zitadel, so later requirements can seed calendars and events for them. It runs under rootless Podman with `podman compose` (`02` § Runtime layout); nothing may require a Docker daemon or root.
- Accept: `make dev` brings the stack up as an unprivileged user without changing sysctls; `make seed` loads the seed and is idempotent; CalDAV answers at `https://caldav.localhost:8443`, the API at `https://api.localhost:8443` (the port is configurable).
- Notes: the seed is the stack's own; nothing comes from the closed Phase 0 spike (E01). R09 adds the Zitadel configuration to `make seed`. Requirements that add calendars or events to the seed follow the Phase 1 rules: every calendar is Private until Phase 4 (E04-R03), so seeded events are skeletons with no content properties (E03-R09, INV-01).

### E02-R04 · Single verification entry point   `agent`
`make verify` MUST run, for every package: format check, lint, type check and unit tests, plus `make check-stack` and `make test-seed` from E02-R03, and then two suites against the local stack: `verify-invariants` (E02-R05) and `verify-corpus`. Later requirements register their checks with these targets instead of editing `make verify`. E15-R01 adds the round-trip corpus, E04-R06 the UUID check, E12-R05 the crypto vectors and E07 the INV-06 payload test.
- Accept: non-zero exit on any failure; runtime under 10 min on CI; `make verify-<component>` runs one component; a suite with no registered checks yet passes and says so, rather than failing or being skipped silently.

### E02-R05 · Invariant checks in CI   `agent`
The automatable invariants in `06` MUST be CI checks:
- INV-05: client packages (`apps/*`, `packages/crypto_*`) contain no code that emits `EXDATE`/`RECURRENCE-ID`.
- INV-07: `server/**` dependency trees contain no libsodium, tweetnacl, `@noble/*` or similar content-crypto package (allow-list with justification for TLS/hash libs).
- Accept: each check is registered in `infra/scripts/verify/invariants/` (E02-R04), so `make verify` runs it, and passes on the current tree.
- Accept: each check has deliberately bad fixtures in the repo, and unit tests assert that the check fails on each of them for the invariant's reason, not for an unrelated error. CI runs these tests once E02-R06 runs `make verify`; R05 does not wait for it.
- Notes: INV-06 (the push payload schema test) is added by E07-R04 together with the payload builder, in Phase 4. There is nothing to check before then.

### E02-R06 · CI pipeline   `agent`
GitHub Actions MUST run `make verify` on every PR, with path filters per component, cached dependencies, and a required status check on `main`.
- Accept: a PR touching only `apps/web` runs web checks plus the cross-cutting ones.

### E02-R07 · OpenAPI-first contract   `agent`
`spec/openapi.yaml` MUST be the API contract. The TS client, the Dart `dio` client and the Fastify route schemas are generated from it or validated against it.
- Accept: CI fails when the generated clients are stale (`make gen && git diff --exit-code`).
- Notes: the Dart client is needed from Phase 3; the TS client can wait until Phase 5.

### E02-R08 · Conventions doc   `agent`
`CONTRIBUTING.md` MUST record branch naming, commit style, the `06` agent working agreement, and how to add an ADR.

### E02-R09 · Zitadel configuration as code   `agent+review`
The Zitadel instance configuration MUST live in `infra/zitadel/` as OpenTofu code with the Zitadel provider (D-19). OpenTofu and the provider versions are pinned the way E02-R02 pins toolchains. The configuration covers:
- the project (the organisation, its admin, the seed account and the login UI's `IAM_LOGIN_CLIENT` account come from Zitadel's first-instance settings in `infra/dev/compose.yaml`, as E02-R03 set them up);
- the API's registration;
- the Android app's native OIDC + PKCE registration, with the **JWT access-token type**, so clients that request the project audience scope get the project ID in `aud`;
- login and password policies;
- self-registration off;
- no custom actions; branding by settings only.

`make seed` applies it to the local stack after E02-R03's users, with OpenTofu running in a container like the seed, so nothing is installed on the host. The same code configures staging (E08-R03) and production (E08-R02).

For tests, `make token USER=<seeded user>` MUST print an access token for that user without a browser:
- it uses only Zitadel's public APIs, for example the v2 session and OIDC auth-request APIs that a custom login UI uses;
- it never uses a password grant, and never a token type the app registrations don't issue;
- it uses its own service account, never the login UI's `IAM_LOGIN_CLIENT` account (which production needs for the login UI), and that account exists only in the local and staging configurations;
- the helper refuses to run against the production issuer.
- Accept: on a fresh local stack, `make seed` twice in a row leaves `tofu plan` with no changes.
- Accept: `make token USER=<seeded user>` prints a JWT whose `aud` contains the project ID and that verifies against Zitadel's JWKS.
- Accept: tearing down Zitadel's database and re-applying gives an identical configuration.
- Accept: the production configuration contains no token-helper service account.
- Deps: E02-R03.
- Notes: moved out of E08-R08 on 2026-10-05, so auth is in place before E03 and E05 need it. E08-R08 keeps the upgrade cadence. This is `agent+review` because it sets the auth surface: list every grant and policy in the PR.
