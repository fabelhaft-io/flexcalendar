#!/usr/bin/env bash
# --- E08-R10 · option B: a pre-provisioned role and no admin at all ----------
#
# The cluster bootstrap creates the `zitadel` database and a role that owns it
# (initdb/20-zitadel-role.sql), and Zitadel runs as that role only: no admin
# login, and `start-from-setup`, which skips `init`.
#
#   ./option-b.sh                 # one cold start, the privilege checks, teardown
#   ./option-b.sh --starts 10     # ten first starts from an empty volume
#   ./option-b.sh --upgrade       # then setup of the newest v4 against that database
#   ./option-b.sh --keep          # leave the project running for inspection
#
# Expected on 2026-10-12 (and the reason `option-b2.sh` exists): this does not
# start — `setup` stops on `40_init_push_func_v4` with
# `relation "eventstore.events" does not exist`, because the internals that
# `zitadel init` creates are missing. The script prints the service log on
# failure and exits non-zero.
#
# Needs rootless `podman` with `podman compose` and `curl`; publishes Zitadel's
# HTTP port on 127.0.0.1:18081 only, and removes its own project
# (`calflex-zre-b`) with `down -v` at the end.
set -euo pipefail

readonly PROJECT=calflex-zre-b
HERE=$(dirname "$0")
readonly HERE
readonly COMPOSE_FILE="$HERE/compose.option-b.yaml"
readonly HTTP_PORT=18081
# shellcheck source=./lib.sh
source "$HERE/lib.sh"

init_hook() {
  say "no one-off job: the bootstrap created the role and the database"
  pg_sql "$ZRE_SUPERUSER" postgres "$ZRE_PW_SUPERUSER" \
    "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = '$ZRE_ROLE'"
  pg_sql "$ZRE_SUPERUSER" postgres "$ZRE_PW_SUPERUSER" \
    "SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = 'zitadel'"
}

run_option init_hook "$ZRE_ROLE" "$ZRE_PW_ROLE" "$@"
