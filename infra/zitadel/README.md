# Zitadel configuration (E02-R09)

One root module, three `environments/*.tfvars`: **OpenTofu 1.13.1** and
**zitadel/zitadel 3.8.7**, exact constraints plus committed provider checksums.
The multi-architecture OpenTofu container is also pinned by digest. No host
OpenTofu install is required. Changes to these pins require a fresh lockfile,
checksums, staging rehearsal and human security review.

The first-instance settings own the organization, admin, seed account and login
UI account. This code only reads that organization ID, then manages the project,
API/native app registrations, instance policies and (non-production only) a
separate `calflex-token-helper` account. There are no custom actions, identity
providers, SMTP, branding scripts, application keys or password-derived keys.
Branding, if added, must use Zitadel settings only.

## Local use

```sh
make dev
make seed                 # users first, then containerized OpenTofu apply
make seed                 # no additional users or configuration drift
make zitadel-plan         # tofu plan -detailed-exitcode: 0 clean, 2 changes
make token USER=alice     # stdout contains only a verified access JWT
make token USER=bob
```

Development admin and seeded-user password defaults are `Development1!`
(13 characters). Override through the documented environment, never source
control. Old local volumes with the previous shorter seed password must be
reset before using the new defaults; seed never silently resets existing users.
The helper works for local `.localhost` issuers and the exact staging issuer
`https://auth.staging.flexcalendar.de` only. Other custom development domains
are intentionally not allowed by the helper; use `.localhost` names instead.

`run.mjs apply|plan|token` is the container entry point. Local provider gRPC goes
over the private network to `zitadel-api:8080`, using `x-zitadel-forward-host` to
select the public instance. Public API requests go through Caddy, verifying its
CA and sending the public Host (including the published HTTPS port). No TLS
verification bypass is used. No port, privilege or sysctl is added.

The OpenTofu **pg backend** stores state in schema `calflex_tofu` in the
**same `zitadel` database** as the instance, using `PG_CONN_STR` from the
environment. Local Compose defaults to the same connection as Zitadel's DSN;
`CALFLEX_TOFU_PG_CONN_STR` can override it. Outside local, supply the connection
through the password-manager CLI with verified database TLS. The backend
creates its own schema; do not point it at a different database or instance.
Database reset, drop, backup and restore therefore include both configuration
state and instance data together (D-11). Provider/cache metadata is ephemeral
under `/tmp/calflex-tofu/<environment>/.terraform`, not a state volume.
**State contains the helper PAT; do not commit, print or publish state or
`tofu output -json`.** Restrict database and backup access accordingly.
Existing local installations with the old `zitadel-state` volume must run
`make dev-reset` before applying this backend change (destructive); remove the
obsolete volume with `podman volume rm calendar-flex-dev_zitadel-state` if it
exists. Do not migrate stale state from a deleted instance.

## Reviewed auth surface

- Android application name `de.flexcalendar.app`; redirect
  `de.flexcalendar.app:/oauth2redirect`, logout `de.flexcalendar.app:/logout` in
  every environment. Native public OIDC 1.0, authentication NONE, response CODE,
  grants **authorization code + refresh token**, PKCE required. JWT access-token
  type; no implicit, password, device-code or token-exchange grant. Zero clock
  skew, dev mode off, extra origins empty, role/userinfo assertions off, native
  success page skipped. No `android {}` App Links metadata: empty fingerprints are not persisted by
  Zitadel, and private-use scheme redirects do not use App Links.
- API registration uses **PRIVATE_KEY_JWT** auth method, with **no provisioned
  key or client secret**: it is an audience/registration, not an enabled
  machine credential. No other OIDC registration exists.
- Project role assertion/check and org project-membership check off; branding
  comes from the project's resource owner. Clients request
  `urn:zitadel:iam:org:project:id:<project_id>:aud` to include the project in `aud`.
- Password minimum **12**; uppercase/lowercase/number/symbol rules all **false**;
  maximum age and expiry-warning days **0** (no expiry). Password lockout **10**,
  OTP lockout **0**; admin-assisted unlock/reset, no timed unlock.
- Username/password login **on**, registration **off**, external IdPs **off**
  and list empty. TOTP and U2F second factors allowed; verified U2F/passkeys
  allowed as multi-factor/passwordless. MFA and local-only forced MFA **off**.
  Password-reset link **hidden** (ADR 0003). Unknown-username ignoring **off**;
  domain discovery **on**; email/phone login disabling **off**; default redirect
  empty (Zitadel console). All policy values are explicit in `policies.tf`.
- Access/ID tokens **12 h**; refresh idle **30 days**, absolute **90 days**;
  password and external-login checks **10 days**; second-factor check **18 h**,
  multi-factor check **12 h**; MFA-setup skip **30 days**.
