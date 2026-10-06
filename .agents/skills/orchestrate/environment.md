# Environment and recipes

## Toolchains on the dev host

- Node 24 via nvm. pnpm is not on `PATH`: use `corepack pnpm …`.
- Java 27 is the default; JDK 21 is at `/usr/lib/jvm/java-21-openjdk`.
- `plantuml`; `gh`, logged in as the repo owner.
- Containers: rootless Podman. `podman compose` hands the file to docker-compose over the user socket. There is no Docker daemon.
- PHP, Composer, Dart and Flutter are **not** on the host. Run them in containers: `php:8.4-cli` (copy `composer` out of `composer:2`, or use that image for installs), and `dart:<pinned>`. For Flutter there is no `ghcr.io/cirruslabs/flutter` tag for our pin. Download the official tarball into the scratch directory, `https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_<version>-stable.tar.xz`, and check its SHA-256 against the `stable` entry for that version in `https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json`.
- Shims in a directory on `PATH` let `make verify` and `make gen` run on the host. `php` runs with `--network host`, because the tooling tests reach host ports; `composer` is below. `flutter` and `dart` are shims too, not an exported `HOME`, because corepack and pnpm need the real one:

  ```sh
  #!/bin/sh
  # composer
  exec podman run --rm -v "$PWD":/app:Z -v <scratch>/composer:/usr/local/bin/composer:ro,Z -w /app <php image> composer "$@"
  ```

  ```sh
  #!/bin/sh
  # flutter (the dart shim is the same with .../flutter/bin/dart)
  HOME=<scratch>/home PUB_CACHE=<scratch>/pub-cache FLUTTER_SUPPRESS_ANALYTICS=true DART_SUPPRESS_ANALYTICS=true CI=true exec <scratch>/flutter/bin/flutter "$@"
  ```

- **`pdo_pgsql`.** `server/caldav/composer.json` requires `ext-pdo_pgsql`, and neither `php:8.4-cli` nor `composer:2` has it (checked 2026-10-07). A `vendor/` installed by a PHP that does (the implementer sandbox's) embeds a platform check that fails under the plain image ("Composer detected issues in your platform"). Either install `vendor/` with `composer install --ignore-platform-req=ext-pdo_pgsql`, which leaves the extension out of the check, or build a derived image (`FROM docker.io/library/php:8.4-cli`, `apt-get install -y libpq-dev unzip git`, `docker-php-ext-install pdo_pgsql`) and use it in the `php` and `composer` shims. `php:8.4-cli` has no `unzip`, so install `vendor/` with `composer:2` or the derived image.
- `make verify-tooling` runs `php` and binds host ports 8080 and 3000: keep them free and `php` on `PATH`.
- Since E02-R07 `make verify` and `make gen` need the pinned Flutter on `PATH`. `flutter pub get` and `flutter analyze` in `apps/mobile` leave an untracked `apps/mobile/android/app/src/main/java/io/flutter/plugins/GeneratedPluginRegistrant.java`. Remove it and the empty directories before you re-run the coordinator, which refuses a dirty worktree.
- The implementer sandbox has its own pinned static PHP and Composer (`agent-team/src/lib/toolchains.ts`), no Podman, and no stack access.

## The local stack (`make dev`, project `calendar-flex-dev`)

- Caddy publishes `CALFLEX_HTTPS_PORT` (8443), and listens on 8443 inside the network whatever the port. Hosts: `caldav.`, `api.`, `auth.` (Zitadel, login UI at `/ui/v2/login`) and `mailpit.` under `.localhost`.
- For curl, trust Caddy's CA and never use `-k`: `podman cp calendar-flex-dev-caddy-1:/data/caddy/pki/authorities/local/root.crt <scratch>/root.crt`, then `--cacert <scratch>/root.crt`.
- `make seed` creates `alice` and `bob`. To check users yourself, read the seed PAT from the `calendar-flex-dev_zitadel-bootstrap` volume (never print it) and call `POST /v2/users`.
- Non-default port: run a second stack with `COMPOSE_PROJECT_NAME=cfport CALFLEX_HTTPS_PORT=9443 make dev …`, and remove it with `make dev-reset` under the same variables.
- Leave the default stack stopped (`make dev-down`) when you're done. Every worktree uses the same project name, so `make dev-down` from any checkout stops it, and a stack started from a requirement's worktree builds that worktree's files: don't edit them while it builds.

## Shell pitfalls

- The owner's login shell is fish, not bash: `==` breaks it, `${PIPESTATUS[…]}` is empty, and `set -- $var` in a loop is fish's `set`, so the fields come out empty. Wrap anything non-trivial in `bash -c '…'`, or write a script into the scratch directory and run it with `bash`.
- Never read `agent-team/.env` (the model API keys).
- Leave branch deletion to the owner.
- A wait loop on `pgrep -f '<text>'` matches its own command line; wait on the background job itself instead.
- `tsx` runs a `.ts` file outside a package as CJS, so top-level `await` fails. Name it `.mts`.
- Tool-specific restrictions (hooks, safety checks) are in that tool's own skill, for example `.claude/skills/orchestrate/SKILL.md`.
