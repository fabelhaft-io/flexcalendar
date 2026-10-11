import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  analyze,
  expandIds,
  firstVerdict,
  followUpCounts,
  format,
  gitSource,
  parseDecisions,
  parseDeps,
  parseEpic,
  parseHeaderDeps,
  parseQueue,
} from './next-ready.mjs';

// --- parsers -----------------------------------------------------------------

test('expandIds reads full IDs, ranges, slash lists and epic-relative short forms', () => {
  assert.deepEqual(expandIds('E04-R01 and E04-R02 (Done, PRs #38 and #41)'), [
    'E04-R01',
    'E04-R02',
  ]);
  assert.deepEqual(expandIds('E04-R03..R05, E05-R07'), [
    'E04-R03',
    'E04-R04',
    'E04-R05',
    'E05-R07',
  ]);
  assert.deepEqual(expandIds('E06-R02/R09'), ['E06-R02', 'E06-R09']);
  assert.deepEqual(expandIds('R01 (agent+review), R02–R04, R08', 'E05'), [
    'E05-R01',
    'E05-R02',
    'E05-R03',
    'E05-R04',
    'E05-R08',
  ]);
  assert.deepEqual(expandIds('R02–R03'), [], 'a short form needs its epic');
});

test('expandIds does not read IDs out of other text', () => {
  const noise = 'PR #51, RFC 5545, 2026-10-09, KR01, PR01, D-02, E05 alone';
  assert.deepEqual(expandIds(noise, 'E05'), []);
  assert.deepEqual(expandIds('(R03)', 'E05'), ['E05-R03']);
});

test('parseDeps separates IDs, whole epics, decisions, alternatives and prose', () => {
  assert.deepEqual(parseDeps(' E03-R01, E04-R02.', 'E05').ids, [
    'E03-R01',
    'E04-R02',
  ]);
  const annotated = parseDeps(
    ' E04-R02 (the roles and the bootstrap), E02-R09',
    'E08',
  );
  assert.deepEqual(annotated.ids, ['E04-R02', 'E02-R09']);
  assert.deepEqual(annotated.notes, [], 'a parenthesis is not prose');
  assert.equal(
    parseDeps(' E10-R01, E10-R02 (mobile); E09-R01 (web)', 'E10').unclear !==
      null,
    true,
  );
  assert.equal(parseDeps(' E04-R02 or E04-R03', 'E05').unclear !== null, true);
  assert.deepEqual(parseDeps(' E04, E03-R01', 'E05').epics, ['E04']);
  assert.deepEqual(parseDeps(' D-04 and E03-R01', 'E05').decisions, ['D-04']);
  assert.equal(
    parseDeps(' E12-R02, which settles which primitives', 'E12').notes.length,
    1,
  );
  assert.deepEqual(parseDeps(' —', 'E05').ids, []);
  assert.deepEqual(parseDeps(' the buckets from R01', 'E08').ids, ['E08-R01']);
});

test('parseHeaderDeps enforces plain groups and only notes conditional ones', () => {
  const header = parseHeaderDeps(
    'E05, E06-R02/R09, E12, E02-R07 (generated Dart client); E07 for push (Phase 4)',
    'E10',
  );
  assert.deepEqual(header.ids, ['E06-R02', 'E06-R09', 'E02-R07']);
  assert.deepEqual(header.epics, ['E05', 'E12']);
  assert.deepEqual(header.notes, ['conditional: E07 for push (Phase 4)']);
  const decisions = parseHeaderDeps(
    'E02-R03, E04-R01; D-02, D-05, D-18; D-04 for Phase 4',
    'E03',
  );
  assert.deepEqual(decisions.decisions, ['D-02', 'D-05', 'D-18', 'D-04']);
  assert.deepEqual(decisions.ids, ['E02-R03', 'E04-R01']);
});

test('parseDecisions marks only Pinned rows', () => {
  const table = [
    '| ID | Topic | Decision | Affects | Epics | Status |',
    '|---|---|---|---|---|---|',
    '| D-01 | Runtime | Node | API | E05 | **Pinned** 2026-10-04 |',
    '| D-02 | Server | SabreDAV | CalDAV | E03 | Open |',
    '| D-03 | IdP | Zitadel | auth | E02 | Proposed |',
  ].join('\n');
  const decisions = parseDecisions(table);
  assert.equal(decisions.get('D-01'), true);
  assert.equal(decisions.get('D-02'), false);
  assert.equal(decisions.get('D-03'), false);
  assert.equal(decisions.get('D-99'), undefined);
});

