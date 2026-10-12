# ADR 0005 — Zitadel never runs as a cluster superuser

- **Status**: Proposed
- **Date**: 2026-10-12
- **Relates to**: [`02-technology-choices.md`](../02-technology-choices.md) § Hosting (runtime layout,
  sizing, backups), [`adr/0001-calendar-privacy-modes.md`](0001-calendar-privacy-modes.md),
  [`adr/0004-single-4gb-host.md`](0004-single-4gb-host.md), E08-R10 (this evaluation), E08-R11 (its
  implementation), E08-R02 (the local stack), E08-R08 (the Zitadel upgrade), E04-R02 (the database
  roles), E02-R09 (the OpenTofu configuration runner)

**Nothing is implemented by this ADR.** It is E08-R10's evaluation, and E08-R11 implements whichever
option the owner accepts.

## Context

E08-R10: *"Zitadel MUST NOT run as the cluster superuser. Since E04-R02 the API and the CalDAV service
have their own roles, but the local stack still runs Zitadel and the `zitadel-config` runner (E02-R09)
as the bootstrap login, a superuser. The IdP sees the login password (D-17) and parses the most
untrusted input, so a compromise there would reach every database in the cluster, including the API's
key and envelope tables."*

The requirement's "MUST NOT" is hard. Which of the options below satisfies it is what this ADR
proposes; the owner accepts or amends it.

The pressure behind it:

- **D-17** puts the user's login password in Zitadel (`adr/0001`, ADR 0003). Zitadel is therefore the
  one service that sees a secret that must never be worth a database-wide compromise, and it also
  parses every login request, JWT, SAML assertion and OIDC callback the internet sends us.
- **D-11** keeps every durable state in **one Postgres cluster** — CalDAV objects, the sidecar
  envelopes, the audit log, Zitadel's own database — and ADR 0004 keeps that cluster on the same 4 GB
  host as the IdP. A superuser login inside the IdP container is one `pg_dump` away from the private
  key material E04 keeps, and one `DROP DATABASE` from "events lost = product dead".
- **D-19** and ADR 0004 pin the rest of the shape this decision has to live with: one host, rootless
  Podman, images pinned by digest, secrets read through a password-manager CLI, and OpenTofu state in
  the **same `zitadel` database**, in schema `calflex_tofu`, which is exactly why E02-R09's runner is
  part of the same blast radius.

