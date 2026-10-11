// E15-R03: tests for the differential recurrence comparison.
//
// Every case builds the two engines' normalised output synthetically (in a
// temp directory or inline), so the gate's own behaviour is pinned without
// running ical.js or sabre/vobject. `make verify-corpus` runs the real engines
// through the same code.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  collectEngine,
  compareOutputs,
  corpusDirectory,
  differenceValue,
  fixtureIds,
  main,
  parseRulings,
  runEngines,
  validateExpansion,
} from './corpus-compare.mjs';

const EMPTY_RULINGS = '```json\n{"rulings": []}\n```\n';

/**
 * @typedef {object} Expansion
 * @property {string} fixture
 * @property {string[]} occurrences
 * @property {Array<{start: string, replaces: string}>} overrides
 */

/**
 * @param {string} fixture
 * @param {string[]} [occurrences]
 * @param {Array<{start: string, replaces: string}>} [overrides]
 * @returns {Expansion}
 */
function expansion(
  fixture,
  occurrences = ['20260101T090000Z'],
  overrides = [],
) {
  return { fixture, occurrences, overrides };
}

/**
 * @param {Expansion[]} expansions
 * @returns {Map<string, Expansion>}
 */
function outputs(...expansions) {
  return new Map(expansions.map((value) => [value.fixture, value]));
}

/**
 * @param {object} [overrides]
 * @returns {import('./corpus-compare.mjs').Ruling}
 */
function ruling(overrides = {}) {
  return {
    fixture: 'case',
    type: 'occurrences',
    index: 1,
    icaljs: 'C',
    vobject: 'Z',
    rfc: 'RFC 5545 § 3.8.5.3',
    correct: 'icaljs',
    note: '',
    ...overrides,
  };
}

/**
 * A fake `run` that writes the given fixtures into the directory the runner was
 * told to use, exactly as the two real runners do.
 * @param {object} input
 * @param {Expansion[]} [input.icaljs]
 * @param {Expansion[]} [input.vobject]
 * @param {Record<string, number>} [input.status]
 */
function writingRun({ icaljs = [], vobject = [], status = {} }) {
  return (
    /** @type {string} */ command,
    /** @type {string[]} */ args,
    /** @type {any} */ options,
  ) => {
    const directory =
      command === 'node' ? options.env.CALFLEX_CORPUS_OUT : args[1];
    mkdirSync(directory, { recursive: true });
    for (const value of command === 'node' ? icaljs : vobject)
      writeFileSync(
        join(directory, `${value.fixture}.json`),
        JSON.stringify(value),
      );
    return { status: status[command] ?? 0, stdout: '', stderr: '' };
  };
}

/** @returns {string} a fresh temporary directory */
function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), 'calflex-corpus-test-'));
}

/** @param {string} command */
function failingRun(command) {
  return (/** @type {string} */ name) =>
    name === command
      ? { status: 1, stdout: '', stderr: 'the runner blew up\n' }
      : { status: 0, stdout: '', stderr: '' };
}

test('equal engine outputs pass', () => {
  const result = compareOutputs({
    fixtures: ['case'],
    icaljs: outputs(expansion('case')),
    vobject: outputs(expansion('case')),
    rulings: [],
  });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.disagreements, []);
});

test('a difference without a ruling fails with the fixture and both values', () => {
  const result = compareOutputs({
    fixtures: ['case'],
    icaljs: outputs(expansion('case', ['A', 'C', 'E'])),
    vobject: outputs(expansion('case', ['A', 'Z', 'E'])),
    rulings: [],
  });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /case/);
  assert.match(result.failures[0], /occurrences 1 \(icaljs C, vobject Z\)/);
  assert.match(result.failures[0], /no ruling/);
});

