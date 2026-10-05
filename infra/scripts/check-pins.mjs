import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/** @param {string} value */
function version(value) {
  if (!/^\d+(\.\d+){0,2}$/.test(value))
    throw new Error('Unsupported version pin.');
  return value.split('.').map(Number).concat([0, 0]).slice(0, 3);
}
/** @param {number[]} a @param {number[]} b */
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
// Only the explicit numeric comparators and caret constraints used by this repo
// are supported. New syntax fails closed rather than silently passing a pin.
/** @param {string} pin @param {string} range */
export function admits(pin, range) {
  const v = version(pin);
  return range
    .trim()
    .split(/\s+/)
    .every((part) => {
      const match = /^(\^|>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/.exec(part);
      if (!match) throw new Error('Unsupported SDK constraint.');
      const lower = version(match[2]);
      const order = compare(v, lower);
      switch (match[1]) {
        case '^': {
          const index = lower.findIndex((n) => n !== 0);
          const upper = [...lower];
          const bump = index < 0 ? 2 : index;
          upper[bump]++;
          for (let i = bump + 1; i < 3; i++) upper[i] = 0;
          return order >= 0 && compare(v, upper) < 0;
        }
        case '>=':
          return order >= 0;
        case '<=':
          return order <= 0;
        case '>':
          return order > 0;
        case '<':
          return order < 0;
        default:
          return order === 0;
      }
    });
}
/** @typedef {{nvm: string, runtime: string, engines: string, flutter: string, release: {version: string, dart_sdk_version: string}, mobileSdk: string, cryptoSdk: string}} Pins */
/** @param {Pins} pins */
export function checkPins(pins) {
  // .nvmrc is allowed to pin a major (currently 24). The devEngines
  // constraint supplies the minimum patch; both must select the same major.
  const runtime = /^\^(\d+\.\d+\.\d+)$/.exec(pins.runtime);
  if (!runtime)
    throw new Error('devEngines.runtime.version: expected a caret pin.');
  const nvmParts = pins.nvm.split('.');
  if (
    !nvmParts.every((part, i) => Number(part) === version(runtime[1])[i]) ||
    !/^\d+(\.\d+){0,2}$/.test(pins.nvm)
  )
    throw new Error('.nvmrc disagrees with devEngines.runtime.version.');
  if (!admits(runtime[1], pins.engines))
    throw new Error('engines.node excludes the Node runtime pin.');
  if (pins.flutter !== pins.release.version)
    throw new Error('.fvmrc disagrees with the Flutter release fixture.');
  if (!admits(pins.release.dart_sdk_version, pins.mobileSdk))
    throw new Error(
      'apps/mobile Dart SDK constraint excludes the Flutter Dart pin.',
    );
  if (!admits(pins.release.dart_sdk_version, pins.cryptoSdk))
    throw new Error(
      'packages/crypto_dart SDK constraint excludes the Flutter Dart pin.',
    );
}

export function readPins(
  root = resolve(fileURLToPath(new URL('../..', import.meta.url))),
) {
  /** @param {string} path */
  const text = (path) => readFileSync(resolve(root, path), 'utf8');
  /** @param {string} path */
  const json = (path) => JSON.parse(text(path));
  const pkg = json('package.json');
  return {
    nvm: text('.nvmrc').trim(),
    runtime: pkg.devEngines.runtime.version,
    engines: pkg.engines.node,
    flutter: json('apps/mobile/.fvmrc').flutter,
    release: json('infra/scripts/fixtures/flutter-release.json').release,
    mobileSdk: parse(text('apps/mobile/pubspec.yaml')).environment.sdk,
    cryptoSdk: parse(text('packages/crypto_dart/pubspec.yaml')).environment.sdk,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    checkPins(readPins());
    console.log('Node, Flutter and Dart pins agree.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Pin check failed.');
    process.exitCode = 1;
  }
}
