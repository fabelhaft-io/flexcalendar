// --- flexcalendar API service (E05-R01) ------------------------------------
//
// A thin Fastify service that fronts CalDAV for our own clients (D-01). Every
// route is declared here and in `spec/openapi.yaml`; the contract test proves
// the two agree. Every route but the readiness probe is behind two global
// `onRequest` hooks, installed in this order: the rate limiter, then the OIDC
// bearer hook (`src/auth.mjs`). An unauthenticated flood is therefore counted
// before a single token is verified, and a refused request is a 429. No request
// logging yet (E05-R10 owns it), and the service never decrypts and stores no
// event content (INV-01, INV-07).

import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { createAudienceSource } from './audience.mjs';
import {
  createAuthHook,
  errorSchema,
  isHealthProbe,
  registerAuthRoutes,
  userSchema,
} from './auth.mjs';
import { readConfig } from './config.mjs';
import { UnavailableError, createOidcClient } from './oidc.mjs';

/** The readiness probe body; also the spec's Health schema. */
export const healthSchema = {
  type: 'object',
  required: ['status', 'service'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['ok'] },
    service: { type: 'string', enum: ['api'] },
  },
};

// Kept for the contract test and for E05-R10, which owns logging.
export { errorSchema, userSchema };

/** A store with no database: `/me` cannot answer, but the service still boots. */
const noDatabase = {
  async findBySubject() {
    return undefined;
  },
  async createFirstSight() {
    throw new Error('no database configured');
  },
};

/** An IdP that is never configured: the hook refuses before it is consulted. */
const noIssuer = {
  async verify() {
    throw new UnavailableError('no issuer configured');
  },
  async userinfo() {
    throw new UnavailableError('no issuer configured');
  },
};

/**
 * How many client keys the limiter's in-memory store keeps, so a flood cannot
 * grow it without bound. One API instance runs on the one VPS (D-10); the
 * README says what a second instance would need.
 */
const RATE_LIMIT_CACHE_KEYS = 10_000;

/**
 * Fastify 5's numeric `trustProxy` fails closed instead of counting hops, so
 * the hop count becomes the predicate it expects: hop 0 is the socket (an
 * untrusted client may forge `X-Forwarded-For`), hop 1 is the one proxy in
 * front of us (Caddy), whose address we trust and whose `X-Forwarded-For` is
 * the client.
 * @param {number} hops
 * @returns {false | ((address: string, hop: number) => boolean)}
 */
const trustProxy = (hops) =>
  hops === 0 ? false : (_address, hop) => hop < hops;

/**
 * The limiter as one global `onRequest` hook. `@fastify/rate-limit` installs
 * its own hook per route through `onRoute`, and route-level hooks run *after*
 * instance-level ones — so the limiter is applied here, on the instance, ahead
 * of the auth hook and on every path, unknown ones included.
 * @param {import('fastify').FastifyInstance} app
 * @param {import('@fastify/rate-limit').RateLimitOptions} options
 * @returns {import('fastify').onRequestHookHandler}
 */
function createRateLimitHook(app, options) {
  /**
   * Built once, on the first request: the decorator only exists once the
   * plugin above has loaded.
   * @type {(request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<unknown>}
   */
  let limiter;
  return async function rateLimitRequest(request, reply) {
    limiter ??= app.rateLimit(options);
    await limiter(request, reply);
  };
}

/**
 * @param {object} [options]
 * @param {ReturnType<typeof readConfig>} [options.config] defaults to the environment
 * @param {{findBySubject: Function, createFirstSight: Function}} [options.store]
 * @param {{verify: Function, userinfo: Function}} [options.oidc]
 * @param {{current: Function, refresh: Function}} [options.audience]
 * @param {import('fastify').onRouteHookHandler} [options.onRoute] used by the contract test
 */
export function buildApp({
  config = readConfig(),
  store,
  oidc,
  audience,
  onRoute,
} = {}) {
  const app = Fastify({
    // No request logging yet. E05 adds it, with the no-event-content rule (INV-01).
    logger: false,
    // Behind Caddy, `request.ip` is the client; directly exposed, it is the
    // socket address and `X-Forwarded-For` is ignored.
    trustProxy: trustProxy(config.trustedProxyHops),
  });

  if (onRoute) app.addHook('onRoute', onRoute);

  app.get(
    '/healthz',
    {
      config: { bearerAuth: false },
      schema: { response: { 200: healthSchema } },
    },
    async () => ({ status: 'ok', service: 'api' }),
  );

  const dependencies = {
    config,
    store: store ?? noDatabase,
    oidc:
      oidc ??
      (config.issuer
        ? createOidcClient({ issuer: config.issuer, baseUrl: config.baseUrl })
        : noIssuer),
    audience:
      audience ??
      createAudienceSource({
        audience: config.audience,
        file: config.audienceFile,
      }),
  };

  /** @type {import('@fastify/rate-limit').RateLimitOptions} */
  const rateLimitOptions = {
    // Per client address, in memory: one API instance, one VPS (D-10).
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowSeconds * 1000,
    cache: RATE_LIMIT_CACHE_KEYS,
    // The container health check is never refused, whatever the client did.
    allowList: isHealthProbe,
  };

  // The registration comes first, visibly, ahead of the hook and the routes it
  // guards (CodeQL's js/missing-rate-limiting), and its hook is installed ahead
  // of the bearer hook so a flood of bad tokens is counted before it is
  // verified. `global` is off because the limiter runs as that one instance
  // hook, not once per route.
  app.register(rateLimit, { global: false, ...rateLimitOptions });
  app.addHook('onRequest', createRateLimitHook(app, rateLimitOptions));
  app.addHook('onRequest', createAuthHook(dependencies));

  registerAuthRoutes(app, dependencies);

  // A fixed body, whatever went wrong: an error message must never carry a
  // token, a claim or envelope bytes out of the service.
  app.setErrorHandler((error, request, reply) => {
    const status = Number(/** @type {any} */ (error)?.statusCode);
    // The limiter's refusal. `@fastify/rate-limit` has already put `Retry-After`
    // on the reply, and the body names no counter, key or address.
    if (status === 429) {
      reply.code(429).send({ error: 'rate_limited' });
      return;
    }
    reply
      .code(
        Number.isInteger(status) && status >= 400 && status < 500
          ? status
          : 500,
      )
      .send({ error: 'request_failed' });
  });

  return app;
}
