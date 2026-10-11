// --- flexcalendar API service (E05-R01, E05-R03, E05-R10) --------------------
//
// A thin Fastify service that fronts CalDAV for our own clients (D-01). Every
// route is declared here and in `spec/openapi.yaml`; the contract test proves
// the two agree. Every route but the readiness probe is behind two global
// `onRequest` hooks, installed in this order: the rate limiter, then the OIDC
// bearer hook (`src/auth.mjs`). An unauthenticated flood is therefore counted
// before a single token is verified, and a refused request is a 429.
//
// E05-R03 adds the calendars routes (`src/calendars.mjs`) and the two things
// they needed here: the CalDAV adapter (built on first use, so a service that
// cannot reach the listener still boots) and a route table that turns "known
// path, unregistered method" into a 405 with `Allow` instead of Fastify's 404
// (`src/allow.mjs`).
//
// E05-R04 adds the events routes (`src/events.mjs`): single-object CRUD with
// `If-Match`/`If-None-Match` forwarded to CalDAV, the raw object plus a parsed
// view in every answer, and the current representation inside a 412.
//
// E05-R10 owns the error model and the observability hooks:
//
//   * Every error is an RFC 9457 problem document (`src/problem.mjs`), never
//     Fastify's default body — Fastify's own framework refusals (an over-long
//     path parameter, a URL that is not a URL) included, which `frameworkErrors`
//     below turns into the same fixed problems.
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
import { createAllowRegistry } from './allow.mjs';
import { createAudienceSource } from './audience.mjs';
import {
  createAuthHook,
  isHealthProbe,
  registerAuthRoutes,
  userSchema,
} from './auth.mjs';
import { createCalDavAdapter } from './caldav/adapter.mjs';
import { registerCalendarRoutes } from './calendars.mjs';
import { registerEventRoutes } from './events.mjs';
import { readConfig } from './config.mjs';
import { UnavailableError, createOidcClient } from './oidc.mjs';
import { problemForStatus, problemResponse, sendProblem } from './problem.mjs';

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
 * A calendars store with no database: the routes that need one answer a 500
 * through the error handler rather than pretending a calendar exists.
 */
const noCalendars = {
  async listForMember() {
    throw new Error('no database configured');
  },
  async findMembership() {
    throw new Error('no database configured');
  },
  async createPrivate() {
    throw new Error('no database configured');
  },
  async replaceMeta() {
    throw new Error('no database configured');
  },
  async remove() {
    throw new Error('no database configured');
  },
};

/**
 * The CalDAV adapter, built on first use. Building it validates the origin and
 * the delegation keys, so a service that cannot reach CalDAV still boots and
 * answers its readiness probe; the first request that needs CalDAV is the one
 * that gets the configuration error, as a problem document.
 * @returns {{forUser: (userId: string, options: {requestId?: string}) => {makeCalendar: Function, deleteCalendar: Function, putObject: Function, getObject: Function, deleteObject: Function}}}
 */
function createLazyAdapter() {
  /** @type {ReturnType<typeof createCalDavAdapter> | undefined} */
  let adapter;
  return {
    forUser(userId, options) {
      adapter ??= createCalDavAdapter();
      return adapter.forUser(userId, options);
    },
  };
}

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
 * @param {{listForMember: Function, findMembership: Function, createPrivate: Function, replaceMeta: Function, remove: Function}} [options.calendars]
 * @param {{forUser: any}} [options.caldav] the CalDAV adapter; built from the environment on first use, and typed where its methods are used (`src/calendars.mjs`, `src/events.mjs`)
 * @param {{verify: Function, userinfo: Function}} [options.oidc]
 * @param {{current: Function, refresh: Function}} [options.audience]
 * @param {import('fastify').onRouteHookHandler} [options.onRoute] used by the contract test
 * @param {false | {stream?: {write: (message: string) => void}}} [options.logger] tests capture a stream this way
 */
export function buildApp({
  config = readConfig(),
  store,
  calendars,
  caldav,
  oidc,
  audience,
  onRoute,
  logger,
} = {}) {
  const app = Fastify({
    logger: loggerOptions(config.logLevel, logger),
    // The longest path parameter this service has a rule for. A `uid` of up to
    // `calendarobjects.uid`'s `VARCHAR(200)` (E03-R10) has to reach the route,
    // so it gets the 404 an unknown one gets instead of the router's own 414;
    // anything longer is still refused before a handler runs.
    routerOptions: { maxParamLength: 200 },
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
    // Fastify's own refusals — a path parameter over the router's limit, a URL
    // that is not a URL — happen before any route runs, and its default body is
    // `{"error":…,"code":"FST_ERR_…","message":"'/calendars/…'"}`: not a problem
    // document, and it carries the request path (E05-R10: nothing in a body is
    // derived from the request). They are answered here as the same fixed
    // problems the routes use.
    frameworkErrors: (error, request, reply) => {
      // A parameter longer than the router allows cannot name anything this API
      // ever minted, which is the `404` a `uid` or a calendar id outside the
      // canonical shape gets (E03-R10); a malformed URL and every other
      // framework refusal follow their own status through the problem table.
      const slug =
        /** @type {any} */ (error)?.code === 'FST_ERR_MAX_PARAM_LENGTH'
          ? 'not-found'
          : problemForStatus(/** @type {any} */ (error)?.statusCode);
      sendProblem(reply, slug, { instance: request.id });
    },
    // Behind Caddy, `request.ip` is the client; directly exposed, it is the
    // socket address and `X-Forwarded-For` is ignored.
    trustProxy: trustProxy(config.trustedProxyHops),
  });

  // The 405 table (E05-R03): every registered route, recorded as Fastify
  // registers it, so the not-found handler can tell an unknown path from a
  // known one under another method.
  const allow = createAllowRegistry();
  app.addHook('onRoute', (route) => {
    allow.add(route.url, route.method);
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
      // A method other than GET/HEAD is a 405 like everywhere else — it just
      // needs a token first, because the readiness exemption is exactly those
      // two methods (E05-R01).
      schema: { response: { 200: healthSchema, 405: problemResponse() } },
    },
    async () => ({ status: 'ok', service: 'api' }),
  );

  const dependencies = {
    config,
    store: store ?? noDatabase,
    calendars: calendars ?? noCalendars,
    caldav: caldav ?? createLazyAdapter(),
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
  registerCalendarRoutes(app, dependencies);
  registerEventRoutes(app, dependencies);

  // An unknown path is a 404; a known path under a method it does not register
  // is a 405 with the methods it does (`Allow`), which is why this handler asks
  // the route table before it answers (E05-R03). Either way the body is a
  // problem document and never Fastify's default JSON.
  app.setNotFoundHandler((request, reply) => {
    const methods = allow.allowFor(request.raw?.url ?? request.url ?? '');
    if (methods !== undefined) {
      reply.header('allow', methods.join(', '));
      sendProblem(reply, 'method-not-allowed', { instance: request.id });
      return;
    }
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
