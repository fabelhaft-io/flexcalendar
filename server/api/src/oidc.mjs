// --- E05-R01: the OIDC client the API authenticates with --------------------
//
// The API validates Zitadel access tokens locally against its JWKS (D-03): it
// never introspects, and it never accepts an opaque token. Discovery, the JWKS
// and the userinfo endpoint are the only three calls it makes, all GET, all
// capped and all without following a redirect.
//
// `CALFLEX_OIDC_BASE_URL` is where those calls go; the `issuer` is the identity
// they must confirm. Locally the two differ (http://zitadel-api:8080 inside the
// network, https://auth.localhost:8443 in the token), so requests carry
// `Host: <issuer>`. Endpoints published by discovery are required to be
// same-origin with the issuer and are re-rooted on the base URL.
//
// Nothing here logs. Errors carry no claim, header or token bytes.

import http from 'node:http';
import https from 'node:https';
// `createRemoteJWKSet` is deliberately not used: it fetches with the global
// agent and cannot be pinned to CALFLEX_OIDC_BASE_URL with the issuer's Host.
import { importJWK, jwtVerify, errors } from 'jose';

/** A discovery/JWKS call may take this long before it is abandoned. */
export const TIMEOUT_MS = 5000;
/** Discovery/JWKS/userinfo responses are capped at 1 MiB before parsing. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** Keys are re-read at most every 10 minutes; a cached set survives an outage. */
export const KEY_TTL_MS = 10 * 60 * 1000;
/** An unknown `kid` triggers at most one JWKS refetch in this window. */
export const REFETCH_WINDOW_MS = 30 * 1000;
/** The signature algorithm allow-list (RS256 only). */
export const ALGORITHMS = ['RS256'];
/** `iss`/`aud`/`exp`/`nbf` skew allowance. */
export const CLOCK_TOLERANCE_SECONDS = 5;
/** `sub` is stored in `users.idp_subject`; keep it bounded. */
export const MAX_SUBJECT_LENGTH = 255;

/** The identity provider is not configured, or has no usable keys: 503. */
export class UnavailableError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'UnavailableError';
  }
}

/**
 * GETs JSON without following redirects, with a timeout and a body cap.
 * @param {string} url
 * @param {{headers?: Record<string, string>, timeoutMs?: number, maxBytes?: number}} [options]
 * @returns {Promise<any>}
 */
export function getJson(url, options = {}) {
  const {
    headers = {},
    timeoutMs = TIMEOUT_MS,
    maxBytes = MAX_BODY_BYTES,
  } = options;
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(
      target,
      { method: 'GET', headers, timeout: timeoutMs },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error('identity provider request failed'));
          return;
        }
        /** @type {Buffer[]} */
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy();
            reject(new Error('identity provider response too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('identity provider returned invalid JSON'));
          }
        });
        response.on('error', reject);
      },
    );
    request.on('timeout', () =>
      request.destroy(new Error('request timed out')),
    );
    request.on('error', reject);
    request.end();
  });
}

/**
 * @param {object} options
 * @param {string} options.issuer the `iss` every access token must carry
 * @param {string} [options.baseUrl] where to reach the IdP, defaults to the issuer
 * @param {typeof getJson} [options.request] injectable transport
 * @param {() => number} [options.now] injectable clock
 */
