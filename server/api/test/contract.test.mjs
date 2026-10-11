import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import SwaggerParser from '@apidevtools/swagger-parser';
import { buildApp } from '../src/app.mjs';
import { readConfig } from '../src/config.mjs';

// E05-R01 removes the non-product skeleton page: no route is exempt any more.
/** @type {string[]} */
const allowed = [];
/** @param {string} path */
const normalize = (path) => path.replace(/:([^/]+)/g, '{$1}');
/**
 * @typedef {{method: string, url: string, config?: {bearerAuth?: boolean}, schema?: {response?: Record<string, unknown>}}} Route
 * @typedef {{tags?: string[], responses: Record<string, {content: Record<string, {schema: unknown}>}>, security?: {bearerAuth: unknown}[]}} Operation
 * @typedef {Record<string, Record<string, Operation>>} Paths
 */
/**
 * The operation's effective security: its own, or the document's.
 * @param {Operation} operation @param {{bearerAuth: unknown}[]} documentSecurity
 */
const requiresBearer = (operation, documentSecurity) =>
  (operation.security ?? documentSecurity).some((entry) =>
    Object.hasOwn(entry, 'bearerAuth'),
  );

/** @param {Route[]} routes @param {Paths} paths @param {string[]} exemptions @param {{bearerAuth: unknown}[]} documentSecurity */
function compare(routes, paths, exemptions = allowed, documentSecurity = []) {
  for (const path of exemptions)
    assert.ok(
      routes.some((r) => r.url === path),
      `unused allow-list entry: ${path}`,
    );
  // Fastify synthesizes HEAD for GET; it is not a separate OpenAPI operation.
  const explicit = routes.filter((r) => r.method !== 'HEAD');
  for (const route of explicit) {
    const path = normalize(route.url);
    if (exemptions.includes(path)) continue;
    const operation = paths[path]?.[route.method.toLowerCase()];
    assert.ok(operation, `route missing from spec: ${route.method} ${path}`);
    // Every operation is filed under at least one tag: the generated clients and
    // the docs group by them, and an untagged operation silently lands nowhere.
    assert.ok(
      Array.isArray(operation.tags) && operation.tags.length > 0,
      `operation has no tag: ${route.method} ${path}`,
    );
    // The route's auth requirement and the spec's must agree, in both
    // directions: a route without the hook must not be documented as
    // protected, and a documented `bearerAuth` operation must be hooked.
    assert.equal(
      route.config?.bearerAuth === true,
      requiresBearer(operation, documentSecurity),
      `auth requirement differs: ${route.method} ${path}`,
    );
    for (const [code, response] of Object.entries(operation.responses)) {
      const routeResponse = /** @type {any} */ (route.schema?.response?.[code]);
      assert.ok(routeResponse, `route has no response schema: ${path} ${code}`);
      // A route schema without a `content` map is the plain `application/json`
      // form; one with a map must declare exactly the media types the spec does
      // (E05-R10: success is `application/json`, every error is
      // `application/problem+json`).
      const expectedContent = response.content ?? {};
      const routeContent = routeResponse.content ?? {
        'application/json': { schema: routeResponse },
      };
      assert.deepEqual(
        Object.keys(routeContent).sort(),
        Object.keys(expectedContent).sort(),
        `response content types differ: ${path} ${code}`,
      );
      for (const mediaType of Object.keys(expectedContent)) {
        assert.deepEqual(
          routeContent[mediaType]?.schema,
          expectedContent[mediaType].schema,
          `response schema differs: ${path} ${code} ${mediaType}`,
        );
      }
    }
    // The other direction: a status the route can answer with must exist in
    // the contract, or a client generated from the spec cannot see it.
    for (const code of Object.keys(route.schema?.response ?? {}))
      assert.ok(
        operation.responses[code],
        `route defines a response the spec lacks: ${path} ${code}`,
      );
  }
  for (const [path, operations] of Object.entries(paths))
    for (const method of Object.keys(operations).filter((key) =>
      [
        'get',
        'post',
        'put',
        'patch',
        'delete',
        'head',
        'options',
        'trace',
      ].includes(key),
    ))
      assert.ok(
        routes.some(
          (r) => normalize(r.url) === path && r.method.toLowerCase() === method,
        ),
        `spec operation has no route: ${method} ${path}`,
      );
}

