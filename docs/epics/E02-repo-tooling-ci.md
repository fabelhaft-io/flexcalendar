# E02 — Monorepo, tooling, CI, local stack

| | |
|---|---|
| Phase | 0–1 (in parallel with E01) |
| Status | Ready |
| Executor | `agent` |
| Depends on | D-09 (layout), D-01/D-02 for the service skeletons |
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
`infra/dev/compose.yaml` MUST start Postgres, the CalDAV service, the API, Zitadel with its login UI container (per D-03, ADR 0004), Mailpit for SMTP, and Caddy with a local CA, with seed data from E01-R02. It runs under rootless Podman with `podman compose` (`02` § Runtime layout); nothing may require a Docker daemon or root.
- Accept: `make dev` brings the stack up as an unprivileged user without changing sysctls; `make seed` loads fixtures; CalDAV answers at `https://caldav.localhost:8443`, the API at `https://api.localhost:8443` (the port is configurable).

### E02-R04 · Single verification entry point   `agent`
`make verify` MUST run, for every package: format check, lint, type check, unit tests, and then the invariant checks (E02-R05) and the round-trip corpus (E15-R01) against the local stack.
- Accept: non-zero exit on any failure; runtime under 10 min on CI; `make verify-<component>` runs one component.

### E02-R05 · Invariant checks in CI   `agent`
The automatable invariants in `06` MUST be CI checks:
- INV-05: client packages (`apps/*`, `packages/crypto_*`) contain no code that emits `EXDATE`/`RECURRENCE-ID`.
- INV-07: `server/**` dependency trees contain no libsodium, tweetnacl, `@noble/*` or similar content-crypto package (allow-list with justification for TLS/hash libs).
- INV-06: push payload builder has a schema test.
- Accept: each check fails on a deliberately bad fixture commit (tested in CI).

### E02-R06 · CI pipeline   `agent`
GitHub Actions MUST run `make verify` on every PR, with path filters per component, cached dependencies, and a required status check on `main`.
- Accept: a PR touching only `apps/web` runs web checks plus the cross-cutting ones.

### E02-R07 · OpenAPI-first contract   `agent`
`spec/openapi.yaml` MUST be the API contract. The TS client, the Dart `dio` client and the Fastify route schemas are generated from it or validated against it.
- Accept: CI fails when the generated clients are stale (`make gen && git diff --exit-code`).
- Notes: the Dart client is needed from Phase 3; the TS client can wait until Phase 5.

### E02-R08 · Conventions doc   `agent`
`CONTRIBUTING.md` MUST record branch naming, commit style, the `06` agent working agreement, and how to add an ADR.