export function createOidcClient({
  issuer,
  baseUrl = issuer,
  request = getJson,
  now = Date.now,
}) {
  const issuerUrl = new URL(issuer);
  const base = new URL(baseUrl);
  /** Only the issuer's own authority is trusted to publish endpoints. */
  const sameOrigin = (/** @type {URL} */ target) =>
    target.origin === issuerUrl.origin;
  /** Requests to a different deployment send the issuer's authority. */
  /** @type {Record<string, string>} */
  const hostHeader =
    base.host === issuerUrl.host ? {} : { host: issuerUrl.host };

  /** @type {{jwksUri: string, userinfoEndpoint: string} | undefined} */
  let metadata;
  let metadataAt = Number.NEGATIVE_INFINITY;
  /** @type {Map<string, any>} */
  let keys = new Map();
  let keysAt = Number.NEGATIVE_INFINITY;
  let lastRefetch = Number.NEGATIVE_INFINITY;
  /** @type {Promise<void> | undefined} */
  let loading;

  /** @param {string} value @returns {string} */
  function endpoint(value) {
    const target = new URL(value);
    if (!sameOrigin(target))
      throw new Error('discovery published a cross-origin endpoint');
    return new URL(`${target.pathname}${target.search}`, base).toString();
  }

  /** @returns {Promise<{jwksUri: string, userinfoEndpoint: string}>} */
  async function loadMetadata() {
    if (metadata && now() - metadataAt < KEY_TTL_MS) return metadata;
    const document = await request(
      new URL('/.well-known/openid-configuration', base).toString(),
      { headers: hostHeader },
    );
    if (document?.issuer !== issuer)
      throw new Error('discovery issuer mismatch');
    const next = {
      jwksUri: endpoint(String(document.jwks_uri ?? '')),
      userinfoEndpoint: endpoint(String(document.userinfo_endpoint ?? '')),
    };
    metadata = next;
    metadataAt = now();
    return next;
  }

  /** @returns {Promise<void>} */
  async function loadKeys() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const { jwksUri } = await loadMetadata();
        const document = await request(jwksUri, { headers: hostHeader });
        /** @type {Map<string, any>} */
        const next = new Map();
        for (const jwk of Array.isArray(document?.keys) ? document.keys : []) {
          // RSA signing keys only; anything else is ignored, not attempted.
          if (jwk?.kty !== 'RSA') continue;
          if (typeof jwk.kid !== 'string' || !jwk.kid) continue;
          if (jwk.use && jwk.use !== 'sig') continue;
          if (jwk.alg && jwk.alg !== 'RS256') continue;
          try {
            next.set(jwk.kid, await importJWK(jwk, 'RS256'));
          } catch {
            // A single unusable JWK does not invalidate the set.
          }
        }
        if (next.size === 0) throw new Error('no usable signing keys');
        keys = next;
        keysAt = now();
      } finally {
        loading = undefined;
      }
    })();
    return loading;
  }

  /** With keys cached, an IdP outage must not stop validation. */
  async function ensureKeys() {
    if (keys.size > 0) {
      if (now() - keysAt < KEY_TTL_MS) return;
      try {
        await loadKeys();
      } catch {
        // Keep the cached set: the tokens it can verify stay valid.
      }
      return;
    }
    try {
      await loadKeys();
    } catch {
      throw new UnavailableError('no identity provider keys available');
    }
  }

  /**
   * The key resolver `jwtVerify` calls. An unknown `kid` refetches the JWKS,
   * at most once per window, so random `kid`s cannot become a fetch flood.
   * @param {{kid?: string}} header
   */
  async function keyFor(header) {
    const kid = header.kid;
    if (typeof kid !== 'string' || !kid) throw new Error('token has no kid');
    const cached = keys.get(kid);
    if (cached) return cached;
    if (now() - lastRefetch >= REFETCH_WINDOW_MS) {
      lastRefetch = now();
      try {
        await loadKeys();
      } catch {
        // Fall through: the cached set decides the outcome.
      }
    }
    const found = keys.get(kid);
    if (!found) throw new Error('unknown signing key');
    return found;
  }

  return {
    /**
     * Validates a compact JWS against the IdP's JWKS.
     * @param {string} token
     * @param {string} audience the expected `aud`
     * @returns {Promise<Record<string, any>>}
     */
    async verify(token, audience) {
      await ensureKeys();
      const { payload } = await jwtVerify(token, keyFor, {
        algorithms: ALGORITHMS,
        issuer,
        audience,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['exp', 'nbf', 'sub'],
      });
      if (
        typeof payload.sub !== 'string' ||
        payload.sub.length === 0 ||
        payload.sub.length > MAX_SUBJECT_LENGTH
      )
        throw new Error('invalid subject');
      return payload;
    },
    /**
     * The caller's own userinfo, used once per first sight. Never on the 401
     * path: it is only reached after the token verified.
     * @param {string} token
     * @returns {Promise<Record<string, any>>}
     */
    async userinfo(token) {
      const { userinfoEndpoint } = await loadMetadata();
      return request(userinfoEndpoint, {
        headers: { ...hostHeader, authorization: `Bearer ${token}` },
      });
    },
  };
}

/**
 * True when `jwtVerify` rejected the token on its `aud` claim, i.e. the value
 * may simply be stale (the project audience is written after the API boots).
 * @param {unknown} error
 */
export function isAudienceMismatch(error) {
  return (
    error instanceof errors.JWTClaimValidationFailed && error.claim === 'aud'
  );
}
