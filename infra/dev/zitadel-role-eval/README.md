# `infra/dev/zitadel-role-eval/` — E08-R10's measurement harness

E08-R10 is an **evaluation**: nothing in the local stack changes, and the
deliverable is [`docs/adr/0005-zitadel-database-role.md`](../../docs/adr/0005-zitadel-database-role.md)
plus this harness, which produces the numbers the ADR quotes. Every claim about
runtime behaviour in the ADR comes from a command run and printed here — a
`Proposed` ADR that asserted one without running it would be worthless.

## The scripts

| Script | Option | What it starts | Zitadel command | Result (measured with `local-binary-probe.sh`; the container scripts themselves are unrun — no Podman in the sandbox) |
|---|---|---|---|---|
| `option-c.sh` | C — the status quo | the superuser login does everything | `start-from-init` as `zre_root` | starts |
| `option-a.sh` | A — a separate startup sequence | one-off `zitadel init` as `zre_admin` (CREATEDB + CREATEROLE, not a superuser), then the app role | `start-from-setup` as `calflex_zitadel` | starts |
| `option-b.sh` | B — a pre-provisioned role, no admin | the bootstrap creates the role and the database; no admin anywhere | `start-from-setup` as `calflex_zitadel` | **does not start** (see below) |
| `option-b2.sh` | B2 — B plus one internals init | bootstrap for role and database, then a one-off `zitadel init zitadel` **as the app role** | `start-from-setup` as `calflex_zitadel` | starts |

`option-b.sh` is kept because its failure is the evaluation's first finding:
`setup` stops on `40_init_push_func_v4` with `relation "eventstore.events" does
not exist`, so a database the bootstrap created is not enough — the internals
`zitadel init` writes must exist. `option-b2.sh` is the variant that supplies
exactly that step, without any admin credentials.

Each script:

- uses **its own** compose file and its own rootless `podman compose` project
  (`calflex-zre-a`/`-b`/`-b2`/`-c`), its own volume and its own network, and
  **removes the project with `podman compose -p <project> down -v`** when it is
  done. It never touches `flexcalendar-dev`;
- starts `postgres:18-alpine` and `ghcr.io/zitadel/zitadel:v4.16.0` from an
  empty volume. The only published port is Zitadel's HTTP port on
  `127.0.0.1` (`18080`/`18081`/`18082`/`18083`) so the script can read
  `/debug/ready`; `8443`, `5432`, `8080` and `3000` stay free;
- prints, with the command echoed before its output, the privilege checks the
  requirement lists: `\du`, `has_database_privilege` for the role on every
  database, and attempts as the runtime role to read the `caldav` database
  (the harness builds a stand-in for it in `initdb/10-standin.sql`), to
  `CREATE ROLE` and to `CREATE DATABASE`;
- reports the container's environment, names only and values masked. The image
  has **no shell** — `find` over its layers shows only `/app/zitadel`,
  `/etc/passwd` and `/etc/ssl` — so `podman exec … env` cannot work at all; the
  script shows that failure and then reads the environment from
  `podman inspect`, which is what the process really runs with.

```sh
./option-a.sh                      # one cold start + the privilege checks, then teardown
./option-a.sh --starts 10          # ten first starts from an empty volume (default 10)
./option-a.sh --upgrade            # then v4.19.4's setup against that database, same role
./option-a.sh --keep               # leave the project up for inspection
```

`--starts 10` deletes the volume and brings the stack up ten times, recording
each outcome and its time to `/debug/ready`; that is where the
`postgres:18-alpine` entrypoint race shows. `--upgrade` runs the same service
with `ZRE_IMAGE_TAG=v4.19.4` against the database the pinned version created,
still as the same runtime role (E08-R08).

**Duration.** A single cold start is about 30 s once the images are pulled
(Zitadel's linux/amd64 layers are about 53 MB compressed); `--starts 10` about
6 minutes; `--upgrade` about a minute plus the second image pull.

**Requirements.** Rootless `podman` with `podman compose` (the reviewer's
machine, per D-20 — the agent sandbox cannot run Podman) and `curl`. No
`sudo`, no sysctl change, no port below 1024.

## `local-binary-probe.sh` — the same measurements without a container runtime

The agent sandbox has no Podman, so the measurements in the ADR were produced
by this script: it unpacks the **`zitadel` binary out of the pinned image**
through the registry API (verifying the image index digest) and runs it against
a throwaway PostgreSQL 18 cluster built from `embedded-postgres-binaries-linux-amd64:18.6.0`
(verified against a pinned SHA-256), with `scram-sha-256` authentication so a
role cannot borrow another role's identity. Nothing is unpacked inside the
repository: everything lands in `~/.cache/flexcalendar-agent-team/zre/`.

```sh
./local-binary-probe.sh a            # option A: init as an admin, start as the app role
./local-binary-probe.sh b            # option B: the failure mode
./local-binary-probe.sh b2           # option B2: the shape the ADR recommends
./local-binary-probe.sh c            # option C: the status quo
./local-binary-probe.sh init-matrix  # which privileges `zitadel init` itself needs
./local-binary-probe.sh a --starts 10
./local-binary-probe.sh a --upgrade
```

`b3` and `b4` are extra variants of option B kept from the investigation
(`start-from-init` as the app role, with and without database ownership); both
fail with `permission denied to create database`, because `init`'s database
step creates the database rather than checking for it.

What the probe cannot measure, and the container scripts can: the image's
entrypoint, its default user, whether admin credentials stay in the running
container, and the Postgres bootstrap's own entrypoint race.

## Rules this harness follows

- No secret in a commit. The passwords here are fixed throwaway values for a
  throwaway cluster that exists for a few minutes on one machine; nothing
  prints one, and the SQL client takes it from `PGPASSWORD`.
- Nothing under `infra/dev/zitadel-role-eval/` changes the local stack: the
  harness has its own compose files and its own project names, and
  `infra/dev/compose.yaml`, `infra/dev/postgres/initdb/` and `infra/zitadel/`
  stay exactly as they are. E08-R11 implements the ADR's outcome.
