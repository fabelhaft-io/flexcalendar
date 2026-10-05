// --- calendar-flex API service: local-stack skeleton (E02-R03) ---------------
//
// `make dev` runs this so the stack has a real API at
// https://api.localhost:<port>/ from day one. E05-R01 replaces it with the REST
// facade over CalDAV, on the same technology (Node 24 + TypeScript + Fastify,
// D-01) and under the same rule: this service never decrypts and stores no
// event content (INV-01, INV-07).
//
// Until then it answers liveness only. There is no database connection, no
// Zitadel call and no request logging; the environment variables the container
// receives are read by E05-R01, not here.
//
// `GET /healthz` is the readiness probe (infra/dev/compose.yaml).

import Fastify from 'fastify';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '0.0.0.0';

const service = {
  service: 'api',
  status: 'skeleton',
  note: 'The REST facade over CalDAV arrives with E05-R01.',
};

const app = Fastify({
  // No request logging yet. E05 adds it, with the no-event-content rule (INV-01).
  logger: false,
});

app.get('/healthz', async () => ({ status: 'ok', service: 'api' }));

app.get('/', async () => service);

// 501 rather than 404: the route space exists in earnest, it is simply not
// implemented in this skeleton.
app.setNotFoundHandler(async (request, reply) => {
  reply.code(501);
  return { ...service, method: request.method, url: request.url };
});

try {
  const address = await app.listen({ port, host });
  process.stdout.write(`calendar-flex api skeleton listening on ${address}\n`);
} catch (error) {
  process.stderr.write(
    `calendar-flex api skeleton failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exit(1);
}
