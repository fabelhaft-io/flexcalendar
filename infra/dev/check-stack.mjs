#!/usr/bin/env node
// --- calendar-flex local stack: static checks (E02-R03) ----------------------
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
    for (const source of sources.trim().split(/\s+/).slice(0, -1)) {
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

// --- verdict -----------------------------------------------------------------

process.stdout.write(`\n${checks.length - problems.length}/${checks.length} checks passed\n`);
if (problems.length > 0) {
  process.stdout.write(`\n${problems.map((problem) => `- ${problem}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('the local stack definition is consistent\n');
