// --- E05-R01: the API's OIDC and database configuration ---------------------
//
// Everything is read from the environment (INV-07 and the working agreement:
// no secrets in the repository). The local stack wires these in
// `infra/dev/compose.yaml`; E08 supplies the same names from the secret store.

/** @param {string | undefined} value */
const text = (value) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{issuer?: string, baseUrl?: string, audience?: string, audienceFile?: string, databaseUrl?: string}}
 */
export function readConfig(env = process.env) {
  const issuer = text(env.CALFLEX_OIDC_ISSUER);
  return {
    // The identity an access token must name. No issuer means no auth (503).
    issuer,
    // Where the IdP is actually reached from inside the network. It differs
    // from the issuer locally: Zitadel answers on http://zitadel-api:8080 and
    // Caddy presents it as https://auth.localhost:8443.
    baseUrl: text(env.CALFLEX_OIDC_BASE_URL) ?? issuer,
    audience: text(env.CALFLEX_OIDC_AUDIENCE),
    audienceFile: text(env.CALFLEX_OIDC_AUDIENCE_FILE),
    databaseUrl: text(env.CALFLEX_DATABASE_URL),
  };
}
