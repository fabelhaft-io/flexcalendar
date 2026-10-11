#!/usr/bin/env node
// --- flexcalendar local stack: static checks (E02-R03) ----------------------
//
// `make check-stack` runs this. It checks the *definition* of the local stack,
// not a running stack — `make dev` and `make seed` need rootless Podman and a
// container runtime, which the agent sandbox does not have. What it can prove
// without a runtime, it proves:
//
//   * every component the requirement names is in infra/dev/compose.yaml;
//   * nothing in the stack needs a Docker daemon, root privileges or a sysctl
//     change, and every published port is above 1024 (`02` § Runtime layout);
//   * every container has a memory limit (ADR 0004);
//   * the seed has at least two users, with unique logins and emails;
//   * `.env.example` documents every variable the compose file interpolates;
//   * the Caddyfile uses the local CA, never ACME, and every upstream it
//     proxies to is a compose service on the port it exposes;
//   * the Makefile has the entry points the acceptance criteria name.
//
// It reads files; it changes nothing.

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { portableExecHealthcheck } from '../scripts/healthchecks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '..', '..');

const problems = [];
const checks = [];

/** Records one check. `ok` may be a boolean or a function returning an error. */
function check(description, ok) {
  const result = typeof ok === 'function' ? ok() : ok;
  checks.push(description);
  if (result !== true) {
    problems.push(`${description}${typeof result === 'string' ? ` — ${result}` : ''}`);
  }
  process.stdout.write(`${result === true ? 'ok  ' : 'FAIL'}  ${description}\n`);
}

const read = (file) => readFile(path.join(here, file), 'utf8');

// --- the compose file --------------------------------------------------------

const composeText = await read('compose.yaml');
const compose = parse(composeText);
const services = compose?.services ?? {};

for (const [name, service] of Object.entries(services)) {
  check(`${name}: exec-form health-check arguments contain no whitespace (Podman 4.9)`,
    portableExecHealthcheck(service?.healthcheck?.test));
}

const requiredServices = {
  postgres: 'Postgres',
  'zitadel-api': 'Zitadel (D-03, ADR 0004)',
  'zitadel-login': "Zitadel's login UI container (ADR 0004)",
  mailpit: 'Mailpit',
  caldav: 'the CalDAV service (D-02)',
  api: 'the API (D-01)',
  caddy: 'Caddy with a local CA',
};

for (const [name, description] of Object.entries(requiredServices)) {
  check(`compose.yaml starts ${description} as \`${name}\``, name in services);
}

check('compose.yaml parses as YAML with a services map', Object.keys(services).length > 0);

check('the CalDAV image is built from server/caldav', () => {
  const build = services.caldav?.build;
  return build?.dockerfile === 'server/caldav/Dockerfile' && build?.context === '../..'
    ? true
    : `got ${JSON.stringify(build)}`;
});

check('the API image is built from server/api', () => {
  const build = services.api?.build;
  return build?.dockerfile === 'server/api/Dockerfile' && build?.context === '../..'
    ? true
    : `got ${JSON.stringify(build)}`;
});

// A COPY whose source is not in the repository only fails at build time, which
// is the slowest place to find it.
const exists = async (target) => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

for (const [name, service] of Object.entries(services)) {
  const dockerfile = service?.build?.dockerfile;
  if (dockerfile === undefined) continue;
  const text = await readFile(path.join(repository, dockerfile), 'utf8');
  for (const [, sources] of text.matchAll(/^COPY\s+(?!--from)(.+)$/gm)) {
    const tokens = sources.trim().split(/\s+/);
    if (tokens.some((token) => token.startsWith('--from='))) continue;
    for (const source of tokens.filter((token) => !token.startsWith('--')).slice(0, -1)) {
      check(`${name}: the Dockerfile copies ${source}, which exists`, await exists(path.join(repository, source)));
    }
  }
}

// --- rootless Podman, no root, no sysctls ------------------------------------

const privilegedKeys = ['privileged', 'sysctls', 'cap_add', 'userns_mode', 'pid', 'ipc', 'devices'];
for (const [name, service] of Object.entries(services)) {
  for (const key of privilegedKeys) {
    check(`${name} does not use \`${key}\``, service?.[key] === undefined);
  }
  check(`${name} does not use the host network namespace`, service?.network_mode !== 'host');
}

