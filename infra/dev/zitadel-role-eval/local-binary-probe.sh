#!/usr/bin/env bash
# --- E08-R10 · Zitadel database role: the no-container measurement probe ------
#
# E08-R10 says "Nothing is implemented": the deliverable is the ADR plus the
# harness that produces its numbers. `option-a.sh`, `option-b.sh` and
# `option-c.sh` run the measurements against `podman compose`, which is how the
# reviewer runs them. This script runs the *same* measurements on the host
# process, for environments without a container runtime (the agent sandbox):
# it extracts the `zitadel` binary out of the pinned image
# `ghcr.io/zitadel/zitadel:v4.16.0` through the registry API (verifying the
# index digest) and runs it against a throwaway PostgreSQL 18 cluster whose
# binaries come from the Maven artifact
# `embedded-postgres-binaries-linux-amd64:18.6.0` (verified against a pinned
# SHA-256). Everything is unpacked under `$ZRE_CACHE`
# (`~/.cache/flexcalendar-agent-team/zre` by default) — never into the
# repository, which the coordinator commits: a 180 MB binary has no business in
# git.
#
# What this probe cannot measure, and the container scripts do:
#   - the image's own entrypoint, user (`zitadel`) and default environment;
#   - `podman exec … env` / `ls /zitadel/bootstrap`: whether admin credentials
#     remain in the container;
#   - the Postgres bootstrap `infra/dev/postgres/initdb/` itself, and the
#     entrypoint race of `postgres:18-alpine`.
#
# Usage:
#   local-binary-probe.sh <a|b|b2|c|init-matrix> [--starts N] [--upgrade] [--keep]
#
#   a            option A — one-off `zitadel init` with admin credentials
#                (CREATEDB + CREATEROLE, not superuser), then
#                `start-from-setup` as the app role
#   b            option B — the cluster bootstrap creates the database and the
#                owning role, `start-from-setup` as that role, no admin at all
#   b2           option B, plus only `zitadel init zitadel` ("ZITADEL
#                internals") as the app role — no admin credentials at all
#   b3           option B, but with `start-from-init` as the entrypoint and the
#                app role's own credentials configured as the admin ones
#   b4           option B3, except the database stays owned by the bootstrap
#                superuser (today's 10-zitadel-database.sql shape)
#   c            option C — status quo: `start-from-init` as the cluster
#                superuser
#   init-matrix  `zitadel init` under five privilege sets, to answer the epic's
#                "is CREATEROLE needed?" with a command and its output
#   --starts N   repeat the option's first start from an empty data directory N
#                times (default 10) and report each outcome and time to healthy
#   --upgrade    after a successful start of the pinned version, run the same
#                command of $ZRE_UPGRADE_VERSION (default v4.19.4) against the
#                same database as the same role
#   --keep       leave the throwaway cluster running for inspection
#
# The passwords below are throwaway values for this throwaway cluster only, and
# they are printed nowhere: every command that takes a password prints it
# masked, and the SQL client reads it from the environment.
#
# Requirements: curl, tar, xz, jq, sha256sum, and either `psql` or `php` with
# pdo_pgsql. PostgreSQL runs as the calling user and refuses to run as root.
set -euo pipefail

readonly ZRE_CACHE="${ZRE_CACHE:-$HOME/.cache/flexcalendar-agent-team/zre}"
readonly PINNED_VERSION="${ZRE_PINNED_VERSION:-v4.16.0}"
readonly UPGRADE_VERSION="${ZRE_UPGRADE_VERSION:-v4.19.4}"
# `Docker-Content-Digest` of the multi-arch index, read on 2026-10-12. The probe
# refuses a tag whose index digest moved. Pass "unknown" to skip the check for a
# version whose digest is not pinned yet.
readonly PINNED_INDEX_DIGEST="${ZRE_PINNED_INDEX_DIGEST:-sha256:15543f7a80c3e37905fe8c7db56af7ed2a9ece256704322c1449d7e8453afdab}"
readonly UPGRADE_INDEX_DIGEST="${ZRE_UPGRADE_INDEX_DIGEST:-sha256:90a3045b80a2b5b395e1e770302076906af3a5911225af7c464b4f3bd00d0a1b}"
readonly PG_JAR_URL="https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-linux-amd64/18.6.0/embedded-postgres-binaries-linux-amd64-18.6.0.jar"
readonly PG_JAR_SHA256="008ee189eaa7ca2b58bd01dd950291e638b998392cf982297acd4779ec898ac1"
readonly PG_DIR="$ZRE_CACHE/pg/embedded-postgres-binaries-linux-amd64-18.6.0"
readonly PGBIN="$PG_DIR/bin"
readonly PGPORT="${ZRE_PGPORT:-55432}"
readonly ZPORT="${ZRE_ZITADEL_PORT:-18080}"
readonly MASTERKEY="${ZRE_MASTERKEY:-MasterkeyNeedsToHave32Characters}"
readonly PGDATABASE_ZITADEL=zitadel
readonly PGDATABASE_CALDAV=caldav
readonly ROLE_SUPERUSER=postgres
readonly ROLE_ADMIN=zre_admin
readonly ROLE_ZITADEL=calflex_zitadel
readonly ROLE_CALDAV=calflex_caldav
readonly PW_ADMIN=zre-throwaway-admin
readonly PW_ZITADEL=zre-throwaway-zitadel
readonly PW_CALDAV=zre-throwaway-caldav
readonly PW_SUPERUSER=ZreThrowawayRoot1!
readonly PW_LIMITED=ZreThrowaway1!

