# Environment and recipes

## Toolchains on the dev host

- Node 24 via nvm. pnpm is not on `PATH`: use `corepack pnpm …`.
- Java 27 is the default; JDK 21 is at `/usr/lib/jvm/java-21-openjdk`.
- `plantuml`; `gh`, logged in as the repo owner.
- Containers: rootless Podman. `podman compose` hands the file to docker-compose over the user socket. There is no Docker daemon.
- PHP, Composer, Dart and Flutter are **not** installed system-wide. **Run `make host-tools` once per machine** (again when a pin changes): it puts the pinned ones on `PATH` as shims in `~/.local/bin`, with no root and no containers, so `make verify` and `make gen` run on the host. It is idempotent, and it never overwrites a file in the bin directory that it did not write.
  - PHP and Composer are the implementer sandbox's pinned static build (`agent-team/src/lib/toolchains.ts`, hash-checked), kept in `~/.cache/flexcalendar-agent-team-tools/`. It includes `pdo_pgsql`, so the platform check in a `vendor/` installed by the sandbox also passes on the host. The shims point `PHPRC` at a `php.ini` with `memory_limit = -1`, because a static PHP has none and PHPStan's workers crash at the 128M default. PHPStan prints "Unable to load dynamic library … phpstan_turbo" on this PHP; the warning is harmless.
  - Flutter is the version in `apps/mobile/.fvmrc`, checked against the SHA-256 in Google's `releases_linux.json`, kept in `~/.cache/flexcalendar-host-tools/`. Dart is the one inside it. The two shims run with a private `HOME` and pub cache, because corepack and pnpm need the real `HOME` and Flutter's own state doesn't belong in it; Gradle's home and the Android SDK stay the real ones.
  - Container PHP is no substitute: `php:8.4-cli` and `composer:2` have no `pdo_pgsql` (checked 2026-10-07), so Composer's platform check fails on a `vendor/` built with it unless you pass `--ignore-platform-req=ext-pdo_pgsql`.
- `make verify-tooling` runs `php` and binds host ports 8080 and 3000: keep them free and `php` on `PATH`.
- Since E02-R07 `make verify` and `make gen` need the pinned Flutter on `PATH`. `flutter pub get` and `flutter analyze` in `apps/mobile` leave an untracked `apps/mobile/android/app/src/main/java/io/flutter/plugins/GeneratedPluginRegistrant.java`. Remove it and the empty directories before you re-run the coordinator, which refuses a dirty worktree.
- The implementer sandbox has its own pinned static PHP and Composer (`agent-team/src/lib/toolchains.ts`), no Podman, and no stack access.

## The local stack (`make dev`, project `flexcalendar-dev`)

- Caddy publishes `CALFLEX_HTTPS_PORT` (8443), and listens on 8443 inside the network whatever the port. Hosts: `caldav.`, `api.`, `auth.` (Zitadel, login UI at `/ui/v2/login`) and `mailpit.` under `.localhost`.
- For curl, trust Caddy's CA and never use `-k`: `podman cp flexcalendar-dev-caddy-1:/data/caddy/pki/authorities/local/root.crt <scratch>/root.crt`, then `--cacert <scratch>/root.crt`.
- `make seed` creates `alice` and `bob`. To check users yourself, read the seed PAT from the `flexcalendar-dev_zitadel-bootstrap` volume (never print it) and call `POST /v2/users`.
- Non-default port: run a second stack with `COMPOSE_PROJECT_NAME=cfport CALFLEX_HTTPS_PORT=9443 make dev …`, and remove it with `make dev-reset` under the same variables.
- Leave the default stack stopped (`make dev-down`) when you're done. Every worktree uses the same project name, so `make dev-down` from any checkout stops it, and a stack started from a requirement's worktree builds that worktree's files: don't edit them while it builds.

## Shell pitfalls

- The owner's login shell is fish, not bash: `==` breaks it, `${PIPESTATUS[…]}` is empty, and `set -- $var` in a loop is fish's `set`, so the fields come out empty. Wrap anything non-trivial in `bash -c '…'`, or write a script into the scratch directory and run it with `bash`.
- Never read `agent-team/.env` (the model API keys).
- Leave branch deletion to the owner.
- A wait loop on `pgrep -f '<text>'` matches its own command line; wait on the background job itself instead.
- `tsx` runs a `.ts` file outside a package as CJS, so top-level `await` fails. Name it `.mts`.
- Tool-specific restrictions (hooks, safety checks) are in that tool's own skill, for example `.claude/skills/orchestrate/SKILL.md`.