for (const [name, service] of Object.entries(services)) {
  for (const entry of service?.ports ?? []) {
    check(`${name} publishes ${entry} on a port above 1024`, () => {
      const resolved = String(entry)
        .replace(/\$\{[A-Z0-9_]+:-([^}]*)\}/g, '$1')
        .replace(/\$\{[A-Z0-9_]+\}/g, '0');
      const hostPort = Number(resolved.split(':')[0]);
      return Number.isInteger(hostPort) && hostPort >= 1024
        ? true
        : `host port ${hostPort} would need CAP_NET_BIND_SERVICE`;
    });
  }
}

check('only Caddy publishes a port', () => {
  const publishers = Object.entries(services)
    .filter(([, service]) => (service?.ports ?? []).length > 0)
    .map(([name]) => name);
  return publishers.length === 1 && publishers[0] === 'caddy'
    ? true
    : `published by ${publishers.join(', ') || 'nothing'}`;
});

check('the published HTTPS port is the configurable one', () => {
  const ports = (services.caddy?.ports ?? []).map(String);
  return ports.includes('${CALFLEX_HTTPS_PORT:-8443}:8443')
    ? true
    : `got ${JSON.stringify(ports)}`;
});

// --- memory limits (ADR 0004) ------------------------------------------------

for (const [name, service] of Object.entries(services)) {
  check(`${name} has a memory limit (ADR 0004)`, typeof service?.mem_limit === 'string');
}

// --- the seed ----------------------------------------------------------------

check('the seed runs as a one-shot service, under its own profile', () => {
  const seed = services.seed;
  if (!seed) return 'no seed service';
  if (!(seed.profiles ?? []).includes('seed')) return 'not behind a profile, so `make dev` would start it';
  if (seed.restart !== 'no') return 'a restart policy would loop a one-shot job';
  return true;
});

// The seed runs inside the network, where Caddy always listens on 8443: a base
// URL built from the *published* port fails with ECONNREFUSED the moment that
// port is not 8443 (review 1, fix 2). Zitadel, in turn, resolves its instance
// from the request's Host, so the seed presents the authority a browser uses.
const seedEnvironment = services.seed?.environment ?? {};

check('the seed reaches Caddy on its container port, not the published one', () => {
  const baseUrl = String(seedEnvironment.CALFLEX_SEED_BASE_URL ?? '');
  if (!/:8443$/.test(baseUrl)) return `CALFLEX_SEED_BASE_URL is ${JSON.stringify(baseUrl)}, which must end in :8443`;
  if (baseUrl.includes('${CALFLEX_HTTPS_PORT')) return 'the published port is the connection port again';
  return true;
});

check('the seed sends Zitadel the authority the developer uses', () => {
  const host = String(seedEnvironment.CALFLEX_SEED_HOST ?? '');
  return host.startsWith('auth.') && host.includes('${CALFLEX_HTTPS_PORT:-8443}')
    ? true
    : `CALFLEX_SEED_HOST is ${JSON.stringify(host)}`;
});

// A healthcheck whose command words YAML parsed as something else (a `? :`
// ternary becomes a mapping) fails at container start, not here.
for (const [name, service] of Object.entries(services)) {
  const test = service?.healthcheck?.test;
  if (test === undefined) continue;
  check(`${name}'s healthcheck is a list of strings`, () =>
    Array.isArray(test) && test.every((word) => typeof word === 'string')
      ? true
      : JSON.stringify(test),
  );
}

const seedData = JSON.parse(await read('seed/users.json'));
const seedUsers = seedData?.users ?? [];

check('seed/users.json seeds at least two users', () =>
  seedUsers.length >= 2 ? true : `only ${seedUsers.length}`,
);

const logins = new Set();
const emails = new Set();
for (const user of seedUsers) {
  for (const field of ['userName', 'firstName', 'lastName', 'email']) {
    check(`seeded user ${user?.userName ?? '?'} has a ${field}`, typeof user?.[field] === 'string' && user[field] !== '');
  }
  check(`seeded login ${user?.userName ?? '?'} is unique`, !logins.has(user?.userName));
  logins.add(user?.userName);
  check(`seeded email ${user?.email ?? '?'} is unique`, !emails.has(user?.email));
  emails.add(user?.email);
}

