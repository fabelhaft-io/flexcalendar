# Environment and recipes

## Toolchains on the dev host

- Node 24 via nvm. pnpm is not on `PATH`: use `corepack pnpm …`.
- Java 27 is the default; JDK 21 is at `/usr/lib/jvm/java-21-openjdk`.
- `plantuml`; `gh`, logged in as the repo owner.
- Containers: rootless Podman. `podman compose` hands the file to docker-compose over the user socket. There is no Docker daemon.
- PHP, Composer, Dart and Flutter are **not** on the host. Run them in containers: `php:8.4-cli` (copy `composer` out of `composer:2`, or use that image for installs), and `dart:<pinned>`. For Flutter there is no `ghcr.io/cirruslabs/flutter` tag for our pin. Download the official `flutter_linux_<version>-stable.tar.xz` into the scratch directory, check its SHA-256 against `releases_linux.json`, and run it with `HOME` and `PUB_CACHE` pointed there.
- A `composer` shim on `PATH` that runs `php:8.4-cli` lets `make verify` run on the host:

  ```sh
  #!/bin/sh
  exec podman run --rm -v "$PWD":/app:Z -v <scratch>/composer:/usr/local/bin/composer:ro,Z -w /app docker.io/library/php:8.4-cli composer "$@"
  ```

- The implementer sandbox has its own pinned static PHP and Composer (`agent-team/src/lib/toolchains.ts`), no Podman, and no stack access.

## The local stack (`make dev`, project `calendar-flex-dev`)

- Caddy publishes `CALFLEX_HTTPS_PORT` (8443), and listens on 8443 inside the network whatever the port. Hosts: `caldav.`, `api.`, `auth.` (Zitadel, login UI at `/ui/v2/login`) and `mailpit.` under `.localhost`.
- For curl, trust Caddy's CA and never use `-k`: `podman cp calendar-flex-dev-caddy-1:/data/caddy/pki/authorities/local/root.crt <scratch>/root.crt`, then `--cacert <scratch>/root.crt`.
- `make seed` creates `alice` and `bob`. To check users yourself, read the seed PAT from the `calendar-flex-dev_zitadel-bootstrap` volume (never print it) and call `POST /v2/users`.
- Non-default port: run a second stack with `COMPOSE_PROJECT_NAME=cfport CALFLEX_HTTPS_PORT=9443 make dev …`, and remove it with `make dev-reset` under the same variables.
- Leave the default stack stopped (`make dev-down`) when you're done.

## Shell pitfalls

- The owner's login shell is fish, not bash: `==` breaks it and `${PIPESTATUS[…]}` is empty. Wrap anything non-trivial in `bash -c '…'`, or write a script into the scratch directory and run it with `bash`.
- Never read `agent-team/.env` (the model API keys).
- Leave branch deletion to the owner.
- A wait loop on `pgrep -f '<text>'` matches its own command line; wait on the background job itself instead.
- `tsx` runs a `.ts` file outside a package as CJS, so top-level `await` fails. Name it `.mts`.
- Tool-specific restrictions (hooks, safety checks) are in that tool's own skill, for example `.claude/skills/orchestrate/SKILL.md`.
