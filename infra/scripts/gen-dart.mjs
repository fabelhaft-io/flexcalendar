// The Dart half of `make gen` (E02-R07): swagger_parser, then build_runner and
// dart format, into apps/mobile/lib/api.
//
// swagger_parser 1.45.0 fails in two quiet ways. It prints "No schemes were
// generated" and exits 0 when it reads nothing, and it dies on a path-level
// `parameters:` list (it casts every path-item member to a map before it skips
// the key). The old recipe wiped lib/api first and checked nothing, so either
// failure left the client deleted and `make gen` green. This script refuses a
// path-level list before it touches anything, moves the old client aside
// rather than deleting it, and puts it back when the generator produced
// nothing or failed.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../..', import.meta.url));
const spec = 'spec/openapi.yaml';
const mobile = 'apps/mobile';
const output = 'apps/mobile/lib/api';
// Ignored (`.dart_tool/`) and on the same filesystem, so a rename suffices.
const backup = 'apps/mobile/.dart_tool/flexcalendar-api-backup';
const NOTHING_GENERATED = /No schemes were generated/i;

/**
 * The paths whose path item carries its own `parameters` list.
 * @param {string} text the OpenAPI document
 * @returns {string[]}
 */
export function pathLevelParameters(text) {
  const document = parse(text);
  const paths = document?.paths;
  if (!paths || typeof paths !== 'object') return [];
  return Object.entries(paths)
    .filter(
      ([, item]) => item && typeof item === 'object' && 'parameters' in item,
    )
    .map(([path]) => path);
}

/** @param {string} directory @returns {number} */
export function dartFileCount(directory) {
  if (!existsSync(directory)) return 0;
  return readdirSync(directory, { recursive: true }).filter((file) =>
    String(file).endsWith('.dart'),
  ).length;
}

/**
 * Runs a command, passes its output through, and returns it.
 * @param {string[]} command @param {string} cwd @returns {string}
 */
function run(command, cwd) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error || result.status !== 0)
    throw new Error(
      `${command.slice(0, 3).join(' ')} failed (exit ${result.status ?? 'unavailable'}).`,
    );
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/**
 * @param {string} [directory] the repository root
 * @param {(command: string[], cwd: string) => string} [runner]
 */
export function main(directory = root, runner = run) {
  const offending = pathLevelParameters(
    readFileSync(resolve(directory, spec), 'utf8'),
  );
  if (offending.length)
    throw new Error(
      `${spec}: a path-level \`parameters:\` list under ${offending.join(', ')}. ` +
        'swagger_parser 1.45.0 cannot read one; declare each path parameter on its operations.',
    );
  const target = resolve(directory, output);
  const saved = resolve(directory, backup);
  rmSync(saved, { recursive: true, force: true });
  if (existsSync(target)) {
    mkdirSync(dirname(saved), { recursive: true });
    renameSync(target, saved);
  }
  try {
    const cwd = resolve(directory, mobile);
    runner(['flutter', 'pub', 'get'], cwd);
    const parser = runner(['dart', 'run', 'swagger_parser'], cwd);
    if (NOTHING_GENERATED.test(parser))
      throw new Error('swagger_parser generated nothing.');
    runner(['dart', 'run', 'build_runner', 'build'], cwd);
    runner(['dart', 'format', 'lib/api'], cwd);
    if (!dartFileCount(target))
      throw new Error(`${output} holds no Dart file after generation.`);
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    if (existsSync(saved)) renameSync(saved, target);
    throw new Error(
      `${error instanceof Error ? error.message : 'Dart client generation failed.'} ` +
        `The previous ${output} is restored.`,
      { cause: error },
    );
  }
  rmSync(saved, { recursive: true, force: true });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Dart client generation failed.',
    );
    process.exitCode = 1;
  }
}