test('firstVerdict reads the newest section, which is on top', () => {
  assert.equal(
    firstVerdict('- **Verdict: PASS** (review 3)\n\n- Verdict: BLOCKED'),
    'PASS',
  );
  assert.equal(firstVerdict('# x\n- Verdict: BLOCKED (review 1)'), 'BLOCKED');
  assert.equal(firstVerdict('no verdict here'), null);
  assert.equal(firstVerdict(null), null);
});

const EPIC = `# E01 — Fixture

| | |
|---|---|
| Depends on | D-01 |

## Requirements

### E01-R01 · Base   \`agent\`
- Deps: —

### E01-R02 · Needs base   \`agent+review\`
- Deps: E01-R01.
- Notes: mentions D-02.

### E01-R03 · Both kinds of work (Phase 7)   \`human\` + \`agent\`

### E01-R04 · No tag
`;

test('parseEpic reads headings, tags, titles, decisions and Deps', () => {
  const epic = parseEpic(EPIC);
  assert.equal(epic.epicId, 'E01');
  assert.deepEqual(epic.deps.decisions, ['D-01']);
  assert.deepEqual(
    epic.requirements.map((r) => [r.id, r.executor, r.title]),
    [
      ['E01-R01', 'agent', 'Base'],
      ['E01-R02', 'agent+review', 'Needs base'],
      ['E01-R03', 'mixed', 'Both kinds of work (Phase 7)'],
      ['E01-R04', null, 'No tag'],
    ],
  );
  assert.deepEqual(epic.requirements[1].deps.ids, ['E01-R01']);
  assert.deepEqual(epic.requirements[1].decisions, ['D-02']);
});

const FOLLOW_UPS = `# Loop

## Queue

1. **E04 and E03** Phase 1: E04-R01 and E04-R02 (Done), E03-R08.
2. **E05**: R01 (\`agent+review\`), R02–R03, R08. R02 waits for the ADR.
3. **E15**: R01–R02.

## Follow-ups waiting for their requirement

- **E05-R03 and later:** a note.
- **E05-R03, E15-R01:** another.
`;

test('parseQueue lists candidates in order, per item, with later mentions', () => {
  const queue = parseQueue(FOLLOW_UPS);
  assert.deepEqual(queue.order, [
    'E04-R01',
    'E04-R02',
    'E03-R08',
    'E05-R01',
    'E05-R02',
    'E05-R03',
    'E05-R08',
    'E15-R01',
    'E15-R02',
  ]);
  assert.equal(queue.item.get('E05-R03'), 2);
  assert.equal(queue.item.get('E15-R02'), 3);
  assert.equal(queue.mentions.get('E05-R02')?.length, 1);
  assert.match(
    queue.mentions.get('E05-R02')?.[0] ?? '',
    /R02 waits for the ADR/,
  );
  assert.equal(queue.mentions.has('E05-R03'), false);
});

test('followUpCounts counts lines outside the queue only', () => {
  const counts = followUpCounts(FOLLOW_UPS);
  assert.equal(counts.get('E05-R03'), 2);
  assert.equal(counts.get('E15-R01'), 1);
  assert.equal(
    counts.get('E04-R01'),
    undefined,
    'the queue itself is not a follow-up',
  );
});

// --- the analysis, against real git repositories -------------------------------

const BACKLOG = `| ID | Topic | Decision | Status |
|---|---|---|---|
| D-01 | Runtime | Node | **Pinned** 2026-10-04 |
| D-02 | Server | SabreDAV | Open |
`;

const FIXTURE_EPIC = `# E01 — Fixture

| | |
|---|---|
| Depends on | D-01 |

## Requirements

### E01-R01 · Base   \`agent\`
- Deps: —

### E01-R02 · Needs base   \`agent\`
- Deps: E01-R01.

### E01-R03 · Needs the second   \`agent\`
- Deps: E01-R02.

### E01-R04 · Human task   \`human\`

### E01-R05 · Needs an open decision   \`agent\`
Follows D-02.
- Deps: E01-R01.

### E01-R06 · Alternatives   \`agent\`
- Deps: E01-R01; E01-R02.

### E01-R07 · Needs two siblings   \`agent\`
- Deps: E01-R01, E01-R08.

### E01-R08 · A sibling   \`agent\`
- Deps: —

### E01-R09 · Not in the queue   \`agent\`
- Deps: E01-R01.

### E01-R10 · Another root   \`agent\`
- Deps: —

### E01-R11 · Typo in Deps   \`agent\`
- Deps: E01-R99.
`;

