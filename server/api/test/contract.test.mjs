import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import SwaggerParser from '@apidevtools/swagger-parser';
import { buildApp } from '../src/app.mjs';

// E05-R01 removes this non-product skeleton page. No other route is exempt.
const allowed = ['/'];
/** @param {string} path */
const normalize = (path) => path.replace(/:([^/]+)/g, '{$1}');
/** @typedef {{method: string, url: string, schema?: {response?: Record<string, unknown>}}} Route */
/** @typedef {Record<string, Record<string, {responses: Record<string, {content: Record<string, {schema: unknown}>}>}>>} Paths */
/** @param {Route[]} routes @param {Paths} paths @param {string[]} exemptions */
function compare(routes, paths, exemptions = allowed) {
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
          schema: /** @type {Route['schema']} */ (route.schema),
        });
    },
  });
  try {
    await app.ready();
    compare(routes, /** @type {Paths} */ (resolved.paths));
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
const operation = {
  responses: { 200: { content: { 'application/json': { schema: health } } } },
};
const paths = { '/healthz': { get: operation } };
const route = {
  method: 'GET',
  url: '/healthz',
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