test('a difference with a matching ruling passes and is reported as accepted', () => {
  const result = compareOutputs({
    fixtures: ['case'],
    icaljs: outputs(expansion('case', ['A', 'C', 'E'])),
    vobject: outputs(expansion('case', ['A', 'Z', 'E'])),
    rulings: [ruling()],
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.disagreements.length, 1);
  assert.deepEqual(result.disagreements[0].difference, {
    type: 'occurrences',
    index: 1,
    icaljs: 'C',
    vobject: 'Z',
  });
  assert.deepEqual(result.unusedRulings, []);
});

test('a ruling whose recorded difference does not match fails', () => {
  const at = (/** @type {object} */ overrides) =>
    compareOutputs({
      fixtures: ['case'],
      icaljs: outputs(expansion('case', ['A', 'C', 'E'])),
      vobject: outputs(expansion('case', ['A', 'Z', 'E'])),
      rulings: [ruling(overrides)],
    }).failures;
  assert.match(at({ index: 2 })[0], /records occurrences 2/);
  assert.match(at({ type: 'overrides' })[0], /records overrides 1/);
  assert.match(at({ icaljs: 'Y' })[0], /records icaljs Y/);
  assert.match(at({ vobject: 'Y' })[0], /records vobject Y/);
});

test('a stale ruling fails', () => {
  const result = compareOutputs({
    fixtures: ['case'],
    icaljs: outputs(expansion('case')),
    vobject: outputs(expansion('case')),
    rulings: [ruling()],
  });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /stale ruling/);
  assert.equal(result.unusedRulings.length, 1);
});

test('a ruling for a fixture the corpus does not hold fails', () => {
  const result = compareOutputs({
    fixtures: ['case'],
    icaljs: outputs(expansion('case')),
    vobject: outputs(expansion('case')),
    rulings: [ruling({ fixture: 'absent' })],
  });
  assert.match(
    result.failures.join('\n'),
    /ruling for absent, which the corpus does not hold/,
  );
});

test('a fixture missing from one engine fails, and so does an extra one', () => {
  const missing = compareOutputs({
    fixtures: ['case', 'other'],
    icaljs: outputs(expansion('case'), expansion('other')),
    vobject: outputs(expansion('case')),
    rulings: [],
  });
  assert.match(
    missing.failures.join('\n'),
    /vobject: no output for fixture other/,
  );

  const extra = compareOutputs({
    fixtures: ['case'],
    icaljs: outputs(expansion('case')),
    vobject: outputs(expansion('case'), expansion('stray')),
    rulings: [],
  });
  assert.match(extra.failures.join('\n'), /vobject: output for stray/);
});

test('an engine that returns zero fixtures fails', () => {
  const result = compareOutputs({
    fixtures: ['case'],
    icaljs: outputs(),
    vobject: outputs(expansion('case')),
    rulings: [],
  });
  assert.match(result.failures.join('\n'), /icaljs: returned zero fixtures/);
  assert.deepEqual(result.disagreements, []);
});

test('a malformed engine output fails', () => {
  assert.match(validateExpansion('case', null) ?? '', /not an object/);
  assert.match(
    validateExpansion('case', expansion('other')) ?? '',
    /names the fixture other/,
  );
  assert.match(
    validateExpansion('case', {
      fixture: 'case',
      occurrences: [1],
      overrides: [],
    }) ?? '',
    /not a canonical date/,
  );
  assert.match(
    validateExpansion('case', {
      fixture: 'case',
      occurrences: [],
      overrides: [{ start: 'A' }],
    }) ?? '',
    /needs a start and a replaces key/,
  );
});

test('an override difference is reported as start|replaces', () => {
  const result = compareOutputs({
    fixtures: ['case'],
    icaljs: outputs(expansion('case', [], [{ start: 'S', replaces: 'R' }])),
    vobject: outputs(expansion('case', [])),
    rulings: [],
  });
  assert.match(
    result.failures.join('\n'),
    /overrides 0 \(icaljs S\|R, vobject \(absent\)\)/,
  );
  assert.equal(differenceValue({ start: 'S', replaces: 'R' }), 'S|R');
  assert.equal(differenceValue('X'), 'X');
});

test('the comparison is order sensitive', () => {
  const result = compareOutputs({
    fixtures: ['case'],
    icaljs: outputs(expansion('case', ['A', 'B'])),
    vobject: outputs(expansion('case', ['B', 'A'])),
    rulings: [],
  });
  assert.match(
    result.failures.join('\n'),
    /occurrences 0 \(icaljs A, vobject B\)/,
  );
});

