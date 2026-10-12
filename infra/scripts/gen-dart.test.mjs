import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { dartFileCount, main, pathLevelParameters } from './gen-dart.mjs';

const root = resolve(import.meta.dirname, '../..');
const operationLevel = `openapi: 3.1.0
paths:
  /calendars/{id}:
    patch:
      parameters:
        - name: id
          in: path
components:
  parameters:
    Id:
      name: id
      in: path
`;
const pathLevel = `openapi: 3.1.0
paths:
  /calendars/{id}:
    parameters:
      - name: id
        in: path
    patch: {}
  /calendars:
    get: {}
`;

test('a path-level parameters list is found; operation and component lists are not', () => {
  assert.deepEqual(pathLevelParameters(operationLevel), []);
  assert.deepEqual(pathLevelParameters(pathLevel), ['/calendars/{id}']);
  assert.deepEqual(pathLevelParameters('openapi: 3.1.0\n'), []);
});

test('the committed spec has no path-level parameters list', () => {
  assert.deepEqual(
    pathLevelParameters(
      readFileSync(resolve(root, 'spec/openapi.yaml'), 'utf8'),
    ),
    [],
  );
});

/**
 * A repository with a spec and, unless `fresh`, a committed client of one file.
 * @param {{ spec?: string, fresh?: boolean }} [options]
 */
function fixture({ spec = operationLevel, fresh = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'gen-dart-'));
  mkdirSync(resolve(directory, 'spec'));
  writeFileSync(resolve(directory, 'spec/openapi.yaml'), spec);
  mkdirSync(resolve(directory, 'apps/mobile/lib'), { recursive: true });
  if (!fresh) {
    mkdirSync(resolve(directory, 'apps/mobile/lib/api'));
    writeFileSync(resolve(directory, 'apps/mobile/lib/api/old.dart'), 'old');
  }
  return directory;
}

/**
 * A stand-in for the four tools; `behave` decides what each step does.
 * @param {string} directory
 * @param {(step: string, api: string) => string | void} behave
 */
function fakeRunner(directory, behave) {
  /** @type {string[]} */ const calls = [];
  const api = resolve(directory, 'apps/mobile/lib/api');
  /** @param {string[]} command @param {string} cwd */
  const runner = (command, cwd) => {
    assert.equal(cwd, resolve(directory, 'apps/mobile'));
    const step = command.slice(0, 3).join(' ');
    calls.push(step);
    return behave(step, api) ?? '';
  };
  return { calls, runner };
}

/** @param {string} api */
function writeClient(api) {
  mkdirSync(api, { recursive: true });
  writeFileSync(resolve(api, 'new.dart'), 'new');
}

test('a successful run replaces the client and leaves no backup', () => {
  const directory = fixture();
  try {
    const { calls, runner } = fakeRunner(directory, (step, api) => {
      if (step === 'dart run swagger_parser') writeClient(api);
    });
    main(directory, runner);
    assert.deepEqual(calls, [
      'flutter pub get',
      'dart run swagger_parser',
      'dart run build_runner',
      'dart format lib/api',
    ]);
    const api = resolve(directory, 'apps/mobile/lib/api');
    assert.ok(existsSync(resolve(api, 'new.dart')));
    // A schema removed from the spec loses its file.
    assert.ok(!existsSync(resolve(api, 'old.dart')));
    assert.ok(
      !existsSync(
        resolve(directory, 'apps/mobile/.dart_tool/flexcalendar-api-backup'),
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** @type {{ name: string, behave: (step: string, api: string) => string | void, message: RegExp }[]} */
const failures = [
  {
    name: '"No schemes were generated" with exit 0',
    behave: (step) =>
      step === 'dart run swagger_parser'
        ? '[swagger_parser] No schemes were generated\n'
        : undefined,
    message:
      /swagger_parser generated nothing\. The previous apps\/mobile\/lib\/api is restored\./,
  },
  {
    name: 'a crash after partial output',
    behave: (step, api) => {
      if (step === 'dart run swagger_parser') writeClient(api);
      if (step === 'dart run build_runner')
        throw new Error('dart run build_runner failed (exit 1).');
    },
    message: /build_runner failed .* is restored\./,
  },
  {
    name: 'exit 0 with no Dart file',
    behave: () => undefined,
    message:
      /holds no Dart file after generation\. The previous .* is restored\./,
  },
];

for (const { name, behave, message } of failures) {
  test(`a failed run restores the previous client: ${name}`, () => {
    const directory = fixture();
    try {
      const { runner } = fakeRunner(directory, behave);
      assert.throws(() => main(directory, runner), message);
      const api = resolve(directory, 'apps/mobile/lib/api');
      assert.equal(readFileSync(resolve(api, 'old.dart'), 'utf8'), 'old');
      assert.ok(!existsSync(resolve(api, 'new.dart')));
      assert.equal(dartFileCount(api), 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('a first generation that fails leaves no client behind', () => {
  const directory = fixture({ fresh: true });
  try {
    const { runner } = fakeRunner(directory, () => undefined);
    assert.throws(() => main(directory, runner), /holds no Dart file/);
    assert.ok(!existsSync(resolve(directory, 'apps/mobile/lib/api')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a path-level parameters list stops the run before anything is touched', () => {
  const directory = fixture({ spec: pathLevel });
  try {
    const { calls, runner } = fakeRunner(directory, () => undefined);
    assert.throws(
      () => main(directory, runner),
      /spec\/openapi\.yaml: a path-level `parameters:` list under \/calendars\/\{id\}/,
    );
    assert.deepEqual(calls, []);
    assert.equal(
      readFileSync(resolve(directory, 'apps/mobile/lib/api/old.dart'), 'utf8'),
      'old',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
