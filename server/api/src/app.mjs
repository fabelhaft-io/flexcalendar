import Fastify from 'fastify';

/** @param {{ onRoute?: import('fastify').onRouteHookHandler }} [options] */
export function buildApp(options = {}) {
  const service = {
    service: 'api',
    status: 'skeleton',
    note: 'The REST facade over CalDAV arrives with E05-R01.',
  };

  const app = Fastify({
    // No request logging yet. E05 adds it, with the no-event-content rule (INV-01).
    logger: false,
  });

  if (options.onRoute) app.addHook('onRoute', options.onRoute);

  app.get(
    '/healthz',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            required: ['status', 'service'],
            additionalProperties: false,
            properties: {
              status: { type: 'string', enum: ['ok'] },
              service: { type: 'string', enum: ['api'] },
            },
          },
        },
      },
    },
    async () => ({ status: 'ok', service: 'api' }),
  );

  app.get('/', async () => service);

  // 501 rather than 404: the route space exists in earnest, it is simply not
  // implemented in this skeleton.
  app.setNotFoundHandler(async (request, reply) => {
    reply.code(501);
    return { ...service, method: request.method, url: request.url };
  });

  return app;
}

// Review-only change: selects the server-api component job without the stack.
