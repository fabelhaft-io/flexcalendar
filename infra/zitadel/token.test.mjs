import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { getToken, refuseProduction, verifyAccessToken } from './token.mjs';
import { run } from './run.mjs';

const issuer = 'https://auth.localhost:8443';
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'test-signing-key',
  alg: 'RS256',
  use: 'sig',
};
function jwt(overrides = {}) {
  const payload = [
    Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString(
      'base64url',
    ),
    Buffer.from(
      JSON.stringify({
        iss: issuer,
        aud: ['project'],
        sub: 'alice-id',
        exp: Math.floor(Date.now() / 1000) + 60,
        ...overrides,
      }),
    ).toString('base64url'),
  ].join('.');
  return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`;
}

async function stub(t, overrides = {}) {
  let challenge, state, session, code;
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = req.headers['content-type']?.startsWith('application/json')
      ? JSON.parse(raw)
      : new URLSearchParams(raw);
    const url = new URL(req.url, issuer);
    calls.push({
      path: url.pathname,
      method: req.method,
      authorization: req.headers.authorization,
    });
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const redirect = (location) => {
      res.writeHead(302, { location });
      res.end();
    };
    if (url.pathname === '/management/v1/orgs/me') {
      assert.equal(req.headers.authorization, 'Bearer seed-pat');
      return json(200, { org: { id: 'org-id' } });
    }
    if (url.pathname === '/.well-known/openid-configuration')
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/oauth/v2/authorize`,
        token_endpoint: `${issuer}/oauth/v2/token`,
        jwks_uri: `${issuer}/oauth/v2/keys`,
      });
    if (url.pathname === '/oauth/v2/authorize') {
      assert.equal(url.searchParams.get('client_id'), 'android');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(url.searchParams.get('response_type'), 'code');
      assert.ok(
        url.searchParams
          .get('scope')
          .includes('urn:zitadel:iam:org:project:id:project:aud'),
      );
      challenge = url.searchParams.get('code_challenge');
      state = url.searchParams.get('state');
      return redirect(`${issuer}/ui/v2/login/login?authRequest=auth-id`);
    }
    if (url.pathname === '/management/v1/users/_search') {
      assert.equal(req.headers.authorization, 'Bearer helper-pat');
      assert.equal(body.queries[0].userNameQuery.userName, 'alice');
      return json(200, { result: [{ id: 'alice-id' }] });
    }
    if (url.pathname === '/v2/sessions' && req.method === 'POST') {
      assert.equal(req.headers.authorization, 'Bearer helper-pat');
      assert.equal(body.checks.user.userId, 'alice-id');
      assert.equal(body.checks.password.password, 'Development1!');
      session = { sessionId: 'session', sessionToken: 'session-token' };
      return json(200, session);
    }
    if (url.pathname === '/v2/oidc/auth_requests/auth-id') {
      assert.deepEqual(body.session, session);
      assert.equal(req.headers.authorization, 'Bearer helper-pat');
      assert.equal(code, undefined, 'auth request must only be completed once');
      code = 'single-use-code';
      return json(200, { callbackUrl: `${issuer}/oidc/v1/authorize/callback` });
    }
    if (url.pathname === '/oidc/v1/authorize/callback')
      return redirect(
        `de.flexcalendar.app:/oauth2redirect?code=${code}&state=${overrides.badState ? 'wrong' : state}`,
      );
    if (url.pathname === '/oauth/v2/token') {
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('client_id'), 'android');
      assert.equal(body.get('code'), code);
      assert.equal(
        createHash('sha256')
          .update(body.get('code_verifier'))
          .digest('base64url'),
        challenge,
      );
      code = undefined; // A second exchange must fail.
      return json(200, {
        access_token: overrides.token ?? jwt(),
        token_type: 'Bearer',
      });
    }
    if (url.pathname === '/oauth/v2/keys') return json(200, { keys: [jwk] });
    if (url.pathname === '/v2/sessions/session' && req.method === 'DELETE') {
      assert.ok(session, 'session must exist before deletion');
      session = undefined;
      return json(200, {});
    }
    return json(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    calls,
    getSession: () => session,
  };
}

function settings(baseUrl) {
  return {
    issuer,
    baseUrl,
    environment: 'local',
    clientId: 'android',
    projectId: 'project',
    pat: 'helper-pat',
    password: 'Development1!',
    user: 'alice',
  };
}

test('real authorization-code + S256 session flow prints an app-issued, JWKS-verified JWT and deletes session', async (t) => {
  const s = await stub(t);
  const token = await getToken(settings(s.baseUrl));
  assert.equal(
    verifyAccessToken(token, { keys: [jwk] }, { issuer, projectId: 'project' })
      .sub,
    'alice-id',
  );
  assert.equal(s.getSession(), undefined);
});

test('wrong state fails before exchanging the code; cleans session', async (t) => {
  const s = await stub(t, { badState: true });
  await assert.rejects(
    getToken(settings(s.baseUrl)),
    /invalid authorization callback/,
  );
  assert.equal(s.getSession(), undefined);
  assert.ok(!s.calls.some((c) => c.path === '/oauth/v2/token'));
});

