# `infra/dev/zitadel-role-eval/` — E08-R10's measurement harness

E08-R10 is an **evaluation**: nothing in the local stack changes, and the
deliverable is [`docs/adr/0005-zitadel-database-role.md`](../../docs/adr/0005-zitadel-database-role.md)
plus this harness, which produces the numbers the ADR quotes. Every claim about
runtime behaviour in the ADR comes from a command run and printed here — a
`Proposed` ADR that asserted one without running it would be worthless.

## The scripts

| Script | Option | What it starts | Zitadel command | Result on 2026-10-12 (`results/2026-10-12/`) |
|---|---|---|---|---|
| `option-c.sh` | C — the status quo | the superuser login does everything | `start-from-init` as `zre_root` | starts, ready after 5 s; the runtime role is a superuser that reads `caldav`, creates roles and creates databases (`option-c.txt`) |
| `option-a.sh` | A — a separate startup sequence | one-off `zitadel init` as `zre_admin` (CREATEDB + CREATEROLE, not a superuser), then the app role | `start-from-setup` as `calflex_zitadel` | starts, ready after 4 s; 10/10 cold starts (`option-a.txt`, `option-a-starts.txt`); upgrade to v4.19.4 ready after 1 s (`option-a-upgrade.txt`) |
| `option-b.sh` | B — a pre-provisioned role, no admin | the bootstrap creates the role and the database; no admin anywhere | `start-from-setup` as `calflex_zitadel` | **does not start** (`option-b.txt`) — see below |
| `option-b2.sh` | B2 — B plus one internals init | bootstrap for role and database, then a one-off `zitadel init zitadel` **as the app role** | `start-from-setup` as `calflex_zitadel` | starts, ready after 5 s; 10/10 cold starts (`option-b2.txt`, `option-b2-starts.txt`); upgrade to v4.19.4 ready after 2 s (`option-b2-upgrade.txt`) |

`option-b.sh` is kept because its failure is the evaluation's first finding:
`setup` stops on `40_init_push_func_v4` with `relation "eventstore.events2" does
not exist`, so a database the bootstrap created is not enough — the internals
`zitadel init` writes must exist. `option-b2.sh` is the variant that supplies
exactly that step, without any admin credentials.

Each script:

- uses **its own** compose file and its own rootless `podman compose` project
  (`calflex-zre-a`/`-b`/`-b2`/`-c`), its own volume and its own network, and
  **removes the project with `podman compose -p <project> down -v`** — on
  failure too, through an `EXIT` trap, so `option-b.sh` no longer leaves its
  project behind when `start-from-setup` fails. It never touches
  `flexcalendar-dev`; `--keep` is the only way to leave it for inspection;
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
  `podman inspect`, which is what the process really runs with;
- **prints no password.** `psql` does not take one on its command line: the
  throwaway values in the compose files are written, once, into a `.pgpass`
  *inside* the Postgres container (`pgpass_init`, `PGPASSFILE=/tmp/zre.pgpass`),
  and every command's output — stderr included — goes through `mask`. That
  matters because `podman compose` echoes the whole `exec` command it ran when
  that command exits non-zero, and the expected denials exit non-zero.

```sh
bash option-a.sh                      # one cold start + the privilege checks, then teardown
bash option-a.sh --starts 10          # ten first starts from an empty volume (default 10)
bash option-a.sh --upgrade            # then v4.19.4's setup against that database, same role
bash option-a.sh --keep               # leave the project up for inspection
```

(`bash <script>` is the documented form: it works whether or not the checkout
carries the executable bit. The same four flags work for every option script.)

`--starts 10` deletes the volume and brings the stack up ten times, recording
each outcome and its time to `/debug/ready`; that is where the
`postgres:18-alpine` entrypoint race shows — 20 cold starts (10 for A, 10 for
B2) on 2026-10-12 hit none, with the healthcheck probing TCP. `--upgrade` runs
the same service with `ZRE_IMAGE_TAG=v4.19.4` against the database the pinned
version created, still as the same runtime role (E08-R08).

**Duration**, measured on 2026-10-12 (`results/2026-10-12/run.txt`, images
pulled): one option script 17–22 s; `option-b.sh` about 4.8 min (it fails and
then burns the 240 s health timeout); `--starts 10` about 3.5 min; `--upgrade`
25–40 s. The whole set of eight runs took about 14 min.

**Requirements.** Rootless `podman` with `podman compose` (the reviewer's
machine, per D-20 — the agent sandbox cannot run Podman) and `curl`. No
`sudo`, no sysctl change, no port below 1024.

## `local-binary-probe.sh` — the same measurements without a container runtime

The agent sandbox has no Podman, so this script produced the first pass: it
unpacks the **`zitadel` binary out of the pinned image** through the registry
API (verifying the image index digest) and runs it against a throwaway
PostgreSQL 18 cluster built from `embedded-postgres-binaries-linux-amd64:18.6.0`
(verified against a pinned SHA-256), with `scram-sha-256` authentication so a
role cannot borrow another role's identity. Nothing is unpacked inside the
repository: everything lands in `~/.cache/flexcalendar-agent-team/zre/`.

```sh
bash local-binary-probe.sh a            # option A: init as an admin, start as the app role
bash local-binary-probe.sh b            # option B: the failure mode
bash local-binary-probe.sh b2           # option B2: the shape the ADR recommends
bash local-binary-probe.sh c            # option C: the status quo
bash local-binary-probe.sh init-matrix  # which privileges `zitadel init` itself needs
bash local-binary-probe.sh a --starts 10
bash local-binary-probe.sh a --upgrade
```

`b3` and `b4` are extra variants of option B kept from the investigation
(`start-from-init` as the app role, with and without database ownership); both
fail with `permission denied to create database`, because `init`'s database
step creates the database rather than checking for it.

The container runs above supersede the probe for every criterion that depends on
the image's entrypoint, its default user, the container's environment, or the
Postgres bootstrap's own entrypoint race — the probe sees none of those. The
probe is kept for the one measurement the container harness does not make:
`init-matrix`, which privileges `zitadel init` itself needs (the ADR quotes it
as the local probe).

## Rules this harness follows

- No secret in a commit. The passwords here are fixed throwaway values for a
  throwaway cluster that exists for a few minutes on one machine; nothing
  prints one, `psql` reads a `.pgpass` inside its own container, and `mask`
  filters every command's output.
- Nothing under `infra/dev/zitadel-role-eval/` changes the local stack: the
  harness has its own compose files and its own project names, and
  `infra/dev/compose.yaml`, `infra/dev/postgres/initdb/` and `infra/zitadel/`
  stay exactly as they are. E08-R11 implements the ADR's outcome.