const QUEUE = `# Loop

## Queue

1. **E01** The fixture: R01–R08, R10. R02 waits for the ADR.

## Follow-ups

- E01-R02: a note.
`;

/** @param {string} verdict */
const review = (verdict) =>
  `# Review\n\n- **Verdict: ${verdict}** (review 1)\n`;

/**
 * A throwaway repository with the fixture docs on main.
 * @param {(repo: ReturnType<typeof makeRepo>) => void} fn
 */
function withRepo(fn) {
  const repo = makeRepo();
  try {
    fn(repo);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'next-ready-'));
  /** @param {string[]} args */
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
    );
  /** @param {Record<string, string>} files @param {string} message */
  const commit = (files, message) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git('add', '-A');
    git('commit', '-q', '-m', message);
  };
  git('init', '-q', '-b', 'main');
  commit(
    {
      'docs/06-implementation-backlog.md': BACKLOG,
      'docs/epics/E01-fixture.md': FIXTURE_EPIC,
      'docs/reviews/follow-ups.md': QUEUE,
    },
    'fixture',
  );
  return {
    dir,
    git,
    commit,
    /** A branch off `from` with one commit. */
    branch(
      /** @type {string} */ name,
      /** @type {Record<string, string>} */ files,
      from = 'main',
    ) {
      git('switch', '-q', '-c', name, from);
      commit(files, `work on ${name}`);
      git('switch', '-q', 'main');
    },
    run(options = {}) {
      return analyze(gitSource(dir), { ref: 'main', ...options });
    },
  };
}

/** @param {ReturnType<typeof analyze>} result @param {string} id */
const row = (result, id) => {
  const found = result.rows.find((candidate) => candidate.id === id);
  assert.ok(found, `${id} is in the result`);
  return found;
};

test('nothing is Done on a fresh repository: the roots are ready, the rest explain why not', () => {
  withRepo((repo) => {
    const result = repo.run();
    assert.equal(row(result, 'E01-R01').status, 'ready');
    assert.equal(row(result, 'E01-R08').status, 'ready');
    assert.deepEqual(row(result, 'E01-R02').reasons, ['E01-R01 is open']);
    assert.equal(row(result, 'E01-R02').status, 'blocked');
    assert.equal(row(result, 'E01-R04').status, 'human');
    assert.deepEqual(row(result, 'E01-R05').reasons, [
      'D-02 is not Pinned',
      'E01-R01 is open',
    ]);
    assert.equal(row(result, 'E01-R06').status, 'blocked');
    assert.deepEqual(
      result.ready.map((r) => r.id),
      ['E01-R01', 'E01-R08', 'E01-R10'],
    );
    assert.equal(result.decision.action, 'start');
    assert.deepEqual(result.decision.ids, ['E01-R01', 'E01-R08'], 'two slots');
  });
});

test('a PASS review on main means Done; a BLOCKED one does not', () => {
  withRepo((repo) => {
    repo.commit({ 'docs/reviews/E01-R01.md': review('BLOCKED') }, 'review 1');
    assert.equal(row(repo.run(), 'E01-R01').status, 'ready');
    repo.commit(
      {
        'docs/reviews/E01-R01.md': `${review('PASS')}\n${review('BLOCKED')}`,
      },
      'review 2',
    );
    const result = repo.run();
    assert.equal(row(result, 'E01-R01').status, 'done');
    assert.equal(row(result, 'E01-R02').status, 'ready');
    assert.equal(row(result, 'E01-R03').status, 'blocked');
  });
});

test('a PASS review on an unmerged branch is awaiting a merge, and dependents stack on it', () => {
  withRepo((repo) => {
    repo.branch('feat/E01-R01-base', {
      'docs/reviews/E01-R01.md': review('PASS'),
    });
    const result = repo.run();
    assert.equal(row(result, 'E01-R01').status, 'passed');
    assert.deepEqual(
      result.awaitingMerge.map((r) => r.id),
      ['E01-R01'],
    );
    assert.equal(row(result, 'E01-R02').status, 'ready');
    assert.deepEqual(row(result, 'E01-R02').stackOn, ['feat/E01-R01-base']);
    assert.equal(
      row(result, 'E01-R03').status,
      'blocked',
      'R02 is not reviewed yet',
    );
  });
});

test("origin's copy of a branch counts, shown without the origin/ prefix", () => {
  withRepo((repo) => {
    repo.branch('feat/E01-R01-base', {
      'docs/reviews/E01-R01.md': review('PASS'),
    });
    repo.git(
      'update-ref',
      'refs/remotes/origin/feat/E01-R01-base',
      'feat/E01-R01-base',
    );
    repo.git('branch', '-q', '-D', 'feat/E01-R01-base');
    const result = repo.run();
    assert.equal(row(result, 'E01-R01').status, 'passed');
    assert.equal(row(result, 'E01-R01').branch, 'feat/E01-R01-base');
  });
});