WORK="$ZRE_CACHE/work"
LOGDIR="$ZRE_CACHE/logs"
DATA=""
ZPID=""
HEALTHY_SECONDS=""
OPTION="once"

# --------------------------------------------------------------------------
# output helpers
# --------------------------------------------------------------------------

say() { printf '\n### %s\n' "$*"; }
show() { printf '+ %s\n' "$*"; }
mask() { sed -E 's/(PASSWORD|PASSWORD_) [^ ]+/\1 ***/g; s/(PASSWORD|password)=[^ ]+/\1=***/g; s#(://[^:]+:)[^@]+@#\1***@#g'; }

# --------------------------------------------------------------------------
# SQL client: psql when present, PHP's pdo_pgsql otherwise
# --------------------------------------------------------------------------

# shellcheck disable=SC2016  # PHP code: the single quotes are deliberate
readonly SQL_PHP='
$dsn = "pgsql:host=127.0.0.1;port=".getenv("PGZ_PORT").";dbname=".getenv("PGZ_DB");
try { $db = new PDO($dsn, getenv("PGZ_USER"), getenv("PGZ_PASSWORD"), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]); }
catch (Throwable $e) { echo "CONNECT FAILED: ".$e->getMessage()."\n"; exit(3); }
try { $st = $db->query(getenv("PGZ_SQL")); } catch (Throwable $e) { echo "ERROR: ".$e->getMessage()."\n"; exit(1); }
if ($st->columnCount() === 0) { echo "OK\n"; exit(0); }
$rows = $st->fetchAll(PDO::FETCH_ASSOC);
echo implode(" | ", array_keys($rows[0] ?? []))."\n";
foreach ($rows as $r) { echo implode(" | ", array_map(fn($v) => $v === null ? "" : (string)$v, $r))."\n"; }
'

# sql_as <role> <db> <password> <one statement>
# Prints the command (password masked) before its output, like the container
# scripts do with `podman exec … psql`.
sql_as() {
  local role=$1 db=$2 pw=$3 statement=$4
  show "psql -h 127.0.0.1 -p $PGPORT -U $role -d $db -c \"$statement\"   # password from PGPASSWORD"
  if command -v psql >/dev/null 2>&1; then
    PGPASSWORD="$pw" psql -h 127.0.0.1 -p "$PGPORT" -U "$role" -d "$db" -X -A -F ' | ' \
      -v ON_ERROR_STOP=0 -c "$statement" 2>&1 || true
  else
    PGZ_PORT="$PGPORT" PGZ_DB="$db" PGZ_USER="$role" PGZ_PASSWORD="$pw" PGZ_SQL="$statement" \
      php -r "$SQL_PHP" 2>&1 || true
  fi
}

# --------------------------------------------------------------------------
# downloads (verified, outside the worktree)
# --------------------------------------------------------------------------

require_tools() {
  local missing=() tool
  for tool in curl tar xz jq sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  if ! command -v psql >/dev/null 2>&1 && ! command -v php >/dev/null 2>&1; then
    missing+=("psql or php (for the SQL checks)")
  fi
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "probe needs: ${missing[*]}" >&2
    exit 2
  fi
}

registry_token() {
  curl -fsS 'https://ghcr.io/token?scope=repository:zitadel/zitadel:pull&service=ghcr.io' | jq -r .token
}

