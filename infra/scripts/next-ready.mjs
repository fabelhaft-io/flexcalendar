import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// `make next-ready`: which requirements can the orchestrator start now?
//
// Advisory, not an authority. It turns the questions the orchestrate skill asks by
// hand ("every Deps entry Done, every D-* Pinned") into a ranked list, so a loop
// does not re-read sixteen epics each time. Whatever it cannot classify with
// confidence it lists under "needs judgment" with the reason, and never guesses.
//
// Everything is read from one git ref (origin/main by default), not the working
// tree, so a worktree on a requirement branch gets the same answer as main.
//
//   candidates  the IDs named in docs/reviews/follow-ups.md § Queue, in order
//   Done        docs/reviews/<ID>.md on the ref, newest verdict PASS (a squash
//               merge leaves the branch looking unmerged; the review doc is what
//               lands on main)
//   awaiting    a feat/<ID>-* branch whose review doc says PASS, not Done yet:
//               an open PR waiting for the owner. Dependents may stack on it
//               (follow-ups.md § Queue), up to --max-stack of them
//   in progress a feat/<ID>-* branch without a PASS (a stale branch counts too)

const root = fileURLToPath(new URL('../..', import.meta.url));

const REF_RE =
  /(?<![\w-])(?:(E\d{2})-)?R(\d{2})(?:\s*(?:\.\.|–|—|-)\s*R?(\d{2}))?((?:\/R?\d{2})*)/g;
const EPIC_RE = /(?<![\w-])E(\d{2})(?![\w-])/g;
const DECISION_RE = /\bD-\d{2}\b/g;

/**
 * Each place `text` names requirements, with the IDs it names: `E04-R01`,
 * `E04-R03..R05`, `R02–R05` and `E06-R02/R09` (the short forms need `epicId`).
 * @param {string} text @param {string | null} epicId
 * @returns {{ index: number, ids: string[] }[]}
 */
function idMatches(text, epicId) {
  const found = [];
  for (const match of text.matchAll(REF_RE)) {
    const epic = match[1] ?? epicId;
    if (!epic) continue;
    const first = Number(match[2]);
    let last = match[3] ? Number(match[3]) : first;
    if (last < first || last - first > 30) last = first;
    const numbers = [];
    for (let n = first; n <= last; n++) numbers.push(n);
    for (const extra of match[4].matchAll(/\d{2}/g))
      numbers.push(Number(extra[0]));
    found.push({
      index: match.index,
      ids: numbers.map((n) => `${epic}-R${String(n).padStart(2, '0')}`),
    });
  }
  return found;
}

/**
 * Requirement IDs named in `text`, in order of first appearance.
 * @param {string} text @param {string | null} [epicId] @returns {string[]}
 */
export function expandIds(text, epicId = null) {
  return [...new Set(idMatches(text, epicId).flatMap((match) => match.ids))];
}

/** @param {string} text @param {string | null} epicId @returns {string[]} */
function bareEpics(text, epicId) {
  return [...text.matchAll(EPIC_RE)]
    .map((match) => `E${match[1]}`)
    .filter((epic) => epic !== epicId);
}

/**
 * A requirement's `- Deps:` text. A `;` or "or" means alternatives or groups the
 * text does not spell out, so it is `unclear` and left to a human. Prose around
 * the IDs becomes a note.
 * @param {string} raw @param {string} epicId
 */
export function parseDeps(raw, epicId) {
  const text = raw.trim();
  const plain = text.replace(/\([^)]*\)/g, ' ');
  const leftover = plain
    .replace(REF_RE, ' ')
    .replace(EPIC_RE, ' ')
    .replace(DECISION_RE, ' ')
    .replace(/\band\b/g, ' ')
    .replace(/[\s,.;/—-]+/g, ' ')
    .trim();
  return {
    ids: expandIds(plain, epicId),
    epics: bareEpics(plain, epicId),
    decisions: [...new Set(text.match(DECISION_RE) ?? [])],
    unclear: /;|\bor\b/i.test(plain) ? text : null,
    notes: leftover ? [`Deps text: ${text}`] : [],
  };
}

/**
 * An epic's "Depends on" cell. `;` separates groups here. A group that says
 * "for" or "Phase" is conditional, so it is noted, not enforced.
 * @param {string} cell @param {string} epicId
 */
