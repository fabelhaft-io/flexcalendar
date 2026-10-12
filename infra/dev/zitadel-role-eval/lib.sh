#!/usr/bin/env bash
# --- E08-R10 · harness shared helpers ----------------------------------------
#
# Sourced by `option-a.sh`, `option-b.sh`, `option-b2.sh` and `option-c.sh`.
# Never executed on its own.
#
# shellcheck disable=SC2034  # the constants below are the sourced file's API:
# the option scripts read them in their init hooks and pass them to run_option.

# Everything here runs against **this harness's own rootless `podman compose`
# project** (`calflex-zre-<option>`): its own compose file, its own volume and
# its own network. It never touches `flexcalendar-dev`, never publishes a port
# the local stack uses (the only published port is Zitadel's HTTP port on
# 127.0.0.1, so the reviewer can read `/debug/ready` and no host port is shared
# with the default stack) and it removes its project with `down -v` when done.
#
# The credentials below are throwaway values for this harness's throwaway
# cluster. They are also written into the compose files in plain text on
# purpose: a throwaway password that nobody can read is not a working harness.
# No script prints a password: the SQL client takes it from `PGPASSWORD`, and
# the environment report prints names only.
set -euo pipefail

# These constants are this file's public surface: the option scripts read them
# in their init hooks and pass them to run_option.
readonly ZRE_PINNED_TAG="${ZRE_PINNED_TAG:-v4.16.0}"
readonly ZRE_UPGRADE_TAG="${ZRE_UPGRADE_TAG:-v4.19.4}"
readonly ZRE_MASTERKEY="${ZRE_MASTERKEY:-MasterkeyNeedsToHave32Characters}"
readonly ZRE_HEALTH_TIMEOUT="${ZRE_HEALTH_TIMEOUT:-240}"

# The cluster superuser of this throwaway project (the role option C runs as).
readonly ZRE_SUPERUSER=zre_root
readonly ZRE_PW_SUPERUSER=zre-throwaway-root
# The admin of option A's one-off `init` (CREATEDB + CREATEROLE, not superuser).
readonly ZRE_ADMIN=zre_admin
readonly ZRE_PW_ADMIN=zre-throwaway-admin
# The role Zitadel runs as, in every option.
readonly ZRE_ROLE=calflex_zitadel
readonly ZRE_PW_ROLE=zre-throwaway-zitadel
# The stand-in for the sibling database (E04-R02's `caldav`).
readonly ZRE_CALDAV_ROLE=calflex_caldav
readonly ZRE_CALDAV_DB=caldav
readonly ZRE_PW_CALDAV=zre-throwaway-caldav

PROJECT=""
COMPOSE_FILE=""
HTTP_PORT=""
HEALTHY_SECONDS=""

say() { printf '\n### %s\n' "$*"; }
show() { printf '+ %s\n' "$*"; }
mask() { sed -E 's/(PASSWORD|password)=[^ ]+/\1=***/g; s#(://[^:]+:)[^@]+@#\1***@#g'; }

compose() { podman compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }

require_podman() {
  if ! command -v podman >/dev/null 2>&1; then
    echo "podman is not on PATH: this harness needs rootless podman + podman compose" >&2
    exit 2
  fi
  show "podman --version"; podman --version
  show "podman compose version"; podman compose version
}

# --- SQL, run inside the project's own Postgres container --------------------

# pg_sql <role> <db> <password> <one statement>
# Prints the command (password masked) before its output, and keeps going when
# the statement is *supposed* to be refused.
pg_sql() {
  local role=$1 db=$2 pw=$3 statement=$4
  show "podman compose -p $PROJECT exec -T -e PGPASSWORD=*** postgres psql -h 127.0.0.1 -U $role -d $db -c \"$statement\""
  compose exec -T -e "PGPASSWORD=$pw" postgres \
    psql -h 127.0.0.1 -U "$role" -d "$db" -X -A -F ' | ' -v ON_ERROR_STOP=0 -c "$statement" 2>&1 || true
}