fetch_zitadel() {
  local version=$1 digest=$2 dest="$ZRE_CACHE/zitadel-$1"
  if [ -x "$dest/app/zitadel" ]; then
    show "$dest/app/zitadel already extracted"
    return
  fi
  local token tmp actual manifest
  token=$(registry_token)
  say "pulling ghcr.io/zitadel/zitadel:$version with the registry API (no container runtime)"
  show "curl -sI -H 'Accept: application/vnd.oci.image.index.v1+json' https://ghcr.io/v2/zitadel/zitadel/manifests/$version"
  actual=$(curl -fsSI -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json' \
    "https://ghcr.io/v2/zitadel/zitadel/manifests/$version" |
    awk -F': ' 'tolower($1) == "docker-content-digest" {print $2}' | tr -d '\r')
  echo "Docker-Content-Digest: $actual"
  if [ "$digest" != "unknown" ] && [ "$actual" != "$digest" ]; then
    echo "index digest of $version moved: expected $digest, got $actual" >&2
    exit 1
  fi
  tmp=$(mktemp -d "$ZRE_CACHE/manifest.XXXXXX")
  curl -fsS -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json' \
    "https://ghcr.io/v2/zitadel/zitadel/manifests/$version" >"$tmp/index.json"
  manifest=$(jq -r '[.manifests[] | select(.platform.architecture == "amd64" and .platform.os == "linux")][0].digest' "$tmp/index.json")
  echo "linux/amd64 manifest: $manifest"
  curl -fsS -H "Authorization: Bearer $token" -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
    "https://ghcr.io/v2/zitadel/zitadel/manifests/$manifest" >"$tmp/manifest.json"
  mkdir -p "$dest"
  local i=0 d
  while read -r d; do
    i=$((i + 1))
    show "curl -o layer$i.tgz https://ghcr.io/v2/zitadel/zitadel/blobs/$d"
    curl -fsSL -H "Authorization: Bearer $token" "https://ghcr.io/v2/zitadel/zitadel/blobs/$d" -o "$tmp/layer$i.tgz"
    tar -xzf "$tmp/layer$i.tgz" -C "$dest" 2>/dev/null || true
  done < <(jq -r '.layers[].digest' "$tmp/manifest.json")
  [ -x "$dest/app/zitadel" ] || { echo "no /app/zitadel in $version" >&2; exit 1; }
  echo "extracted $dest/app/zitadel"
  rm -rf "$tmp"
}

fetch_postgres() {
  local jar="$PG_DIR.jar"
  if [ -x "$PGBIN/postgres" ]; then
    show "$PGBIN/postgres already extracted"
    return
  fi
  say "unpacking PostgreSQL 18.6 binaries (Maven: embedded-postgres-binaries-linux-amd64:18.6.0)"
  mkdir -p "$PG_DIR"
  if [ ! -f "$jar" ]; then
    show "curl -o $jar $PG_JAR_URL"
    curl -fsSL "$PG_JAR_URL" -o "$jar"
  fi
  show "echo '$PG_JAR_SHA256  $jar' | sha256sum -c -"
  echo "$PG_JAR_SHA256  $jar" | sha256sum -c -
  ( cd "$PG_DIR" && unzip -o -q "$jar" postgres-linux-x86_64.txz && tar -xJf postgres-linux-x86_64.txz )
  "$PGBIN/postgres" --version
}

# --------------------------------------------------------------------------
# the throwaway cluster
# --------------------------------------------------------------------------

cluster_init() {
  local tag=$1
  DATA="$WORK/$tag/pgdata"
  # A short socket path: PostgreSQL refuses a Unix-domain socket path over 107
  # bytes, and $ZRE_CACHE is deep. The probe connects over TCP anyway.
  local sockdir="/tmp/zre-sock-$tag"
  rm -rf "$sockdir"
  mkdir -p "$sockdir" "$LOGDIR"
  show "initdb -D $DATA -U $ROLE_SUPERUSER --auth=scram-sha-256 --pwfile=<throwaway>"
  printf '%s\n' "$PW_SUPERUSER" >"/tmp/zre-pwfile-$tag"
  "$PGBIN/initdb" -D "$DATA" -U "$ROLE_SUPERUSER" --auth=scram-sha-256 --pwfile="/tmp/zre-pwfile-$tag" -E UTF8 >"$LOGDIR/$tag-initdb.log" 2>&1 ||
    { tail -5 "$LOGDIR/$tag-initdb.log"; exit 1; }
  rm -f "/tmp/zre-pwfile-$tag"
  printf "unix_socket_directories = '%s'\nport = %s\nlisten_addresses = '127.0.0.1'\n" "$sockdir" "$PGPORT" >>"$DATA/postgresql.conf"
  show "pg_ctl -D $DATA -l $LOGDIR/$tag-pg.log start"
  "$PGBIN/pg_ctl" -D "$DATA" -l "$LOGDIR/$tag-pg.log" -w start >/dev/null 2>&1 ||
    { cat "$LOGDIR/$tag-pg.log"; exit 1; }
  echo "PostgreSQL 18 up on 127.0.0.1:$PGPORT (scram-sha-256 — a role cannot borrow another role's identity)"
}

