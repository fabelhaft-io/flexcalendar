// --- calendar-flex API service (E05-R01) ------------------------------------
//
// A thin Fastify service that fronts CalDAV for our own clients (D-01). Every
// route is declared here and in `spec/openapi.yaml`; the contract test proves
// the two agree. Every route but the readiness probe is behind the OIDC bearer
// hook (`src/auth.mjs`). No request logging yet (E05-R10 owns it), and the
// service never decrypts and stores no event content (INV-01, INV-07).

import Fastify from 'fastify';
import { createAudienceSource } from './audience.mjs';
import { errorSchema, registerAuth, userSchema } from './auth.mjs';
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

  registerAuth(app, {
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
  });

  // A fixed body, whatever went wrong: an error message must never carry a
  // token, a claim or envelope bytes out of the service.
  app.setErrorHandler((error, request, reply) => {
    const status = Number(/** @type {any} */ (error)?.statusCode);
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
