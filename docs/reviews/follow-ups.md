# Implementation loop — queue and follow-ups

The state of the orchestrator loop (`.agents/skills/orchestrate/`): what runs next, the review findings that belong to a later requirement, and the questions waiting for the owner. Update it on the requirement branch whenever a review changes it. The epic Status cells and the PR list stay the source of truth for what is Done.

## Queue

As of 2026-10-10. **Requirements are built on top of each other** (owner's decision of 2026-10-10: assume every PR merges). A branch is cut from the branch it depends on, its PR targets that branch, and main is merged forward into the stack (a signed `chore(<ID>): merge main (<ID>)` commit, never a force-push) after each merge. A requirement still starts only once every `Deps` entry is Done or has a branch in the stack.

1. **E04 and E03** Phase 1 requirements, alternating as their Deps allow: E04-R01 and E04-R02 (Done, PRs #38 and #41, 2026-10-09), E04-R03 (Done, PR #44, 2026-10-09), E04-R04 (Done, PR #46, 2026-10-10), E03-R01 (Done, PR #45, 2026-10-10), E03-R09 (Done, PR #47, 2026-10-10), E04-R05 (Done, PR #48, 2026-10-10), E04-R06 (passed review, PR #49, 2026-10-10), E03-R10 (passed review, PR #50, stacked on #49, 2026-10-10), E03-R02 (passed review, PR #52, stacked on #50, 2026-10-11), then E03-R08 (`agent+review`).
   - E03-R08 edits `server/caldav` and its test suite like R10 and R02: stack it on E03-R02. They can run beside an E04 or E05 requirement when their `--paths` don't overlap (`server/caldav/`, `Makefile` and the infra files against `server/api/`).
2. **E05**: R01 (`agent+review`), R02–R05, R08–R10.
3. **E08**: R02, R03, R04, R05, R07, R08, and R10 (Zitadel's database role: not urgent, but its step 1, an ADR the owner accepts, comes before R02). Staging checks by the coordinator (D-20).
4. **E15**: R01–R03.

## Follow-ups waiting for their requirement

- **Done 2026-10-06:** **"Verify required"** (E02-R06) is a required status check on `main`, in the ruleset "my main my rules" (GitHub Actions app only). The ruleset's one-approval rule is unchanged.

- **From the E03-R01 reviews, for later requirements** (R01 itself is in PR #45):
  - **E05-R02:** reuse `server/caldav/tests/Fixtures/delegation-vectors.json`; sign the request-target exactly as sent; the API reaches `http://caldav-internal:8081`. A database outage or a missing schema answers 401 like a denial on the wire; the service log tells them apart (`delegation_error` against `delegation_denied <reason>`);
  - **E03-R08:** until it lands, ownership is SabreDAV's `principaluri`. Another user's home answers 404 and `MKCALENDAR` into it 409, identical to an id that exists nowhere; keep that equivalence. `MKCALENDAR` of a non-UUID name, or of a UUID with no `public.calendars` row, answers 201 today and E03-R09 treats it as Private (E03-R09 review 2); bind collections to rows;
  - **E08:** the `delegation` network's subnet `172.30.91.0/24` and the fixed address are dev-only; `CALFLEX_DELEGATION_KEYS` comes from the secret store in production. The CalDAV service logs a `dav_failure` line for every DAV error, ordinary 404 and 412 and the guard's 403 included (66 lines in one test run before E03-R09); log only status 500 and above, or sample.
- **From the E03-R09 reviews, for later requirements** (R09 itself is in PR #47):
  - **E05-R04, E05-R10:** a write the guard rejects is a 403 whose `DAV:error` holds `cf:private-skeleton-only` and a child `cf:name` (the offending property, parameter or component, or `UNLISTED`). Map it to problem+json with that name and never a value; the API must not forward the CalDAV body;
  - **E05-R09:** a `VTIMEZONE` the API embeds must stay inside the allow-list (`TZID`, `LAST-MODIFIED`, `TZURL`, `X-LIC-LOCATION`; `STANDARD`/`DAYLIGHT` with `DTSTART`, `TZOFFSETFROM`, `TZOFFSETTO`, `RRULE`, `RDATE`, `TZNAME`). A zone copied from tzurl.org carries `X-PROLEPTIC-TZNAME` and is rejected;
  - **E15-R01:** the Private-calendar fixtures are skeletons with `X-CALFLEX-ENVELOPE-SHA256` on every `VEVENT`, no content properties, and no `X-` parameters;
  - the `make test-caldav` log scan greps `CALFLEX_GUARD_MARKER`: a marker that must not reach the log needs that prefix.
- **From the E03-R10 reviews, for later requirements** (R10 itself is in PR #50):
  - **E05-R02, E05-R03, E05-R04:** insert the `public.calendars` row **before** the first `PUT` into a new collection, or the write is `403` with `cf:unmapped-collection`; the API maps that element (and `cf:private-skeleton-only`) to problem+json, never forwarding the CalDAV body. `sync_token` in `caldav_changes` is the number `sync-collection` reports (`calendarchanges.synctoken + 1`): E05-R08 and E07 hand it to clients as "changed up to";
  - **E05-R04, E05-R10 and the open `UID` question:** a `PUT` body without `UID` is stored with SabreDAV's `sabre-vobject-<uuid>`, and a `UID` over 200 characters is a 500 (`calendarobjects.uid` is `VARCHAR(200)`). The API creates UUIDv4 UIDs and rejects longer ones;
  - **E07:** one outbox row per object change. Deleting a collection writes no per-object rows (they cascade with the `public.calendars` row), and a `MOVE` between calendars is two rows in two transactions; the 30 s `sync-collection` fallback covers what the outbox misses;
  - **whoever next edits `GuardedCalendars`:** mutation V8 survives. Moving the `COMMIT` ahead of the outbox insert passes every test, because the kill seam sits before the commit. A second seam after the insert, killed there (nothing may persist), would catch it; the implementer's own notes expected the existing tests to catch it. The owner can also ask for a fourth run of E03-R10 to add it.
- **From the E03-R02 review, for later requirements** (R02 itself is in PR #52):
  - **E03-R03 (Phase 4):** the device-credential backend re-runs the discovery case (`tests/Integration/DiscoveryTest.php`) on the public listener with an app password, and `/.well-known/caldav` stays unauthenticated: it is answered by the standalone `public/index.php` before any auth;
  - **E15-R05:** Apple Calendar and DAVx⁵ follow `301` with a `PROPFIND` on staging; the redirect is `Location: /` (the DAV root) for every method;
  - **E08:** a production Caddyfile proxies `/.well-known/caldav` to the CalDAV public listener unchanged; no rewrite to another path;
- **Migrations (E04-R01 review 3, E04-R02):**
  - whoever adds the first `down = false` migration: the "down to zero" cases in `migrate.test.mjs` and `schema.test.mjs` must stop at it;
  - `server/api/migrate.config.json` holds dashed keys only: node-pg-migrate 9.0.0 reads those from the file, lets the file override the command line, and takes `single-transaction` and `lock` from its CLI defaults (`true`), which the rollback cases guard;
  - the role-exists guard at the top of `1791496692783_core-tables-and-roles.mjs` has no test; a regression there only costs a worse error message.
- **E13-R06 (E04-R03 review 1):** E04-R03 made `calendars.mode` the enum `public.calendar_mode` and added `calendars_mode_private_only_check CHECK (mode = 'private')`. E13-R06's migration lifts it with `ALTER TABLE public.calendars DROP CONSTRAINT calendars_mode_private_only_check`, which leaves `calendars_meta_envelope_check` in force (tested). Its `down` must re-add the constraint: E04-R03's `down` drops it without `IF EXISTS` and fails otherwise. Neither E13-R06's text nor E04's names the constraint yet. It also adds the real-SQL cases that E03-R09 cannot have: once `shared` and `published` rows exist, `WriteGuard::fromPdo`'s query must be shown to return them and the guard to let a `SUMMARY` through (today only an injected lookup, and a mutation that makes the lookup answer `shared`, cover that branch).
- **From E04-R04 review 1:**
  - **E12-R01, E15-R02:** the DST cases the docs don't pin. With the zone's `VTIMEZONE` rules, `ical.js` maps `TZID=Europe/Berlin:20261025T023000` (occurs twice) to `20261025T013000Z`, the second occurrence, where RFC 5545 § 3.3.5 says the first (`…T003000Z`); and `20260329T023000` (does not exist) to `20260329T003000Z`, where the RFC says use the offset before the gap (`…T013000Z`). The wire spec and its vectors must pin one answer for the Dart `timezone` package and `ical.js` alike;
  - **E05-R07, E13-R02:** `recurrenceKey` (`server/api/src/recurrence-key.mjs`) resolves a `TZID` from the `VTIMEZONE` in the same document, then from `ical.js`'s global registry, and throws on an unresolved one; `ical.js` ships no zone data and stock apps often omit the `VTIMEZONE`. The API needs a trusted source of IANA zones, and must not register a client's `VTIMEZONE` into the global `TimezoneService` (one client could redefine `Europe/Berlin` for everyone);
  - **Renovate:** drop `--skipLibCheck` from `server/api`'s `typecheck` when an `ical.js` release ships NodeNext-clean declarations. `ical.js` is MPL-2.0.
- **From the E04-R05 review 2, for later requirements** (R05 itself is in PR #48):
  - **E12-R01:** the sealed and signed CCK record in `spec/crypto.md` must carry its signer's user id (or `calendar_keys` needs a signer column): the table has `calendar_id`, `epoch`, `user_id` (the recipient) and the opaque `record`. Wrapped private keys and records have no size limit in the database; the API checks sizes;
  - **E14-R01:** its migration drops `user_key_wraps_no_escrow_check` by name and its `down` re-adds it (named in the epic since E04-R05); `user_key_wraps` is keyed `(user_id, kind)`, so an escrow wrap is a second row beside the `recovery_code` one;
  - **E13-R01:** "key-capable" means a `user_keys` row.
- **E06:** `invitations` has only `token_hash`, `expires_at` and `revoked_at`. The invite role, invitee email, creator and a consumption marker (E06-R01/R09: "a reused token is rejected") come with E06's own migration, and so does a pending state for `calendar_members`. A `calendar_keys` record has a composite FK to `calendar_members`, so a pending member must already be a row there before the owner's client can seal them a record.
- **E07:** `calflex_api` has `SELECT` only on `caldav_changes` (the CalDAV service writes the outbox). The grants its worker needs go into E07's own migration.
- **From the E04-R06 reviews, for later requirements** (R06 itself is in PR #49):
  - **E10-R01:** INV-03 (`infra/scripts/invariants.mjs`, `INV-03.json`) scans `server/` and `apps/` for literal non-v4 generator names. Dart's `uuid` package passes only as `Uuid().v4()`, `const Uuid().v4()`; a variable named `uuid1`, `uuid6` or `uuid7` fails. Java, Kotlin and Swift generators that are not literal names (`UUID.nameUUIDFromBytes`, `Generators.timeBasedEpochGenerator()`) are not covered, and `packages/` is outside the scan;
  - **every migration author:** a column default that names a UUID generator other than exactly `gen_random_uuid()` (of any column type) fails `schema.test.mjs`, so does a `SERIAL` or `IDENTITY` column outside the schema `sabredav` and `public.pgmigrations`; `event_envelopes`, `user_keys`, `user_key_wraps` and `calendar_keys` have composite natural keys and no generated id.
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

- **Free-text values on Private calendars (E03-R09 review 2).** The allow-list is of names, parameters and components, plus the fixed values of the table. The values of allowed properties are not inspected, so `UID:Chemo with Dr Smith`, a `TZID` parameter with a clinic's name, `PRODID` and `X-LIC-LOCATION` are all stored in cleartext. The README says so. A server-side backstop for `UID` is possible: INV-03 says our code creates UUIDv4 UIDs and ADR 0001 says no stock app ever edits a Private calendar, so the guard could require a UUIDv4 `UID` on Private. That is a change to E03-R09's table, hence an ADR 0001 amendment. Not started; say if you want it. A second reason came with E03-R10: a `PUT` body without `UID` is given `sabre-vobject-<uuid>` by SabreDAV's repair, which is not a UUIDv4 either.
