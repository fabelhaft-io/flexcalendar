// E15-R03: compare the two recurrence engines over `spec/ical-fixtures/rrule/`.
//
// `make verify-corpus` runs this (registered in
// `infra/scripts/verify/corpus/E15-R03.json`). It runs both component runners —
// `ical.js` from `server/api/test/` and `sabre/vobject` from
// `server/caldav/tests/` — over the one fixed five-year window, diffs their
// normalised output fixture by fixture, and fails on the first difference
// unless `spec/ical-fixtures/RULINGS.md` records exactly that difference and
// names the engine that is right.
//
// Resolution is a ruling, not a skip. A disagreement without a ruling fails, a
// ruling that no longer describes a real disagreement (a stale ruling hides the
// next regression) fails, a ruling for an unknown fixture fails, a malformed
// ruling block fails, an engine that crashes fails, and an engine that returns
// no fixtures at all fails — a gate over an empty input cannot fail, so it must
// be refused rather than trusted.
//
// The normalisation is implemented once per engine
// (`server/api/test/recurrence-corpus.mjs` and
// `server/caldav/tests/RecurrenceCorpus.php`) and documented in
// `spec/ical-fixtures/rrule/README.md`.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root. */
export const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** The corpus directory. */
export const corpusDirectory = join(root, 'spec/ical-fixtures/rrule');

/** The human-readable rulings file. */
export const rulingsPath = join(root, 'spec/ical-fixtures/RULINGS.md');

/** Environment variable each component runner writes its JSON output to. */
export const OUTPUT_VARIABLE = 'CALFLEX_CORPUS_OUT';

/**
 * Runs one command and returns its status plus captured output.
 * @typedef {(command: string, args: string[], options: object) => {status: number | null, stdout?: string, stderr?: string}} Runner
 */

/**
 * @typedef {object} Difference
 * @property {'occurrences' | 'overrides'} type
 * @property {number} index
 * @property {string | null} icaljs
 * @property {string | null} vobject
 */

/**
 * @typedef {object} Ruling
 * @property {string} fixture
 * @property {'occurrences' | 'overrides'} type
 * @property {number} index
 * @property {string | null} icaljs
 * @property {string | null} vobject
 * @property {string} rfc
 * @property {'icaljs' | 'vobject'} correct
 * @property {string} note
 */

/** @param {string} [directory] @returns {string[]} */
export function fixtureIds(directory = corpusDirectory) {
  return readdirSync(directory)
    .filter((file) => file.endsWith('.ics'))
    .map((file) => file.slice(0, -'.ics'.length))
    .sort();
}

/**
 * Parse and validate the fenced JSON block of `spec/ical-fixtures/RULINGS.md`.
 * This mirrors `parseRulings` in `server/api/test/recurrence-corpus.mjs`: each
 * component suite reads the same block, and this is the copy the corpus gate
 * uses.
 * @param {string} text
 * @returns {Ruling[]}
 */
