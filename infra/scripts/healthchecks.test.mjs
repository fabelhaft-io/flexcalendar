import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { portableExecHealthcheck } from './healthchecks.mjs';

test('stack health checks are portable to Podman 4.9; bad probes fail', () => {
  const good = parse(readFileSync('infra/dev/compose.yaml', 'utf8'));
  const bad = JSON.parse(
    readFileSync('infra/scripts/fixtures/bad-healthchecks.json', 'utf8'),
  );
  for (const service of Object.values(good.services)) {
    assert.equal(portableExecHealthcheck(service.healthcheck?.test), true);
  }
  for (const service of Object.values(bad.services)) {
    assert.equal(portableExecHealthcheck(service.healthcheck.test), false);
  }
  assert.equal(portableExecHealthcheck(['CMD', 'probe', 'with\ttab']), false);
  assert.equal(
    portableExecHealthcheck(['CMD-SHELL', 'probe with spaces']),
    true,
  );
});

test('API and CalDAV probes preserve success and failure exit codes', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const compose = parse(readFileSync('infra/dev/compose.yaml', 'utf8'));
  for (const [service, port] of /** @type {[string, number][]} */ ([
    ['caldav', 8080],
    ['api', 3000],
  ])) {
    let status = 200;
    const server = createServer((request, response) => {
      assert.equal(request.url, '/healthz');
      response.writeHead(status);
      response.end();
    });
    const probe = () =>
      new Promise((resolve, reject) => {
        const [, executable, ...args] =
          compose.services[service].healthcheck.test;
        const child = spawn(executable, args, { stdio: 'ignore' });
        child.on('error', reject);
        child.on('exit', resolve);
      });
    await new Promise((resolve) =>
      server.listen(port, '127.0.0.1', () => resolve(undefined)),
    );
    try {
      assert.equal(await probe(), 0);
      status = 503;
      assert.equal(await probe(), 1);
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve(undefined))),
      );
    }
    assert.equal(await probe(), 1);
  }
});