test('a malformed ruling block is rejected', () => {
  assert.throws(
    () => parseRulings('# nothing\n'),
    /no fenced json ruling block/,
  );
  assert.throws(
    () => parseRulings('```json\n{not json}\n```\n'),
    /not valid JSON/,
  );
  assert.throws(
    () => parseRulings('```json\n{"rulings": 3}\n```\n'),
    /must be an array/,
  );
  assert.throws(
    () => parseRulings('```json\n{"rulings": [{"fixture": "x"}]}\n```\n'),
    /firstDifference must be an object/,
  );
  const withDifference = (
    /** @type {object} */ fields,
    /** @type {string} */ extra = '',
  ) =>
    `\`\`\`json\n{"rulings": [{"fixture":"x","firstDifference":${JSON.stringify(
      fields,
    )},"rfc":"RFC 5545 § 3.8.5.3","correct":"icaljs"${extra}}]}\n\`\`\`\n`;
  assert.throws(
    () =>
      parseRulings(
        withDifference({
          type: 'weekly',
          index: 0,
          icaljs: null,
          vobject: null,
        }),
      ),
    /must be occurrences or overrides/,
  );
  assert.throws(
    () =>
      parseRulings(
        withDifference({
          type: 'occurrences',
          index: -1,
          icaljs: null,
          vobject: null,
        }),
      ),
    /non-negative integer/,
  );
  assert.throws(
    () =>
      parseRulings(
        '```json\n{"rulings": [{"fixture":"x","firstDifference":{"type":"occurrences","index":0,"icaljs":null,"vobject":null},"rfc":"RFC 5545 § 3.8.5.3","correct":"either"}]}\n```\n',
      ),
    /must be icaljs or vobject/,
  );
  const entry =
    '{"fixture":"x","firstDifference":{"type":"occurrences","index":0,"icaljs":null,"vobject":null},"rfc":"RFC 5545 § 3.8.5.3","correct":"icaljs"}';
  assert.throws(
    () =>
      parseRulings(`\`\`\`json\n{"rulings": [${entry}, ${entry}]}\n\`\`\`\n`),
    /duplicate ruling for x/,
  );
  assert.equal(parseRulings(EMPTY_RULINGS).length, 0);
});

test('collectEngine reads the files the runner wrote, and rejects a crash', () => {
  const directory = temporaryDirectory();
  const collected = collectEngine({
    engine: 'case',
    command: ['fake-node', '--write', directory],
    cwd: '.',
    output: directory,
    env: { CALFLEX_CORPUS_OUT: directory },
    run: (/** @type {string} */ command, /** @type {string[]} */ args) => {
      mkdirSync(args[1], { recursive: true });
      writeFileSync(
        join(args[1], 'case.json'),
        JSON.stringify(expansion('case')),
      );
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(collected.error, null);
  assert.deepEqual([...collected.outputs.keys()], ['case']);

  const crashed = collectEngine({
    engine: 'case',
    command: ['fake-node'],
    cwd: '.',
    output: directory,
    run: () => ({ status: 1, stdout: '', stderr: 'boom\n' }),
  });
  assert.match(crashed.error ?? '', /exited 1/);
  assert.match(crashed.error ?? '', /boom/);
  assert.equal(crashed.outputs.size, 0);
});

test('runEngines asks each component for its output', () => {
  const engines = runEngines({
    run: writingRun({
      icaljs: [expansion('a')],
      vobject: [expansion('a')],
    }),
    workdir: temporaryDirectory(),
  });
  assert.equal(engines.icaljs.error, null);
  assert.equal(engines.vobject.error, null);
  assert.deepEqual([...engines.icaljs.outputs.keys()], ['a']);
  assert.deepEqual([...engines.vobject.outputs.keys()], ['a']);
});

test('main passes when both engines agree and fails when one crashes', () => {
  const fixtures = fixtureIds(corpusDirectory);
  const agreeing = fixtures.map((fixture) => expansion(fixture));
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const errors = [];
  const code = main({
    run: writingRun({ icaljs: agreeing, vobject: agreeing }),
    rulingsText: EMPTY_RULINGS,
    log: (line) => lines.push(line),
    error: (line) => errors.push(line),
  });
  assert.equal(code, 0);
  assert.match(lines.join('\n'), new RegExp(`${fixtures.length} fixtures`));
  assert.deepEqual(errors, []);

  /** @type {string[]} */
  const crashLines = [];
  /** @type {string[]} */
  const crashErrors = [];
  const crashCode = main({
    run: failingRun('php'),
    rulingsText: EMPTY_RULINGS,
    log: (line) => crashLines.push(line),
    error: (line) => crashErrors.push(line),
  });
  assert.equal(crashCode, 1);
  assert.match(crashErrors.join('\n'), /vobject: the runner exited 1/);

  const brokenRulingCode = main({
    run: writingRun({}),
    rulingsText: '```json\n{not json}\n```\n',
    log: () => {},
    error: () => {},
  });
  assert.equal(brokenRulingCode, 1);
});
