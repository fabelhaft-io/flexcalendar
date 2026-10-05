import { createHash, randomBytes, createPublicKey, verify } from 'node:crypto';
import { request, successful } from './http.mjs';

const redirectUri = 'de.flexcalendar.app:/oauth2redirect';

export function refuseProduction(issuer, environment) {
  const url = new URL(issuer);
  const local =
    url.hostname === 'auth.localhost' || url.hostname.endsWith('.localhost');
  const staging =
    url.hostname === 'auth.staging.flexcalendar.de' &&
    (url.port === '' || url.port === '443');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !(
      (environment === 'local' && local) ||
      (environment === 'staging' && staging)
    )
  ) {
    throw new Error(
      'token helper refuses production and non-local/non-staging issuers',
    );
  }
}

export function verifyAccessToken(token, jwks, { issuer, projectId }) {
  const parts = token?.split('.');
  if (parts?.length !== 3) throw new Error('expected a JWT access token');
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  } catch {
    throw new Error('malformed JWT');
  }
  if (
    !header ||
    !claims ||
    typeof header !== 'object' ||
    typeof claims !== 'object'
  )
    throw new Error('malformed JWT');
  if (header.alg !== 'RS256' || header.crit)
    throw new Error('unsupported JWT algorithm');
  const key = jwks.keys?.find(
    (candidate) =>
      candidate.kid === header.kid &&
      candidate.kty === 'RSA' &&
      (!candidate.use || candidate.use === 'sig') &&
      (!candidate.alg || candidate.alg === 'RS256'),
  );
  if (
    !key ||
    !verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key, format: 'jwk' }),
      Buffer.from(parts[2], 'base64url'),
    )
  ) {
    throw new Error('JWT signature verification failed');
  }
  const now = Date.now() / 1000;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    claims.iss !== issuer ||
    !audiences.includes(projectId) ||
    typeof claims.exp !== 'number' ||
    claims.exp <= now ||
    (claims.nbf !== undefined && claims.nbf > now) ||
    !claims.sub
  ) {
    throw new Error('JWT issuer, audience or lifetime verification failed');
  }
  return claims;
}

export async function getToken({
  issuer,
  baseUrl = issuer,
  environment,
  clientId,
  projectId,
  pat,
  password,
  user,
  ca,
}) {
  refuseProduction(issuer, environment);
  // Even if a caller overrides the connection URL, never send credentials to production.
  const connection = new URL(baseUrl);
  if (environment === 'staging' && connection.origin !== new URL(issuer).origin)
    throw new Error('staging connection must match issuer');
  if (
    environment === 'local' &&
    !(
      connection.hostname === 'auth.localhost' ||
      connection.hostname.endsWith('.localhost') ||
      connection.hostname === '127.0.0.1'
    )
  )
    throw new Error('local connection must be local');
  const options = { ca, host: new URL(issuer).host };
  const at = (url) => {
    const target = new URL(url, issuer);
    if (target.origin !== new URL(issuer).origin)
      throw new Error('unexpected cross-origin Zitadel URL');
    return `${baseUrl}${target.pathname}${target.search}`;
  };
  const send = (url, extra = {}) => request(at(url), { ...options, ...extra });
  const discovery = successful(
    await send('/.well-known/openid-configuration'),
    'discovery',
  );
  if (discovery.issuer !== issuer) throw new Error('discovery issuer mismatch');
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const authorize = new URL(discovery.authorization_endpoint);
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: `openid profile urn:zitadel:iam:org:project:id:${projectId}:aud`,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
  }).toString();
  let response = await send(authorize);
  let login;
  for (let hop = 0; hop < 6 && response.location; hop += 1) {
    const next = new URL(response.location, issuer);
    if (next.origin !== new URL(issuer).origin)
      throw new Error('unexpected login origin');
    if (next.searchParams.has('authRequest')) {
      login = next;
      break;
    }
    response = await send(next);
  }
  const authRequest = login?.searchParams.get('authRequest');
  if (!authRequest)
    throw new Error('authorization did not return an auth request');
  const users = successful(
    await send('/management/v1/users/_search', {
      method: 'POST',
      token: pat,
      body: {
        queries: [
          {
            userNameQuery: {
              userName: user,
              method: 'TEXT_QUERY_METHOD_EQUALS',
            },
          },
        ],
      },
    }),
    'find user',
  );
  if (users.result?.length !== 1)
    throw new Error('expected exactly one seeded user');
  const session = successful(
    await send('/v2/sessions', {
      method: 'POST',
      token: pat,
      body: {
        checks: {
          user: { userId: users.result[0].id },
          password: { password },
        },
        lifetime: '300s',
      },
    }),
    'create session',
  );
  try {
    const callback = successful(
      await send(`/v2/oidc/auth_requests/${encodeURIComponent(authRequest)}`, {
        method: 'POST',
        token: pat,
        body: {
          session: {
            sessionId: session.sessionId,
            sessionToken: session.sessionToken,
          },
        },
      }),
      'complete auth request',
    );
    let next = new URL(callback.callbackUrl, issuer);
    for (let hop = 0; next.protocol === 'https:' && hop < 6; hop += 1) {
      response = await send(next);
      if (!response.location) throw new Error('callback did not redirect');
      next = new URL(response.location, issuer);
    }
    if (
      `${next.protocol}${next.pathname}` !== redirectUri ||
      next.searchParams.get('state') !== state ||
      !next.searchParams.get('code')
    ) {
      throw new Error('invalid authorization callback');
    }
    const tokens = successful(
      await send(discovery.token_endpoint, {
        method: 'POST',
        form: {
          grant_type: 'authorization_code',
          client_id: clientId,
          code: next.searchParams.get('code'),
          redirect_uri: redirectUri,
          code_verifier: verifier,
        },
      }),
      'exchange code',
    );
    if (tokens.token_type?.toLowerCase() !== 'bearer')
      throw new Error('unexpected OAuth token type');
    const jwks = successful(await send(discovery.jwks_uri), 'JWKS');
    verifyAccessToken(tokens.access_token, jwks, { issuer, projectId });
    return tokens.access_token;
  } finally {
    successful(
      await send(`/v2/sessions/${encodeURIComponent(session.sessionId)}`, {
        method: 'DELETE',
        token: pat,
      }),
      'delete test session',
    );
  }
}
