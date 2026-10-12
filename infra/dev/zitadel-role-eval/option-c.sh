#!/usr/bin/env bash
# --- E08-R10 · option C: the status quo --------------------------------------
#
# `start-from-init` as the cluster superuser, which is what `infra/dev/compose.yaml`
# does today: the DSN user is also the admin. Nothing is separated, and a
# compromise of the IdP reaches every database in the cluster.
#
#   ./option-c.sh                 # one cold start, the privilege checks, teardown
#   ./option-c.sh --starts 10     # ten first starts from an empty volume
#   ./option-c.sh --upgrade       # then setup of the newest v4 against that database
#   ./option-c.sh --keep          # leave the project running for inspection
#
# Measured on 2026-10-12: this starts, and the runtime role is a superuser that
# reads the sibling `caldav` database, creates roles and creates databases.
#
# Needs rootless `podman` with `podman compose` and `curl`; publishes Zitadel's
# HTTP port on 127.0.0.1:18083 only, and removes its own project
# (`calflex-zre-c`) with `down -v` at the end.
set -euo pipefail

readonly PROJECT=calflex-zre-c
HERE=$(dirname "$0")
readonly HERE
readonly COMPOSE_FILE="$HERE/compose.option-c.yaml"
readonly HTTP_PORT=18083
# shellcheck source=./lib.sh
source "$HERE/lib.sh"

init_hook() {
  say "status quo: no separate bootstrap, the superuser does everything"
  pg_sql "$ZRE_SUPERUSER" postgres "$ZRE_PW_SUPERUSER" \
    "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = '$ZRE_SUPERUSER'"
}

run_option init_hook "$ZRE_SUPERUSER" "$ZRE_PW_SUPERUSER" "$@"
