#!/usr/bin/env bash
# --- E08-R10 · option A: a separate startup sequence -------------------------
#
# One-off `zitadel init` with admin credentials (CREATEDB + CREATEROLE, not a
# superuser), then `setup` and `start` as the app role without admin rights —
# the owner's leading hypothesis of 2026-10-09, quoted in E08-R10.
#
#   bash option-a.sh                 # one cold start, the privilege checks, teardown
#   bash option-a.sh --starts 10     # ten first starts from an empty volume
#   bash option-a.sh --upgrade       # then setup of the newest v4 against that database
#   bash option-a.sh --keep          # leave the project running for inspection
#
# Measured on 2026-10-12 in this harness's own project (results/2026-10-12/
# option-a.txt, option-a-starts.txt, option-a-upgrade.txt): ready after 4 s, the
# runtime role `calflex_zitadel` is a plain login with no attributes that is
# refused the sibling database, `CREATE ROLE` and `CREATE DATABASE`, the long
# running container holds no `ADMIN_*` variable, 10/10 cold starts reached
# `/debug/ready` (wall 210 s) and v4.19.4's `setup` ran on that database as the
# same role (ready after 1 s).
#
# Needs rootless `podman` with `podman compose`, `curl`, and the local stack's
# ports free: this harness publishes Zitadel's HTTP port on 127.0.0.1:18080
# only. It removes its own project (`calflex-zre-a`) with `down -v` at the end,
# on failure too unless `--keep` was given.
set -euo pipefail

readonly PROJECT=calflex-zre-a
HERE=$(dirname "$0")
readonly HERE
readonly COMPOSE_FILE="$HERE/compose.option-a.yaml"
readonly HTTP_PORT=18080
# shellcheck source=./lib.sh
source "$HERE/lib.sh"

# The one-off init job, run as an admin that is not a superuser. The role is
# created setup-style by SQL because `zitadel init` cannot create its own admin.
init_hook() {
  say "one-off: zitadel init, run as '$ZRE_ADMIN' (CREATEDB + CREATEROLE, not superuser)"
  pg_sql "$ZRE_SUPERUSER" postgres \
    "CREATE ROLE $ZRE_ADMIN LOGIN CREATEDB CREATEROLE PASSWORD '$ZRE_PW_ADMIN'"
  show "podman compose -p $PROJECT --profile init run --rm zitadel-init"
  compose --profile init run --rm -T zitadel-init
  pg_sql "$ZRE_SUPERUSER" postgres \
    "SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = 'zitadel'"
}

run_option init_hook "$ZRE_ROLE" "$@"