test('OpenAPI 3.1 is valid and every Fastify route agrees with it', async () => {
  const spec = parse(
    readFileSync(
      new URL('../../../spec/openapi.yaml', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(spec.openapi, '3.1.0');
  await SwaggerParser.validate(spec);
  const resolved = await SwaggerParser.dereference(spec);
  /** @type {Route[]} */
  const routes = [];
  const app = buildApp({
    logger: false,
    onRoute(route) {
      for (const method of Array.isArray(route.method)
        ? route.method
        : [route.method])
        routes.push({
          method,
          url: route.url,
          config: /** @type {Route['config']} */ (route.config),
          schema: /** @type {Route['schema']} */ (route.schema),
        });
    },
  });
  try {
    await app.ready();
    compare(
      routes,
      /** @type {Paths} */ (resolved.paths),
      allowed,
      /** @type {{bearerAuth: unknown}[]} */ (resolved.security ?? []),
    );
    const response = await app.inject('/healthz');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok', service: 'api' });
  } finally {
    await app.close();
  }
});

const health = {
  type: 'object',
  required: ['status', 'service'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['ok'] },
    service: { type: 'string', enum: ['api'] },
  },
};
const error = {
  type: 'object',
  required: ['error'],
  additionalProperties: false,
  properties: { error: { type: 'string' } },
};
const operation = {
  tags: ['health'],
  responses: { 200: { content: { 'application/json': { schema: health } } } },
  security: [],
};
const paths = { '/healthz': { get: operation } };
const route = {
  method: 'GET',
  url: '/healthz',
  config: { bearerAuth: false },
  schema: { response: { 200: health } },
};
test('missing operations and schemas fail for their own reasons', () => {
  compare([route], paths, []);
  assert.throws(
    () => compare([{ ...route, url: '/other' }], paths, []),
    /route missing from spec/,
  );
  assert.throws(() => compare([], paths, []), /spec operation has no route/);
  assert.throws(
    () => compare([{ method: 'GET', url: '/healthz' }], paths, []),
    /route has no response schema/,
  );
  assert.throws(
    () => compare([route], paths, ['/']),
    /unused allow-list entry/,
  );
  compare(
    [{ ...route, url: '/items/:id' }],
    { '/items/{id}': { get: operation } },
    [],
  );
});
test('a response code the route can send but the spec lacks fails', () => {
  const withExtra = {
    ...route,
    schema: { response: { 200: health, 503: error } },
  };
  assert.throws(
    () => compare([withExtra], paths, []),
    /route defines a response the spec lacks: \/healthz 503/,
  );
});
test('the auth requirement is compared in both directions', () => {
  const protectedPaths = {
    '/healthz': { get: { ...operation, security: [{ bearerAuth: [] }] } },
  };
  assert.throws(
    () => compare([route], protectedPaths, []),
    /auth requirement differs: GET \/healthz/,
  );
  // The document's security applies when the operation does not override it.
  const inherited = {
    '/healthz': { get: { ...operation, security: undefined } },
  };
  assert.throws(
    () => compare([route], inherited, [], [{ bearerAuth: [] }]),
    /auth requirement differs: GET \/healthz/,
  );
  // …and a hooked route the spec leaves open fails the same way.
  compare(
    [{ ...route, config: { bearerAuth: true } }],
    { '/healthz': { get: { ...operation, security: [{ bearerAuth: [] }] } } },
    [],
  );
  assert.throws(
    () =>
      compare(
        [{ ...route, config: { bearerAuth: true } }],
        { '/healthz': { get: { ...operation, security: [] } } },
        [],
      ),
    /auth requirement differs: GET \/healthz/,
  );
});
test('an operation without a tag fails', () => {
  // `'health'` is not a tag list at all; the check must refuse it too.
  for (const tags of /** @type {any[]} */ ([undefined, [], 'health'])) {
    assert.throws(
      () =>
        compare([route], { '/healthz': { get: { ...operation, tags } } }, []),
      /operation has no tag: GET \/healthz/,
      `tags ${JSON.stringify(tags)} was accepted`,
    );
  }
  // The real document is checked the same way: removing `tags` from `/me` in
  // `spec/openapi.yaml` fails the first test in this file.
});
for (const [name, schema] of Object.entries({
  type: { ...health, type: 'string' },
  required: { ...health, required: ['status'] },
  enum: {
    ...health,
    properties: {
      ...health.properties,
      status: { type: 'string', enum: ['bad'] },
    },
  },
  extraProperty: {
    ...health,
    properties: { ...health.properties, extra: { type: 'string' } },
  },
  additionalProperties: { ...health, additionalProperties: true },
}))
  test(`schema mismatch: ${name}`, () => {
    assert.throws(
      () =>
        compare(
          [{ ...route, schema: { response: { 200: schema } } }],
          paths,
          [],
        ),
      /response schema differs/,
    );
  });

test('a response content type the spec does not declare fails', () => {
  // The route answers a problem where the contract promises JSON.
  const withProblem = {
    ...route,
    schema: {
      response: {
        200: {
          content: { 'application/problem+json': { schema: health } },
        },
      },
    },
  };
  assert.throws(
    () => compare([withProblem], paths, []),
    /response content types differ: \/healthz 200/,
  );
});

/**
 * The runtime half of the contract check: a response the real service answered
 * must be one the spec declares, with the media type the spec declares.
 * @param {any} resolved the dereferenced spec
 * @param {{method: string, path: string, statusCode: number, contentType: string}} actual
 */
function assertDeclaredResponse(resolved, actual) {
  const operation = resolved.paths[actual.path]?.[actual.method.toLowerCase()];
  assert.ok(operation, `the spec has no ${actual.method} ${actual.path}`);
  const declared = operation.responses?.[String(actual.statusCode)];
  assert.ok(
    declared,
    `undeclared response code: ${actual.method} ${actual.path} ${actual.statusCode}`,
  );
  const mediaType = actual.contentType.split(';')[0];
  assert.ok(
    declared.content?.[mediaType],
    `undeclared content type: ${actual.method} ${actual.path} ${actual.statusCode} ${mediaType}`,
  );
}

test('every response the real service answers is declared, type included', async () => {
  const spec = parse(
    readFileSync(
      new URL('../../../spec/openapi.yaml', import.meta.url),
      'utf8',
    ),
  );
  const resolved = await SwaggerParser.dereference(spec);
  const app = buildApp({
    logger: false,
    config: readConfig({
      CALFLEX_OIDC_ISSUER: 'https://auth.example.test',
      CALFLEX_OIDC_BASE_URL: 'https://auth.example.test',
      CALFLEX_OIDC_AUDIENCE: 'project-id',
    }),
    oidc: {
      /** @param {string} token */
      async verify(token) {
        if (token !== 'aaa.bbb.ccc') throw new Error('invalid token');
        return { sub: 'known-subject' };
      },
      async userinfo() {
        throw new Error('userinfo is not part of this test');
      },
    },
    audience: {
      async current() {
        return 'project-id';
      },
      async refresh() {
        return false;
      },
    },
    store: {
      /** @param {string} subject */
      async findBySubject(subject) {
        return subject === 'known-subject'
          ? {
              id: '11111111-1111-4111-8111-111111111111',
              handle: 'alice',
              email: 'alice@example.test',
            }
          : undefined;
      },
      async createFirstSight() {
        throw new Error('first sight is not part of this test');
      },
    },
  });
  try {
    await app.ready();
    const probes = [
      { method: 'GET', path: '/healthz', headers: {} },
      { method: 'GET', path: '/me', headers: {} },
      {
        method: 'GET',
        path: '/me',
        headers: { authorization: 'Bearer aaa.bbb.ccc' },
      },
      {
        method: 'GET',
        path: '/me',
        headers: { authorization: 'Bearer xxx.yyy.zzz' },
      },
    ];
    for (const probe of probes) {
      const response = /** @type {any} */ (
        await app.inject(
          /** @type {any} */ ({
            method: probe.method,
            url: probe.path,
            headers: probe.headers,
          }),
        )
      );
      assert.ok(
        response.headers['x-request-id'],
        `no correlation ID on ${probe.method} ${probe.path}`,
      );
      assertDeclaredResponse(resolved, {
        method: probe.method,
        path: probe.path,
        statusCode: response.statusCode,
        contentType: String(response.headers['content-type']),
      });
    }

    // The limiter's 429 too, which never reaches a route.
    const limited = buildApp({
      logger: false,
      config: readConfig({
        CALFLEX_OIDC_ISSUER: 'https://auth.example.test',
        CALFLEX_OIDC_BASE_URL: 'https://auth.example.test',
        CALFLEX_OIDC_AUDIENCE: 'project-id',
        CALFLEX_RATE_LIMIT_MAX: '1',
      }),
      audience: {
        async current() {
          return 'project-id';
        },
        async refresh() {
          return false;
        },
      },
    });
    try {
      await limited.ready();
      await limited.inject({ url: '/me' });
      const flood = /** @type {any} */ (await limited.inject({ url: '/me' }));
      assert.equal(flood.statusCode, 429);
      assertDeclaredResponse(resolved, {
        method: 'GET',
        path: '/me',
        statusCode: flood.statusCode,
        contentType: String(flood.headers['content-type']),
      });
      assert.equal(flood.headers['retry-after'], '60');
    } finally {
      await limited.close();
    }
  } finally {
    await app.close();
  }
});