cluster_stop() {
  if [ -n "$DATA" ]; then
    "$PGBIN/pg_ctl" -D "$DATA" -m immediate -w stop >/dev/null 2>&1 || true
  fi
}

# `caldav` stands in for the sibling database (E04-R02's schema): a table with
# event-ish content that Zitadel's runtime role must not be able to read.
provision_caldav() {
  say "stand-in for the sibling database: $PGDATABASE_CALDAV, owned by $ROLE_CALDAV"
  sql_as "$ROLE_SUPERUSER" postgres "$PW_SUPERUSER" "CREATE ROLE $ROLE_CALDAV LOGIN PASSWORD '$PW_CALDAV'"
  sql_as "$ROLE_SUPERUSER" postgres "$PW_SUPERUSER" "CREATE DATABASE $PGDATABASE_CALDAV OWNER $ROLE_CALDAV"
  sql_as "$ROLE_CALDAV" "$PGDATABASE_CALDAV" "$PW_CALDAV" \
    "CREATE TABLE public.calendars (id int primary key, uid uuid)"
  sql_as "$ROLE_CALDAV" "$PGDATABASE_CALDAV" "$PW_CALDAV" \
    "INSERT INTO public.calendars (id, uid) VALUES (1, '11111111-1111-4111-8111-111111111111')"
}

# --------------------------------------------------------------------------
# the checks E08-R10 lists
# --------------------------------------------------------------------------

privilege_report() {
  local role=$1 pw=$2
  say "privileges at runtime — role '$role'"
  sql_as "$ROLE_SUPERUSER" postgres "$PW_SUPERUSER" \
    "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname"
  sql_as "$ROLE_SUPERUSER" postgres "$PW_SUPERUSER" \
    "SELECT datname, pg_get_userbyid(datdba) AS owner, datacl FROM pg_database WHERE NOT datistemplate ORDER BY datname"
  sql_as "$ROLE_SUPERUSER" postgres "$PW_SUPERUSER" \
    "SELECT datname, has_database_privilege('$role', datname, 'CONNECT') AS connect, has_database_privilege('$role', datname, 'CREATE') AS create, has_database_privilege('$role', datname, 'TEMP') AS temp FROM pg_database WHERE NOT datistemplate ORDER BY datname"
  sql_as "$role" "$PGDATABASE_CALDAV" "$pw" "SELECT session_user, current_user"
  sql_as "$role" "$PGDATABASE_CALDAV" "$pw" "SELECT count(*) FROM public.calendars"
  sql_as "$role" postgres "$pw" "CREATE ROLE zre_probe_must_fail LOGIN"
  sql_as "$role" postgres "$pw" "CREATE DATABASE zre_probe_must_fail"
  say "optional hardening: is CONNECT on the sibling database already denied?"
  sql_as "$ROLE_SUPERUSER" postgres "$PW_SUPERUSER" "REVOKE ALL ON DATABASE $PGDATABASE_CALDAV FROM PUBLIC"
  sql_as "$role" "$PGDATABASE_CALDAV" "$pw" "SELECT count(*) FROM public.calendars"
}

# The runtime environment of the Zitadel process, names only, values masked.
# The container scripts additionally check the container itself.
runtime_env_report() {
  local pair name admin_count=0
  say "environment handed to the Zitadel process (names only, values masked)"
  for pair in "$@"; do
    name=${pair%%=*}
    if [[ $name == *PASSWORD* ]]; then
      printf '  %s=***\n' "$name"
    else
      printf '  %s\n' "$pair"
    fi
    if [[ $name == *ADMIN_* ]]; then
      admin_count=$((admin_count + 1))
    fi
  done
  printf '  -> %s ZITADEL_DATABASE_POSTGRES_ADMIN_* variables in the runtime environment\n' "$admin_count"
}

# --------------------------------------------------------------------------
# running Zitadel
# --------------------------------------------------------------------------

# start_zitadel <version> <command> <label> [NAME=value…]
# Runs the server in the background, waits for /debug/ready, reports the time.
start_zitadel() {
  local version=$1 command=$2 label=$3
  shift 3
  local bin="$ZRE_CACHE/zitadel-$version/app/zitadel"
  local log="$LOGDIR/$version-$label.log"
  say "$label — $bin $command (Zitadel $version)"
  runtime_env_report "$@"
  local start code=000 i
  start=$(date +%s)
  env -i PATH="$PATH" HOME="$HOME" "$@" "$bin" "$command" --masterkey "$MASTERKEY" >"$log" 2>&1 &
  ZPID=$!
  for i in $(seq 1 "${ZRE_HEALTH_TIMEOUT:-240}"); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$ZPORT/debug/ready" || true)
    if [ "$code" = "200" ]; then break; fi
    if ! kill -0 "$ZPID" 2>/dev/null; then break; fi
    sleep 1
  done
  HEALTHY_SECONDS=$(( $(date +%s) - start ))
  echo "/debug/ready -> HTTP $code after ${HEALTHY_SECONDS}s"
  if [ "$code" != "200" ]; then
    echo "--- last 25 lines of $log ---"
    tail -25 "$log" | mask
    stop_zitadel
    return 1
  fi
  echo "healthy_in_seconds=$HEALTHY_SECONDS"
  return 0
}

