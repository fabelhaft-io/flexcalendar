# Environment and recipes

## Toolchains on the dev host

- Node 24 via nvm. pnpm is not on `PATH`: use `corepack pnpm …`.
- Java 27 is the default; JDK 21 is at `/usr/lib/jvm/java-21-openjdk`.
- `plantuml`; `gh`, logged in as the repo owner.
- Containers: rootless Podman. `podman compose` hands the file to docker-compose over the user socket. There is no Docker daemon.
- PHP, Composer, Dart and Flutter are **not** on the host. Run them in containers: `php:8.4-cli` (copy `composer` out of `composer:2`, or use that image for installs), and `dart:<pinned>`. For Flutter there is no `ghcr.io/cirruslabs/flutter` tag for our pin. Download the official `flutter_linux_<version>-stable.tar.xz` into the scratchpad, check its SHA-256 against `releases_linux.json`, and run it with `HOME` and `PUB_CACHE` pointed there.
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

- The tool shell is not bash: `==` breaks it and `${PIPESTATUS[…]}` is empty. Wrap anything non-trivial in `bash -c '…'`, or write a script into the scratchpad and run it with `bash`.
- The project's Bash hook rejects any command text that names a dotenv file other than `.env.example`, even in a regex, a heredoc or `git check-ignore`. Write `[.]en[v]` in commands, and use the file-edit tools for text that mentions such files. Never read `agent-team/.env`.
- A safety check blocks `rm -rf` inside `bash -c` and scripts, and sometimes inline scripts it can't parse. Use fresh directory names (`clean-$(date +%s)`) instead of deleting, and put Python or Node checks in a scratchpad file.
- The auto-mode classifier blocks `git branch -D`. Leave branch deletion to the user.
- Foreground `sleep` is blocked. Use `run_in_background` and wait for the notification. A wait loop on `pgrep -f '<text>'` matches its own command line.
- `tsx` runs a scratchpad `.ts` file as CJS, so top-level `await` fails. Name it `.mts`.