export function parseHeaderDeps(cell, epicId) {
  /** @type {string[]} */ const ids = [];
  /** @type {string[]} */ const epics = [];
  /** @type {string[]} */ const notes = [];
  for (const segment of cell.split(';')) {
    const plain = segment.replace(/\([^)]*\)/g, ' ');
    const foundIds = expandIds(plain, null);
    const foundEpics = bareEpics(plain, epicId);
    if (/\bfor\b|\bPhase\b/i.test(segment)) {
      if (foundIds.length || foundEpics.length)
        notes.push(`conditional: ${segment.trim()}`);
      continue;
    }
    ids.push(...foundIds);
    epics.push(...foundEpics);
  }
  return {
    ids: [...new Set(ids)],
    epics: [...new Set(epics)],
    decisions: [...new Set(cell.match(DECISION_RE) ?? [])],
    notes,
  };
}

/**
 * `D-nn` → Pinned, from the decision table in docs/06.
 * @param {string} text @returns {Map<string, boolean>}
 */
export function parseDecisions(text) {
  const decisions = new Map();
  for (const line of text.split('\n')) {
    const row = /^\|\s*(D-\d{2})\s*\|(.*)\|\s*$/.exec(line);
    if (!row) continue;
    const status = row[2].split('|').pop() ?? '';
    decisions.set(row[1], /\bPinned\b/.test(status));
  }
  return decisions;
}

/**
 * The newest review verdict: a review doc has the newest section on top.
 * @param {string | null} text @returns {'PASS' | 'BLOCKED' | null}
 */
export function firstVerdict(text) {
  const match = /Verdict:\s*\**\s*(PASS|BLOCKED)/.exec(text ?? '');
  return match ? /** @type {'PASS' | 'BLOCKED'} */ (match[1]) : null;
}

/**
 * @typedef {object} Requirement
 * @property {string} id @property {string} epicId @property {string} title
 * @property {string | null} executor @property {string[]} decisions
 * @property {ReturnType<typeof parseDeps>} deps
 */