Today: `infra/dev/compose.yaml` runs `ghcr.io/zitadel/zitadel:v4.16.0` with
`start-from-init` and `ZITADEL_DATABASE_POSTGRES_DSN` pointing at `caldav` — the role the Postgres
entrypoint created as the cluster superuser. `infra/dev/postgres/initdb/10-zitadel-database.sql`
creates the `zitadel` database and `20-roles.sql` creates the API/CalDAV/migration roles, but no role
exists for Zitadel itself. `infra/zitadel/`'s OpenTofu runner uses the same connection
(`PG_CONN_STR`, defaulting to Zitadel's DSN) for `calflex_tofu`.

What this does **not** touch: CalDAV stays the source of truth, no `VEVENT` changes, no event content
enters any database privilege discussion, and nothing here affects round-tripping with stock apps. The
subject is the privilege set of one login.

### The options, at least

| | Shape | Who has admin rights |
|---|---|---|
| **C** | the status quo: `start-from-init` as the superuser, one login for user and admin | the runtime login |
| **A** | a one-off `zitadel init` job with admin credentials, then `setup` and `start` as an app role | an admin login with CREATEDB + CREATEROLE, only in the one-off job |
| **B** | a pre-provisioned role and no admin at all: the cluster bootstrap creates the database and a role that owns it, Zitadel runs as that role only, `start-from-setup` | nobody |
| **B2** | B plus a one-off `zitadel init zitadel` ("initialize ZITADEL internals") job that runs **as the app role** | nobody |

A is the owner's leading hypothesis of 2026-10-09, not a decision. B2 was not on the list: it is what
the measurements turned B into (see [The measured results](#the-measured-results)).

## Decision

**Recommend B2: a pre-provisioned role, no admin login anywhere, and a one-off `zitadel init zitadel`
step that runs as that role.** The Zitadel containers then run `start-from-setup`.

In one sentence: *keep option A's shape — a separate startup step before the long running service —
but remove the admin account, because the bootstrap can create the database and the role, and the only
part of `init` that is still needed can run with the app role's own privileges.*

Concretely, for **E08-R11**:

1. **The bootstrap creates the role and the database.** One `initdb`-style script (production: a
   deploy step or a migration, see below) does
   `CREATE ROLE calflex_zitadel LOGIN PASSWORD …;` and
   `CREATE DATABASE zitadel OWNER calflex_zitadel;`.
2. **The one-off step becomes `zitadel init zitadel`**, run as `calflex_zitadel`, with no `ADMIN_*`
   variables — a Compose one-off job (`profiles: [init]`, like today's `migrate` and `seed`
   services) or a step of `make deploy`.
3. **The long running service runs `start-from-setup`** as `calflex_zitadel`, still with no `ADMIN_*`
   variables. `start-from-init` is retired for this purpose: its `database` and `user` steps are
   unconditional `CREATE DATABASE` / `CREATE USER` (see
   [the init steps](#why-start-from-init-cannot-stay)), so they cannot run as a role that owns
   nothing cluster-wide.
4. **`zitadel-config` (E02-R09) gets its own role too**: `calflex_tofu`, LOGIN, own credentials, no
   superuser, using the schema `calflex_tofu` in the same `zitadel` database (D-11). Its `PG_CONN_STR`
   stops being Zitadel's DSN.
5. **Existing local volumes need `make dev-reset`** — the bootstrap SQL only runs on an empty volume,
   and the `zitadel` database's owner changes.

If the owner prefers to keep an admin account (for example because they want one command to bring an
empty cluster up), **option A is the fallback**: it is measured to work, needs `CREATEDB` +
`CREATEROLE` and nothing more, and keeps those credentials in the one-off job only.

## How these numbers were produced

Two harnesses, both under `infra/dev/zitadel-role-eval/` (see its
[README](../../infra/dev/zitadel-role-eval/README.md)):

- **`local-binary-probe.sh`** — the numbers quoted below. The agent sandbox cannot run rootless Podman
  under bwrap, so the probe unpacks the `zitadel` binary **out of the pinned image** through the GHCR
  registry API and runs it against a throwaway PostgreSQL 18 cluster (`scram-sha-256`, so a role
  cannot borrow another role's identity) whose binaries come from
  `embedded-postgres-binaries-linux-amd64:18.6.0` (SHA-256
  `008ee189eaa7ca2b58bd01dd950291e638b998392cf982297acd4779ec898ac1`). The image's own contents are
  used, not the release notes.
- **`option-a.sh` / `option-b.sh` / `option-b2.sh` / `option-c.sh`** — the same measurements inside
  rootless `podman compose` projects (`calflex-zre-*`), for the reviewer's machine. **They have not
  been executed**, because the sandbox has no container runtime; every cell that depends on the
  container itself is marked `pending — reviewer runs <script>` and claims nothing.

What was pinned and verified before anything ran:

```
$ curl -sI -H 'Accept: application/vnd.oci.image.index.v1+json' \
      https://ghcr.io/v2/zitadel/zitadel/manifests/v4.16.0 | grep -i docker-content-digest
docker-content-digest: sha256:15543f7a80c3e37905fe8c7db56af7ed2a9ece256704322c1449d7e8453afdab
$ curl -sI … https://ghcr.io/v2/zitadel/zitadel/manifests/v4.19.4 | grep -i docker-content-digest
docker-content-digest: sha256:90a3045b80a2b5b395e1e770302076906af3a5911225af7c464b4f3bd00d0a1b
$ file <extracted>/app/zitadel
/app/zitadel: ELF 64-bit LSB executable, x86-64, statically linked, stripped
$ find <extracted image> -maxdepth 2          # the image has no shell at all
<image>/etc/passwd
<image>/etc/ssl
<image>/app/zitadel
$ curl -s … /blobs/<config digest> | jq .config
{"User":"zitadel","Env":["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
 "Entrypoint":["/app/zitadel"],"Cmd":null,"ExposedPorts":{"8080/tcp":{}}}
```

The image's own `--help` texts, which the epic says to trust rather than the docs:

```
$ zitadel init --help
The user provided by flags needs privileges to
- create the database if it does not exist
- see other users and create a new one if the user does not exist
- grant all rights of the ZITADEL database to the user created if not yet set
$ zitadel start-from-setup --help
Requirements:
- database
- database is initialized
$ zitadel init zitadel --help
initialize ZITADEL internals
```

## The measured results

Every block below is the real output of the command above it, trimmed with `…`. The probe's throwaway
cluster is named `postgres` where the container harness names it `zre_root`; the roles and the results
are otherwise the same.

### 1. The privileges at runtime

**Option C (status quo).** `local-binary-probe.sh c` — the superuser does everything:

```
### privileges at runtime — role 'postgres'
+ psql … -c "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles …"
rolname        | rolsuper | rolcreatedb | rolcreaterole | rolcanlogin
calflex_caldav |          |             |               | 1
postgres       | 1        | 1           | 1             | 1
+ psql … -c "SELECT datname, has_database_privilege('postgres', datname, 'CONNECT') …, 'CREATE' …, 'TEMP' …"
datname  | connect | create | temp
caldav   | 1       | 1      | 1
postgres | 1       | 1      | 1
zitadel  | 1       | 1      | 1
+ psql … -U postgres -d caldav -c "SELECT count(*) FROM public.calendars"
count
1
+ psql … -U postgres -d postgres -c "CREATE ROLE zre_probe_must_fail LOGIN"
OK
+ psql … -U postgres -d postgres -c "CREATE DATABASE zre_probe_must_fail"
OK
```

Time to `/debug/ready` on a cold start: **5 s**.

**Options A, B2 (the app role).** `local-binary-probe.sh a` / `… b2`, runtime role
`calflex_zitadel`:

```
### privileges at runtime — role 'calflex_zitadel'
+ psql … -c "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles …"
rolname        | rolsuper | rolcreatedb | rolcreaterole | rolcanlogin
calflex_caldav |          |             |               | 1
calflex_zitadel|          |             |               | 1
postgres       | 1        | 1           | 1             | 1
zre_admin      |          | 1           | 1             | 1        (option A only)
+ psql … -c "SELECT datname, has_database_privilege('calflex_zitadel', datname, …) …"
datname  | connect | create | temp
caldav   | 1       |        | 1
postgres | 1       |        | 1
zitadel  | 1       | 1      | 1
+ psql … -U calflex_zitadel -d caldav -c "SELECT count(*) FROM public.calendars"
ERROR: SQLSTATE[42501]: Insufficient privilege: 7 ERROR:  permission denied for table calendars
+ psql … -U calflex_zitadel -d postgres -c "CREATE ROLE zre_probe_must_fail LOGIN"
ERROR: permission denied to create role
DETAIL:  Only roles with the CREATEROLE attribute may create roles.
+ psql … -U calflex_zitadel -d postgres -c "CREATE DATABASE zre_probe_must_fail"
ERROR:  permission denied to create database
### optional hardening: revoke CONNECT on the sibling database from PUBLIC
+ psql … -c "REVOKE ALL ON DATABASE caldav FROM PUBLIC"
+ psql … -U calflex_zitadel -d caldav -c "SELECT count(*) FROM public.calendars"
CONNECT FAILED: … FATAL:  permission denied for database "caldav"
DETAIL:  User does not have CONNECT privilege.
```

`connect` and `temp` on `caldav` are `1` only because PostgreSQL grants `CONNECT` and `TEMP` to
`PUBLIC` on every new database: the role reaches the database and is still refused at the first
table. `CREATE` on `zitadel` is `1` because the role owns it (option B2/B) or because `zitadel init`
grants `ALL` on it (option A). The `REVOKE` line shows the optional extra step that closes even the
connection; E08-R11 may take it, and nothing depends on it.

**Option B (the failing variant).** Its runtime role never exists, because the service never starts —
see below.

### 2. Do admin credentials stay in the Zitadel container?

Option A: `zitadel init` runs in a one-off job that has `ZITADEL_DATABASE_POSTGRES_ADMIN_USERNAME` /
`…_PASSWORD`; the long running service's environment holds none. Options B2 and B: no container ever
sees an `ADMIN_*` variable. Option C: the runtime container *is* the admin.

```
### environment handed to the Zitadel process (names only, values masked)
  ZITADEL_DATABASE_POSTGRES_USER_USERNAME=calflex_zitadel
  ZITADEL_DATABASE_POSTGRES_USER_PASSWORD=***
  …
  -> 0 ZITADEL_DATABASE_POSTGRES_ADMIN_* variables in the runtime environment      (A, B2)
  -> 2 ZITADEL_DATABASE_POSTGRES_ADMIN_* variables in the runtime environment      (C)
```

`pending — reviewer runs ./option-a.sh, ./option-b2.sh, ./option-c.sh`: the same check against the
running **container**, which is the criterion as written. The image has no shell (`env`, `ls` and `sh`
do not exist in it), so the scripts print the (failing) `podman exec … env`, then
`podman inspect --format '{{range .Config.Env}}…'`, and report the number of `ADMIN_*` names.

### 3. First-start reliability

Ten starts from an empty data directory, each followed by a wait for `/debug/ready`:

```
$ local-binary-probe.sh a --starts 10
start  1/10: rc=0 time_to_ready=4s          …   start 10/10: rc=0 time_to_ready=4s
### option a: 10/10 first starts from an empty data directory reached /debug/ready (wall 90s)
$ local-binary-probe.sh b2 --starts 10
start  1/10: rc=0 time_to_ready=4s          …   start 10/10: rc=0 time_to_ready=4s
### option b2: 10/10 first starts from an empty data directory reached /debug/ready (wall 92s)
```

Options A and B2: **10/10**, 4–5 s each. Option C: one start measured, 5 s (`… c`).

`pending — reviewer runs ./option-a.sh --starts 10` (and `./option-b2.sh --starts 10`,
`./option-c.sh --starts 10`): the same loop in `podman compose`, where `postgres:18-alpine`'s
entrypoint race — a temporary server that listens on the Unix socket only, so a socket probe goes
green before TCP clients are accepted — is part of what is being measured. The probe's cluster has no
entrypoint, so it cannot see that race.

### 4. Does the shape start at all?

**Option B**: no.

```
$ local-binary-probe.sh b
### option-b-v4.16.0 — …/zitadel start-from-setup (Zitadel v4.16.0)
+ psql … -c "CREATE ROLE calflex_zitadel LOGIN …"; CREATE DATABASE zitadel OWNER calflex_zitadel
### bootstrap outside Zitadel: …
/debug/ready -> HTTP 000 after 1s
--- last 25 lines of …-option-b-v4.16.0.log ---
… level=info msg="verify migration" name=40_init_push_func_v4
… error="ERROR: relation \"eventstore.events2\" does not exist (SQLSTATE 42P01)"
… error="ERROR: relation \"eventstore.events\" does not exist (SQLSTATE 42P01)"
… level=ERROR msg="migration failed" name=40_init_push_func_v4 …
… level=ERROR+6 msg="setup failed, skipping cleanup" … parent="ERROR: relation \"eventstore.events\" does not exist (SQLSTATE 42P01)"
```

`start-from-setup` demands a database that "is initialized" (its own help text), and a database the
bootstrap created is not: the tables `zitadel init` writes are missing. This is the epic's
"measure both `start-from-init` and `start-from-setup` … if the latter works, the one-off `init` of
the first option adds nothing the bootstrap does not already do" — it does not work, so something
still has to run `init`. **B2** supplies exactly that something, as the app role:

```
$ local-binary-probe.sh b2
### one-off: zitadel init zitadel, run as 'calflex_zitadel' — no admin credentials
+ … zitadel init zitadel
zitadel init zitadel exit=0                      (verify zitadel/system/encryption keys/projections/
                                                  eventstore/events tables/unique constraints)
### option-b2-v4.16.0 — … start-from-setup (Zitadel v4.16.0)
/debug/ready -> HTTP 200 after 4s
healthy_in_seconds=4
```

**Option A** starts too: `zitadel init` with `zre_admin` (CREATEDB + CREATEROLE, **not** a
superuser) exits 0 and leaves

```
+ psql … -c "SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = 'zitadel'"
datname | owner
zitadel | zre_admin
### what the one-off init left behind in the database
nspname
eventstore
projections
public
system
table_schema | tables
eventstore   | 2
system       | 1
```

then the app role starts the service: `/debug/ready -> HTTP 200 after 4s`.

### 5. Which privileges does `zitadel init` itself need?

The epic: *"Whether Zitadel's `init` passes without `CREATEROLE` is found out by running it."*
`local-binary-probe.sh init-matrix`, five admin logins against a fresh cluster:

```
### zitadel init — admin 'postgres' (superuser)                     exit=0
### zitadel init — admin 'zre_createdb_createrole' (createdb+createrole)   exit=0
### zitadel init — admin 'zre_createdb_only' (createdb only)         exit=1
ERROR … parent="initialize database failed: ERROR: permission denied to create role (SQLSTATE 42501)"
### zitadel init — admin 'zre_plain' (no createdb, no createrole)   exit=1
ERROR … parent="initialize database failed: ERROR: permission denied to create role (SQLSTATE 42501)"
### zitadel init — admin 'zre_existingdb' (database already exists, no createdb)  exit=1
ERROR … parent="initialize database failed: ERROR: permission denied to create role (SQLSTATE 42501)"
```

**No.** `init` needs `CREATEDB` *and* `CREATEROLE`; without `CREATEROLE` it fails with
`permission denied to create role`. Its steps are unconditional statements, taken from
`cmd/initialise/sql/` of the v4.16.0 tag:

```sql
-- 01_user.sql     CREATE USER "%[1]s"
-- 02_database.sql CREATE DATABASE "%[1]s"
-- 03_grant_user.sql GRANT ALL ON DATABASE "%[1]s" TO "%[2]s";
```

<a id="why-start-from-init-cannot-stay"></a>
Those three statements are also why **`start-from-init` cannot stay** once the bootstrap owns the
database and the role: `CREATE DATABASE` fails against a database that exists
(`permission denied to create database`, measured as variants `b3`/`b4` of the probe — the app role
cannot create databases even when it owns one), and an admin login is needed to run them at all. A
`start-from-init` with no admin configured is worse than that: it silently tries the Zitadel
*defaults* — `Username: postgres`, `Password: postgres` — which is why the probe's `b3`/`b4` runs
under a real password ("failed SASL auth … for user \"postgres\"") whereas an earlier run against a
`trust`-authenticated cluster passed. Measuring under `trust` would have produced a false "B works".

### 6. The upgrade (E08-R08)

`local-binary-probe.sh a --upgrade`: option A's database, set up by `v4.16.0`, then the same command
from the newest v4 release as the same role:

```
### option-a-v4.16.0 — … zitadel start-from-setup (Zitadel v4.16.0)
/debug/ready -> HTTP 200 after 4s
### upgrade: v4.19.4 against the database v4.16.0 set up, same runtime role
### option-a-v4.19.4 — … zitadel start-from-setup (Zitadel v4.19.4)
/debug/ready -> HTTP 200 after 1s
upgrade rc=0 time_to_ready=1s
$ grep -c 'starting migration' <v4.19.4 log>
17
```

The `v4.19.4` index digest was verified before the pull
(`sha256:90a3045b80a2b5b395e1e770302076906af3a5911225af7c464b4f3bd00d0a1b`), and the log shows 17
migrations actually running (`79_backfill_unique_constraint_owners` among them). So `setup` runs as
the app role across a minor upgrade, with no admin rights — of either shape.

`pending — reviewer runs ./option-a.sh --upgrade` (and `./option-b2.sh --upgrade`): the same
rehearsal with the images pulled from GHCR by Podman, which is what E08-R08 will do on staging.

## The criteria that are not measurements

### The production shape

The local stack starts from an empty volume; production is a cluster that already exists and will
never re-run `initdb`. Roles are **cluster-global** objects, so the deploy path is:

1. **A one-off SQL step, run as an admin login that exists today and is then retired** — the
   `postgres`/`zre_root`-equivalent role of the production cluster, through the password-manager CLI
   (D-19) and never from a Compose file, executed once by `make deploy ENV=production`:
   `CREATE ROLE calflex_zitadel LOGIN PASSWORD …;` and
   `CREATE DATABASE zitadel OWNER calflex_zitadel;`. It is idempotent by the same
   `WHERE NOT EXISTS … \gexec` guard `infra/dev/postgres/initdb/` already uses. It can equally be a
   migration of the API's chain (`server/api` owns the one chain for every table); a role and a
   database are cluster-global, which is the one thing that chain has never created, so a deploy step
   is the better fit.
2. **Nothing else.** After that the containers run with `calflex_zitadel` only, exactly as measured.
3. **pgBackRest restores carry the roles**: a restore into a fresh cluster brings `calflex_zitadel`
   and its password hash back (roles are in the dump's global objects), so the weekly restore check
   covers them too. Staging is created from code, so `make staging-up` runs step 1 as well.
4. **`make dev-reset`** is the local equivalent, and the only cost to developers: the bootstrap SQL
   runs on an empty volume only, so an existing local volume has neither the role nor the new owner.

### Secrets and their rotation (D-19)

The runtime role needs one password, and it is a **new** secret: today Zitadel has no database
credential of its own. It goes to the password manager, becomes a `.env.example` line, and is
rotated with `ALTER ROLE calflex_zitadel PASSWORD …` plus a redeploy of the Zitadel containers — the
same mechanism as the API's and CalDAV's passwords (E04-R02). Option A would add a *second* secret,
the admin's, and rotate it in a way that is easy to get wrong (init is not re-run on every start, so
a stale admin password would go unnoticed until the next cold start). B2 has one secret, and the
same shape locally, on staging and in production: bootstrap SQL + `init zitadel` + `start-from-setup`.

### `calflex_tofu` — the OpenTofu state schema (D-11, E02-R09)

The state lives in the same `zitadel` database, in schema `calflex_tofu`, and today the runner's
`PG_CONN_STR` defaults to Zitadel's DSN — i.e. to whatever Zitadel's login is. Under this decision
that is `calflex_zitadel`, which would put the state's *contents* (it holds `calflex-token-helper`'s
PAT, per `infra/zitadel/README.md`) behind the IdP's login. **E08-R11 gives it a role of its own**:
`calflex_tofu`, LOGIN, own password, no `CREATEDB`/`CREATEROLE`, and the deploy step (or the
tofu runner's first run) creates schema `calflex_tofu` owned by it so the backend never needs
database-level `CREATE`. `infra/zitadel/run.mjs` keeps reading `CALFLEX_TOFU_PG_CONN_STR`; only its
default changes.

## Consequences

- **E08-R11** implements the recommendation: one bootstrap script, one `init zitadel` job, one
  `start-from-setup` command, one new password, `PG_CONN_STR` for `calflex_tofu`, and a documented
  `make dev-reset`.
- **E08-R02** (the local stack) changes only in the way R11 describes: `infra/dev/postgres/initdb/`
  gains Zitadel's role and database, and `infra/dev/compose.yaml`'s `zitadel-api` swaps
  `start-from-init` for the job plus `start-from-setup`. Until R11 lands, the local stack stays as it
  is; this evaluation changes nothing.
- **E08-R08** (the upgrade): `setup` in the new binary runs as the app role, measured. The upgrade
  rehearsal stays "staging first"; it no longer needs an admin database login at all.
- **The blast radius after a compromise of the IdP shrinks to Zitadel's own database.** What is left
  is still the IdP's data (sessions, password hashes, the login UI's client secret) — so D-17's rule
  "the IdP sees the password and nothing derived from it protects keys" stays as important as ever,
  and INV-12 is unaffected by this decision.
- **Risks in `05`**: none of the listed risks change; this is a privilege change with no protocol or
  event-content impact. Risk 8 (hosting / on-call) improves slightly: one fewer superuser login in a
  container, and one fewer secret.
- **A new operational step exists**: a one-off init job that must run before the service on an empty
  cluster. Compose profiles and `make deploy` steps already carry that kind of job
  (`migrate`, `seed`, `zitadel-config`), so it adds no new concept.
- **The ADR stays `Proposed`** until the owner accepts or amends it; E08-R11 waits for that.
  `docs/00-overview.md`'s "Decision Records" list needs the one-line entry, which is outside this
  requirement's writable paths.

## Alternatives considered

- **Option C — the status quo, with compensating controls (the baseline).** Object privileges inside
  Zitadel's own database, monitoring, and a promise that nobody runs a stray query. **Rejected**: it
  leaves a superuser login in the container that parses the internet's input, which is the whole
  finding of E08-R10. Measured: the runtime role reads the sibling `caldav` database, creates roles
  and creates databases.
- **Option A — a one-off admin init, then the app role.** Works, measured, and 10/10 reliable. Kept
  as the fallback, because it needs a second secret and an admin login that exists at all only in the
  bootstrap job.
- **Option B — pre-provisioned role, no admin, `start-from-setup` only.** Measured to fail: the
  database has no internals. It is the option the epic hoped would work, and the reason B2 exists.
- **Option B2 — the same, plus `init zitadel` as the app role.** **Recommended.**
- **A dedicated Postgres instance for Zitadel** (separate container/volume, its own superuser, one
  pgBackRest repository each). **Rejected**: D-11 and ADR 0004 keep every durable state in one
  cluster on one 4 GB host, and two instances would double the memory footprint of the largest
  component for no gain over a role boundary — the same argument that keeps the API and CalDAV as
  roles rather than instances.
- **`ALTER DATABASE … OWNER TO calflex_zitadel` and nothing else** (no separate role): a role is
  still needed to log in with, and ownership without a login is not a boundary. Folded into every
  option above.
- **Running Zitadel as `postgres` with `NOINHERIT`/`SET ROLE` games or a `pgaudit` rule.**
  **Rejected**: it hides the privilege instead of removing it, and it is not measurable on the pinned
  image.

## Open questions

1. **The container-level rows of this ADR are measured on the host process, not in the container.**
   The reviewer runs `./option-a.sh`, `./option-b.sh`, `./option-b2.sh`, `./option-c.sh`,
   `./option-a.sh --starts 10`, `./option-b2.sh --starts 10` and `./option-a.sh --upgrade` (and the
   same `--upgrade` for B2) before the owner accepts. Everything that depends on the image's
   entrypoint, on the container's environment, or on the `postgres:18-alpine` entrypoint race is
   unverified until then.
2. **`calflex_tofu`'s exact privileges are not measured.** The OpenTofu private-backend requirements
   (whether it insists on creating the schema itself) have to be confirmed in E08-R11 by running
   `make zitadel-plan` with the new `PG_CONN_STR` against the local stack; the sandbox has no OpenTofu
   and no Podman.
3. **Whether the shared `zitadel` database's owner should be the app role or the deploy step's admin
   account** (option A leaves it with the admin, B2 with the app role). B2's ownership is what makes
   `init zitadel` work without a grant; if the owner is untouchable in production, `GRANT CREATE ON
   DATABASE zitadel TO calflex_zitadel` has to be added by the deploy step instead.
4. **The first-start race is only partly covered.** The probe repeats the cold start ten times, but
   the `postgres:18-alpine` entrypoint race and Compose's `depends_on: service_healthy` behaviour are
   container-level; question 1's runs cover them.
5. **`docs/00-overview.md` needs the ADR's one-line entry** under "Decision Records", and this
   repository's convention wants the decision reflected in `02` § Runtime layout. Both files are
   outside E08-R10's writable paths, so neither is touched here.
