#!/usr/bin/env bash
# --- E08-R10 · option B2: pre-provisioned role, one-off internals init -------
#
# Option B plus the one step it is missing: a one-off `zitadel init zitadel`
# job that runs as the app role (no admin credentials at all) and creates the
# internals inside the database the role owns. The long running service then
# runs `start-from-setup` as the same role.
#
#   bash option-b2.sh                # one cold start, the privilege checks, teardown
#   bash option-b2.sh --starts 10    # ten first starts from an empty volume
#   bash option-b2.sh --upgrade      # then setup of the newest v4 against that database
#   bash option-b2.sh --keep         # leave the project running for inspection
#
# Measured on 2026-10-12 in this harness's own project (results/2026-10-12/
# option-b2.txt, option-b2-starts.txt, option-b2-upgrade.txt): ready after 5 s,
# the one-off `zitadel init zitadel` job ran as `calflex_zitadel` alone, the
# runtime role is a plain login with no attributes that is refused the sibling
# database, `CREATE ROLE` and `CREATE DATABASE`, the container holds no
# `ADMIN_*` variable, 10/10 cold starts reached `/debug/ready` (wall 208 s) and
# v4.19.4's `setup` ran on that database as the same role (ready after 2 s).
# This is the shape the ADR recommends.
#
# Needs rootless `podman` with `podman compose` and `curl`; publishes Zitadel's
# HTTP port on 127.0.0.1:18082 only, and removes its own project
# (`calflex-zre-b2`) with `down -v` at the end, on failure too unless `--keep`
# was given.
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
  pg_sql "$ZRE_SUPERUSER" postgres \
    "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = '$ZRE_ROLE'"
}

run_option init_hook "$ZRE_ROLE" "$@"
