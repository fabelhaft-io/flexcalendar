# Implementation loop — queue and follow-ups

The state of the orchestrator loop (`.agents/skills/orchestrate/`): what runs next, the review findings that belong to a later requirement, and the questions waiting for the owner. Update it on the requirement branch whenever a review changes it. The epic Status cells and the PR list stay the source of truth for what is Done.

## Queue

As of 2026-10-05. Each requirement starts only once it is Ready and the PRs it builds on are merged.

1. **E02-R04** · single verification entry point: passed review, PR #13.
2. **chore** · PHP and Composer in the implementer sandbox: PR #14.
3. **chore** · the implementer's handoff fails schema validation in 3 of 6 runs (`agent-team/src/lib/handoff.ts`); find out why and fix it. In the same PR, add `.agents` to the directories the coordinator refuses (`FORBIDDEN_DIRS`), because it holds the orchestrator skill.
4. **E02-R09** · Zitadel configuration as code, `agent+review`. Waits for #13 (both edit the `Makefile`).
5. **E02-R05**, then **E02-R07**, then **E02-R06**.
6. **E04 and E03** Phase 1 requirements, alternating as their Deps allow: E04-R01, E04-R02, E03-R01 (`agent+review`), then E04-R03…R06 and E03-R02, R08 (`agent+review`), R09, R10.
7. **E05**: R01 (`agent+review`), R02–R05, R08–R10.
8. **E08**: R02, R03, R04, R05, R07, R08. Staging checks by the coordinator (D-20).
9. **E15**: R01–R03.

## Follow-ups waiting for their requirement

- **E02-R05/R06**, a pin-consistency check:
  - `.nvmrc` against `devEngines` and the `engines` range;
  - both pubspecs' Dart SDK against the Dart that the `.fvmrc` Flutter release ships.
- **E02-R06**, CI:
  - read the pins, never repeat them: `actions/setup-node` with `node-version-file: .nvmrc`; pnpm through corepack from `packageManager`; `subosito/flutter-action` with `flutter-version-file: apps/mobile/.fvmrc`; `shivammathur/setup-php` 8.4; `actions/setup-java` 21 with `gradle/actions/setup-gradle`;
  - JDK 21 isn't auto-provisioned (no toolchain download URLs);
  - CI runs `pnpm install` and `composer install`, and starts the stack before `make verify`, which deliberately doesn't start it (E02-R04);
  - making the check required on `main` is a repo setting, so ask the owner.
- **E02-R07:** add `info.license: Apache-2.0` to `spec/openapi.yaml`; confirm `servers` and the OpenAPI version.
- **E03-R01:**
  - the CalDAV image installs `pdo_pgsql`;
  - add `sabre/dav ^4.7` to `composer.json` and `composer.lock` (the lock exists since E02-R04, with the dev tools only);
  - replace the `php -S` skeleton (FrankenPHP in classic mode, never worker mode, `02`).
- **E05-R01:** replaces the API skeleton in `server/api/src/server.mjs`.
- **E08:** production pins images by digest; the dev stack's image tags are no template for that.
- **E10-R01 (Phase 3):**
  - keep the Gradle 9.3.1 wrapper and `gradle/gradle-daemon-jvm.properties` after `flutter create`;
  - `minSdk = 26` (the template default is 24);
  - confirm Flutter's Gradle run honours the daemon JVM criteria.
- **Not in any requirement yet** (from E02-R04):
  - Markdown is not linted (an owner decision);
  - `infra/dev/*.mjs` (`check-stack`, the seed) are in no format, lint or type gate.
- **Text nits on `main`**, for whoever touches the file next:
  - `CONTRIBUTING.md` says the harness writes the new subject "once PR #6 is merged", which is stale;
  - `pnpm-workspace.yaml` calls `packages/crypto_dart` "README-only" (it has a pubspec);
  - the `gradle-daemon-jvm.properties` comment overstates "Gradle resolves a matching toolchain itself" (it only detects an installed JDK 21).

## Open with the owner

- **Merged branches** are still there locally and on GitHub, along with the worktree `../calendar-flex-agent-E02-R03`. Deleting them is the owner's call; suggestion: turn on "Automatically delete head branches".
- **The pnpm rationale paragraph for `02`:** offered, not answered. The reason is that pnpm's strict `node_modules` is what makes the INV-07 dependency check and the E05-R02 `tsdav` rule hold.
