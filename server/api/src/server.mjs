// --- calendar-flex API service: entry point (E05-R01) -----------------------
//
// `make dev` runs this so the stack has a real API at
// https://api.localhost:<port>/ . Node 24 + Fastify (D-01), behind the OIDC
// bearer hook (D-03): every endpoint but `/healthz` needs a Zitadel access
// token validated against its JWKS. This service never decrypts and stores no
// event content (INV-01, INV-07).
//
// `GET /healthz` is the readiness probe (infra/dev/compose.yaml) and touches
// no database and no IdP. Everything else needs CALFLEX_OIDC_ISSUER and an
// audience (CALFLEX_OIDC_AUDIENCE, or the file `zitadel-config apply` writes);
// without them the service answers 503 rather than accepting a request.

import pg from 'pg';
import { buildApp } from './app.mjs';
import { readConfig } from './config.mjs';
import { createUserStore } from './store.mjs';

const config = readConfig();
// `pg.Pool` connects lazily, so a stack whose Postgres is not up yet still
// boots and keeps answering its readiness probe.
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 5000,
});
const app = buildApp({ config, store: createUserStore(pool) });
const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '0.0.0.0';

try {
  const address = await app.listen({ port, host });
  process.stdout.write(`calendar-flex api listening on ${address}\n`);
} catch (error) {
  process.stderr.write(
    `calendar-flex api failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exit(1);
}
