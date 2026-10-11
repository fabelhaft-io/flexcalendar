// --- E05-R01 test support: a stub identity provider --------------------------
//
// The negative tokens in the tests are signed here, by a key this server
// publishes as its own JWKS — never by Zitadel. It speaks just the three
// endpoints the API uses (discovery, JWKS, userinfo) and records what it saw,
// so a test can prove there was no introspection call and no JWKS fetch flood.
//
// Test-only material: keys live in memory, in `test/` (INV-07 scans `src/`).

import {
  createHmac,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  randomUUID,
} from 'node:crypto';
import { createServer } from 'node:http';

/** The issuer the stub publishes; the API must be given exactly this. */
export const ISSUER = 'https://auth.example.test';
/** The audience its tokens carry, i.e. the project ID. */
export const AUDIENCE = 'project-id';

/** @param {string} kid */
function keyPair(kid) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  return {
    kid,
    privateKey,
    jwk: {
      ...publicKey.export({ format: 'jwk' }),
      kid,
      use: 'sig',
      alg: 'RS256',
    },
  };
}

/** @param {unknown} value */
const b64url = (value) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Starts the stub. Nothing is ever written to stdout or stderr.
 * @param {{issuer?: string, audience?: string}} [options]
 */
export async function startIdp({ issuer = ISSUER, audience = AUDIENCE } = {}) {
  /** @type {{kid: string, privateKey: any, jwk: any}[]} */
  let keys = [keyPair('key-a')];
  /** @type {any} */
  let userinfo;
  /** @type {{discovery: number, jwks: number, userinfo: number}} */
  const calls = { discovery: 0, jwks: 0, userinfo: 0 };
  /** @type {{path: string, host: string | undefined}[]} */
  const requests = [];

  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    requests.push({ path, host: request.headers.host });
    const json = (
      /** @type {number} */ status,
      /** @type {unknown} */ body,
    ) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (path === '/.well-known/openid-configuration') {
      calls.discovery += 1;
      json(200, {
        issuer,
        jwks_uri: `${issuer}/oauth/v2/keys`,
        userinfo_endpoint: `${issuer}/oidc/v1/userinfo`,
      });
      return;
    }
    if (path === '/oauth/v2/keys') {
      calls.jwks += 1;
      json(200, { keys: keys.map((key) => key.jwk) });
      return;
    }
    if (path === '/oidc/v1/userinfo') {
      calls.userinfo += 1;
      const header = String(request.headers.authorization ?? '');
      const payload = header.startsWith('Bearer ')
        ? JSON.parse(
            Buffer.from(
              header.slice(7).split('.')[1] ?? '',
              'base64url',
            ).toString('utf8'),
          )
        : {};
      if (userinfo === undefined) {
        json(200, {
          sub: payload.sub,
          email_verified: true,
          preferred_username: payload.sub,
          email: `${payload.sub}@example.test`,
        });
        return;
      }
      if (typeof userinfo === 'function') {
        const result = userinfo(payload);
        if (result === undefined) {
          json(503, { error: 'unavailable' });
          return;
        }
        json(200, result);
        return;
      }
      json(200, userinfo);
      return;
    }
    json(404, {});
  });
  await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  const address = /** @type {import('node:net').AddressInfo} */ (
    server.address()
  );

  return {
    issuer,
    audience,
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    requests,
    /** The key currently published (and used for signing by default). */
    key: () => keys[keys.length - 1],
    /** Simulates JWKS rotation: the new key replaces the old one. */
    rotate(kid = `key-${randomUUID()}`) {
      keys = [keyPair(kid)];
      return keys[0];
    },
    /** A key the stub never publishes. */
    unknownKey: (kid = 'unknown-key') => keyPair(kid),
    /** The served key's SPKI bytes, for the "HS256 signed with them" case. */
    publicKeyBytes: () =>
      createPublicKey({ key: keys[keys.length - 1].jwk, format: 'jwk' }).export(
        {
          type: 'spki',
          format: 'der',
        },
      ),
    /**
     * Signs a token. Defaults to the current key, the stub's issuer and
     * audience, a live `exp` and a fresh `nbf`.
     * @param {Record<string, any>} [overrides]
     * @param {{key?: any, alg?: string, secret?: string}} [options]
     */
    token(
      overrides = {},
      {
        key = keys[keys.length - 1],
        alg = 'RS256',
        secret = 'shared-secret',
      } = {},
    ) {
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        sub: 'known-subject',
        iss: issuer,
        aud: audience,
        iat: now,
        nbf: now - 10,
        exp: now + 3600,
        ...overrides,
      };
      const header = { alg, kid: key.kid, typ: 'JWT' };
      const signingInput = `${b64url(header)}.${b64url(claims)}`;
      if (alg === 'none') return `${signingInput}.`;
      if (alg === 'HS256')
        return `${signingInput}.${createHmac('sha256', secret).update(signingInput).digest('base64url')}`;
      return `${signingInput}.${createSign('RSA-SHA256')
        .update(signingInput)
        .sign(key.privateKey)
        .toString('base64url')}`;
    },
    /**
     * What userinfo answers next: an object, a function of the token payload,
     * or `undefined` for the stub's own default.
     */
    setUserinfo(/** @type {any} */ value) {
      userinfo = value;
    },
    close: () =>
      new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}
