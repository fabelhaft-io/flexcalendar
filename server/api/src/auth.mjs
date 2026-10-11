// --- E05-R01: OIDC bearer authentication for every endpoint but /healthz ----
//
// One global `onRequest` hook validates `Authorization: Bearer <JWT>` against
// the IdP's JWKS before any route runs — unknown routes and unknown methods
// included, so a request without a valid token is always 401 and never 404.
// `GET`/`HEAD /healthz` is the only exemption, and it stays database-free.
//
// `createAuthHook` returns that hook and `registerAuthRoutes` installs the
// route it protects; `buildApp` installs both, after the rate limiter's own
// `onRequest` hook, so a flood of bad tokens is counted before any of them is
// verified.
//
// The token's `sub` maps to a `users` row, created on first sight from the
// issuer's own userinfo (never from an unvalidated token, never by
// introspection). Every refusal is the same 401 with a fixed body and no
// reason code: the caller learns nothing, and nothing is logged (E05-R10 owns
// logging). No token, header, claim or userinfo field reaches a log line, an
// error message or a response body.

import { UnavailableError, isAudienceMismatch } from './oidc.mjs';
import { problemResponse, sendProblem } from './problem.mjs';

/** `users.id` is a uuid; the spec's User schema types it as a string. */
export const userSchema = {
  type: 'object',
  description: 'One `public.users` row; every field is a string.',
  required: ['id', 'handle', 'email'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: 'The `users.id` uuid.' },
    handle: { type: 'string' },
    email: { type: 'string' },
  },
};

const BEARER =
  /^bearer[ \t]+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;
const MAX_TOKEN_LENGTH = 8192;
/** Postgres unique-violation SQLSTATE, for `users_handle_unique`/`users_email_unique`. */
const UNIQUE_VIOLATION = '23505';

/**
 * The one and only 401: identical status, body and headers for every reason.
 * @param {import('fastify').FastifyReply} reply
 */
function unauthorized(reply) {
  reply
    .header('www-authenticate', 'Bearer')
    .header('cache-control', 'no-store');
  sendProblem(reply, 'unauthorized');
}

/**
 * The bearer token of exactly one well-formed `Authorization` header, or
 * undefined. Never read from the query string, never longer than 8 KiB, and
 * never anything but three base64url segments (an opaque token is a 401 before
 * any network call).
 * @param {import('fastify').FastifyRequest} request
 * @returns {string | undefined}
 */
export function bearerToken(request) {
  const distinct = request.raw?.headersDistinct?.authorization;
  if (Array.isArray(distinct) && distinct.length !== 1) return undefined;
  const header =
    (Array.isArray(distinct) ? distinct[0] : undefined) ??
    request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = BEARER.exec(header.trim());
  if (!match) return undefined;
  const token = match[1];
  return token.length > MAX_TOKEN_LENGTH ? undefined : token;
}

/**
 * The per-request identity the hook attaches: the token's `sub`, plus the
 * `users.id` once a route has resolved the row.
 * @param {import('fastify').FastifyRequest} request
 * @returns {{id?: string, sub?: string}}
 */
function identity(request) {
  return /** @type {any} */ (request).user ?? {};
}

/**
 * The one exemption, shared by the auth hook and the rate limiter: exactly
 * `GET`/`HEAD /healthz`, no prefix and no normalised spelling, so a container
 * health check is never refused and nothing else slips through.
 * @param {import('fastify').FastifyRequest} request
 */
export function isHealthProbe(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const url = request.raw?.url ?? request.url ?? '';
  return url.split('?')[0] === '/healthz';
}

/**
 * Resolves the token's subject to a `users` row, creating it on first sight
 * from the issuer's userinfo. Every refusal explains nothing about the token.
 * @param {object} options
 * @param {import('fastify').FastifyRequest} options.request
 * @param {import('fastify').FastifyReply} options.reply
 * @param {{findBySubject: Function, createFirstSight: Function}} options.store
 * @param {{userinfo: Function}} options.oidc
 * @returns {Promise<{id: string, handle: string, email: string} | undefined>}
 */
