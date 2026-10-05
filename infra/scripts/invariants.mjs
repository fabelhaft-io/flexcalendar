import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
/** @type {Record<string, Record<string, string>> | undefined} */
let policy;
const ignored = new Set([
  'node_modules',
  'vendor',
  '.git',
  '.dart_tool',
  '.gradle',
  '.fvm',
  'build',
  'dist',
  '.symlinks',
  'ephemeral',
]);
const sources = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.dart',
  '.kt',
  '.kts',
  '.java',
  '.swift',
  '.vue',
  '.svelte',
]);

/** @param {string} root @param {string} path */
function inputError(root, path) {
  return new Error(
    `Invariant check input error: ${relative(root, path)} (no source data logged).`,
  );
}

/** @template T @param {string} root @param {string} path @param {() => T} read @returns {T} */
function input(root, path, read) {
  try {
    return read();
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith('INV-') ||
        error.message.startsWith('Invariant check input error:'))
    )
      throw error;
    throw inputError(root, path);
  }
}

/** @param {string} directory @param {string} root @returns {string[]} */
function files(directory, root) {
  if (!existsSync(directory)) return [];
  return input(root, directory, () =>
    readdirSync(directory, { withFileTypes: true }),
  ).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? files(path, root) : [path];
  });
}

/** Conservative code search: never prints source lines or event data. @param {string} root */
export function recurrence(root) {
  const clients = files(resolve(root, 'apps'), root);
  const packages = resolve(root, 'packages');
  if (existsSync(packages)) {
    for (const entry of input(root, packages, () =>
      readdirSync(packages, { withFileTypes: true }),
    )) {
      if (entry.isDirectory() && /^crypto[-_]/.test(entry.name))
        clients.push(...files(resolve(packages, entry.name), root));
    }
  }
  for (const path of clients) {
    if (
      sources.has(extname(path)) &&
      /(?<![\w-])(?:EXDATE|RECURRENCE-ID)(?![\w-])/i.test(
        input(root, path, () => readFileSync(path, 'utf8')),
      )
    ) {
      throw new Error(
        `INV-05: forbidden client recurrence property name in ${relative(root, path)}; send an intent instead.`,
      );
    }
  }
}

/** @param {string} root @param {string} path */
function json(root, path) {
  return input(root, path, () => {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw inputError(root, path);
    return value;
  });
}

/** @param {string} name */
export function cryptoName(name) {
  return (
    /crypt|cipher|sodium|nacl|chacha|salsa|poly1305|25519|secp|elliptic|openssl|hash|hmac|argon|bcrypt|scrypt|pbkdf/i.test(
      name,
    ) ||
    /(?:^|[-_./@\d])(?:aes|sha|tls|ssl|jwe|pgp|jose)(?=$|[-_./@\d])/i.test(name)
  );
}

/** @param {Record<string, any>} value @returns {[string, any][]} */
function dependencies(value) {
  return [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ].flatMap((key) => Object.entries(value[key] ?? {}));
}

/** @param {string} ecosystem @param {string} name @param {string} version */
function approved(ecosystem, name, version) {
  /** @type {Record<string, Record<string, string>>} */
  const approvals =
    policy ??
    json(repo, resolve(repo, 'infra/scripts/invariant-dependencies.json'));
  policy = approvals;
  // Explicit deny even if someone accidentally adds a content cipher to the allow-list.
  if (
    /sodium|nacl|^@noble\/|crypto-js|node-forge|openpgp|(^|\/)phpseclib|defuse\/|halite|sjcl|(^|\/)cryptography/i.test(
      name,
    )
  ) {
    throw new Error(
      `INV-07: content-crypto dependency ${name}@${version} in server tree.`,
    );
  }
  if (
    (ecosystem === 'platform' || cryptoName(name)) &&
    (!Object.hasOwn(approvals[ecosystem], name) ||
      !approvals[ecosystem][name].trim())
  ) {
    throw new Error(
      `INV-07: unreviewed ${ecosystem === 'platform' ? 'platform' : 'crypto-looking'} dependency ${name}@${version}; a non-content-crypto justification is required.`,
    );
  }
}