stop_zitadel() {
  if [ -n "$ZPID" ] && kill -0 "$ZPID" 2>/dev/null; then
    kill "$ZPID" 2>/dev/null || true
    wait "$ZPID" 2>/dev/null || true
  fi
  ZPID=""
}

# The environment both `setup` and `start` need, minus the credentials.
common_env() {
  printf '%s\n' \
    "ZITADEL_DATABASE_POSTGRES_HOST=127.0.0.1" \
    "ZITADEL_DATABASE_POSTGRES_PORT=$PGPORT" \
    "ZITADEL_DATABASE_POSTGRES_DATABASE=$PGDATABASE_ZITADEL" \
    "ZITADEL_DATABASE_POSTGRES_USER_SSL_MODE=disable" \
    "ZITADEL_PORT=$ZPORT" \
    "ZITADEL_TLS_ENABLED=false" \
    "ZITADEL_EXTERNALSECURE=false" \
    "ZITADEL_EXTERNALDOMAIN=localhost" \
    "ZITADEL_FIRSTINSTANCE_ORG_NAME=flexcalendar" \
    "ZITADEL_FIRSTINSTANCE_ORG_HUMAN_USERNAME=calflex-admin" \
    "ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD=$PW_LIMITED" \
    "ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORDCHANGEREQUIRED=false"
}

# --------------------------------------------------------------------------
# per-option prepare / start
# --------------------------------------------------------------------------

# option C — status quo: the superuser login does init, setup and start.
prepare_c() { cluster_init c; provision_caldav; }

start_c() {
  local version=$1
  local -a args
  mapfile -t args < <(common_env)
  args+=("ZITADEL_DATABASE_POSTGRES_USER_USERNAME=$ROLE_SUPERUSER" "ZITADEL_DATABASE_POSTGRES_USER_PASSWORD=$PW_SUPERUSER")
  args+=("ZITADEL_DATABASE_POSTGRES_ADMIN_USERNAME=$ROLE_SUPERUSER" "ZITADEL_DATABASE_POSTGRES_ADMIN_PASSWORD=$PW_SUPERUSER")
  start_zitadel "$version" start-from-init "option-c-$version" "${args[@]}"
}

# option A — one-off `zitadel init` as an admin with CREATEDB + CREATEROLE,
# then `start-from-setup` as the app role.
prepare_a() {
  cluster_init a
  provision_caldav
  sql_as "$ROLE_SUPERUSER" postgres "$PW_SUPERUSER" "CREATE ROLE $ROLE_ADMIN LOGIN CREATEDB CREATEROLE PASSWORD '$PW_ADMIN'"
  say "one-off: zitadel init as '$ROLE_ADMIN' (CREATEDB + CREATEROLE, not superuser)"
  show "env ZITADEL_DATABASE_POSTGRES_ADMIN_USERNAME=$ROLE_ADMIN ZITADEL_DATABASE_POSTGRES_USER_USERNAME=$ROLE_ZITADEL ZITADEL_DATABASE_POSTGRES_DATABASE=$PGDATABASE_ZITADEL ZITADEL_DATABASE_POSTGRES_ADMIN_PASSWORD=*** zitadel init"
  local rc=0
  env -i PATH="$PATH" HOME="$HOME" \
    ZITADEL_DATABASE_POSTGRES_HOST=127.0.0.1 \
    ZITADEL_DATABASE_POSTGRES_PORT="$PGPORT" \
    ZITADEL_DATABASE_POSTGRES_DATABASE="$PGDATABASE_ZITADEL" \
    ZITADEL_DATABASE_POSTGRES_ADMIN_USERNAME="$ROLE_ADMIN" \
    ZITADEL_DATABASE_POSTGRES_ADMIN_PASSWORD="$PW_ADMIN" \
    ZITADEL_DATABASE_POSTGRES_ADMIN_SSL_MODE=disable \
    ZITADEL_DATABASE_POSTGRES_USER_USERNAME="$ROLE_ZITADEL" \
    ZITADEL_DATABASE_POSTGRES_USER_PASSWORD="$PW_ZITADEL" \
    ZITADEL_DATABASE_POSTGRES_USER_SSL_MODE=disable \
    "$ZRE_CACHE/zitadel-$PINNED_VERSION/app/zitadel" init >"$LOGDIR/option-a-init.log" 2>&1 || rc=$?
  echo "zitadel init exit=$rc"
  tail -8 "$LOGDIR/option-a-init.log" | mask
  [ "$rc" -eq 0 ] || return 1
  sql_as "$ROLE_SUPERUSER" postgres "$PW_SUPERUSER" \
    "SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = '$PGDATABASE_ZITADEL'"
  say "what the one-off init left behind in the database"
  sql_as "$ROLE_SUPERUSER" "$PGDATABASE_ZITADEL" "$PW_SUPERUSER" \
    "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY nspname"
  sql_as "$ROLE_SUPERUSER" "$PGDATABASE_ZITADEL" "$PW_SUPERUSER" \
    "SELECT table_schema, count(*) AS tables FROM information_schema.tables WHERE table_schema LIKE '%zitadel%' OR table_schema IN ('eventstore','projections','auth','notification','system') GROUP BY table_schema ORDER BY table_schema"
}