test('a chain of branches that exist only on origin is still one stack', () => {
  withRepo((repo) => {
    repo.branch('feat/E01-R01-base', {
      'docs/reviews/E01-R01.md': review('PASS'),
    });
    repo.branch(
      'feat/E01-R08-sibling',
      { 'docs/reviews/E01-R08.md': review('PASS') },
      'feat/E01-R01-base',
    );
    for (const name of ['feat/E01-R01-base', 'feat/E01-R08-sibling']) {
      repo.git('update-ref', `refs/remotes/origin/${name}`, name);
      repo.git('branch', '-q', '-D', name);
    }
    // A fresh clone has only origin/feat/...; ancestry must use those real refs.
    const result = repo.run();
    assert.equal(row(result, 'E01-R07').status, 'ready');
    assert.deepEqual(row(result, 'E01-R07').stackOn, ['feat/E01-R08-sibling']);
  });
});

test('a squash-merged branch is Done even though the branch still looks unmerged', () => {
  withRepo((repo) => {
    repo.branch('feat/E01-R01-base', {
      'docs/reviews/E01-R01.md': review('PASS'),
    });
    // A squash merge puts the same files on main as a new commit; the branch is not an ancestor.
    repo.commit(
      { 'docs/reviews/E01-R01.md': review('PASS') },
      'squash of feat/E01-R01-base',
    );
    const result = repo.run();
    assert.equal(row(result, 'E01-R01').status, 'done');
    assert.deepEqual(result.awaitingMerge, []);
    // The premise: a squash leaves the branch looking unmerged.
    assert.throws(() =>
      repo.git('merge-base', '--is-ancestor', 'feat/E01-R01-base', 'main'),
    );
  });
});

test('a branch without a PASS is in progress and holds a slot', () => {
  withRepo((repo) => {
    repo.branch('feat/E01-R01-base', {
      'docs/reviews/E01-R01.md': review('BLOCKED'),
    });
    repo.branch('feat/E01-R08-sibling', { 'notes.txt': 'work in progress' });
    const result = repo.run({ maxParallel: 2 });
    assert.deepEqual(
      result.inProgress.map((r) => r.id),
      ['E01-R01', 'E01-R08'],
    );
    assert.equal(row(result, 'E01-R02').status, 'blocked');
    assert.deepEqual(row(result, 'E01-R02').reasons, [
      'E01-R01 is in-progress',
    ]);
    // R10 is ready, but both slots are taken.
    assert.deepEqual(
      result.ready.map((r) => r.id),
      ['E01-R10'],
    );
    assert.equal(result.decision.action, 'wait');
    assert.match(result.decision.reason, /2 implementers are already running/);
    assert.equal(repo.run({ maxParallel: 3 }).decision.action, 'start');
  });
});

test('the stack cap stops new work while PRs wait for the owner', () => {
  withRepo((repo) => {
    repo.branch('feat/E01-R01-base', {
      'docs/reviews/E01-R01.md': review('PASS'),
    });
    const open = repo.run({ maxStack: 3 });
    assert.equal(open.decision.action, 'start');
    const capped = repo.run({ maxStack: 1 });
    assert.equal(capped.decision.action, 'wait');
    assert.deepEqual(capped.decision.ids, []);
    assert.match(
      capped.decision.reason,
      /1 PRs await the owner's merge \(cap 1\)/,
    );
  });
});

test('slots and the cap limit how many requirements start at once', () => {
  withRepo((repo) => {
    repo.branch('feat/E01-R01-base', {
      'docs/reviews/E01-R01.md': review('PASS'),
    });
    // R02 (stacked on R01's branch), R08 and R10 are ready; room for one under cap 2.
    const result = repo.run({ maxStack: 2, maxParallel: 2 });
    assert.deepEqual(
      result.ready.map((r) => r.id),
      ['E01-R02', 'E01-R08', 'E01-R10'],
    );
    assert.deepEqual(result.decision.ids, ['E01-R02']);
  });
});

