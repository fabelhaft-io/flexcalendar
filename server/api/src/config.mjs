// --- E05-R01: the API's OIDC, database and rate-limit configuration ---------
//
// Everything is read from the environment (INV-07 and the working agreement:
// no secrets in the repository). The local stack wires these in
// `infra/dev/compose.yaml`; E08 supplies the same names from the secret store.
//
// Invalid numbers stop the service at startup instead of falling back to a
// default: a rate limit or a proxy hop count nobody can see is worse than a
// service that refuses to boot.

/** @param {string | undefined} value */
const text = (value) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * A whole number setting, with a floor. An unset variable takes `fallback`.
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @param {number} fallback
 * @param {number} minimum
 * @returns {number}
 */
function wholeNumber(env, name, fallback, minimum) {
  const raw = text(env[name]);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number`);
  const value = Number.parseInt(raw, 10);
  if (value < minimum) throw new Error(`${name} must be at least ${minimum}`);
  return value;
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{issuer?: string, baseUrl?: string, audience?: string, audienceFile?: string, databaseUrl?: string, rateLimitMax: number, rateLimitWindowSeconds: number, trustedProxyHops: number}}
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
    // One in-memory bucket per client address, 300 requests per 60 s.
    rateLimitMax: wholeNumber(env, 'CALFLEX_RATE_LIMIT_MAX', 300, 1),
    rateLimitWindowSeconds: wholeNumber(
      env,
      'CALFLEX_RATE_LIMIT_WINDOW_SECONDS',
      60,
      1,
    ),
    // 0 (the default): the socket address is the client and `X-Forwarded-For`
    // is ignored. 1: exactly one proxy (Caddy) sits in front of the API.
    trustedProxyHops: wholeNumber(env, 'CALFLEX_TRUSTED_PROXY_HOPS', 0, 0),
  };
}