start_a() {
  local version=$1
  local -a args
  mapfile -t args < <(common_env)
  args+=("ZITADEL_DATABASE_POSTGRES_USER_USERNAME=$ROLE_ZITADEL" "ZITADEL_DATABASE_POSTGRES_USER_PASSWORD=$PW_ZITADEL")
  start_zitadel "$version" start-from-setup "option-$OPTION-$version" "${args[@]}"
}

# option B3 — the bootstrap creates database and role, and the entrypoint stays
# `start-from-init`, but there is no separate admin account: the admin
# credentials the init steps use ARE the app role's own.
start_b3() {
  local version=$1
  local -a args
  mapfile -t args < <(common_env)
  args+=("ZITADEL_DATABASE_POSTGRES_USER_USERNAME=$ROLE_ZITADEL" "ZITADEL_DATABASE_POSTGRES_USER_PASSWORD=$PW_ZITADEL")
  args+=("ZITADEL_DATABASE_POSTGRES_ADMIN_USERNAME=$ROLE_ZITADEL" "ZITADEL_DATABASE_POSTGRES_ADMIN_PASSWORD=$PW_ZITADEL")
  args+=("ZITADEL_DATABASE_POSTGRES_ADMIN_EXISTINGDATABASE=true")
  start_zitadel "$version" start-from-init "option-$OPTION-$version" "${args[@]}"
}

# option B — the bootstrap creates the database and the role that owns it.
prepare_b() {
  cluster_init b
  provision_caldav
  say "bootstrap outside Zitadel: CREATE ROLE $ROLE_ZITADEL LOGIN; CREATE DATABASE $PGDATABASE_ZITADEL OWNER $ROLE_ZITADEL (like infra/dev/postgres/initdb/20-roles.sql)"
  sql_as "$ROLE_SUPERUSER" postgres "$PW_SUPERUSER" "CREATE ROLE $ROLE_ZITADEL LOGIN PASSWORD '$PW_ZITADEL'"
  sql_as "$ROLE_SUPERUSER" postgres "$PW_SUPERUSER" "CREATE DATABASE $PGDATABASE_ZITADEL OWNER $ROLE_ZITADEL"
  sql_as "$ROLE_SUPERUSER" postgres "$PW_SUPERUSER" "REVOKE ALL ON DATABASE $PGDATABASE_ZITADEL FROM PUBLIC"
}

# option B4 — the same role, but the database stays owned by the bootstrap
# superuser (the shape `10-zitadel-database.sql` has today), so the app role has
# no grant rights of its own.
prepare_b4() {
  cluster_init b
  provision_caldav
  say "bootstrap outside Zitadel: CREATE ROLE $ROLE_ZITADEL LOGIN; CREATE DATABASE $PGDATABASE_ZITADEL OWNER $ROLE_SUPERUSER (today's 10-zitadel-database.sql shape)"
  sql_as "$ROLE_SUPERUSER" postgres "$PW_SUPERUSER" "CREATE ROLE $ROLE_ZITADEL LOGIN PASSWORD '$PW_ZITADEL'"
  sql_as "$ROLE_SUPERUSER" postgres "$PW_SUPERUSER" "CREATE DATABASE $PGDATABASE_ZITADEL OWNER $ROLE_SUPERUSER"
}

