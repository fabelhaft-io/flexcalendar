import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { assertProblem } from './support/problem.mjs';

/**
 * Starts the real entry point with no identity provider configured, which is
 * how `make dev` boots before `make seed` has written the project audience.
 */
async function start() {
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      CALFLEX_OIDC_ISSUER: '',
      CALFLEX_OIDC_BASE_URL: '',
      CALFLEX_OIDC_AUDIENCE: '',
      CALFLEX_OIDC_AUDIENCE_FILE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The entry point writes its own startup line and Fastify's logger writes a
  // "Server listening at …" line ahead of it, so the port is read from the
  // line that names it rather than from the first chunk of stdout.
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error('API readiness timed out.')),
      5000,
    );
    timer.unref();
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(
        /flexcalendar api listening on http:\/\/127\.0\.0\.1:(\d+)/,
      );
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('API exited before readiness.'));
    });
  });
  assert.ok(port);
  return {
    base: `http://127.0.0.1:${port}`,
    async stop() {
      child.kill();
      await once(child, 'exit');
    },
  };
}

test('API skeleton starts and answers its readiness probe', async () => {
  const api = await start();
  try {
    const response = await fetch(`${api.base}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', service: 'api' });
  } finally {
    await api.stop();
  }
});

test('the readiness probe is the only route that needs no identity provider', async () => {
  const api = await start();
  try {
    // HEAD too: the probe is what a container healthcheck uses.
    const head = await fetch(`${api.base}/healthz`, { method: 'HEAD' });
    assert.equal(head.status, 200);

    // Everything else is refused while no audience is configured: never
    // accepted, and never a 401 for a request nobody could authenticate.
    for (const path of ['/me', '/']) {
      const response = await fetch(`${api.base}${path}`);
      assert.equal(response.status, 503, `${path} answered ${response.status}`);
      assertProblem(await response.json(), 'unavailable');
    }
  } finally {
    await api.stop();
  }
});