# psql_meta <role> <db> <password> <meta command>  (for `\du`)
psql_meta() {
  local role=$1 db=$2 pw=$3 meta=$4
  show "podman compose -p $PROJECT exec -T -e PGPASSWORD=*** postgres psql -h 127.0.0.1 -U $role -d $db -c '$meta'"
  compose exec -T -e "PGPASSWORD=$pw" postgres \
    psql -h 127.0.0.1 -U "$role" -d "$db" -X -c "$meta" 2>&1 || true
}

# --- the checks E08-R10 lists ------------------------------------------------

privilege_report() {
  local role=$1 pw=$2
  say "privileges at runtime — role '$role'"
  psql_meta "$ZRE_SUPERUSER" postgres "$ZRE_PW_SUPERUSER" '\du'
  pg_sql "$role" postgres "$pw" \
    "SELECT datname, has_database_privilege('$role', datname, 'CONNECT') AS connect, has_database_privilege('$role', datname, 'CREATE') AS create, has_database_privilege('$role', datname, 'TEMP') AS temp FROM pg_database WHERE NOT datistemplate ORDER BY datname"
  pg_sql "$role" "$ZRE_CALDAV_DB" "$pw" "SELECT session_user, current_user"
  pg_sql "$role" "$ZRE_CALDAV_DB" "$pw" "SELECT count(*) FROM public.calendars"
  pg_sql "$role" postgres "$pw" "CREATE ROLE zre_probe_must_fail LOGIN"
  pg_sql "$role" postgres "$pw" "CREATE DATABASE zre_probe_must_fail"
  say "optional hardening: revoke CONNECT on the sibling database from PUBLIC"
  pg_sql "$ZRE_SUPERUSER" postgres "$ZRE_PW_SUPERUSER" "REVOKE ALL ON DATABASE $ZRE_CALDAV_DB FROM PUBLIC"
  pg_sql "$role" "$ZRE_CALDAV_DB" "$pw" "SELECT count(*) FROM public.calendars"
}

