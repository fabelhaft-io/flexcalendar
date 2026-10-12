#!/usr/bin/env bash
# --- E08-R10 · option B2: pre-provisioned role, one-off internals init -------
#
# Option B plus the one step it is missing: a one-off `zitadel init zitadel`
# job that runs as the app role (no admin credentials at all) and creates the
# internals inside the database the role owns. The long running service then
# runs `start-from-setup` as the same role.
#
#   ./option-b2.sh                # one cold start, the privilege checks, teardown
#   ./option-b2.sh --starts 10    # ten first starts from an empty volume
#   ./option-b2.sh --upgrade      # then setup of the newest v4 against that database
#   ./option-b2.sh --keep         # leave the project running for inspection
#
# Measured on 2026-10-12: this starts, the runtime role is a plain login
# without CREATEDB, CREATEROLE or superuser, and the container holds no admin
# credential. This is the shape the ADR recommends.
#
# Needs rootless `podman` with `podman compose` and `curl`; publishes Zitadel's
# HTTP port on 127.0.0.1:18082 only, and removes its own project
# (`calflex-zre-b2`) with `down -v` at the end.
set -euo pipefail

readonly PROJECT=calflex-zre-b2
HERE=$(dirname "$0")
readonly HERE
readonly COMPOSE_FILE="$HERE/compose.option-b2.yaml"
readonly HTTP_PORT=18082
# shellcheck source=./lib.sh
source "$HERE/lib.sh"

init_hook() {
  say "one-off: zitadel init zitadel, run as '$ZRE_ROLE' — no admin credentials"
  show "podman compose -p $PROJECT --profile init run --rm zitadel-init"
  compose --profile init run --rm -T zitadel-init
  pg_sql "$ZRE_SUPERUSER" postgres "$ZRE_PW_SUPERUSER" \
    "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = '$ZRE_ROLE'"
}

run_option init_hook "$ZRE_ROLE" "$ZRE_PW_ROLE" "$@"
