# `infra/` — compose files, Caddyfile, deploy scripts

Everything that runs the stack. No application code.

| Directory | What belongs there | Owning epic |
|---|---|---|
| `spike/` | the Phase 0 Radicale + Caddy spike on a public host (Let's Encrypt, 443 open) | [E01](../docs/epics/E01-integration-spike.md) |
| `dev/` | the local stack: Postgres, the CalDAV service, the API, Zitadel with its login UI, Mailpit, and Caddy with a local CA | [E02-R03](../docs/epics/E02-repo-tooling-ci.md) |
| `prod/` | production deploy: Caddy with Let's Encrypt on 443, the services, workers, the IdP and Postgres, from one command | [E08](../docs/epics/E08-operations.md) |

Rules that apply to everything here (`docs/02-technology-choices.md`
§ Runtime layout):

- **Rootless Podman** (`podman compose`), never a Docker daemon, no Kubernetes.
  The local stack changes no sysctls and serves HTTPS on 8443.
- Images are OCI images built in CI and pinned by digest; every container gets a
  memory limit. On the server the stack runs as the unprivileged `deploy` user
  under a systemd *user* unit.
- Every deployed Caddyfile pins `acme_ca` to Let's Encrypt's production
  directory (CAA forbids the ZeroSSL fallback and wildcards); the local stack
  uses Caddy's local CA instead.
- **No secrets in the repo**: values come from the environment, and a new
  variable gets a line in the relevant `.env.example`.