# Do admin credentials live in the Zitadel container? The image has no shell —
# `find` over the pinned image's layers shows only `/app/zitadel`,
# `/etc/passwd` and `/etc/ssl` — so `podman exec … env` cannot work at all. The
# report therefore shows that failure and then reads the environment Podman
# gave the container, names only.
runtime_env_report() {
  local service=$1 cid
  cid=$(compose ps -q "$service" | head -1)
  say "environment of the '$service' container (names only, values masked)"
  show "podman exec $cid env"
  podman exec "$cid" env 2>&1 | head -3 || true
  show "podman inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $cid"
  podman inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$cid" | \
    sed -E 's/=.*/=***/' | sort
  local admin
  admin=$(podman inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$cid" | grep -c 'ADMIN_' || true)
  printf '-> %s ZITADEL_DATABASE_POSTGRES_ADMIN_* variables in the container\n' "$admin"
  show "podman inspect --format '{{.Config.Cmd}} {{.Args}} {{.ImageName}}' $cid"
  podman inspect --format '{{.Config.Cmd}} {{.Args}} {{.ImageName}}' "$cid"
  show "podman exec $cid ls -la / 2>&1  # no shell in this image; expected to fail"
  podman exec "$cid" ls -la / 2>&1 | head -3 || true
}

# --- starting the stack ------------------------------------------------------

wait_postgres() {
  local i
  for i in $(seq 1 60); do
    if compose exec -T postgres pg_isready --host 127.0.0.1 --username "$ZRE_SUPERUSER" --dbname postgres >/dev/null 2>&1; then
      echo "postgres is ready (after ${i}s)"
      return 0
    fi
    sleep 1
  done
  echo "postgres did not become ready" >&2
  compose logs --tail 20 postgres || true
  return 1
}

# wait_ready <label>: polls the published /debug/ready, records the seconds.
wait_ready() {
  local label=$1 i code=000 start
  start=$(date +%s)
  for i in $(seq 1 "$ZRE_HEALTH_TIMEOUT"); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HTTP_PORT/debug/ready" || true)
    if [ "$code" = "200" ]; then break; fi
    sleep 1
  done
  HEALTHY_SECONDS=$(( $(date +%s) - start ))
  echo "$label: /debug/ready -> HTTP $code after ${HEALTHY_SECONDS}s"
  if [ "$code" != "200" ]; then
    echo "--- last 25 log lines of the 'zitadel' service ---"
    compose logs --tail 25 zitadel | mask
    return 1
  fi
  return 0
}

# start_from_empty_volume <init-hook>
# `down -v` (empty volume), start Postgres, run the option's bootstrap hook,
# start Zitadel, wait for ready.
start_from_empty_volume() {
  local init_hook=$1
  say "empty volume: podman compose -p $PROJECT down -v"
  compose down -v --remove-orphans || true
  show "podman compose -p $PROJECT up -d postgres"
  compose up -d postgres
  wait_postgres
  "$init_hook"
  show "podman compose -p $PROJECT up -d zitadel"
  compose up -d zitadel
}

# --- modes -------------------------------------------------------------------

# starts_mode <n> <init-hook>
starts_mode() {
  local count=$1 init_hook=$2 i rc ok=0 wall start log
  log=$(mktemp -d)
  wall=$(date +%s)
  for i in $(seq 1 "$count"); do
    rc=0
    if ! start_from_empty_volume "$init_hook" >"$log/start-$i.log" 2>&1; then
      echo "start $i: bringing the stack up failed, see $log/start-$i.log"
    fi
    start=$(date +%s)
    wait_ready "start $i/$count" || rc=$?
    printf 'start %2s/%s: rc=%s time_to_ready=%ss wall=%ss\n' \
      "$i" "$count" "$rc" "$HEALTHY_SECONDS" "$(( $(date +%s) - start ))"
    if [ "$rc" -eq 0 ]; then ok=$((ok + 1)); fi
  done
  say "$PROJECT: $ok/$count first starts from an empty volume reached /debug/ready (wall $(( $(date +%s) - wall ))s)"
}

# upgrade_mode <init-hook>
# The pinned version sets the database up; then the same service restarts on
# the newest v4 release, still as the same runtime role, and `setup` runs from
# the newer binary (E08-R08).
upgrade_mode() {
  local init_hook=$1
  change_tag "$ZRE_PINNED_TAG"
  start_from_empty_volume "$init_hook"
  wait_ready "pinned $ZRE_PINNED_TAG"
  say "upgrade rehearsal: same role, database created by $ZRE_PINNED_TAG, image $ZRE_UPGRADE_TAG"
  change_tag "$ZRE_UPGRADE_TAG"
  show "podman compose -p $PROJECT up -d --force-recreate zitadel   # ZRE_IMAGE_TAG=$ZRE_UPGRADE_TAG"
  ZRE_IMAGE_TAG="$ZRE_UPGRADE_TAG" compose up -d --force-recreate zitadel
  wait_ready "upgrade $ZRE_UPGRADE_TAG"
  runtime_env_report zitadel
}

change_tag() {
  local tag=$1
  echo "image tag for this run: $tag"
  export ZRE_IMAGE_TAG="$tag"
}

teardown() {
  say "removing this harness's own project (never flexcalendar-dev)"
  show "podman compose -p $PROJECT down -v --remove-orphans"
  compose down -v --remove-orphans || true
}

# --- the CLI every option script shares --------------------------------------

# run_option <init-hook> <runtime-role> <runtime-password>
run_option() {
  local init_hook=$1 role=$2 pw=$3
  shift 3
  local starts=0 upgrade=0 keep=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --starts) starts=${2:-10}; shift 2 ;;
      --upgrade) upgrade=1; shift ;;
      --keep) keep=1; shift ;;
      *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
  done
  require_podman
  if [ "$upgrade" -eq 1 ]; then
    upgrade_mode "$init_hook"
    teardown
    return
  fi
  if [ "$starts" -gt 0 ]; then
    starts_mode "$starts" "$init_hook"
    teardown
    return
  fi
  start_from_empty_volume "$init_hook"
  if ! wait_ready "pinned $ZRE_PINNED_TAG"; then
    printf 'option %s did not start; leaving the project in place\n' "$PROJECT" >&2
    return 1
  fi
  runtime_env_report zitadel
  privilege_report "$role" "$pw"
  if [ "$keep" -eq 0 ]; then
    teardown
  else
    say "kept: podman compose -p $PROJECT ps   (remove with podman compose -p $PROJECT down -v)"
  fi
}