// --- configuration drift -----------------------------------------------------

const interpolated = new Set(
  [...composeText.matchAll(/\$\{(CALFLEX_[A-Z0-9_]+)(?::-[^}]*)?\}/g)].map((match) => match[1]),
);
const envExample = await read('.env.example');
const documented = new Set([...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]));

check('compose.yaml interpolates at least one variable', interpolated.size > 0);
for (const name of [...interpolated].sort()) {
  check(`.env.example documents ${name}`, documented.has(name));
}

// Dedicated logins must not regress to the cluster bootstrap superuser.
for (const [service, role, key] of [
  ['api', 'calflex_api', 'CALFLEX_DATABASE_URL'],
  ['caldav', 'calflex_caldav', 'CALFLEX_DATABASE_URL'],
  ['migrate', 'calflex_migrate', 'CALFLEX_MIGRATE_DATABASE_URL'],
]) {
  check(`${service} connects as ${role}`, () =>
    String(services[service]?.environment?.[key] ?? '').includes(`postgresql://${role}:`)
      ? true : 'missing dedicated database login',
  );
}
for (const name of ['CALFLEX_MIGRATE_PASSWORD', 'CALFLEX_API_PASSWORD', 'CALFLEX_CALDAV_PASSWORD']) {
  check(`postgres supplies ${name} to role bootstrap`, name in (services.postgres?.environment ?? {}));
}
check('Postgres mounts the real role bootstrap read-only', () =>
  (services.postgres?.volumes ?? []).includes('./postgres/initdb:/docker-entrypoint-initdb.d:ro')
    ? true : 'missing initdb mount',
);
check('role bootstrap exists', (await read('postgres/initdb/20-roles.sql')).includes('CREATE ROLE calflex_migrate'));

// --- the Caddyfile -----------------------------------------------------------

const caddyfile = await read('Caddyfile');

/** Prose is not configuration: drop whole-line comments before pattern checks. */
const withoutComments = (text) =>
  text
    .split('\n')
    .map((line) => (line.trimStart().startsWith('#') ? '' : line))
    .join('\n');

check('the Caddyfile issues certificates from the local CA', caddyfile.includes('local_certs'));
check('the local Caddyfile never talks to an ACME server', () =>
  /acme|letsencrypt|zerossl/i.test(withoutComments(caddyfile)) ? 'found an ACME reference' : true,
);
check('the Caddyfile serves HTTPS on 8443', /https_port\s+8443/.test(caddyfile));

for (const host of ['caldav', 'api', 'auth', 'mailpit']) {
  check(
    `the Caddyfile routes ${host}.<CALFLEX_DEV_DOMAIN>`,
    caddyfile.includes(`${host}.{$CALFLEX_DEV_DOMAIN`),
  );
}

// The login UI answers `/ui/v2/login` and everything under it; routing only the
// wildcard form sends the bare path to the core, which answers 404 (review 1,
// fix 1).
check('the Caddyfile routes the login UI both its base path and everything under it', () =>
  /@login\s+path\s+\/ui\/v2\/login\s+\/ui\/v2\/login\/\*/.test(withoutComments(caddyfile))
    ? true
    : 'the base path /ui/v2/login is not routed to zitadel-login',
);

for (const [, upstream, port] of caddyfile.matchAll(/reverse_proxy\s+([a-z0-9._-]+):(\d+)/g)) {
  check(`Caddy's upstream ${upstream}:${port} is a compose service`, upstream in services);
  check(`${upstream} exposes ${port} to Caddy`, () =>
    (services[upstream]?.expose ?? []).map(String).includes(port) ? true : 'not in `expose`',
  );
}

// --- the entry points the acceptance criteria name ---------------------------

const makefile = await readFile(path.join(repository, 'Makefile'), 'utf8');

for (const target of ['dev', 'dev-down', 'seed', 'check-stack']) {
  check(`the Makefile has a \`${target}\` target`, new RegExp(`^${target}:`, 'm').test(makefile));
}

check('the Makefile runs the stack with `podman compose`, never a Docker daemon', () => {
  const code = withoutComments(makefile);
  if (!/^PODMAN \?= podman$/m.test(code)) return 'PODMAN is not `podman`';
  if (!/^PODMAN_COMPOSE \?= \$\(PODMAN\) compose$/m.test(code)) return 'PODMAN_COMPOSE is not `$(PODMAN) compose`';
  if (/\bdocker\b/i.test(code)) return 'a Docker command is referenced';
  return true;
});