/** @param {string} text */
export function parseEpic(text) {
  const epicId = /^# (E\d{2})\b/m.exec(text)?.[1] ?? '';
  const cell = /^\|\s*Depends on\s*\|(.*)\|\s*$/m.exec(text)?.[1] ?? '';
  /** @type {Requirement[]} */ const requirements = [];
  for (const section of text.split(/^(?=### E\d{2}-R\d{2} · )/m)) {
    const heading = /^### (E\d{2}-R\d{2}) · (.*)$/m.exec(section);
    if (!heading || !section.startsWith('### ')) continue;
    const body = section.split(/^## /m)[0];
    const tags = [...heading[2].matchAll(/`(agent\+review|agent|human)`/g)].map(
      (match) => match[1],
    );
    // One tag is the executor; several (`human` + `agent`) is for a human to read.
    const executor = tags.length === 1 ? tags[0] : tags.length ? 'mixed' : null;
    const depsLine = /^- Deps:(.*(?:\n[ \t]+.*)*)/m.exec(body)?.[1] ?? '';
    requirements.push({
      id: heading[1],
      epicId,
      title: heading[2].replace(/(\s*`[^`]*`|\s*\+)+\s*$/, '').trim(),
      executor,
      decisions: [...new Set(body.match(DECISION_RE) ?? [])],
      deps: parseDeps(depsLine, epicId),
    });
  }
  return { epicId, deps: parseHeaderDeps(cell, epicId), requirements };
}

/**
 * The queue's candidate IDs in order, and each queue item's number. A short ID
 * (`R02–R05`) belongs to the epic when the item's bold title is exactly one.
 * `mentions` holds the text around every later mention of an ID in its item: the
 * queue's prose ("R02 waits for the ADR") is not something to parse, but the
 * reader must see it next to the ID.
 * @param {string} followUps
 * @returns {{ order: string[], item: Map<string, number>, mentions: Map<string, string[]> }}
 */
export function parseQueue(followUps) {
  const section = /^## Queue\s*$([\s\S]*?)(?=^## )/m.exec(followUps)?.[1] ?? '';
  const order = [];
  const item = new Map();
  /** @type {Map<string, string[]>} */ const mentions = new Map();
  for (const block of section.split(/^(?=\d+\. )/m)) {
    const head = /^(\d+)\. (.*)/.exec(block);
    if (!head) continue;
    const title = /\*\*(.+?)\*\*/.exec(head[2])?.[1] ?? '';
    const epicId = /^E\d{2}$/.test(title) ? title : null;
    /** @type {Set<string>} */ const seen = new Set();
    for (const { index, ids } of idMatches(block, epicId)) {
      for (const id of ids) {
        if (!item.has(id)) {
          item.set(id, Number(head[1]));
          order.push(id);
        }
        if (seen.has(id)) {
          const around = block
            .slice(Math.max(0, index - 100), index + 50)
            .replace(/\s+/g, ' ')
            .trim();
          mentions.set(id, [...(mentions.get(id) ?? []), `…${around}…`]);
        }
        seen.add(id);
      }
    }
  }
  return { order, item, mentions };
}

/**
 * How many lines of follow-ups.md outside the queue name each requirement: the
 * orchestrate skill's "brief before run 1" starts from them.
 * @param {string} followUps @returns {Map<string, number>}
 */
export function followUpCounts(followUps) {
  const rest = followUps.replace(/^## Queue\s*$[\s\S]*?(?=^## )/m, '');
  /** @type {Map<string, number>} */ const counts = new Map();
  for (const line of rest.split('\n'))
    for (const id of expandIds(line, null))
      counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

/**
 * Reads files and branches from a git ref.
 * @param {string} cwd
 */
export function gitSource(cwd) {
  /** @param {string[]} args */
  const git = (args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  return {
    /** @param {string} ref @param {string} path @returns {string | null} */
    read(ref, path) {
      try {
        return git(['show', `${ref}:${path}`]);
      } catch {
        return null;
      }
    },
    /** @param {string} ref @param {string} dir @returns {string[]} */
    list(ref, dir) {
      try {
        return git(['ls-tree', '--name-only', ref, `${dir}/`])
          .split('\n')
          .filter(Boolean);
      } catch {
        return [];
      }
    },
    /** Every feat/ branch, local and origin's. @returns {string[]} */
    branches() {
      return git([
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/heads/feat',
        'refs/remotes/origin/feat',
      ])
        .split('\n')
        .filter(Boolean);
    },
    /** @param {string} ancestor @param {string} descendant */
    isAncestor(ancestor, descendant) {
      try {
        git(['merge-base', '--is-ancestor', ancestor, descendant]);
        return true;
      } catch {
        return false;
      }
    },
    /** @param {string} ref @returns {string | null} */
    sha(ref) {
      try {
        return git([
          'rev-parse',
          '--short',
          '--verify',
          `${ref}^{commit}`,
        ]).trim();
      } catch {
        return null;
      }
    },
  };
}

/**
 * @param {ReturnType<typeof gitSource>} source
 * @param {{ ref: string, maxStack?: number, maxParallel?: number }} options
 */
export function analyze(source, { ref, maxStack = 3, maxParallel = 2 }) {
  const epics = source
    .list(ref, 'docs/epics')
    .filter((file) => /\/E\d{2}-.*\.md$/.test(file))
    .map((file) => parseEpic(source.read(ref, file) ?? ''));
  const decisions = parseDecisions(
    source.read(ref, 'docs/06-implementation-backlog.md') ?? '',
  );
  const followUps = source.read(ref, 'docs/reviews/follow-ups.md') ?? '';
  const queue = parseQueue(followUps);
  const followUpLines = followUpCounts(followUps);
  const reviewFiles = new Set(source.list(ref, 'docs/reviews'));

  /** @type {Map<string, string[]>} */ const branchesById = new Map();
  for (const name of source.branches()) {
    const id = /(?:^|\/)feat\/(E\d{2}-R\d{2})-/.exec(name)?.[1];
    if (id) branchesById.set(id, [...(branchesById.get(id) ?? []), name]);
  }

  /** `branch` is the name to show; `ref` is the real ref, which may exist only on origin.
   * @type {Map<string, { state: string, branch: string | null, ref: string | null }>} */
  const base = new Map();
  for (const epic of epics) {
    for (const requirement of epic.requirements) {
      const path = `docs/reviews/${requirement.id}.md`;
      const onMain = reviewFiles.has(path)
        ? firstVerdict(source.read(ref, path))
        : null;
      if (onMain === 'PASS') {
        base.set(requirement.id, { state: 'done', branch: null, ref: null });
        continue;
      }
      const refs = branchesById.get(requirement.id) ?? [];
      const passed = refs.find(
        (name) => firstVerdict(source.read(name, path)) === 'PASS',
      );
      const shown = (/** @type {string} */ name) =>
        name.replace(/^origin\//, '');
      if (passed)
        base.set(requirement.id, {
          state: 'passed',
          branch: shown(passed),
          ref: passed,
        });
      else if (refs.length)
        base.set(requirement.id, {
          state: 'in-progress',
          branch: shown(refs[0]),
          ref: refs[0],
        });
      else base.set(requirement.id, { state: 'open', branch: null, ref: null });
    }
  }

  const epicDone = (/** @type {string} */ epicId) => {
    const epic = epics.find((candidate) => candidate.epicId === epicId);
    return Boolean(
      epic?.requirements.length &&
      epic.requirements.every(
        (requirement) => base.get(requirement.id)?.state === 'done',
      ),
    );
  };

  /** @type {{ id: string, epicId: string, title: string, executor: string | null,
   *   status: string, branch: string | null, stackOn: string[], queueItem: number | null,
   *   followUps: number, reasons: string[], notes: string[] }[]} */
  const rows = [];
  for (const epic of epics) {
    for (const requirement of epic.requirements) {
      const own = /** @type {{ state: string, branch: string | null }} */ (
        base.get(requirement.id)
      );
      /** @type {string[]} */ const blockers = [];
      /** @type {string[]} */ const judgment = [];
      /** Unmerged dependency branches: shown name → real ref.
       * @type {Map<string, string>} */ const stack = new Map();
      let status = own.state;

      if (own.state === 'open') {
        if (requirement.executor === 'human') status = 'human';
        else {
          for (const decision of new Set([
            ...requirement.decisions,
            ...epic.deps.decisions,
          ]))
            if (decisions.get(decision) !== true)
              blockers.push(`${decision} is not Pinned`);
          /** @param {string} id @param {string[]} into */
          const need = (id, into) => {
            const dependency = base.get(id);
            if (!dependency)
              into.push(`${id} is not a requirement in docs/epics`);
            else if (
              dependency.state === 'passed' &&
              dependency.branch &&
              dependency.ref
            )
              stack.set(dependency.branch, dependency.ref);
            else if (dependency.state !== 'done')
              into.push(`${id} is ${dependency.state}`);
          };
          for (const id of requirement.deps.ids) need(id, blockers);
          for (const epicId of requirement.deps.epics)
            if (!epicDone(epicId))
              judgment.push(`${epicId} (whole epic) is not Done`);
          for (const id of epic.deps.ids) need(id, judgment);
          for (const epicId of epic.deps.epics)
            if (!epicDone(epicId))
              judgment.push(`${epicId} (whole epic) is not Done`);
          if (requirement.deps.unclear)
            judgment.push(
              `Deps need a human read: ${requirement.deps.unclear}`,
            );
          if (!requirement.executor)
            judgment.push('the heading has no executor tag');
          if (requirement.executor === 'mixed')
            judgment.push('the heading has several executor tags');
          // Branches that contain each other are one stack.
          const tips = [...stack.keys()].filter(
            (name) =>
              ![...stack.entries()].some(
                ([other, otherRef]) =>
                  other !== name &&
                  source.isAncestor(
                    /** @type {string} */ (stack.get(name)),
                    otherRef,
                  ),
              ),
          );
          if (tips.length > 1)
            blockers.push(
              `depends on ${tips.length} unmerged branches (${tips.join(', ')}); wait for a merge`,
            );
          status = blockers.length
            ? 'blocked'
            : judgment.length
              ? 'needs-judgment'
              : 'ready';
          stack.clear();
          for (const tip of tips) stack.set(tip, tip);
        }
      }
      rows.push({
        id: requirement.id,
        epicId: epic.epicId,
        title: requirement.title,
        executor: requirement.executor,
        status,
        branch: own.branch,
        stackOn: [...stack.keys()],
        queueItem: queue.item.get(requirement.id) ?? null,
        followUps: followUpLines.get(requirement.id) ?? 0,
        reasons: [...blockers, ...judgment],
        notes: [
          ...requirement.deps.notes,
          ...epic.deps.notes,
          ...(queue.mentions.get(requirement.id) ?? []).map(
            (mention) => `queue also says: ${mention}`,
          ),
        ],
      });
    }
  }

  const rank = new Map(queue.order.map((id, index) => [id, index]));
  const byRank = (
    /** @type {{id: string}} */ a,
    /** @type {{id: string}} */ b,
  ) =>
    (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9) ||
    a.id.localeCompare(b.id);
  const pick = (/** @type {string} */ status, queued = true) =>
    rows
      .filter(
        (row) => row.status === status && (row.queueItem !== null) === queued,
      )
      .sort(byRank);
  const awaitingMerge = pick('passed', true).concat(pick('passed', false));
  const inProgress = pick('in-progress', true).concat(
    pick('in-progress', false),
  );
  const ready = pick('ready');
  const slots = Math.max(0, maxParallel - inProgress.length);

  /** @type {{ action: 'start' | 'wait' | 'none', ids: string[], reason: string }} */
  let decision;
  if (awaitingMerge.length >= maxStack)
    decision = {
      action: 'wait',
      ids: [],
      reason: `${awaitingMerge.length} PRs await the owner's merge (cap ${maxStack}); do not start more.`,
    };
  else if (!ready.length)
    decision = {
      action: 'none',
      ids: [],
      reason: 'no queued requirement is ready; see needs judgment and blocked.',
    };
  else if (slots === 0)
    decision = {
      action: 'wait',
      ids: [],
      reason: `${inProgress.length} implementers are already running (max ${maxParallel}).`,
    };
  else
    decision = {
      action: 'start',
      ids: ready
        .slice(0, Math.min(slots, maxStack - awaitingMerge.length))
        .map((row) => row.id),
      reason: 'ready, in queue order',
    };

  return {
    ref,
    sha: source.sha(ref),
    maxStack,
    maxParallel,
    rows,
    awaitingMerge,
    inProgress,
    ready,
    readyUnqueued: pick('ready', false),
    judgment: pick('needs-judgment'),
    blocked: pick('blocked'),
    decision,
  };
}

/** @param {ReturnType<typeof analyze>} result @param {{ all?: boolean }} [options] */
export function format(result, { all = false } = {}) {
  /** @param {ReturnType<typeof analyze>['rows']} rows @param {boolean} [why] */
  const lines = (rows, why = false) =>
    rows.length
      ? rows.flatMap((row) => [
          `  ${row.id}  ${row.title}${row.executor ? `  [${row.executor}]` : ''}${
            row.stackOn.length ? `  stack on ${row.stackOn.join(', ')}` : ''
          }${row.branch ? `  (${row.branch})` : ''}${
            row.queueItem ? `  queue item ${row.queueItem}` : ''
          }${row.followUps ? `  follow-ups: ${row.followUps}` : ''}`,
          ...(why ? row.reasons.map((reason) => `      - ${reason}`) : []),
          ...row.notes.map((note) => `      * ${note}`),
        ])
      : ['  none'];
  const out = [
    `next-ready @ ${result.ref} (${result.sha ?? 'unknown'}); candidates: docs/reviews/follow-ups.md § Queue`,
    '',
    `Awaiting the owner's merge (${result.awaitingMerge.length} of max ${result.maxStack}):`,
    ...lines(result.awaitingMerge),
    '',
    `In progress (${result.inProgress.length}, max ${result.maxParallel} at once; a stale feat/ branch counts, check git worktree list):`,
    ...lines(result.inProgress),
    '',
    'Ready, in queue order:',
    ...lines(result.ready),
    '',
    'Needs judgment (queued):',
    ...lines(result.judgment, true),
  ];
  if (result.readyUnqueued.length)
    out.push(
      '',
      'Ready but not named in the queue (the owner decides):',
      ...lines(result.readyUnqueued),
    );
  if (all) out.push('', 'Blocked (queued):', ...lines(result.blocked, true));
  out.push(
    '',
    "The queue item's own notes are prose this script does not read: read them before you start.",
    `NEXT: ${result.decision.action}${result.decision.ids.length ? ` ${result.decision.ids.join(' ')}` : ''} (${result.decision.reason})`,
  );
  return out.join('\n');
}

/** @param {string[]} argv @param {(text: string) => void} print @returns {number} */
export function main(argv = process.argv.slice(2), print = console.log) {
  const { values } = parseArgs({
    args: argv,
    options: {
      ref: { type: 'string' },
      'max-stack': { type: 'string', default: '3' },
      'max-parallel': { type: 'string', default: '2' },
      json: { type: 'boolean', default: false },
      next: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      explain: { type: 'string' },
    },
  });
  const source = gitSource(root);
  const ref =
    values.ref ??
    ['origin/main', 'main', 'HEAD'].find((candidate) =>
      source.sha(candidate),
    ) ??
    'HEAD';
  const result = analyze(source, {
    ref,
    maxStack: Number(values['max-stack']),
    maxParallel: Number(values['max-parallel']),
  });
  if (values.explain) {
    const row = result.rows.find(
      (candidate) => candidate.id === values.explain,
    );
    print(
      row
        ? JSON.stringify(row, null, 2)
        : `${values.explain} is not a requirement`,
    );
    return row ? 0 : 1;
  }
  if (values.next) {
    if (result.decision.action !== 'start') return 1;
    print(result.decision.ids.join(' '));
    return 0;
  }
  print(
    values.json
      ? JSON.stringify(result, null, 2)
      : format(result, { all: values.all }),
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main();