test('two unrelated unmerged dependency branches block; a chain of them is one stack', () => {
  withRepo((repo) => {
    repo.branch('feat/E01-R01-base', {
      'docs/reviews/E01-R01.md': review('PASS'),
    });
    repo.branch('feat/E01-R08-sibling', {
      'docs/reviews/E01-R08.md': review('PASS'),
    });
    const siblings = repo.run();
    assert.equal(row(siblings, 'E01-R07').status, 'blocked');
    assert.match(
      row(siblings, 'E01-R07').reasons.join(),
      /depends on 2 unmerged branches/,
    );

    repo.git('branch', '-q', '-D', 'feat/E01-R08-sibling');
    repo.branch(
      'feat/E01-R08-sibling',
      { 'docs/reviews/E01-R08.md': review('PASS') },
      'feat/E01-R01-base',
    );
    const chain = repo.run();
    assert.equal(row(chain, 'E01-R07').status, 'ready');
    assert.deepEqual(row(chain, 'E01-R07').stackOn, ['feat/E01-R08-sibling']);
  });
});

test('Deps that are alternatives need a human read; they are never guessed', () => {
  withRepo((repo) => {
    repo.commit(
      {
        'docs/reviews/E01-R01.md': review('PASS'),
        'docs/reviews/E01-R02.md': review('PASS'),
      },
      'two Done',
    );
    const result = repo.run();
    assert.equal(row(result, 'E01-R06').status, 'needs-judgment');
    assert.match(
      row(result, 'E01-R06').reasons.join(),
      /Deps need a human read/,
    );
    assert.deepEqual(
      result.judgment.map((r) => r.id),
      ['E01-R06'],
    );
    assert.equal(
      result.ready.some((r) => r.id === 'E01-R06'),
      false,
    );
  });
});

test('a Deps entry that names no requirement blocks instead of passing silently', () => {
  withRepo((repo) => {
    const result = repo.run();
    assert.equal(row(result, 'E01-R11').status, 'blocked');
    assert.deepEqual(row(result, 'E01-R11').reasons, [
      'E01-R99 is not a requirement in docs/epics',
    ]);
  });
});

test('only queued IDs are candidates; the rest are listed for the owner', () => {
  withRepo((repo) => {
    repo.commit({ 'docs/reviews/E01-R01.md': review('PASS') }, 'R01 Done');
    const result = repo.run();
    assert.equal(row(result, 'E01-R09').status, 'ready');
    assert.equal(row(result, 'E01-R09').queueItem, null);
    assert.deepEqual(
      result.readyUnqueued.map((r) => r.id),
      ['E01-R09'],
    );
    assert.equal(
      result.ready.some((r) => r.id === 'E01-R09'),
      false,
    );
  });
});

test('the queue prose around an ID and its follow-ups are shown with it', () => {
  withRepo((repo) => {
    repo.commit({ 'docs/reviews/E01-R01.md': review('PASS') }, 'R01 Done');
    const result = repo.run();
    const r02 = row(result, 'E01-R02');
    assert.equal(r02.followUps, 1);
    assert.match(r02.notes.join('\n'), /queue also says: …/);
    assert.match(r02.notes.join('\n'), /R02 waits for the ADR/);
    const text = format(result);
    assert.match(
      text,
      /E01-R02 {2}Needs base {2}\[agent\] {2}queue item 1 {2}follow-ups: 1\n/,
    );
    assert.match(text, /\* queue also says: …/);
    assert.match(text, /^NEXT: start E01-R02 E01-R08 /m);
  });
});

test('follow-ups in docs/reviews/follow-ups/ count like those in follow-ups.md', () => {
  withRepo((repo) => {
    repo.commit({ 'docs/reviews/E01-R01.md': review('PASS') }, 'R01 Done');
    const before = repo.run();
    assert.equal(row(before, 'E01-R02').followUps, 1);
    assert.equal(row(before, 'E01-R08').followUps, 0);
    repo.commit(
      {
        'docs/reviews/follow-ups/from-E01-R01.md':
          '- **E01-R02:** a note.\n- **E01-R02, E01-R08:** another.\n',
        // not Markdown: ignored
        'docs/reviews/follow-ups/scratch.txt': '- **E01-R08:** not counted.\n',
      },
      'follow-ups, one file per source',
    );
    const after = repo.run();
    assert.equal(row(after, 'E01-R02').followUps, 3);
    assert.equal(row(after, 'E01-R08').followUps, 1);
    assert.deepEqual(
      after.rows.map((r) => r.id),
      before.rows.map((r) => r.id),
      'a follow-ups file names requirements, but it is never a queue entry',
    );
  });
});

test('an unknown ref is an empty answer, not a crash', () => {
  withRepo((repo) => {
    const result = analyze(gitSource(repo.dir), { ref: 'no-such-ref' });
    assert.deepEqual(result.rows, []);
    assert.equal(result.decision.action, 'none');
  });
});