/** @param {string} root */
export function serverDependencies(root) {
  const manifests = files(resolve(root, 'server'), root);
  const nodeManifests = manifests.filter((path) =>
    path.endsWith('/package.json'),
  );
  if (nodeManifests.length) {
    const lockPath = resolve(root, 'pnpm-lock.yaml');
    input(root, lockPath, () => {
      const documents = input(root, lockPath, () =>
        parseAllDocuments(readFileSync(lockPath, 'utf8')),
      );
      if (documents.some((document) => document.errors.length))
        throw inputError(root, lockPath);
      // pnpm 12 has a package-manager document as well as the application document.
      const locks = input(root, lockPath, () =>
        documents.map((document) => document.toJS()),
      );
      const seen = new Set();
      /** @param {any} lock @param {string} importer */
      function visitImporter(lock, importer) {
        const key = `workspace:${importer}`;
        if (seen.has(key)) return;
        seen.add(key);
        const entry = lock.importers?.[importer];
        if (!entry) throw inputError(root, lockPath);
        const manifest = json(root, resolve(root, importer, 'package.json'));
        for (const [name] of dependencies(manifest)) {
          const locked = dependencies(entry).find(
            ([candidate]) => candidate === name,
          );
          if (!locked) throw inputError(root, lockPath);
        }
        for (const [name, reference] of dependencies(entry))
          visit(lock, importer, name, reference.version);
      }
      /** @param {any} lock @param {string} importer @param {string} name @param {string} version */
      function visit(lock, importer, name, version) {
        if (typeof version !== 'string') throw inputError(root, lockPath);
        if (version.startsWith('link:')) {
          const target = relative(
            root,
            resolve(root, importer, version.slice(5)),
          );
          if (target.startsWith('..')) throw inputError(root, lockPath);
          // Workspace packages are dependencies too, not an allow-list escape hatch.
          const workspacePath = resolve(root, target, 'package.json');
          const workspace = json(root, workspacePath);
          const workspaceName = workspace.name;
          if (typeof workspaceName !== 'string')
            throw inputError(root, workspacePath);
          approved('npm', workspaceName, workspace.version ?? version);
          visitImporter(lock, target);
          return;
        }
        // Snapshot keys preserve aliases and peer-resolution suffixes.
        const key = /^(@[^/]+\/)?[^@(/]+@/.test(version)
          ? version
          : `${name}@${version}`;
        const snapshot = lock.snapshots?.[key];
        if (!snapshot) throw inputError(root, lockPath);
        const actualName = key.slice(0, key.indexOf('@', 1));
        approved(
          'npm',
          actualName,
          key.slice(actualName.length + 1).split('(')[0],
        );
        if (seen.has(key)) return;
        seen.add(key);
        for (const [child, reference] of dependencies(snapshot))
          visit(lock, importer, child, reference);
      }
      for (const path of nodeManifests) {
        const importer = relative(root, dirname(path));
        const matching = locks.filter((lock) => lock.importers?.[importer]);
        if (matching.length !== 1) throw inputError(root, lockPath);
        visitImporter(matching[0], importer);
      }
    });
  }
  for (const path of manifests.filter((path) =>
    path.endsWith('/composer.json'),
  )) {
    const manifest = json(root, path);
    const lockPath = resolve(dirname(path), 'composer.lock');
    input(root, lockPath, () => {
      const lock = json(root, lockPath);
      if (!Array.isArray(lock.packages) || !Array.isArray(lock['packages-dev']))
        throw inputError(root, lockPath);
      const packages = [...lock.packages, ...lock['packages-dev']];
      const lockedNames = new Set(packages.map((item) => item.name));
      for (const item of [manifest, ...packages]) {
        for (const [name, constraint] of Object.entries({
          ...item.require,
          ...(item === manifest ? item['require-dev'] : {}),
        })) {
          if (
            name === 'php' ||
            name.startsWith('ext-') ||
            name.startsWith('lib-') ||
            name.startsWith('composer-')
          ) {
            approved('platform', name, constraint);
            continue;
          }
          approved(
            'composer',
            name,
            packages.find((pkg) => pkg.name === name)?.version ?? constraint,
          );
          if (!lockedNames.has(name)) throw inputError(root, lockPath);
        }
      }
      for (const item of packages)
        approved('composer', item.name, item.version ?? 'unspecified');
    });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const check = process.argv[2];
    const root = resolve(process.argv[3] ?? repo);
    if (check === 'INV-05') recurrence(root);
    else if (check === 'INV-07') serverDependencies(root);
    else throw new Error('Unknown invariant check.');
    console.log(`${check}: pass`);
  } catch (error) {
    // Parse errors can contain source/manifest contents. Only controlled diagnostics escape.
    const message =
      error instanceof Error &&
      (error.message.startsWith('INV-') ||
        error.message.startsWith('Invariant check input error:'))
        ? error.message
        : 'Invariant check input error (no source data logged).';
    console.error(message);
    process.exitCode = 1;
  }
}