async function resolveUser({ request, reply, store, oidc }) {
  const subject = identity(request).sub;
  if (!subject) {
    unauthorized(reply);
    return undefined;
  }
  try {
    const existing = await store.findBySubject(subject);
    if (existing) return existing;
  } catch (/** @type {any} */ error) {
    // Logged by name (and, for `pg`, by SQLSTATE) only: a `pg` message can name
    // a row's values — a unique violation prints the e-mail address — so the
    // message and the stack never reach a log line (E05-R10).
    request.log.error({ err: error }, 'store_read_failed');
    sendProblem(reply, 'internal-error');
    return undefined;
  }
  const token = bearerToken(request);
  if (!token) {
    unauthorized(reply);
    return undefined;
  }
  /** @type {any} */
  let claims;
  try {
    claims = await oidc.userinfo(token);
  } catch {
    // A userinfo failure is a 502 and never creates a row.
    sendProblem(reply, 'bad-gateway');
    return undefined;
  }
  if (typeof claims?.sub !== 'string' || claims.sub !== subject) {
    sendProblem(reply, 'bad-gateway');
    return undefined;
  }
  if (claims.email_verified !== true) {
    sendProblem(reply, 'forbidden');
    return undefined;
  }
  const handle =
    typeof claims.preferred_username === 'string'
      ? claims.preferred_username.trim()
      : '';
  const email = typeof claims.email === 'string' ? claims.email.trim() : '';
  if (!handle || !email) {
    sendProblem(reply, 'bad-gateway');
    return undefined;
  }
  try {
    const created = await store.createFirstSight({ subject, handle, email });
    if (!created) {
      sendProblem(reply, 'internal-error');
      return undefined;
    }
    return created;
  } catch (/** @type {any} */ error) {
    // A handle or email that is already taken is a 409; the subject conflict
    // itself is absorbed by ON CONFLICT (idp_subject) DO NOTHING.
    if (error?.code === UNIQUE_VIOLATION) {
      sendProblem(reply, 'conflict');
      return undefined;
    }
    request.log.error({ err: error }, 'store_write_failed');
    sendProblem(reply, 'internal-error');
    return undefined;
  }
}

/**
 * The global `onRequest` hook. Returned rather than installed here: `buildApp`
 * installs it after the rate limiter's hook, in the same routing tree, so the
 * limiter's hook is both statically ahead of it (CodeQL's
 * `js/missing-rate-limiting`) and ahead of it at runtime.
 * @param {object} options
 * @param {{issuer?: string}} options.config
 * @param {{verify: Function, userinfo: Function}} options.oidc
 * @param {{current: Function, refresh: Function}} options.audience
 * @returns {import('fastify').onRequestHookHandler}
 */
export function createAuthHook({ config, oidc, audience }) {
  return async function authenticate(request, reply) {
    if (isHealthProbe(request)) return;
    // Without an issuer or an audience the API cannot validate anyone: 503,
    // never an accepted request.
    const expected = config.issuer ? await audience.current() : undefined;
    if (!config.issuer || !expected) {
      sendProblem(reply, 'unavailable');
      return;
    }
    const token = bearerToken(request);
    if (!token) {
      unauthorized(reply);
      return;
    }
    /** @type {Record<string, any>} */
    let claims;
    try {
      claims = await oidc.verify(token, expected);
    } catch (/** @type {any} */ error) {
      if (error instanceof UnavailableError) {
        sendProblem(reply, 'unavailable');
        return;
      }
      // The project audience is written after the API boots, so an audience
      // mismatch re-reads it once per window before the token is refused.
      if (isAudienceMismatch(error) && (await audience.refresh())) {
        const refreshed = await audience.current();
        if (refreshed && refreshed !== expected) {
          try {
            claims = await oidc.verify(token, refreshed);
          } catch {
            unauthorized(reply);
            return;
          }
        } else {
          unauthorized(reply);
          return;
        }
      } else {
        unauthorized(reply);
        return;
      }
    }
    /** @type {any} */ (request).user = { sub: claims.sub };
  };
}

/**
 * The request decoration and the route the hook protects: `GET /me`. Installed
 * by `buildApp` in the routing tree, after both hooks.
 * @param {import('fastify').FastifyInstance} app
 * @param {object} options
 * @param {{findBySubject: Function, createFirstSight: Function}} options.store
 * @param {{userinfo: Function}} options.oidc
 */
export function registerAuthRoutes(app, { store, oidc }) {
  app.decorateRequest('user', null);

  app.get(
    '/me',
    {
      config: { bearerAuth: true },
      schema: {
        response: {
          200: userSchema,
          // Every refusal the service can answer with is a problem document
          // (E05-R10): the hook's own 401/403/409/502/503, the limiter's 429
          // with its `Retry-After`, and Fastify's own 400/404/405/413/415 and
          // any unhandled 500.
          400: problemResponse(),
          401: problemResponse(),
          403: problemResponse(),
          404: problemResponse(),
          405: problemResponse(),
          409: problemResponse(),
          413: problemResponse(),
          415: problemResponse(),
          429: problemResponse(),
          500: problemResponse(),
          502: problemResponse(),
          503: problemResponse(),
        },
      },
    },
    async (request, reply) => {
      const user = await resolveUser({ request, reply, store, oidc });
      if (!user) return undefined;
      const current = identity(request);
      /** @type {any} */ (request).user = { id: user.id, sub: current.sub };
      return { id: user.id, handle: user.handle, email: user.email };
    },
  );
}
