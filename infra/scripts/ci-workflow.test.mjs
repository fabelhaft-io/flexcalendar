import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/verify.yml', 'utf8'));
test('workflow always triggers and all owned third-party actions have release SHA pins', () => {
  assert.ok(Object.hasOwn(workflow.on, 'pull_request'));
  assert.equal(workflow.on.pull_request, null);
  assert.ok(Object.hasOwn(workflow.on, 'merge_group'));
  assert.equal(workflow.jobs.required.if, 'always()');
  assert.deepEqual(workflow.jobs.required.needs, [
    'changes',
    'components',
    'cross-cutting',
    'full',
  ]);
  for (const file of [
    '.github/workflows/verify.yml',
    '.github/actions/setup/action.yml',
    '.github/actions/stack/action.yml',
  ]) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/uses: (?!\.\/)(.+)/g)) {
      assert.match(match[1], /^[\w/-]+@[a-f0-9]{40} # v?\d+\.\d+\.\d+$/);
    }
  }
});
test('aggregate executes its happy path and rejects failure, cancellation, and unexpected skips', () => {
  const command = workflow.jobs.required.steps[0].run;
  /** @param {Record<string, unknown>} needs */
  const run = (needs) =>
    spawnSync('bash', ['-c', command], {
      env: { ...process.env, NEEDS: JSON.stringify(needs) },
      encoding: 'utf8',
    });
  for (const full of [false, true]) {
    /** @type {Record<string, {result: string, outputs?: Record<string, string>}>} */
    const good = {
      changes: {
        result: 'success',
        outputs: { full: String(full), 'has-components': 'true' },
      },
      components: { result: 'success' },
      'cross-cutting': { result: full ? 'skipped' : 'success' },
      full: { result: full ? 'success' : 'skipped' },
    };
    assert.equal(run(good).status, 0);
    for (const job of ['changes', 'components', 'cross-cutting', 'full']) {
      for (const result of ['failure', 'cancelled']) {
        assert.equal(
          run({ ...good, [job]: { ...good[job], result } }).status,
          1,
        );
      }
    }
    assert.equal(
      run({ ...good, [full ? 'full' : 'cross-cutting']: { result: 'skipped' } })
        .status,
      1,
    );
    assert.equal(run({ ...good, components: { result: 'skipped' } }).status, 1);
  }
  const docs = {
    changes: {
      result: 'success',
      outputs: { full: 'false', 'has-components': 'false' },
    },
    components: { result: 'skipped' },
    full: { result: 'skipped' },
    'cross-cutting': { result: 'success' },
  };
  assert.equal(run(docs).status, 0);
});
