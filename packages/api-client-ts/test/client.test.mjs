import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/index.ts';

test('GET /healthz uses fetch and decodes the response', async () => {
  const client = createClient({
    baseUrl: 'https://api.localhost:8443',
    fetch: async (request) => {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, 'https://api.localhost:8443/healthz');
      return Response.json({ status: 'ok', service: 'api' });
    },
  });
  const { data, error } = await client.GET('/healthz');
  assert.equal(error, undefined);
  assert.deepEqual(data, { status: 'ok', service: 'api' });
});