check('`make dev` brings the stack up and waits for it', () =>
  /^\t\$\(COMPOSE\) up --detach --wait$/m.test(makefile) ? true : 'no `up --detach --wait`',
);

check('`make seed` runs the one-shot seed service', () =>
  /^\t\$\(COMPOSE\) --profile seed run --rm seed$/m.test(makefile) ? true : 'no seed run',
);

check('`make test-api-caldav` migrates and then runs the API test job (E05-R02)', () =>
  /^test-api-caldav: migrate\b/m.test(makefile)
    ? /^\t\$\(COMPOSE\) --profile test run --build --rm -T api-test$/m.test(makefile)
      ? true
      : 'the target does not run api-test'
    : 'the target does not depend on `migrate`',
);

// --- the API's CalDAV adapter suite (E05-R02) ---------------------------------

const apiTest = services['api-test'];

check('`api-test` builds the API image\'s `test` target', () => {
  const build = apiTest?.build;
  return build?.dockerfile === 'server/api/Dockerfile' && build?.target === 'test' && build?.context === '../..'
    ? true
    : `got ${JSON.stringify(build)}`;
});

check('the API test job is a one-shot behind the `test` profile', () => {
  if (!apiTest) return 'no api-test service';
  if (!(apiTest.profiles ?? []).includes('test')) return 'not behind the `test` profile';
  if (apiTest.restart !== undefined && apiTest.restart !== 'no') return 'a restart policy would loop a one-shot job';
  return true;
});

check('the API test job reaches the internal listener the API uses', () =>
  String(apiTest?.environment?.CALFLEX_CALDAV_ORIGIN ?? '') === 'http://caldav-internal:8081'
    ? true
    : 'CALFLEX_CALDAV_ORIGIN is not the internal listener',
);

check('the API test job signs with the same delegation keys', () =>
  String(apiTest?.environment?.CALFLEX_DELEGATION_KEYS ?? '') ===
  String(services.caldav?.environment?.CALFLEX_DELEGATION_KEYS ?? '')
    ? true
    : 'the test job and the CalDAV service disagree about the keys',
);

check('the API test job connects as calflex_api', () =>
  String(apiTest?.environment?.CALFLEX_DATABASE_URL ?? '').includes('postgresql://calflex_api:')
    ? true
    : 'missing dedicated database login',
);

const apiDockerfile = await readFile(path.join(repository, 'server/api/Dockerfile'), 'utf8');

check('the API image has a `test` stage for the adapter suite', () =>
  /^FROM node:24-alpine AS test$/m.test(apiDockerfile) ? true : 'no `test` stage',
);

check('that stage carries the tests, the E03-R01 vectors and the suite command', () => {
  const from = apiDockerfile.indexOf(' AS test\n');
  if (from === -1) return 'no `test` stage';
  const rest = apiDockerfile.slice(from);
  const end = rest.indexOf('\nFROM ');
  const body = end === -1 ? rest : rest.slice(0, end);
  for (const source of [
    'server/api/test',
    'server/caldav/tests/Fixtures/delegation-vectors.json',
  ]) {
    if (!body.includes(`COPY ${source} `)) return `the test stage does not COPY ${source}`;
  }
  return /^ENTRYPOINT \["node", "--test", "test\/integration\/\*\.test\.mjs"\]$/m.test(body)
    ? true
    : 'the test stage does not run the integration suite';
});

check('the runtime image stays the default build target', () =>
  /\nFROM node:24-alpine\n/.test(apiDockerfile) ? true : 'the last stage is not an unnamed runtime stage',
);

