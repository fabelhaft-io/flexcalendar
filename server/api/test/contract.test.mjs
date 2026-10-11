import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import SwaggerParser from '@apidevtools/swagger-parser';
import { buildApp } from '../src/app.mjs';

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
      const expected = response.content?.['application/json']?.schema;
      if (!expected) continue;
      const actual = route.schema?.response?.[code];
      assert.ok(actual, `route has no response schema: ${path} ${code}`);
      assert.deepEqual(
        actual,
        expected,
        `response schema differs: ${path} ${code}`,
      );
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
