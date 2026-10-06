import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { components } from './verify.mjs';

/** @param {string[]} paths @param {{name: string}[]} knownComponents */
export function selectComponents(paths, knownComponents = components()) {
  const full = paths.some(
    (path) =>
      !path.includes('/') ||
      /^(infra|\.github)\//.test(path) ||
      path === 'spec/openapi.yaml' ||
      [
        'apps/mobile/swagger_parser.yaml',
        'apps/mobile/pubspec.yaml',
        'apps/mobile/pubspec.lock',
        'packages/api-client-ts/package.json',
      ].includes(path) ||
      path === 'packages/api-client-ts/src/schema.d.ts' ||
      path.startsWith('apps/mobile/lib/api/'),
  );
  const names = knownComponents
    .map(({ name }) => name)
    .filter((name) => name !== 'tooling');
  const selected = names.filter((name) => {
    if (full) return true;
    const directory = name.startsWith('packages-')
      ? `packages/${name.slice(9)}`
      : name.replace('-', '/');
    if (paths.some((path) => path.startsWith(`${directory}/`))) return true;
    // Shared TS packages affect both consumers, and shared Dart affects mobile.
    if (
      paths.some((path) =>
        /^packages\/(crypto-ts|api-client-ts)\//.test(path),
      ) &&
      [
        'server-api',
        'apps-web',
        'packages-crypto-ts',
        'packages-api-client-ts',
      ].includes(name)
    )
      return true;
    if (
      paths.some((path) => path.startsWith('packages/crypto_dart/')) &&
      name === 'apps-mobile'
    )
      return true;
    // A future shared package has unknown consumers; conservatively run all.
    return paths.some(
      (path) =>
        /^packages\//.test(path) &&
        !/^packages\/(crypto-ts|api-client-ts|crypto_dart)\//.test(path),
    );
  });
  return { full, selected };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const diff = spawnSync(
    'git',
    ['diff', '--name-only', '-z', `${process.argv[2]}...${process.argv[3]}`],
    { encoding: 'utf8' },
  );
  if (diff.status !== 0) throw new Error('Cannot detect changed components.');
  const selection = selectComponents(diff.stdout.split('\0').filter(Boolean));
  // An empty matrix cannot be expanded, even for a skipped job.
  const matrix = selection.selected.length ? selection.selected : ['tooling'];
  const output = `full=${selection.full}\ncomponents=${JSON.stringify(matrix)}\nhas-components=${selection.selected.length > 0}\n`;
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
}
