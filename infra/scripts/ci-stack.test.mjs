import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const action = parse(readFileSync('.github/actions/stack/action.yml', 'utf8'));
const command = action.runs.steps.at(-1).run;
test('stack step succeeds, or diagnoses unhealthy/exited containers and fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-stack-'));
  try {
    writeFileSync(join(root, 'make'), '#!/bin/sh\nexit "$MAKE_EXIT"\n', {
      mode: 0o755,
    });
    writeFileSync(
      join(root, 'podman'),
      `#!/bin/sh
case "$*" in
  version) echo 'podman version fixture' ;;
  'compose --file infra/dev/compose.yaml ps -a') echo 'compose status fixture' ;;
  'ps -a --filter label=com.docker.compose.project=calendar-flex-dev --format {{.ID}}') printf 'healthy\nunhealthy\nexited\n' ;;
  'inspect --format {{.State.Status}} exited') echo exited ;;
  'inspect --format {{.State.Status}} '*) echo running ;;
  *'{{.State.Health.Status}}'*unhealthy) echo unhealthy ;;
  *'{{.State.Health.Status}}'*) echo healthy ;;
  'logs --tail 50 unhealthy'|'logs --tail 50 exited') echo "logs $4" ;;
  'inspect --format {{json .State.Health}} unhealthy'|'inspect --format {{json .State.Health}} exited') echo "health $4" ;;
  *) echo 'UNEXPECTED INVOCATION'; exit 2 ;;
esac
`,
      { mode: 0o755 },
    );
    const run = (/** @type {string} */ code) =>
      spawnSync('bash', ['-e', '-c', command], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          MAKE_EXIT: code,
        },
      });
    const good = run('0');
    assert.equal(good.status, 0, good.stderr);
    assert.equal(good.stdout, '');
    const bad = run('1');
    assert.equal(bad.status, 1, bad.stderr);
    for (const expected of [
      'podman version fixture',
      'compose status fixture',
      'logs unhealthy',
      'logs exited',
      'health unhealthy',
      'health exited',
    ])
      assert.ok(bad.stdout.includes(expected), bad.stdout);
    assert.ok(!bad.stdout.includes('logs healthy'));
    assert.ok(!bad.stdout.includes('UNEXPECTED INVOCATION'));
    assert.ok(!/inspect --format.*Config\.Env/.test(command));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