- Local/staging helper machine: JWT access-token type, **no machine secret/key**,
  own sensitive PAT with fixed expiration **2030-01-01T00:00:00Z**. The role is
  **IAM_LOGIN_CLIENT** (the public custom-login APIs require it), _not_ IAM_OWNER.
  This role is powerful (includes user/session writes); treat its state as an
  administrative secret, and rotate it before expiry. It is **not the login
  UI's account or PAT**, and production's count is zero for account, role, PAT.
- Token helper uses public discovery, authorize with random state and **S256**
  PKCE, user lookup, v2 session password check, v2 OIDC auth-request callback,
  then **authorization-code** exchange for the actual Android registration.
  It requests openid/profile/project audience, not offline access. It deletes
  the short-lived (**300 s**) test session afterward. Before printing it verifies
  **RS256** using discovery's same-origin JWKS, issuer, project audience, subject,
  expiry and not-before. It rejects cross-origin redirects/endpoints and state
  mismatches, and refuses production **before** reading credentials or state.
  No login UI credentials or bootstrap PAT are used on the token path.

## Staging and production reuse (E08)

Build the same `Dockerfile` and run the same entry point with `/config` mounted
read-only and variables from `.env.example`, including `PG_CONN_STR` pointing
to that environment's Zitadel database. Only ephemeral cache storage is needed.
Select `CALFLEX_ZITADEL_ENVIRONMENT=staging|production`, and the matching issuer
and base URL. Supply `ZITADEL_ACCESS_TOKEN` from the password-manager CLI for
apply/plan only (bootstrap administrator/IAM_OWNER, not the login UI). The
provider always verifies public TLS outside local. Never expose state outputs
in deployment logs. `run.mjs` selects the corresponding tfvars; production
cannot opt into the helper through a variable. Production is never a test
login target. This module does not create the E08 deployments.

## Checks and reviewer acceptance protocol

Sandbox checks (no running Zitadel):

```sh
make test-seed
make test-zitadel
make check-stack
# With the checksum-verified pinned release binary, from repository root:
tofu fmt -check -recursive infra/zitadel
tofu -chdir=infra/zitadel init -backend=false -input=false
tofu -chdir=infra/zitadel validate
tofu -chdir=infra/zitadel test
CALFLEX_OIDC_ISSUER=https://auth.flexcalendar.de CALFLEX_ZITADEL_ENVIRONMENT=production node infra/zitadel/run.mjs token
# Last command must exit 1 before credential access.
```

The provider tests plan all three configurations with a **mock provider**;
they assert the production helper account, role and PAT are absent, plus policy
and native/JWT constraints. They do not prove real Zitadel applies. Node tests
use a stateful stub that enforces one-use codes, PKCE and session deletion,
separate service credentials, valid JWKS signatures, wrong audience/state and
production refusal. The real runner CLI is exercised with a stub tofu executable.

**Reviewer, outside the sandbox (destructive; local data only):**

```sh
# Run this entire command TWICE in a row; all plans must exit 0:
make dev-reset && make dev && make seed && make seed && make zitadel-plan
make dev-reset && make dev && make seed && make seed && make zitadel-plan
make token USER=alice        # verifies JWKS + project aud before printing
make token USER=bob
# Compare normalized registrations/policies before and after each reset.
# IDs may change; NEVER save tokens/PATs or raw sensitive state.

# Separate teardown: drop ONLY Zitadel's database, keep the rest of Postgres.
# Stop the stack and discard first-instance PAT files (not database/state files).
export COMPOSE_PROJECT_NAME=calendar-flex-dev
podman compose --file infra/dev/compose.yaml down --remove-orphans
podman volume rm calendar-flex-dev_zitadel-bootstrap
podman compose --file infra/dev/compose.yaml up --detach --wait postgres
podman compose --file infra/dev/compose.yaml exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "DROP DATABASE zitadel WITH (FORCE)" -c "CREATE DATABASE zitadel"'
make dev && make seed && make zitadel-plan
make token USER=alice
# Compare the same normalized configuration; other databases must be intact.
```

The exact containerized plan command is
`podman compose --file infra/dev/compose.yaml --profile seed run --rm -T zitadel-config plan`
with `COMPOSE_PROJECT_NAME=calendar-flex-dev` exported, as Make does. Both teardown procedures are **local only**, never staging/production.
For production's no-helper acceptance, run the mock-provider production plan
assertions with `tofu -chdir=infra/zitadel test -filter=tests/auth.tftest.hcl` and
review `environments/production.tfvars` plus the three count expressions.
Run `make verify` against the real local stack too. Do not claim acceptance
from the stubs: actual seed idempotence, token APIs and reset/re-apply need the
reviewer's real stack evidence.
