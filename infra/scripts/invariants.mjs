import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const policy = JSON.parse(
  readFileSync(
    new URL('./invariant-dependencies.json', import.meta.url),
    'utf8',
  ),
);
const ignored = new Set([
  'node_modules',
  'vendor',
  '.git',
  '.dart_tool',
  '.gradle',
  '.fvm',
  'build',
  'dist',
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

/** @param {string} directory @returns {string[]} */
function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error('Unsupported symlink in checked source tree.');
    return entry.isDirectory() ? files(path) : [path];
  });
}

/** Conservative code search: never prints source lines or event data. @param {string} root */
export function recurrence(root) {
  const clients = files(resolve(root, 'apps'));
  const packages = resolve(root, 'packages');
  if (existsSync(packages)) {
    for (const entry of readdirSync(packages, { withFileTypes: true })) {
      if (/^crypto[-_]/.test(entry.name))
        clients.push(...files(resolve(packages, entry.name)));
    }
  }
  for (const path of clients) {
    if (
      sources.has(extname(path)) &&
      /exdate|recurrence[-_]?id/i.test(readFileSync(path, 'utf8'))
    ) {
      throw new Error(
        'INV-05: forbidden client recurrence property reference; send an intent instead.',
      );
    }
  }
}

/** @param {string} path */
function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
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

/** @param {string} ecosystem @param {string} name */
function approved(ecosystem, name) {
  // Explicit deny even if someone accidentally adds a content cipher to the allow-list.
  if (
    /sodium|nacl|^@noble\/|crypto-js|node-forge|openpgp|(^|\/)phpseclib|defuse\/|halite|sjcl|(^|\/)cryptography/i.test(
      name,
    )
  ) {
    throw new Error('INV-07: content-crypto dependency in server tree.');
  }
  if (
    !Object.hasOwn(policy[ecosystem], name) ||
    !policy[ecosystem][name].trim()
  ) {
    throw new Error(
      'INV-07: unreviewed server dependency; a non-content-crypto justification is required.',
    );
  }
}

/** @param {string} root */
export function serverDependencies(root) {
  const manifests = files(resolve(root, 'server'));
  const nodeManifests = manifests.filter((path) =>
    path.endsWith('/package.json'),
  );
  if (nodeManifests.length) {
    const documents = parseAllDocuments(
      readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8'),
    );
    if (documents.some((document) => document.errors.length))
      throw new Error('Invalid dependency lock YAML.');
    // pnpm 12 has a package-manager document as well as the application document.
    const locks = documents.map((document) => document.toJS());
    const seen = new Set();
    /** @param {any} lock @param {string} importer */
    function visitImporter(lock, importer) {
      const key = `workspace:${importer}`;
      if (seen.has(key)) return;
      seen.add(key);
      const entry = lock.importers?.[importer];
      if (!entry)
        throw new Error('Missing workspace importer in dependency lock.');
      const manifest = json(resolve(root, importer, 'package.json'));
      for (const [name] of dependencies(manifest)) {
        const locked = dependencies(entry).find(
          ([candidate]) => candidate === name,
        );
        if (!locked) throw new Error('Manifest dependency missing from lock.');
      }
      for (const [name, reference] of dependencies(entry))
        visit(lock, importer, name, reference.version);
    }
    /** @param {any} lock @param {string} importer @param {string} name @param {string} version */
    function visit(lock, importer, name, version) {
      if (typeof version !== 'string')
        throw new Error('Invalid dependency lock reference.');
      if (version.startsWith('link:')) {
        const target = relative(
          root,
          resolve(root, importer, version.slice(5)),
        );
        if (target.startsWith('..'))
          throw new Error('Workspace dependency escapes repository.');
        // Workspace packages are dependencies too, not an allow-list escape hatch.
        const workspaceName = json(resolve(root, target, 'package.json')).name;
        if (typeof workspaceName !== 'string')
          throw new Error('Workspace dependency has no package name.');
        approved('npm', workspaceName);
        visitImporter(lock, target);
        return;
      }
      // Snapshot keys preserve aliases and peer-resolution suffixes.
      const key = /^(@[^/]+\/)?[^@(/]+@/.test(version)
        ? version
        : `${name}@${version}`;
      const snapshot = lock.snapshots?.[key];
      if (!snapshot) throw new Error('Missing resolved dependency snapshot.');
      const actualName = key.slice(0, key.indexOf('@', 1));
      approved('npm', actualName);
      if (seen.has(key)) return;
      seen.add(key);
      for (const [child, reference] of dependencies(snapshot))
        visit(lock, importer, child, reference);
    }
    for (const path of nodeManifests) {
      const importer = relative(root, dirname(path));
      const matching = locks.filter((lock) => lock.importers?.[importer]);
      if (matching.length !== 1)
        throw new Error(
          'Missing or ambiguous server importer in dependency lock.',
        );
      visitImporter(matching[0], importer);
    }
  }
  for (const path of manifests.filter((path) =>
    path.endsWith('/composer.json'),
  )) {
    const manifest = json(path);
    const lock = json(resolve(dirname(path), 'composer.lock'));
    if (!Array.isArray(lock.packages) || !Array.isArray(lock['packages-dev']))
      throw new Error('Invalid Composer lock.');
    const packages = [...lock.packages, ...lock['packages-dev']];
    const lockedNames = new Set(packages.map((item) => item.name));
    for (const item of [manifest, ...packages]) {
      for (const name of Object.keys({
        ...item.require,
        ...(item === manifest ? item['require-dev'] : {}),
      })) {
        if (
          name === 'php' ||
          name.startsWith('ext-') ||
          name.startsWith('lib-') ||
          name.startsWith('composer-')
        ) {
          approved('platform', name);
          continue;
        }
        approved('composer', name);
        if (!lockedNames.has(name))
          throw new Error('Composer dependency missing from lock.');
      }
    }
    for (const item of packages) approved('composer', item.name);
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
      error instanceof Error && error.message.startsWith('INV-')
        ? error.message
        : 'Invariant check input error (no source data logged).';
    console.error(message);
    process.exitCode = 1;
  }
}