prepare_b2() {  prepare_b
  say "no admin at all: 'zitadel init zitadel' (ZITADEL internals) as $ROLE_ZITADEL"
  show "zitadel init zitadel --help"
  "$ZRE_CACHE/zitadel-$PINNED_VERSION/app/zitadel" init zitadel --help 2>&1 | head -20
  local rc=0
  env -i PATH="$PATH" HOME="$HOME" \
    ZITADEL_DATABASE_POSTGRES_HOST=127.0.0.1 \
    ZITADEL_DATABASE_POSTGRES_PORT="$PGPORT" \
    ZITADEL_DATABASE_POSTGRES_DATABASE="$PGDATABASE_ZITADEL" \
    ZITADEL_DATABASE_POSTGRES_USER_USERNAME="$ROLE_ZITADEL" \
    ZITADEL_DATABASE_POSTGRES_USER_PASSWORD="$PW_ZITADEL" \
    ZITADEL_DATABASE_POSTGRES_USER_SSL_MODE=disable \
    "$ZRE_CACHE/zitadel-$PINNED_VERSION/app/zitadel" init zitadel >"$LOGDIR/option-b2-init.log" 2>&1 || rc=$?
  echo "zitadel init zitadel exit=$rc"
  tail -8 "$LOGDIR/option-b2-init.log" | mask
  [ "$rc" -eq 0 ] || return 1
}

start_b() {
  local version=$1
  local -a args
  mapfile -t args < <(common_env)
  args+=("ZITADEL_DATABASE_POSTGRES_USER_USERNAME=$ROLE_ZITADEL" "ZITADEL_DATABASE_POSTGRES_USER_PASSWORD=$PW_ZITADEL")
  start_zitadel "$version" start-from-setup "option-$OPTION-$version" "${args[@]}"
}

# The privilege matrix for `init` itself.
run_init_matrix() {
  WORK="$ZRE_CACHE/work/init-matrix"
  rm -rf "$WORK"
  mkdir -p "$WORK" "$LOGDIR"
  cluster_init init-matrix
  provision_caldav
  local -a names=("superuser" "createdb+createrole" "createdb only" "no createdb, no createrole" "database already exists, no createdb")
  local -a roles=("$ROLE_SUPERUSER" "zre_createdb_createrole" "zre_createdb_only" "zre_plain" "zre_existingdb")
  local -a tags=("superuser" "createdb-createrole" "createdb" "plain" "existingdb")
  local i rc database app_role
  for i in "${!names[@]}"; do
    case "${tags[$i]}" in
      createdb-createrole) sql_as "$ROLE_SUPERUSER" postgres "$PW_SUPERUSER" "CREATE ROLE ${roles[$i]} LOGIN CREATEDB CREATEROLE PASSWORD '$PW_ADMIN'" ;;
      createdb) sql_as "$ROLE_SUPERUSER" postgres "$PW_SUPERUSER" "CREATE ROLE ${roles[$i]} LOGIN CREATEDB PASSWORD '$PW_ADMIN'" ;;
      plain) sql_as "$ROLE_SUPERUSER" postgres "$PW_SUPERUSER" "CREATE ROLE ${roles[$i]} LOGIN PASSWORD '$PW_ADMIN'" ;;
      existingdb) sql_as "$ROLE_SUPERUSER" postgres "$PW_SUPERUSER" "CREATE ROLE ${roles[$i]} LOGIN PASSWORD '$PW_ADMIN'" ;;
    esac
    database="zitadel_${tags[$i]//-/_}"
    app_role="calflex_zitadel_${tags[$i]//-/_}"
    if [ "${tags[$i]}" = "existingdb" ]; then
      sql_as "$ROLE_SUPERUSER" postgres "$PW_SUPERUSER" "CREATE DATABASE $database OWNER $ROLE_SUPERUSER"
    fi
    say "zitadel init — admin '${roles[$i]}' (${names[$i]}), database '$database', app role '$app_role'"
    local admin_pw="$PW_ADMIN"
    if [ "${roles[$i]}" = "$ROLE_SUPERUSER" ]; then admin_pw="$PW_SUPERUSER"; fi
    show "env ZITADEL_DATABASE_POSTGRES_ADMIN_USERNAME=${roles[$i]} ZITADEL_DATABASE_POSTGRES_ADMIN_PASSWORD=*** ZITADEL_DATABASE_POSTGRES_USER_USERNAME=$app_role ZITADEL_DATABASE_POSTGRES_DATABASE=$database zitadel init"
    rc=0
    env -i PATH="$PATH" HOME="$HOME" \
      ZITADEL_DATABASE_POSTGRES_HOST=127.0.0.1 \
      ZITADEL_DATABASE_POSTGRES_PORT="$PGPORT" \
      ZITADEL_DATABASE_POSTGRES_DATABASE="$database" \
      ZITADEL_DATABASE_POSTGRES_ADMIN_USERNAME="${roles[$i]}" \
      ZITADEL_DATABASE_POSTGRES_ADMIN_PASSWORD="$admin_pw" \
      ZITADEL_DATABASE_POSTGRES_ADMIN_SSL_MODE=disable \
      ZITADEL_DATABASE_POSTGRES_USER_USERNAME="$app_role" \
      ZITADEL_DATABASE_POSTGRES_USER_PASSWORD="$PW_ZITADEL" \
      ZITADEL_DATABASE_POSTGRES_USER_SSL_MODE=disable \
      "$ZRE_CACHE/zitadel-$PINNED_VERSION/app/zitadel" init >"$LOGDIR/init-${tags[$i]}.log" 2>&1 || rc=$?
    echo "exit=$rc"
    tail -6 "$LOGDIR/init-${tags[$i]}.log" | mask
    sql_as "$ROLE_SUPERUSER" postgres "$PW_SUPERUSER" \
      "SELECT datname AS object FROM pg_database WHERE datname = '$database' UNION ALL SELECT rolname FROM pg_roles WHERE rolname = '$app_role' ORDER BY 1"
  done
}

