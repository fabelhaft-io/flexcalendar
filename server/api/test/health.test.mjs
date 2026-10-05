import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('API skeleton starts and answers its readiness probe', async () => {
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const output = await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(() => {
        throw new Error('API exited before readiness.');
      }),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('API readiness timed out.')),
          5000,
        );
        timer.unref();
      }),
    ]);
    const port = String(output[0]).match(/:(\d+)/)?.[1];
    assert.ok(port);
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', service: 'api' });
  } finally {
    child.kill();
    await once(child, 'exit');
  }
});
