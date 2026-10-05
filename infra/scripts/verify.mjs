import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const phases = ['format:check', 'lint', 'typecheck', 'test'];

/** @param {string[]} command @param {string} cwd @param {number} timeout */
export function run(command, cwd = root, timeout = 540_000) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    stdio: 'inherit',
    timeout,
  });
  if (result.error || result.status !== 0) {
    // Do not echo command arguments: registered checks may consume sensitive data.
    throw new Error('Verification check failed or exceeded its time budget.');
  }
}

/** @param {string} directory @returns {string[]} */
function directories(directory) {
  return existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
        .map((entry) => resolve(directory, entry.name))
    : [];
}

export function components() {
  return [
    root,
    ...directories(resolve(root, 'server')),
    ...directories(resolve(root, 'apps')),
    ...directories(resolve(root, 'packages')),
  ]
    .filter((directory) =>
      ['package.json', 'composer.json', 'pubspec.yaml'].some((file) =>
        existsSync(resolve(directory, file)),
      ),
    )
    .map((directory) => ({
      directory,
      name:
        directory === root
          ? 'tooling'
          : relative(root, directory).replaceAll('/', '-'),
    }));
}

/** @param {string} name */
export function component(name) {
  const item = components().find((candidate) => candidate.name === name);
  if (!item) throw new Error('Unknown verification component.');
  const { directory } = item;
  if (existsSync(resolve(directory, 'package.json'))) {
    const manifest = JSON.parse(
      readFileSync(resolve(directory, 'package.json'), 'utf8'),
    );
    for (const phase of phases) {
      if (!manifest.scripts?.[phase])
        throw new Error(`Missing required package script: ${phase}`);
      run(['corepack', 'pnpm', 'run', phase], directory);
    }
  } else if (existsSync(resolve(directory, 'composer.json'))) {
    for (const phase of phases)
      run(['composer', 'run-script', phase], directory);
  } else {
    const dartFiles = readdirSync(directory, { recursive: true }).filter(
      (file) =>
        String(file).endsWith('.dart') && !String(file).includes('.dart_tool/'),
    );
    if (!dartFiles.length) {
      for (const phase of phases)
        console.log(
          `${name}: ${phase}: no Dart source/checks registered yet; pass`,
        );
      return;
    }
    const flutter = existsSync(resolve(directory, '.fvmrc'));
    run([flutter ? 'flutter' : 'dart', 'pub', 'get'], directory);
    run(
      ['dart', 'format', '--output=none', '--set-exit-if-changed', '.'],
      directory,
    );
    run([flutter ? 'flutter' : 'dart', 'analyze', '--fatal-infos'], directory);
    // Dart analysis performs both lint and static type checks.
    if (existsSync(resolve(directory, 'test')))
      run([flutter ? 'flutter' : 'dart', 'test'], directory);
    else console.log(`${name}: test: no registered tests yet; pass`);
  }
}

/** @param {string} directory @param {string} name */
export function suite(directory, name) {
  const files = existsSync(directory)
    ? readdirSync(directory)
        .filter((file) => file.endsWith('.json'))
        .sort()
    : [];
  if (!files.length) console.log(`${name}: no registered checks yet; pass`);
  for (const file of files) {
    const checks = JSON.parse(readFileSync(resolve(directory, file), 'utf8'));
    if (!Array.isArray(checks) || !checks.length)
      throw new Error('Check registration must be a nonempty array.');
    for (const command of checks) {
      if (
        !Array.isArray(command) ||
        !command.length ||
        command.some((arg) => typeof arg !== 'string')
      )
        throw new Error('Check command must be a nonempty string array.');
      run(command);
    }
  }
}

/** @param {string} target */
export function main(target) {
  if (target === 'all') {
    // Sequential even with make -j: stack suites only run after package gates.
    for (const { name } of components()) run(['make', `verify-${name}`]);
    for (const name of [
      'check-stack',
      'test-seed',
      'verify-invariants',
      'verify-corpus',
    ])
      run(['make', name]);
  } else if (target === 'invariants' || target === 'corpus') {
    suite(resolve(root, 'infra/scripts/verify', target), `verify-${target}`);
  } else component(target);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv[2]);
  } catch {
    console.error('Verification failed.');
    process.exitCode = 1;
  }
}