export function parseRulings(text) {
  const match = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  if (!match) throw new Error('RULINGS.md has no fenced json ruling block');
  let decoded;
  try {
    decoded = JSON.parse(match[1]);
  } catch {
    throw new Error(
      'RULINGS.md: the fenced json ruling block is not valid JSON',
    );
  }
  if (
    !decoded ||
    typeof decoded !== 'object' ||
    !Array.isArray(decoded.rulings)
  )
    throw new Error('RULINGS.md: rulings must be an array');
  /** @type {Ruling[]} */
  const rulings = [];
  const seen = new Set();
  for (const [position, entry] of decoded.rulings.entries()) {
    const where = `RULINGS.md: ruling ${position + 1}`;
    if (typeof entry !== 'object' || entry === null)
      throw new Error(`${where} is not an object`);
    const ruling = /** @type {Record<string, unknown>} */ (entry);
    const fixture = stringField(ruling.fixture, `${where} fixture`);
    if (seen.has(fixture))
      throw new Error(`RULINGS.md: duplicate ruling for ${fixture}`);
    seen.add(fixture);
    const difference = ruling.firstDifference;
    if (typeof difference !== 'object' || difference === null)
      throw new Error(`${where}: firstDifference must be an object`);
    const fields = /** @type {Record<string, unknown>} */ (difference);
    const type = stringField(fields.type, `${where} firstDifference.type`);
    if (type !== 'occurrences' && type !== 'overrides')
      throw new Error(
        `${where}: firstDifference.type must be occurrences or overrides`,
      );
    if (
      !Number.isInteger(fields.index) ||
      /** @type {number} */ (fields.index) < 0
    )
      throw new Error(
        `${where}: firstDifference.index must be a non-negative integer`,
      );
    const correct = stringField(ruling.correct, `${where} correct`);
    if (correct !== 'icaljs' && correct !== 'vobject')
      throw new Error(`${where}: correct must be icaljs or vobject`);
    rulings.push({
      fixture,
      type,
      index: /** @type {number} */ (fields.index),
      icaljs: nullableStringField(
        fields.icaljs,
        `${where} firstDifference.icaljs`,
      ),
      vobject: nullableStringField(
        fields.vobject,
        `${where} firstDifference.vobject`,
      ),
      rfc: stringField(ruling.rfc, `${where} rfc`),
      correct,
      note: typeof ruling.note === 'string' ? ruling.note : '',
    });
  }
  return rulings;
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {string}
 */
function stringField(value, what) {
  if (typeof value !== 'string' || !value)
    throw new Error(`${what} must be a non-empty string`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {string | null}
 */
function nullableStringField(value, what) {
  if (value !== null && typeof value !== 'string')
    throw new Error(`${what} must be a string or null`);
  return value;
}

/**
 * One comparison value of an occurrence entry: an occurrence is its canonical
 * start, an override is `<start>|<replaces>`.
 * @param {unknown} entry
 * @returns {string}
 */
export function differenceValue(entry) {
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'object' && entry !== null) {
    const override = /** @type {Record<string, unknown>} */ (entry);
    if (
      typeof override.start === 'string' &&
      typeof override.replaces === 'string'
    )
      return `${override.start}|${override.replaces}`;
  }
  throw new Error(
    'corpus output holds an occurrence that is neither a string nor an override',
  );
}

/**
 * Validate one engine's output for one fixture.
 * @param {string} id
 * @param {unknown} value
 * @returns {string | null} an error message, or null when the shape is right
 */
export function validateExpansion(id, value) {
  if (typeof value !== 'object' || value === null)
    return `${id}: the engine's output is not an object`;
  const expansion = /** @type {Record<string, unknown>} */ (value);
  if (expansion.fixture !== id)
    return `${id}: the engine's output names the fixture ${String(expansion.fixture)}`;
  if (!Array.isArray(expansion.occurrences))
    return `${id}: occurrences is not an array`;
  if (!Array.isArray(expansion.overrides))
    return `${id}: overrides is not an array`;
  for (const occurrence of expansion.occurrences)
    if (typeof occurrence !== 'string')
      return `${id}: an occurrence is not a canonical date or UTC instant`;
  for (const override of expansion.overrides) {
    if (typeof override !== 'object' || override === null)
      return `${id}: an override is not an object`;
    const entry = /** @type {Record<string, unknown>} */ (override);
    if (typeof entry.start !== 'string' || typeof entry.replaces !== 'string')
      return `${id}: an override needs a start and a replaces key`;
  }
  return null;
}

/**
 * @param {'occurrences' | 'overrides'} type
 * @param {unknown[]} left
 * @param {unknown[]} right
 * @returns {Difference | null}
 */
function compareLists(type, left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const one = index < left.length ? differenceValue(left[index]) : null;
    const other = index < right.length ? differenceValue(right[index]) : null;
    if (one !== other) return { type, index, icaljs: one, vobject: other };
  }
  return null;
}

/**
 * The first place two expansions differ: occurrences first, then overrides.
 * @param {{occurrences: unknown[], overrides: unknown[]}} left
 * @param {{occurrences: unknown[], overrides: unknown[]}} right
 * @returns {Difference | null}
 */
export function firstDifference(left, right) {
  return (
    compareLists('occurrences', left.occurrences, right.occurrences) ??
    compareLists('overrides', left.overrides, right.overrides)
  );
}

/**
 * @param {Difference} difference
 * @returns {string}
 */
function describe(difference) {
  return `${difference.type} ${difference.index} (icaljs ${
    difference.icaljs ?? '(absent)'
  }, vobject ${difference.vobject ?? '(absent)'})`;
}

/**
 * Diff the two engines' outputs, fixture by fixture.
 * @param {object} input
 * @param {string[]} input.fixtures
 * @param {Map<string, unknown>} input.icaljs
 * @param {Map<string, unknown>} input.vobject
 * @param {Ruling[]} input.rulings
 * @returns {{failures: string[], disagreements: {fixture: string, difference: Difference, ruling: Ruling}[], unusedRulings: Ruling[]}}
 */
export function compareOutputs({ fixtures, icaljs, vobject, rulings }) {
  const failures = [];
  const disagreements = [];
  const rulingByFixture = new Map(
    rulings.map((ruling) => [ruling.fixture, ruling]),
  );
  const used = new Set();

  /** @type {Array<[string, Map<string, unknown>]>} */
  const sides = [
    ['icaljs', icaljs],
    ['vobject', vobject],
  ];
  for (const [engine, outputs] of sides) {
    if (outputs.size === 0) {
      failures.push(
        `${engine}: returned zero fixtures; a gate over an empty input cannot fail`,
      );
      continue;
    }
    for (const id of fixtures)
      if (!outputs.has(id))
        failures.push(`${engine}: no output for fixture ${id}`);
    for (const id of outputs.keys())
      if (!fixtures.includes(id))
        failures.push(
          `${engine}: output for ${id}, which the corpus does not hold`,
        );
  }

  for (const ruling of rulings)
    if (!fixtures.includes(ruling.fixture))
      failures.push(
        `RULINGS.md: ruling for ${ruling.fixture}, which the corpus does not hold`,
      );

  for (const id of fixtures) {
    if (!icaljs.has(id) || !vobject.has(id)) continue;
    const left = /** @type {any} */ (icaljs.get(id));
    const right = /** @type {any} */ (vobject.get(id));
    const shape = validateExpansion(id, left) ?? validateExpansion(id, right);
    if (shape) {
      failures.push(shape);
      continue;
    }
    const difference = firstDifference(left, right);
    const ruling = rulingByFixture.get(id);
    if (!difference) {
      if (ruling)
        failures.push(
          `${id}: RULINGS.md still records a disagreement, but the engines agree now (stale ruling)`,
        );
      continue;
    }
    disagreements.push({
      fixture: id,
      difference,
      ruling: /** @type {Ruling} */ (ruling),
    });
    if (!ruling) {
      failures.push(
        `${id}: the engines first differ at ${describe(difference)}, and RULINGS.md has no ruling for it`,
      );
      continue;
    }
    used.add(id);
    if (ruling.type !== difference.type || ruling.index !== difference.index) {
      failures.push(
        `${id}: the ruling records ${ruling.type} ${ruling.index}, the engines first differ at ${describe(difference)}`,
      );
      continue;
    }
    if (ruling.icaljs !== difference.icaljs)
      failures.push(
        `${id}: the ruling records icaljs ${ruling.icaljs ?? '(absent)'}, the engine gives ${
          difference.icaljs ?? '(absent)'
        } at the first difference`,
      );
    if (ruling.vobject !== difference.vobject)
      failures.push(
        `${id}: the ruling records vobject ${ruling.vobject ?? '(absent)'}, the engine gives ${
          difference.vobject ?? '(absent)'
        } at the first difference`,
      );
  }

  return {
    failures,
    disagreements,
    unusedRulings: rulings.filter((ruling) => !used.has(ruling.fixture)),
  };
}

/**
 * Run one engine's runner and read the JSON it wrote.
 * @param {object} input
 * @param {string} input.engine
 * @param {string[]} input.command
 * @param {string} input.cwd
 * @param {string} input.output the directory the engine must write to
 * @param {Record<string, string|undefined>} [input.env]
 * @param {Runner} input.run
 * @returns {{outputs: Map<string, unknown>, error: string|null}}
 */
export function collectEngine({ engine, command, cwd, output, env = {}, run }) {
  const result = run(command[0], command.slice(1), {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0)
    return {
      outputs: new Map(),
      error: `${engine}: the runner exited ${result.status ?? 'without a status'}\n${(
        result.stderr ?? ''
      )
        .trim()
        .split('\n')
        .slice(-5)
        .join('\n')}`,
    };
  if (!existsSync(output))
    return {
      outputs: new Map(),
      error: `${engine}: the runner wrote no output to ${output}`,
    };
  /** @type {Map<string, unknown>} */
  const outputs = new Map();
  for (const file of readdirSync(output)
    .filter((name) => name.endsWith('.json'))
    .sort()) {
    const id = file.slice(0, -'.json'.length);
    try {
      outputs.set(id, JSON.parse(readFileSync(join(output, file), 'utf8')));
    } catch {
      return {
        outputs: new Map(),
        error: `${engine}: ${file} is not valid JSON`,
      };
    }
  }
  return { outputs, error: null };
}

/**
 * Run both component runners into a temporary directory.
 * @param {object} input
 * @param {Runner} input.run
 * @param {string} input.workdir
 * @returns {{icaljs: ReturnType<typeof collectEngine>, vobject: ReturnType<typeof collectEngine>}}
 */
export function runEngines({ run, workdir }) {
  return {
    icaljs: collectEngine({
      engine: 'icaljs',
      command: [
        'node',
        '--test',
        '--test-reporter=dot',
        'test/recurrence-corpus.test.mjs',
      ],
      cwd: join(root, 'server/api'),
      output: join(workdir, 'icaljs'),
      env: { [OUTPUT_VARIABLE]: join(workdir, 'icaljs') },
      run,
    }),
    vobject: collectEngine({
      engine: 'vobject',
      command: ['php', 'tests/corpus-cli.php', join(workdir, 'vobject')],
      cwd: join(root, 'server/caldav'),
      output: join(workdir, 'vobject'),
      run,
    }),
  };
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {object} options
 * @returns {{status: number|null, stdout?: string, stderr?: string}}
 */
function defaultRun(command, args, options) {
  const result =
    /** @type {import('node:child_process').SpawnSyncReturns<string>} */ (
      spawnSync(
        command,
        args,
        /** @type {import('node:child_process').SpawnSyncOptions} */ (options),
      )
    );
  if (result.error)
    return {
      status: null,
      stdout: '',
      stderr: `${command}: ${result.error.message}`,
    };
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * @param {object} [dependencies]
 * @param {Runner} [dependencies.run]
 * @param {(line: string) => void} [dependencies.log]
 * @param {(line: string) => void} [dependencies.error]
 * @param {string | null} [dependencies.rulingsText] the ruling block to use instead of RULINGS.md
 * @returns {number} the process exit code
 */
export function main({
  run = defaultRun,
  log = console.log,
  error = console.error,
  rulingsText = null,
} = {}) {
  const fixtures = fixtureIds();
  let rulings;
  try {
    rulings = parseRulings(
      rulingsText ?? readFileSync(rulingsPath, { encoding: 'utf8' }),
    );
  } catch (failure) {
    error(
      `verify-corpus: ${failure instanceof Error ? failure.message : 'cannot read RULINGS.md'}`,
    );
    return 1;
  }

  const workdir = mkdtempSync(join(tmpdir(), 'calflex-corpus-'));
  let engines;
  try {
    engines = runEngines({ run, workdir });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }

  /** @type {string[]} */
  const failures = [];
  for (const engine of [engines.icaljs, engines.vobject])
    if (engine.error) failures.push(engine.error);

  const comparison = compareOutputs({
    fixtures,
    icaljs: engines.icaljs.outputs,
    vobject: engines.vobject.outputs,
    rulings,
  });
  failures.push(...comparison.failures);

  for (const { fixture, difference, ruling } of comparison.disagreements)
    if (
      ruling &&
      !comparison.failures.some((failure) => failure.startsWith(`${fixture}:`))
    )
      log(
        `accepted: ${fixture} differs at ${describe(difference)}; ${ruling.rfc} says ${
          ruling.correct
        } is right`,
      );

  for (const failure of failures) error(`verify-corpus: ${failure}`);
  if (failures.length) {
    error(`verify-corpus: ${failures.length} failure(s)`);
    return 1;
  }
  log(
    `verify-corpus: ${fixtures.length} fixtures, ${comparison.disagreements.length} accepted disagreement(s), 0 failures`,
  );
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = main();
