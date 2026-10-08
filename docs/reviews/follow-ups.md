# Implementation loop — queue and follow-ups

The state of the orchestrator loop (`.agents/skills/orchestrate/`): what runs next, the review findings that belong to a later requirement, and the questions waiting for the owner. Update it on the requirement branch whenever a review changes it. The epic Status cells and the PR list stay the source of truth for what is Done.

## Queue

As of 2026-10-09. Each requirement starts only once it is Ready and the PRs it builds on are merged.

1. **E04 and E03** Phase 1 requirements, alternating as their Deps allow: E04-R01 (passed review 3, PR #38, Done once merged), E04-R02, E03-R01 (`agent+review`), then E04-R03…R06 and E03-R02, R08 (`agent+review`), R09, R10.
   - **Stacked by the owner's decision of 2026-10-09:** E04-R02 runs on top of `feat/E04-R01-migration-tooling`, assuming PR #38 is accepted. Its branch stays local until #38 is merged. #38 is squashed, so a plain `git merge main` would conflict on the hunks both requirements touch: after the merge the branch is rebased with `git rebase --onto main <E04-R01 tip>` (never pushed before, so nothing is force-pushed), and only then pushed with its PR.
   - E03-R01 waits for both merges.
2. **E05**: R01 (`agent+review`), R02–R05, R08–R10.
3. **E08**: R02, R03, R04, R05, R07, R08. Staging checks by the coordinator (D-20).
4. **E15**: R01–R03.

## Follow-ups waiting for their requirement

- **Done 2026-10-06:** **"Verify required"** (E02-R06) is a required status check on `main`, in the ruleset "my main my rules" (GitHub Actions app only). The ruleset's one-approval rule is unchanged.

- **E03-R01:**
  - the CalDAV image installs `pdo_pgsql`;
  - add `sabre/dav` to `composer.json` and `composer.lock` (the lock exists since E02-R04, with the dev tools only), at 4.7.1, the tag whose scripts E04-R01 imports. The Composer package has no `examples/` directory, so the lock can't be compared with the scripts directly: the Accept line checks `composer.lock`'s version and source reference against the record E04-R01 commits (`server/api/sabredav/record.json`: `tag` and `commit`). `composer require sabre/dav:4.7.1` takes the commit `f36f002dce082e1d425c4a0dc8c71a6b176c3b07`;
  - point the SabreDAV PDO backends at the schema `sabredav` (E04-R01) and qualify the service's own reads as `public.users` and so on;
  - replace the `php -S` skeleton (FrankenPHP in classic mode, never worker mode, `02`).
- **E04-R02 (E04-R01 review 3):**
  - switch `CALFLEX_MIGRATE_DATABASE_URL` (`infra/dev/compose.yaml`'s `migrate` service) from the bootstrap login `caldav` to `calflex_migrate`. The roles are cluster objects with secrets, so they don't belong in migrations: create them where the cluster is initialised (`infra/dev/postgres/initdb/` locally, E08 in production). The `sabredav` schema and its tables are owned by whichever login ran the migrations, `caldav` today: make `calflex_migrate` the owner (a fresh `make dev-reset` chain is enough locally);
  - `server/api/test/migrate.test.mjs`: the first `down = false` migration makes the "down to zero" case fail, so that case must stop at it. Table assertions are scoped to `sabredav` plus `public.pgmigrations`, so new `public` tables don't break them;
  - `server/api/migrate.config.json` holds dashed keys only: node-pg-migrate 9.0.0 reads those from the file, lets the file override the command line, and takes `single-transaction` and `lock` from its CLI defaults (`true`), which the rollback cases guard.
- **E04-R06:** SabreDAV's tables in the schema `sabredav` use `SERIAL` integer keys, and the upstream scripts are not ours to change. "Every generated ID column defaults to `gen_random_uuid()`" must exempt that schema by name. The integers never reach an href: a calendar's collection URI is `calendarinstances.uri`, which holds the API's UUID (E03 § Layout).
- **E05-R01:**
  - replaces the API skeleton (`server/api/src/app.mjs`, started by `server.mjs`) and drops the `GET /` allow-list entry in `server/api/test/contract.test.mjs` with it;
  - extends that contract test (E02-R07 review 1): it compares the `application/json` response schemas only. Add parameters, query, body and headers, flag response codes a route defines and the spec lacks, and decide how annotation keys (`description`, `example`) compare when the first schema with one arrives;
  - tags every operation in `spec/openapi.yaml`, because swagger_parser makes one Dart client per tag;
  - a JWT library such as `jose` is crypto-looking for INV-07 (E02-R05), so it needs an entry in `infra/scripts/invariant-dependencies.json` with its own reason (JWT signature verification against Zitadel's JWKS, no content decryption).
- **E10-R01 (E02-R07 review 1):** `flutter create` must keep `apps/mobile/lib/api/`, `swagger_parser.yaml`, the exact pins and `pubspec.lock`. `flutter pub get` writes an untracked `android/app/src/main/java/io/flutter/plugins/GeneratedPluginRegistrant.java`, so the scaffold's `.gitignore` must cover it. `analyzer` is pinned to 13.3.0 because `build_runner` 2.16.1 breaks on analyzer 14 (`contextFeatures`); drop the pin when a `build_runner` release supports 14.
- **Renovate (when it is set up):** group `analyzer` with `build_runner`, and `openapi-typescript` with its `typescript` 5.x pin in `packages/api-client-ts`.
- **E10-R02:** the app always sends PKCE S256 (`flutter_appauth` does by default). Zitadel v4.16 enforces the verifier when a challenge was sent, but it doesn't require PKCE from the public Android client (E02-R09 review 3).
- **E08:**
  - production pins images by digest; the dev stack's image tags are no template for that;
  - E04-R01's second Accept, "from the first production deploy on, CI also migrates a copy of the last released schema", has nothing to act on before the first release. Add the CI step with the first production deploy;
  - R02/R03 run `infra/zitadel` with `PG_CONN_STR` pointing at the instance's own Zitadel database (state in schema `calflex_tofu`, D-11) and `ZITADEL_ACCESS_TOKEN` from the password manager (E02-R09);
  - R03: staging's token-helper PAT expires 2030-01-01 and its account holds `IAM_LOGIN_CLIENT`, which is powerful; plan its rotation.
  - R08: at each Zitadel upgrade, look for a setting that makes PKCE mandatory for public clients, and enable it in `infra/zitadel/` if it exists.
- **E10-R01 (Phase 3):**
  - keep the Gradle 9.3.1 wrapper and `gradle/gradle-daemon-jvm.properties` after `flutter create`;
  - `minSdk = 26` (the template default is 24);
  - confirm Flutter's Gradle run honours the daemon JVM criteria;
  - the `dev|staging|prod` flavors keep the one application ID `de.flexcalendar.app`, with no `applicationIdSuffix`: the redirect scheme is registered once (PR #16, owner-approved).
- **Not in any requirement yet** (from E02-R04):
  - Markdown is not linted, and stays that way: the owner decided on 2026-10-07 that a linter for `docs/` makes no sense (the docs are long-form prose with wide tables). Do not raise it again. The E02-R04 and E02-R08 reviews left it open;
  - `infra/dev/*.mjs` (`check-stack`, the seed) and `infra/zitadel/*.mjs` (E02-R09; `make test-zitadel` exists but `make verify` doesn't run it) are in no format, lint or type gate;
  - `CONTRIBUTING.md` and `infra/dev/compose.yaml` fail `prettier --check` on `main` (found in E04-R01 run 2); both are in no format gate, so nothing reformats them;
  - `infra/dev/seed/seed.mjs:124` has an ESLint `no-useless-assignment` error that predates E02-R09;
  - the tooling test `healthchecks.test.mjs` (E02-R06) binds host ports 8080 and 3000 and runs `php`, so `make verify` on a dev host needs those ports free and PHP on `PATH`, as `CONTRIBUTING.md` already requires;
  - the skipped component matrix shows as `Component (${{ matrix.component }})` on full and docs-only runs (cosmetic).
  - on pushes to `main`, `cancel-in-progress` cancels the earlier merge's run when two merges land seconds apart (2026-10-06, 22:24 UTC: #33's run, cancelled by #32's). The later run tests the combined tree. Restrict `cancel-in-progress` to pull requests if each merge commit should keep its own run;
- **Text nits on `main`**, for whoever touches the file next:
  - `infra/zitadel/README.md` § state tells "existing local installations" to remove an old `zitadel-state` volume; that volume existed only during E02-R09's review, never on `main`;
  - `CONTRIBUTING.md` says the harness writes the new subject "once PR #6 is merged", which is stale;
  - `pnpm-workspace.yaml` calls `packages/crypto_dart` "README-only" (it has a pubspec);
  - the `gradle-daemon-jvm.properties` comment overstates "Gradle resolves a matching toolchain itself" (it only detects an installed JDK 21).

## Open with the owner

Nothing.
