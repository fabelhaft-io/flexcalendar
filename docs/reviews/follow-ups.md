# Implementation loop — queue and follow-ups

The state of the orchestrator loop (`.agents/skills/orchestrate/`): what runs next, the review findings that belong to a later requirement, and the questions waiting for the owner. Update it on the requirement branch whenever a review changes it. The epic Status cells and the PR list stay the source of truth for what is Done.

## Queue

As of 2026-10-09. Each requirement starts only once it is Ready and the PRs it builds on are merged.

1. **E04 and E03** Phase 1 requirements, alternating as their Deps allow: E04-R01 (Done, PR #38 merged 2026-10-09), E04-R02 (passed review 2, PR open), E03-R01 (`agent+review`), then E04-R03…R06 and E03-R02, R08 (`agent+review`), R09, R10.
   - E04-R02 ran stacked on E04-R01's branch by the owner's decision of 2026-10-09. #38 was squashed to a commit with the same tree as the reviewed tip, so the branch was rebased with `git rebase --onto main 19e0bbb` before its first push (nothing force-pushed).
   - E03-R01 waits for E04-R02's merge.
2. **E05**: R01 (`agent+review`), R02–R05, R08–R10.
3. **E08**: R02, R03, R04, R05, R07, R08. Staging checks by the coordinator (D-20).
4. **E15**: R01–R03.

## Follow-ups waiting for their requirement

- **Done 2026-10-06:** **"Verify required"** (E02-R06) is a required status check on `main`, in the ruleset "my main my rules" (GitHub Actions app only). The ruleset's one-approval rule is unchanged.

- **E03-R01:**
  - the CalDAV image installs `pdo_pgsql`;
  - add `sabre/dav` to `composer.json` and `composer.lock` (the lock exists since E02-R04, with the dev tools only), at 4.7.1, the tag whose scripts E04-R01 imports. The Composer package has no `examples/` directory, so the lock can't be compared with the scripts directly: the Accept line checks `composer.lock`'s version and source reference against the record E04-R01 commits (`server/api/sabredav/record.json`: `tag` and `commit`). `composer require sabre/dav:4.7.1` takes the commit `f36f002dce082e1d425c4a0dc8c71a6b176c3b07`;
  - point the SabreDAV PDO backends at the schema `sabredav` (E04-R01) and qualify the service's own reads as `public.users` and so on;
  - replace the `php -S` skeleton (FrankenPHP in classic mode, never worker mode, `02`);
  - the compose `caldav` service already has `CALFLEX_DATABASE_URL` as `calflex_caldav` (E04-R02). That role has DML on all of `sabredav` and its sequences, DML on `caldav_changes` and `delegation_nonces`, `SELECT` on `public.users`, `calendars` and `calendar_members`, and `UPDATE (last_used_at)` on `device_credentials`; nothing else, `pgmigrations` included. A grant the service needs beyond that goes into its own migration.
- **Migrations (E04-R01 review 3, E04-R02):**
  - whoever adds the first `down = false` migration: the "down to zero" cases in `migrate.test.mjs` and `schema.test.mjs` must stop at it;
  - `server/api/migrate.config.json` holds dashed keys only: node-pg-migrate 9.0.0 reads those from the file, lets the file override the command line, and takes `single-transaction` and `lock` from its CLI defaults (`true`), which the rollback cases guard;
  - the role-exists guard at the top of `1791496692783_core-tables-and-roles.mjs` has no test; a regression there only costs a worse error message.
- **E04-R03:** E04-R02 left `calendars.mode` as `text NOT NULL` with `CONSTRAINT calendars_meta_envelope_check CHECK ((mode = 'private') = (meta_envelope IS NOT NULL))`. The enum conversion and the private-only check are yours; keep the envelope check working through the conversion.
- **E06:** `invitations` has only `token_hash`, `expires_at` and `revoked_at`. The invite role, invitee email, creator and a consumption marker (E06-R01/R09: "a reused token is rejected") come with E06's own migration, and so does a pending state for `calendar_members`.
- **E07:** `calflex_api` has `SELECT` only on `caldav_changes` (the CalDAV service writes the outbox). The grants its worker needs go into E07's own migration.
- **E04-R06:** SabreDAV's tables in the schema `sabredav` use `SERIAL` integer keys, and the upstream scripts are not ours to change. "Every generated ID column defaults to `gen_random_uuid()`" must exempt that schema by name, and `public.pgmigrations` (node-pg-migrate's own `SERIAL` id). The integers never reach an href: a calendar's collection URI is `calendarinstances.uri`, which holds the API's UUID (E03 § Layout).
- **E05-R01:**
  - replaces the API skeleton (`server/api/src/app.mjs`, started by `server.mjs`) and drops the `GET /` allow-list entry in `server/api/test/contract.test.mjs` with it;
  - the compose `api` service has `CALFLEX_DATABASE_URL` as `calflex_api` (E04-R02): DML on its own tables, `SELECT` only on `caldav_changes`, `INSERT` and `SELECT` only on `audit_log`, nothing on `delegation_nonces`, `sabredav` or `pgmigrations`;
  - extends that contract test (E02-R07 review 1): it compares the `application/json` response schemas only. Add parameters, query, body and headers, flag response codes a route defines and the spec lacks, and decide how annotation keys (`description`, `example`) compare when the first schema with one arrives;
  - tags every operation in `spec/openapi.yaml`, because swagger_parser makes one Dart client per tag;
  - a JWT library such as `jose` is crypto-looking for INV-07 (E02-R05), so it needs an entry in `infra/scripts/invariant-dependencies.json` with its own reason (JWT signature verification against Zitadel's JWKS, no content decryption).
- **E10-R01 (E02-R07 review 1):** `flutter create` must keep `apps/mobile/lib/api/`, `swagger_parser.yaml`, the exact pins and `pubspec.lock`. `flutter pub get` writes an untracked `android/app/src/main/java/io/flutter/plugins/GeneratedPluginRegistrant.java`, so the scaffold's `.gitignore` must cover it. `analyzer` is pinned to 13.3.0 because `build_runner` 2.16.1 breaks on analyzer 14 (`contextFeatures`); drop the pin when a `build_runner` release supports 14.
- **Renovate (when it is set up):** group `analyzer` with `build_runner`, and `openapi-typescript` with its `typescript` 5.x pin in `packages/api-client-ts`.
- **E10-R02:** the app always sends PKCE S256 (`flutter_appauth` does by default). Zitadel v4.16 enforces the verifier when a challenge was sent, but it doesn't require PKCE from the public Android client (E02-R09 review 3).
- **E08:**
  - production pins images by digest; the dev stack's image tags are no template for that;
  - **R10 (Zitadel's database role, owner's decision of 2026-10-09, doc PR #42):** a separate requirement, not urgent. Evaluate the options first and write an ADR for the owner to accept; implement only then. A separate startup sequence (a one-off `zitadel init` with admin credentials, then `setup` and `start` as an app role) is the owner's leading hypothesis, not a decision. R02 waits for the accepted ADR. Until then Zitadel and the `zitadel-config` runner use the bootstrap login, a superuser, locally;
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
