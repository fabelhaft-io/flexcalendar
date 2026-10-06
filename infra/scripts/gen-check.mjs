import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../..', import.meta.url));
export const generated = [
  'packages/api-client-ts/src/schema.d.ts',
  'apps/mobile/lib/api',
];
/** @param {string} directory @param {string[]} paths @returns {Map<string, string>} */
export function snapshot(directory, paths) {
  const result = new Map();
  /** @param {string} path */
  function visit(path) {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      for (const child of readdirSync(path)) visit(resolve(path, child));
    } else
      result.set(
        relative(directory, path),
        createHash('sha256').update(readFileSync(path)).digest('hex'),
      );
  }
  for (const path of paths) visit(resolve(directory, path));
  return result;
}
/** @param {Map<string, string>} before @param {Map<string, string>} after */
export function differences(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].filter(
    (path) => before.get(path) !== after.get(path),
  );
}
/** @param {string} directory */
function generate(directory) {
  const generation = spawnSync('make', ['gen'], {
    cwd: directory,
    stdio: 'inherit',
  });
  if (generation.status !== 0) throw new Error('API client generation failed.');
}
/** @param {string} directory @param {string[]} paths @param {(directory: string) => void} generateStep */
export function main(
  directory = root,
  paths = generated,
  generateStep = generate,
) {
  const before = snapshot(directory, paths);
  generateStep(directory);
  const changed = differences(before, snapshot(directory, paths));
  // Also catch files already stale in the commit and extra/untracked outputs.
  const tracked = spawnSync(
    'git',
    ['diff', '--name-only', 'HEAD', '--', ...paths],
    { cwd: directory, encoding: 'utf8' },
  );
  const untracked = spawnSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '--', ...paths],
    { cwd: directory, encoding: 'utf8' },
  );
  if (tracked.status !== 0 || untracked.status !== 0)
    throw new Error('Cannot check generated files with git.');
  const failures = new Set(
    [
      ...changed,
      ...tracked.stdout.trim().split('\n'),
      ...untracked.stdout.trim().split('\n'),
    ].filter(Boolean),
  );
  if (failures.size)
    throw new Error(
      `Generated API files are stale, missing or untracked:\n${[...failures].sort().join('\n')}`,
    );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Generation check failed.',
    );
    process.exitCode = 1;
  }
}