// E03-R01 trust-boundary structure (runtime isolation is tested on the stack).
const caldavConfig = await readFile(path.join(repository, 'server/caldav/Caddyfile'), 'utf8');
check('FrankenPHP uses classic mode', !/\bworker\b/i.test(withoutComments(caldavConfig)));
check('FrankenPHP caps PHP threads', /num_threads\s+4/.test(caldavConfig));
check('internal listener binds its dedicated address', /:8081\s*\{\s*bind\s+172\.30\.91\.2/.test(caldavConfig));
const networkNames = (service) => Array.isArray(service?.networks)
  ? service.networks
  : Object.keys(service?.networks ?? {});
check('only the API, CalDAV and their two test jobs join the delegation network',
  Object.entries(services)
    .filter(([, service]) => networkNames(service).includes('delegation'))
    .map(([name]) => name)
    .sort()
    .join(',') === 'api,api-test,caldav,caldav-test');
check('CalDAV has the internal static address', services.caldav?.networks?.delegation?.ipv4_address === '172.30.91.2');
check('dedicated network subnet matches bind', compose.networks?.delegation?.ipam?.config?.[0]?.subnet === '172.30.91.0/24');
check('CalDAV publishes no host port', (services.caldav?.ports ?? []).length === 0);
check('Caddy never routes internal listener', !/8081|caldav-internal/.test(withoutComments(caddyfile)));
check('every public virtual host drops delegation headers',
  (withoutComments(caddyfile).match(/request_header -X-Calflex-Principal/g) ?? []).length === 4);

check('delegation network is internal', compose.networks?.delegation?.internal === true);
check('dynamic pool excludes the static listener address', compose.networks?.delegation?.ipam?.config?.[0]?.ip_range === '172.30.91.128/25');

// --- the OIDC audience handshake (E05-R01) ------------------------------------

// The API validates `aud` against the Zitadel project ID, which only `apply`
// knows, and the API container starts before `make seed` runs. The ID travels
// through a named volume, written once and read read-only.

check('the stack declares a shared `oidc-config` volume', () =>
  Object.hasOwn(compose.volumes ?? {}, 'oidc-config'),
);

check('`zitadel-config` writes the project audience into that volume', () => {
  const config = services['zitadel-config'];
  const out = String(config?.environment?.CALFLEX_OIDC_AUDIENCE_OUT ?? '');
  if (out !== '/oidc/audience') return `CALFLEX_OIDC_AUDIENCE_OUT is ${JSON.stringify(out)}`;
  return (config?.volumes ?? []).includes('oidc-config:/oidc')
    ? true
    : 'zitadel-config does not mount oidc-config read-write';
});

check('the API reads that audience from the volume, read-only', () => {
  const api = services.api;
  const file = String(api?.environment?.CALFLEX_OIDC_AUDIENCE_FILE ?? '');
  if (file !== '/oidc/audience')
    return `CALFLEX_OIDC_AUDIENCE_FILE is ${JSON.stringify(file)}`;
  return (api?.volumes ?? []).includes('oidc-config:/oidc:ro')
    ? true
    : 'the API does not mount oidc-config read-only';
});

check('an explicit `CALFLEX_OIDC_AUDIENCE` overrides the file', () =>
  String(services.api?.environment?.CALFLEX_OIDC_AUDIENCE ?? '') ===
  '${CALFLEX_OIDC_AUDIENCE:-}'
    ? true
    : 'the API has no CALFLEX_OIDC_AUDIENCE knob',
);

check('the API reaches Zitadel over the internal network, plain HTTP', () =>
  String(services.api?.environment?.CALFLEX_OIDC_BASE_URL ?? '') ===
  'http://zitadel-api:8080'
    ? true
    : 'CALFLEX_OIDC_BASE_URL is not the internal Zitadel address',
);

// --- rate limiting and the client address (E05-R01) ---------------------------

// The API's limiter buckets per client address. Behind Caddy that is only the
// real client if the API trusts exactly that one hop; with the 0 default every
// request would arrive from Caddy and share one bucket. The port is not
// published, so no client can bypass Caddy and reach the socket directly.
check('the API trusts exactly one proxy hop, so the limiter sees the client', () =>
  String(services.api?.environment?.CALFLEX_TRUSTED_PROXY_HOPS ?? '') === '1'
    ? true
    : 'CALFLEX_TRUSTED_PROXY_HOPS is not "1"',
);

check('the API publishes no host port a client could reach directly', () =>
  (services.api?.ports ?? []).length === 0
    ? true
    : 'the API publishes a host port',
);

// --- verdict -----------------------------------------------------------------

process.stdout.write(`\n${checks.length - problems.length}/${checks.length} checks passed\n`);
if (problems.length > 0) {
  process.stdout.write(`\n${problems.map((problem) => `- ${problem}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('the local stack definition is consistent\n');
