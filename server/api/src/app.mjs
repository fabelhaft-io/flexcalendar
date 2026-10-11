// --- flexcalendar API service (E05-R01, E05-R10) -----------------------------
//
// A thin Fastify service that fronts CalDAV for our own clients (D-01). Every
// route is declared here and in `spec/openapi.yaml`; the contract test proves
// the two agree. Every route but the readiness probe is behind two global
// `onRequest` hooks, installed in this order: the rate limiter, then the OIDC
// bearer hook (`src/auth.mjs`). An unauthenticated flood is therefore counted
// before a single token is verified, and a refused request is a 429.
//
// E05-R10 owns the error model and the observability hooks:
//
//   * Every error is an RFC 9457 problem document (`src/problem.mjs`), never
//     Fastify's default body.
//   * Every request gets a correlation ID — a UUIDv4 we mint, or an inbound
//     `X-Request-Id` only when it is already a lowercase v4 UUID. It is on every
//     response and goes to CalDAV with the adapter (`forUser(id, {requestId})`).
//   * One structured log line per response, from fixed fields only: the
//     correlation ID, the method, the route *template*, the status and the
//     duration. Never the URL, a query value, a header, a body, an address, a
//     claim or an e-mail.
//
// The service never decrypts and stores no event content (INV-01, INV-07).

import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { createAudienceSource } from './audience.mjs';
import {
  createAuthHook,
  isHealthProbe,
  registerAuthRoutes,
  userSchema,
} from './auth.mjs';
import { readConfig } from './config.mjs';
import { UnavailableError, createOidcClient } from './oidc.mjs';
import { problemForStatus, sendProblem } from './problem.mjs';

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

// Kept for the contract test.
export { userSchema };

/** The header the correlation ID is returned in and sent to CalDAV in. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Exactly a lowercase UUIDv4; anything else is replaced, never trusted. */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The pino levels; `config.mjs` refuses anything outside this list at startup. */
/** @typedef {'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent'} LogLevel */

/** A `pg` SQLSTATE, the only `error.code` a log line may carry. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * The `err` serializer. pino's own prints `message` and `stack`, which can hold
 * a `pg` message (a unique violation prints the e-mail address), a token or a
 * piece of a body. This one keeps the error's name and, for `pg`, the SQLSTATE
 * code — and nothing else.
 * @param {unknown} error
 */
export function serialiseError(error) {
  const name =
    error instanceof Error
      ? error.name
      : typeof (/** @type {any} */ (error)?.name) === 'string'
        ? /** @type {any} */ (error).name
        : typeof error;
  /** @type {{type: string, code?: string}} */
  const serialised = { type: name };
  const code = /** @type {any} */ (error)?.code;
  // Only a five-character uppercase alphanumeric code, which is what Postgres
  // throws; Node's own `code`s (`ENOENT`, `ERR_…`) are longer and are dropped.
  if (typeof code === 'string' && SQLSTATE.test(code)) {
    serialised.code = code;
  }
  return serialised;
}

/**
 * The logger options. `req` and `res` are overridden with empty serializers so
 * no Fastify code path can print a URL, a header or a socket address through
 * them; the request line this service emits is the one below.
 *
 * The serializers are cast because Fastify's type for `serializers.err` demands
 * a `message` and a `stack`, and `serialiseError` deliberately returns neither.
 * @param {string} level
 * @param {false | {stream?: {write: (message: string) => void}}} [logger]
 */
function loggerOptions(level, logger) {
  if (logger === false) return false;
  return {
    level: /** @type {LogLevel} */ (level),
    serializers: /** @type {any} */ ({
      req: () => ({}),
      res: /** @param {any} reply */ (reply) => ({
        statusCode: reply?.statusCode,
      }),
      err: serialiseError,
    }),
    ...(logger ?? {}),
  };
}

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
 * @param {false | {stream?: {write: (message: string) => void}}} [options.logger] tests capture a stream this way
 */
export function buildApp({
  config = readConfig(),
  store,
  oidc,
  audience,
  onRoute,
  logger,
} = {}) {
  const app = Fastify({
    logger: loggerOptions(config.logLevel, logger),
    // The correlation ID is ours: an inbound `X-Request-Id` is believed only
    // when it is already exactly a lowercase v4 UUID (log injection).
    requestIdHeader: false,
    genReqId: (request) => {
      const inbound = request.headers?.['x-request-id'];
      return typeof inbound === 'string' && UUID_V4.test(inbound)
        ? inbound
        : randomUUID();
    },
    // Fastify's own request/response lines print the URL, the address and, on
    // an error, `error.message`. All three are refused here; `onResponse` below
    // emits the one line this service logs.
    logController: new Fastify.LogController({ disableRequestLogging: true }),
    // Behind Caddy, `request.ip` is the client; directly exposed, it is the
    // socket address and `X-Forwarded-For` is ignored.
    trustProxy: trustProxy(config.trustedProxyHops),
  });

  if (onRoute) app.addHook('onRoute', onRoute);

  // Every response carries the correlation ID, the 401s and 429s that never
  // reach a route included.
  app.addHook('onSend', async (request, _reply, payload) => {
    _reply.header(REQUEST_ID_HEADER, request.id);
    return payload;
  });

  // One line per response, from fixed fields only. `route` is the route
  // template (`request.routeOptions.url`) so a path parameter is never logged;
  // an unmatched request is `unmatched`.
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions?.url || 'unmatched',
        status: reply.statusCode,
        durationMs: reply.elapsedTime,
      },
      'request',
    );
  });

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

  // An unknown path and an unknown method on a known path both answer here; the
  // body is a problem document and never Fastify's default JSON.
  app.setNotFoundHandler((request, reply) => {
    sendProblem(reply, 'not-found', { instance: request.id });
  });

  // Whatever went wrong, the answer is a problem document: a fixed `title` per
  // kind, no `detail`, and nothing derived from the request or the exception.
  // The error itself is logged by name (and, for `pg`, by SQLSTATE) — never by
  // message or stack.
  app.setErrorHandler((error, request, reply) => {
    const raw = Number(/** @type {any} */ (error)?.statusCode);
    const status =
      Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : 500;
    const slug = problemForStatus(status);
    if (status >= 500) {
      request.log.error({ err: error }, 'request_failed');
    } else if (status !== 429) {
      // A refused request is expected traffic; the limiter's 429 is covered by
      // the request line and would only add noise at one line per client over
      // its limit.
      request.log.warn({ err: error }, 'request_rejected');
    }
    sendProblem(reply, slug, { instance: request.id });
  });

  return app;
}