test('wrong audience and invalid signature are never printed', async (t) => {
  const s = await stub(t, { token: jwt({ aud: ['other-project'] }) });
  await assert.rejects(getToken(settings(s.baseUrl)), /audience/);
  const token = jwt().split('.');
  token[2] = Buffer.alloc(256).toString('base64url');
  assert.throws(
    () =>
      verifyAccessToken(
        token.join('.'),
        { keys: [jwk] },
        { issuer, projectId: 'project' },
      ),
    /signature/,
  );
  assert.throws(
    () =>
      verifyAccessToken(
        jwt({ exp: 1 }),
        { keys: [jwk] },
        { issuer, projectId: 'project' },
      ),
    /lifetime/,
  );
  assert.equal(s.getSession(), undefined);
});

test('production issuer is refused before credential access, even with local environment', async () => {
  for (const environment of ['local', 'staging', 'production']) {
    await assert.rejects(
      run({
        args: ['token'],
        env: {
          CALFLEX_ZITADEL_ENVIRONMENT: environment,
          CALFLEX_OIDC_ISSUER: 'https://auth.flexcalendar.de',
          CALFLEX_SEED_PAT_PATH: '/not-readable',
        },
      }),
      /refuses production/,
    );
  }
  assert.doesNotThrow(() =>
    refuseProduction('https://auth.staging.flexcalendar.de', 'staging'),
  );
  assert.throws(() =>
    refuseProduction(
      'https://auth.staging.flexcalendar.de.evil.invalid',
      'staging',
    ),
  );
});

test('apply initializes locked provider then applies chosen environment; plan exposes detailed exit codes', async (t) => {
  const s = await stub(t);
  for (const operation of ['apply', 'plan']) {
    const calls = [];
    await run({
      args: [operation],
      env: {
        ZITADEL_ACCESS_TOKEN: 'seed-pat',
        CALFLEX_ZITADEL_BASE_URL: s.baseUrl,
      },
      execute: (args) => {
        calls.push(args);
      },
    });
    assert.ok(calls[0].includes('-lockfile=readonly'));
    assert.deepEqual(calls[1], [
      operation,
      '-input=false',
      operation === 'apply' ? '-auto-approve' : '-detailed-exitcode',
      '-var-file=environments/local.tfvars',
    ]);
  }
});

function child(command, args, env) {
  return new Promise((resolve) => {
    const p = spawn(command, args, {
      env: { ...process.env, MAKELEVEL: '0', MAKEFLAGS: '', ...env },
    });
    let stdout = '',
      stderr = '';
    p.stdout.on('data', (data) => {
      stdout += data;
    });
    p.stderr.on('data', (data) => {
      stderr += data;
    });
    p.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

test('runner CLI happy paths apply and token, with stub provider CLI and stateful Zitadel', async (t) => {
  const s = await stub(t);
  await mkdir('infra/zitadel/.tools', { recursive: true });
  const directory = await mkdtemp('infra/zitadel/.tools/cli-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    `${directory}/tofu`,
    `#!/usr/bin/env node\nif(process.argv[2]==='output') console.log(JSON.stringify({project_id:{value:'project'},android_client_id:{value:'android'},token_helper_pat:{value:'helper-pat'}}));\n`,
    { mode: 0o755 },
  );
  const env = {
    PATH: `${process.cwd()}/${directory}:${process.env.PATH}`,
    ZITADEL_ACCESS_TOKEN: 'seed-pat',
    CALFLEX_ZITADEL_BASE_URL: s.baseUrl,
    CALFLEX_OIDC_ISSUER: issuer,
    CALFLEX_TOKEN_USER: 'alice',
  };
  assert.equal(
    (await child('node', ['infra/zitadel/run.mjs', 'apply'], env)).exitCode,
    0,
  );
  const result = await child('node', ['infra/zitadel/run.mjs', 'token'], env);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim().split('.').length, 3);
  verifyAccessToken(
    result.stdout.trim(),
    { keys: [jwk] },
    { issuer, projectId: 'project' },
  );
  assert.equal(result.stderr, '');

  // Exercise the actual Make targets, substituting only the container transport.
  await writeFile(
    `${directory}/compose.mjs`,
    `import {run} from '${process.cwd()}/infra/zitadel/run.mjs'; await run({args:[process.argv.at(-1)]});`,
  );
  const compose = `COMPOSE=node ${directory}/compose.mjs`;
  const makeToken = await child('make', ['token', 'USER=alice', compose], env);
  assert.equal(makeToken.exitCode, 0, makeToken.stderr);
  verifyAccessToken(
    makeToken.stdout.trim(),
    { keys: [jwk] },
    { issuer, projectId: 'project' },
  );
  const plan = await child('make', ['zitadel-plan', compose], env);
  assert.equal(plan.exitCode, 0, plan.stderr);
  const noUser = await child('make', ['token', compose], env);
  assert.notEqual(noUser.exitCode, 0);
  assert.match(noUser.stderr, /USER=<seeded user>/);
});
