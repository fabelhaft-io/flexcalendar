# Implementation loop — queue and follow-ups

The state of the orchestrator loop (`.agents/skills/orchestrate/`): what runs next, the review findings that belong to a later requirement, and the questions waiting for the owner. Update it on the requirement branch whenever a review changes it. The epic Status cells and the PR list stay the source of truth for what is Done.

## Queue

As of 2026-10-05. Each requirement starts only once it is Ready and the PRs it builds on are merged.

1. **E02-R06** · CI pipeline: passed review 4 after a fourth run the owner allowed (`--force`), PR #21.
2. **E02-R07**: waits for #21 (both edit `package.json` and `infra/scripts/`). No doc picks the OpenAPI generators (TS, and Dart in `apps/mobile`): expect the run to ask.
4. **E04 and E03** Phase 1 requirements, alternating as their Deps allow: E04-R01, E04-R02, E03-R01 (`agent+review`), then E04-R03…R06 and E03-R02, R08 (`agent+review`), R09, R10.
5. **E05**: R01 (`agent+review`), R02–R05, R08–R10.
6. **E08**: R02, R03, R04, R05, R07, R08. Staging checks by the coordinator (D-20).
7. **E15**: R01–R03.

## Follow-ups waiting for their requirement

- **E02-R07:** add `info.license: Apache-2.0` to `spec/openapi.yaml`; confirm `servers` and the OpenAPI version.
- **E03-R01:**
  - the CalDAV image installs `pdo_pgsql`;
  - add `sabre/dav ^4.7` to `composer.json` and `composer.lock` (the lock exists since E02-R04, with the dev tools only);
  - replace the `php -S` skeleton (FrankenPHP in classic mode, never worker mode, `02`).
- **E05-R01:**
  - replaces the API skeleton in `server/api/src/server.mjs`;
  - a JWT library such as `jose` is crypto-looking for INV-07 (E02-R05), so it needs an entry in `infra/scripts/invariant-dependencies.json` with its own reason (JWT signature verification against Zitadel's JWKS, no content decryption).
- **E10-R02:** the app always sends PKCE S256 (`flutter_appauth` does by default). Zitadel v4.16 enforces the verifier when a challenge was sent, but it doesn't require PKCE from the public Android client (E02-R09 review 3).
- **E08:**
  - production pins images by digest; the dev stack's image tags are no template for that;
  - R02/R03 run `infra/zitadel` with `PG_CONN_STR` pointing at the instance's own Zitadel database (state in schema `calflex_tofu`, D-11) and `ZITADEL_ACCESS_TOKEN` from the password manager (E02-R09);
  - R03: staging's token-helper PAT expires 2030-01-01 and its account holds `IAM_LOGIN_CLIENT`, which is powerful; plan its rotation.
  - R08: at each Zitadel upgrade, look for a setting that makes PKCE mandatory for public clients, and enable it in `infra/zitadel/` if it exists.
- **E10-R01 (Phase 3):**
  - keep the Gradle 9.3.1 wrapper and `gradle/gradle-daemon-jvm.properties` after `flutter create`;
  - `minSdk = 26` (the template default is 24);
  - confirm Flutter's Gradle run honours the daemon JVM criteria;
  - the `dev|staging|prod` flavors keep the one application ID `de.flexcalendar.app`, with no `applicationIdSuffix`: the redirect scheme is registered once (PR #16, owner-approved).
- **Not in any requirement yet** (from E02-R04):
  - Markdown is not linted (an owner decision);
  - `infra/dev/*.mjs` (`check-stack`, the seed) and `infra/zitadel/*.mjs` (E02-R09; `make test-zitadel` exists but `make verify` doesn't run it) are in no format, lint or type gate;
  - `infra/dev/seed/seed.mjs:124` has an ESLint `no-useless-assignment` error that predates E02-R09;
  - the tooling test `healthchecks.test.mjs` (E02-R06) binds host ports 8080 and 3000 and runs `php`, so `make verify` on a dev host needs those ports free and PHP on `PATH`, as `CONTRIBUTING.md` already requires;
  - the skipped component matrix shows as `Component (${{ matrix.component }})` on full and docs-only runs (cosmetic).
- **Text nits on `main`**, for whoever touches the file next:
  - `infra/zitadel/README.md` § state tells "existing local installations" to remove an old `zitadel-state` volume; that volume existed only during E02-R09's review, never on `main`;
  - `CONTRIBUTING.md` says the harness writes the new subject "once PR #6 is merged", which is stale;
  - `pnpm-workspace.yaml` calls `packages/crypto_dart` "README-only" (it has a pubspec);
  - the `gradle-daemon-jvm.properties` comment overstates "Gradle resolves a matching toolchain itself" (it only detects an installed JDK 21).

## Open with the owner

- **Merged branches** are still there locally and on GitHub, along with the clean worktrees `../calendar-flex-agent-E02-R03`, `-agent-E02-R04`, `-agent-E02-R05`, `-agent-E02-R09`, `-claude-md`, `-sandbox-php`, `-handoff`, `-doc-r09`, `-doc-r05`, `-claude-connectors`, `-r06-webonly`, `-r06-web2` and `-r06-fail`. The review-only branches `review/E02-R06-*` (test PRs #22–#24, closed) can go too. Deleting them is the owner's call; suggestion: turn on "Automatically delete head branches".
- **Required check on `main`:** make the GitHub check **"Verify required"** required in the branch protection of `main` (E02-R06). It is the single aggregate job; the per-component jobs are skipped on purpose and must not be required.
- **Guardrails wording** (offered, not answered): E02-R09 run 2 stopped before writing anything because its checks need the stack. One sentence in `agent-team/src/prompts/guardrails.md` would settle it, as its own `chore:` PR: an implementer never stops over a check it can't run in the sandbox; it writes the deliverable and lists those checks for the reviewer.