# --------------------------------------------------------------------------
# modes
# --------------------------------------------------------------------------

run_once() {
  local option=$1 version=${2:-$PINNED_VERSION} bootstrap=${3:-yes} tag=${4:-once}
  OPTION=$option
  WORK="$ZRE_CACHE/work/$option-$tag"
  rm -rf "$WORK"
  mkdir -p "$WORK" "$LOGDIR"
  if [ "$bootstrap" = yes ]; then
    case "$option" in
      a) prepare_a ;;
      b) prepare_b ;;
      b2) prepare_b2 ;;
      b3) prepare_b ;;
      b4) prepare_b4 ;;
      c) prepare_c ;;
    esac
  fi
  case "$option" in
    a|b|b2) start_a "$version" ;;
    b3|b4) start_b3 "$version" ;;
    c) start_c "$version" ;;
  esac
}

usage() { sed -n '2,50p' "$0"; exit 2; }

main() {
  local option=${1:-}
  shift || true
  case "$option" in a|b|b2|b3|b4|c|init-matrix) ;; *) usage ;; esac
  local starts=0 upgrade=0 keep=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --starts) starts=${2:-10}; shift 2 ;;
      --upgrade) upgrade=1; shift ;;
      --keep) keep=1; shift ;;
      *) echo "unknown argument: $1" >&2; usage ;;
    esac
  done
  require_tools
  mkdir -p "$ZRE_CACHE" "$WORK" "$LOGDIR"
  fetch_postgres
  fetch_zitadel "$PINNED_VERSION" "$PINNED_INDEX_DIGEST"
  if [ "$upgrade" -eq 1 ]; then
    fetch_zitadel "$UPGRADE_VERSION" "$UPGRADE_INDEX_DIGEST"
  fi

  trap 'stop_zitadel; cluster_stop' EXIT

  if [ "$starts" -gt 0 ]; then
    local i rc ok=0 start
    start=$(date +%s)
    for i in $(seq 1 "$starts"); do
      rc=0
      run_once "$option" "$PINNED_VERSION" yes "start-$i" || rc=$?
      printf 'start %2s/%s: rc=%s time_to_ready=%ss\n' "$i" "$starts" "$rc" "${HEALTHY_SECONDS:-n/a}"
      if [ "$rc" -eq 0 ]; then ok=$((ok + 1)); fi
      stop_zitadel
      cluster_stop
    done
    say "option $option: $ok/$starts first starts from an empty data directory reached /debug/ready (wall $(( $(date +%s) - start ))s)"
    return
  fi

  case "$option" in
    init-matrix) run_init_matrix; return ;;
  esac

  local rc=0
  run_once "$option" "$PINNED_VERSION" yes once || rc=$?
  if [ "$rc" -ne 0 ]; then
    stop_zitadel; cluster_stop
    exit "$rc"
  fi
  case "$option" in
    a|b|b2|b3|b4) privilege_report "$ROLE_ZITADEL" "$PW_ZITADEL" ;;
    c) privilege_report "$ROLE_SUPERUSER" "$PW_SUPERUSER" ;;
  esac
  stop_zitadel
  if [ "$upgrade" -eq 1 ]; then
    say "upgrade: $UPGRADE_VERSION against the database $PINNED_VERSION set up, same runtime role"
    rc=0
    run_once "$option" "$UPGRADE_VERSION" no upgrade || rc=$?
    echo "upgrade rc=$rc time_to_ready=${HEALTHY_SECONDS:-n/a}s"
  fi
  if [ "$keep" -eq 1 ]; then
    say "kept: cluster $DATA, Zitadel pid ${ZPID:-none}"
  else
    cluster_stop
  fi
}

main "$@"
