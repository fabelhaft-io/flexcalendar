// E15-R02: the DST table's validator and its independent oracle.
//
// `make verify-corpus` runs this (registered in
// `infra/scripts/verify/corpus/E15-R02.json`). It reads
// `spec/ical-fixtures/dst/cases.json`, checks its shape and its coverage, and
// re-derives every expected instant from Node's own zone database (ICU, through
// `Intl.DateTimeFormat`) applying the RFC 5545 rules by hand. It never imports
// `ical.js` or `sabre/vobject`: this requirement owns the table, not a runner of
// any engine, so the oracle must be able to disagree with every engine.
//
// What it refuses:
//
// - a table that is not one case list of engine-neutral facts (unknown key,
//   unknown kind, unknown zone, malformed local time or UTC instant, duplicate
//   id, missing `rfc` citation);
// - a table that stops covering a zone, a year, a kind or a transition day:
//   coverage is derived from the transition facts declared below, which are
//   themselves checked against ICU, so deleting a case to make the gate quiet
//   fails instead;
// - any expected instant that is not the one ICU's offsets plus the RFC rules
//   produce, reported with the case id and both instants;
// - a case whose kind its own zone contradicts (a "skipped" time that exists, a
//   "control" whose zone transitions that day, a cross-zone case where both or
//   neither zone switched).
//
// The table is authored from the tz database and the RFC, never emitted from
// this file: the oracle exists to disagree with it, not to generate it.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root. */
export const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** The DST table. */
export const tablePath = join(root, 'spec/ical-fixtures/dst/cases.json');

/** The zones the requirement names, in its order. */
export const ZONES = [
  'Europe/Berlin',
  'America/New_York',
  'America/Sao_Paulo',
  'Australia/Sydney',
  'Asia/Kolkata',
  'Pacific/Chatham',
];

/** The years the requirement names. */
export const YEARS = ['2026', '2027'];

/** The two transition slots of a zone-year. */
export const SLOTS = /** @type {Array<'spring' | 'fall'>} */ ([
  'spring',
  'fall',
]);

/** The case kinds, one per RFC rule the table exercises. */
export const KINDS = [
  'skipped',
  'repeated',
  'daily-existing',
  'daily-skipped',
  'all-day',
  'view-zone',
  'control',
];

/**
 * Where each zone was before the table was written: the local date of every
 * transition in 2026 and 2027, read from the IANA tz database with
 * `zdump -v -c 2026,2029 <zone>`. `spring` is the date the offset increases
 * (the gap), `fall` the date it decreases (the repeated hour); zones that do not
 * appear here have no transition at all and their cases are controls.
 *
 * These are declared facts, not derived from the table: `factProblems()` checks
 * every one of them against ICU, so a stale entry fails the gate instead of
 * quietly shrinking coverage. `spec/ical-fixtures/dst/README.md` records how
 * each date was read.
 *
 * @type {Record<string, Record<string, {spring: string, fall: string}>>}
 */
export const TRANSITIONS = {
  'Europe/Berlin': {
    2026: { spring: '20260329', fall: '20261025' },
    2027: { spring: '20270328', fall: '20271031' },
  },
  'America/New_York': {
    2026: { spring: '20260308', fall: '20261101' },
    2027: { spring: '20270314', fall: '20271107' },
  },
  'Australia/Sydney': {
    2026: { spring: '20261004', fall: '20260405' },
    2027: { spring: '20271003', fall: '20270404' },
  },
  'Pacific/Chatham': {
    2026: { spring: '20260927', fall: '20260405' },
    2027: { spring: '20270926', fall: '20270404' },
  },
};

/**
 * The control zones and the dates a client is most likely to shift them on by
 * mistake. `America/Sao_Paulo` has had no DST since 2019; its dates are the
 * rule Brazil used before then (the first Sunday of November, the third Sunday
 * of February). `Asia/Kolkata` has one offset all year (+05:30); its dates are
 * `Europe/Berlin`'s, the northern-hemisphere rule a client would apply to it by
 * mistake. Both are checked against their derivation in `factProblems()`.
 *
 * @type {Record<string, Record<string, {spring: string, fall: string}>>}
 */
export const CONTROL_DATES = {
  'America/Sao_Paulo': {
    2026: { spring: '20261101', fall: '20260215' },
    2027: { spring: '20271107', fall: '20270221' },
  },
  'Asia/Kolkata': {
    2026: { spring: '20260329', fall: '20261025' },
    2027: { spring: '20270328', fall: '20271031' },
  },
};

/** The zone a control case is viewed from (one that does switch that day). */
export const CONTROL_PARTNER = {
  'America/Sao_Paulo': 'America/New_York',
  'Asia/Kolkata': 'Europe/Berlin',
};

const LOCAL_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/;
const INSTANT_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RFC_RE = /^RFC 5545 § \d+(?:\.\d+)*$/;
const KEYS = ['id', 'zone', 'kind', 'input', 'expected', 'rfc'];

/**
 * @typedef {object} CaseInput
 * @property {string} [dtstart] Local wall time, `YYYYMMDDTHHMMSS`.
 * @property {string} [date] Calendar date, `YYYYMMDD`.
 * @property {string} [viewZone] IANA zone the case is viewed from.
 * @property {{freq: string, count: number}} [rrule]
 */

/**
 * @typedef {object} TableCase
 * @property {string} id
 * @property {string} zone
 * @property {string} kind
 * @property {CaseInput} input
 * @property {string[]} expected
 * @property {{section: string, rule: string}} rfc
 */

/**
 * @typedef {object} Resolution
 * @property {'normal' | 'gap' | 'ambiguous'} kind
 * @property {number} instant Epoch seconds; for a gap, the RFC 5545 form-3 reading.
 * @property {number[]} candidates Every instant whose local time is `localEpoch`.
 */

// --- ICU offset arithmetic ---------------------------------------------------

/** @type {Map<string, Intl.DateTimeFormat>} */
const FORMATTERS = new Map();

/** @param {string} zone @returns {Intl.DateTimeFormat} */
function formatter(zone) {
  let found = FORMATTERS.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTERS.set(zone, found);
  }
  return found;
}

/** @param {string | undefined} zone @returns {boolean} */
export function isKnownZone(zone) {
  if (typeof zone !== 'string' || zone.length === 0) return false;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/**
 * UTC seconds -> the same reading as if the zone's wall clock were UTC.
 * @param {string} zone @param {number} epochSeconds @returns {number}
 */
export function localOf(zone, epochSeconds) {
  /** @type {Record<string, string>} */
  const parts = {};
  for (const part of formatter(zone).formatToParts(
    new Date(epochSeconds * 1000),
  ))
    parts[part.type] = part.value;
  const seconds = utcSeconds(
    Number(parts.year),
    Number(parts.month),
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  if (seconds === null)
    throw new Error(
      `the zone database returned an unusable reading for ${zone}`,
    );
  return seconds;
}

/**
 * The zone's offset in seconds at a UTC instant.
 * @param {string} zone @param {number} epochSeconds @returns {number}
 */
export function offsetOf(zone, epochSeconds) {
  return localOf(zone, epochSeconds) - epochSeconds;
}

/**
 * RFC 5545 § 3.3.5 form 3: the instant a wall-clock reading names. A reading
 * that occurs more than once is the first occurrence; one that does not occur
 * is read with the offset before the gap.
 * @param {string} zone @param {number} localEpoch @returns {Resolution}
 */
export function resolveLocal(zone, localEpoch) {
  /** @type {Set<number>} */
  const offsets = new Set();
  for (const days of [-3, -1, 0, 1, 3])
    offsets.add(offsetOf(zone, localEpoch + days * 86400));
  /** @type {number[]} */
  const candidates = [];
  for (const offset of offsets) {
    const candidate = localEpoch - offset;
    if (
      localOf(zone, candidate) === localEpoch &&
      !candidates.includes(candidate)
    )
      candidates.push(candidate);
  }
  candidates.sort((left, right) => left - right);
  if (candidates.length === 1)
    return { kind: 'normal', instant: candidates[0], candidates };
  if (candidates.length > 1)
    return { kind: 'ambiguous', instant: candidates[0], candidates };
  return {
    kind: 'gap',
    instant: localEpoch - Math.min(...offsets),
    candidates,
  };
}

/**
 * The local dates of a zone's transitions in one year, scanned from ICU. The
 * offset at each local noon is compared with the day before, so this is derived
 * from the zone database rather than from the table or from `TRANSITIONS`.
 * @param {string} zone @param {number} year
 * @returns {{spring: string | null, fall: string | null}}
 */
export function transitionsInYear(zone, year) {
  /** @type {{spring: string | null, fall: string | null}} */
  const found = { spring: null, fall: null };
  let previous = null;
  for (let month = 1; month <= 12; month += 1)
    for (let day = 1; day <= daysInMonth(year, month); day += 1) {
      const noonLocal = utcSeconds(year, month, day, 12, 0, 0);
      if (noonLocal === null) continue;
      const noon = resolveLocal(zone, noonLocal);
      const offset = offsetOf(zone, noon.instant);
      if (previous !== null && offset !== previous)
        found[offset > previous ? 'spring' : 'fall'] = formatDate(
          year,
          month,
          day,
        );
      previous = offset;
    }
  return found;
}

/** @type {Map<string, {spring: string | null, fall: string | null}>} */
const TRANSITION_CACHE = new Map();

/**
 * @param {string} zone @param {string} date `YYYYMMDD`
 * @returns {boolean} Whether the zone switches offset on that local date.
 */
export function transitionsOn(zone, date) {
  if (!isKnownZone(zone)) return false;
  const year = Number(date.slice(0, 4));
  const key = `${zone}|${year}`;
  let found = TRANSITION_CACHE.get(key);
  if (!found) {
    found = transitionsInYear(zone, year);
    TRANSITION_CACHE.set(key, found);
  }
  return found.spring === date || found.fall === date;
}

// --- small calendar helpers --------------------------------------------------

/** @param {number} year @param {number} month @returns {number} */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * @param {number} year @param {number} month @param {number} day
 * @param {number} hour @param {number} minute @param {number} second
 * @returns {number | null} Epoch seconds, or null when the fields are not a date.
 */
function utcSeconds(year, month, day, hour, minute, second) {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(ms);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return ms / 1000;
}

/** @param {string | undefined} text @returns {number | null} */
export function instantSeconds(text) {
  const match = typeof text === 'string' ? INSTANT_RE.exec(text) : null;
  if (!match) return null;
  return utcSeconds(
    .../** @type {[number, number, number, number, number, number]} */ (
      match.slice(1).map(Number)
    ),
  );
}

/** @param {string | undefined} text @returns {number | null} */
export function localSeconds(text) {
  const match = typeof text === 'string' ? LOCAL_RE.exec(text) : null;
  if (!match) return null;
  return utcSeconds(
    .../** @type {[number, number, number, number, number, number]} */ (
      match.slice(1).map(Number)
    ),
  );
}

/** @param {string | undefined} text @returns {number | null} */
function parseDate(text) {
  const match = typeof text === 'string' ? DATE_RE.exec(text) : null;
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  return utcSeconds(year, month, day, 0, 0, 0) === null
    ? null
    : year * 10000 + month * 100 + day;
}

/** @param {number} epochSeconds @returns {string} `YYYYMMDDTHHMMSSZ` */
export function formatInstant(epochSeconds) {
  return new Date(epochSeconds * 1000)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/** @param {number} epochSeconds @returns {string} `YYYYMMDDTHHMMSS` (wall clock) */
function formatWallClock(epochSeconds) {
  return new Date(epochSeconds * 1000)
    .toISOString()
    .replace(/[-:]/g, '')
    .slice(0, 15);
}

/** @param {number} year @param {number} month @param {number} day @returns {string} */
function formatDate(year, month, day) {
  return `${String(year).padStart(4, '0')}${String(month).padStart(2, '0')}${String(
    day,
  ).padStart(2, '0')}`;
}

// --- the table ---------------------------------------------------------------

/**
 * Reads the committed table. Throws when it cannot be read or parsed.
 * @param {string} [path]
 * @returns {TableCase[]}
 */
export function loadTable(path = tablePath) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, { encoding: 'utf8' }));
  } catch (failure) {
    throw new Error(
      `cannot read ${path}: ${failure instanceof Error ? failure.message : 'unknown error'}`,
      { cause: failure },
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('the table must be a JSON object with a `cases` array');
  const cases = /** @type {{cases?: unknown}} */ (parsed).cases;
  if (!Array.isArray(cases))
    throw new Error('the table must be a JSON object with a `cases` array');
  return /** @type {TableCase[]} */ (cases);
}

/**
 * One case's local date (`YYYYMMDD`), from `input.dtstart` or `input.date`.
 * @param {TableCase} item @returns {string}
 */
function caseDate(item) {
  const input = item.input ?? {};
  if (typeof input.dtstart === 'string') return input.dtstart.slice(0, 8);
  if (typeof input.date === 'string') return input.date;
  return '';
}

/**
 * Every local date the case's expected instants fall on, rendered in its zone.
 * Used to require that a recurrence really spans the transition day.
 * @param {TableCase} item @returns {string[]}
 */
function localDatesOf(item) {
  /** @type {string[]} */
  const dates = [];
  for (const instant of item.expected ?? []) {
    const seconds = instantSeconds(instant);
    if (seconds === null) continue;
    dates.push(formatWallClock(localOf(item.zone, seconds)).slice(0, 8));
  }
  return dates;
}

/** @param {TableCase} item @param {string} date @returns {boolean} */
function spans(item, date) {
  const dates = localDatesOf(item);
  return (
    dates.some((value) => value < date) && dates.some((value) => value > date)
  );
}

// --- shape -------------------------------------------------------------------

/**
 * @param {TableCase[]} cases
 * @returns {string[]} One line per problem; empty means the shape is sound.
 */
export function shapeProblems(cases) {
  /** @type {string[]} */
  const problems = [];
  if (!Array.isArray(cases)) return ['the table must be an array of cases'];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const [index, item] of cases.entries()) {
    const at = `case #${index + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      problems.push(`${at}: not an object`);
      continue;
    }
    const id = typeof item.id === 'string' ? item.id : null;
    const label = id ?? at;
    if (!id || !ID_RE.test(id))
      problems.push(`${at}: id must be a lowercase slug`);
    else if (seen.has(id)) problems.push(`${label}: duplicate id`);
    else seen.add(id);
    for (const key of Object.keys(item))
      if (!KEYS.includes(key)) problems.push(`${label}: unknown key ${key}`);
    if (!ZONES.includes(item.zone))
      problems.push(`${label}: unknown zone ${item.zone}`);
    if (!KINDS.includes(item.kind))
      problems.push(`${label}: unknown kind ${item.kind}`);
    const input = item.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      problems.push(`${label}: input must be an object`);
    } else {
      for (const key of Object.keys(input))
        if (!['dtstart', 'date', 'viewZone', 'rrule'].includes(key))
          problems.push(`${label}: unknown input key ${key}`);
      const timed = ['skipped', 'repeated', 'control', 'view-zone'];
      if (timed.includes(item.kind) || item.kind.startsWith('daily-')) {
        if (localSeconds(input.dtstart) === null)
          problems.push(`${label}: input.dtstart must be a real local time`);
        if (input.date !== undefined)
          problems.push(`${label}: a timed case must not carry input.date`);
      } else if (item.kind === 'all-day' && parseDate(input.date) === null)
        problems.push(`${label}: input.date must be a real calendar date`);
      if (['daily-existing', 'daily-skipped'].includes(item.kind)) {
        const rule = input.rrule;
        if (
          !rule ||
          typeof rule !== 'object' ||
          rule.freq !== 'DAILY' ||
          !Number.isInteger(rule.count) ||
          rule.count < 1
        )
          problems.push(
            `${label}: input.rrule must be FREQ=DAILY with a positive COUNT`,
          );
      } else if (input.rrule !== undefined)
        problems.push(`${label}: only a daily case may carry input.rrule`);
      if (['all-day', 'view-zone'].includes(item.kind)) {
        if (!isKnownZone(input.viewZone))
          problems.push(`${label}: input.viewZone must be an IANA zone`);
      } else if (input.viewZone !== undefined)
        problems.push(
          `${label}: only an all-day or view-zone case may carry input.viewZone`,
        );
    }
    if (!Array.isArray(item.expected) || item.expected.length === 0)
      problems.push(`${label}: expected must be a nonempty array`);
    else
      for (const value of item.expected)
        if (instantSeconds(value) === null)
          problems.push(
            `${label}: expected ${value} is not a real UTC instant`,
          );
    const rfc = item.rfc;
    if (!rfc || typeof rfc !== 'object')
      problems.push(`${label}: rfc must cite the RFC 5545 rule`);
    else {
      if (typeof rfc.section !== 'string' || !RFC_RE.test(rfc.section))
        problems.push(`${label}: rfc.section must name an RFC 5545 section`);
      if (typeof rfc.rule !== 'string' || rfc.rule.trim().length < 20)
        problems.push(`${label}: rfc.rule must paraphrase the rule`);
    }
  }
  return problems;
}

// --- coverage ----------------------------------------------------------------

/**
 * @param {TableCase[]} cases
 * @param {{transitions?: typeof TRANSITIONS, controlDates?: typeof CONTROL_DATES}} [facts]
 * @returns {string[]}
 */
export function coverageProblems(cases, facts = {}) {
  const transitions = facts.transitions ?? TRANSITIONS;
  const controls = facts.controlDates ?? CONTROL_DATES;
  /** @type {string[]} */
  const problems = [];
  if (!Array.isArray(cases)) return ['the table must be an array of cases'];
  /** @type {Map<string, TableCase[]>} */
  const groups = new Map();
  for (const item of cases) {
    if (!item || typeof item !== 'object') continue;
    const year = caseDate(item).slice(0, 4);
    const key = `${item.zone}|${year}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  for (const key of groups.keys()) {
    const [zone, year] = key.split('|');
    if (!ZONES.includes(zone))
      problems.push(`${key}: zone is not part of the DST table`);
    if (!YEARS.includes(year))
      problems.push(`${key}: year is not part of the DST table`);
  }
  for (const zone of ZONES)
    for (const year of YEARS) {
      const key = `${zone}|${year}`;
      const group = groups.get(key) ?? [];
      const declared =
        transitions[zone]?.[year] ?? controls[zone]?.[year] ?? null;
      if (!declared) {
        problems.push(`${key}: no transition facts and no control dates`);
        continue;
      }
      for (const slot of SLOTS) {
        const date = declared[slot];
        const single = transitions[zone]
          ? slot === 'spring'
            ? 'skipped'
            : 'repeated'
          : 'control';
        if (
          !group.some((item) => item.kind === single && caseDate(item) === date)
        )
          problems.push(
            `${key}: no ${single} case on the ${slot} date ${date}`,
          );
        if (
          !group.some(
            (item) => item.kind === 'daily-existing' && spans(item, date),
          )
        )
          problems.push(
            `${key}: no daily-existing case spanning the ${slot} date ${date}`,
          );
        if (
          !group.some(
            (item) =>
              item.kind === 'all-day' &&
              item.input.date === date &&
              item.input.viewZone === zone,
          )
        )
          problems.push(
            `${key}: no all-day case on the ${slot} date ${date} in ${zone}`,
          );
      }
      if (transitions[zone]) {
        const spring = declared.spring;
        if (
          !group.some(
            (item) => item.kind === 'daily-skipped' && spans(item, spring),
          )
        )
          problems.push(
            `${key}: no daily-skipped case spanning the spring date ${spring}`,
          );
      }
      if (!group.some((item) => item.kind === 'view-zone'))
        problems.push(`${key}: no case viewed from another zone`);
      if (
        !group.some(
          (item) => item.kind === 'view-zone' && item.input.viewZone !== zone,
        )
      )
        problems.push(`${key}: the view-zone case must name a different zone`);
    }
  return problems;
}

/**
 * Checks the declared transition facts against ICU and against the way the
 * README derives them, so coverage cannot be shrunk by editing a fact.
 * @param {{transitions?: typeof TRANSITIONS, controlDates?: typeof CONTROL_DATES}} [facts]
 * @returns {string[]}
 */
export function factProblems(facts = {}) {
  const transitions = facts.transitions ?? TRANSITIONS;
  const controls = facts.controlDates ?? CONTROL_DATES;
  /** @type {string[]} */
  const problems = [];
  for (const zone of ZONES)
    for (const year of YEARS) {
      const scanned = transitionsInYear(zone, Number(year));
      const declared = transitions[zone]?.[year] ?? null;
      if (!declared) {
        if (scanned.spring || scanned.fall)
          problems.push(
            `${zone} ${year}: declared a control zone but ICU shows spring ${scanned.spring} / fall ${scanned.fall}`,
          );
        if (!controls[zone]?.[year])
          problems.push(
            `${zone} ${year}: neither a transition nor a control date is declared`,
          );
      } else {
        for (const slot of SLOTS)
          if (scanned[slot] !== declared[slot])
            problems.push(
              `${zone} ${year}: declared ${slot} ${declared[slot]} but ICU shows ${scanned[slot]}`,
            );
      }
    }
  const saoPaulo = controls['America/Sao_Paulo'];
  if (saoPaulo)
    for (const year of YEARS.map(Number))
      for (const [
        slot,
        week,
        month,
      ] of /** @type {[('spring' | 'fall'), number, number][]} */ ([
        ['spring', 1, 11],
        ['fall', 3, 2],
      ]))
        if (saoPaulo[year]?.[slot] !== nthSunday(year, month, week))
          problems.push(
            `America/Sao_Paulo ${year}: ${slot} ${saoPaulo[year]?.[slot]} is not the ${week === 1 ? 'first' : 'third'} Sunday`,
          );
  const kolkata = controls['Asia/Kolkata'];
  if (kolkata)
    for (const year of YEARS)
      for (const slot of SLOTS)
        if (
          kolkata[year]?.[slot] !== TRANSITIONS['Europe/Berlin']?.[year]?.[slot]
        )
          problems.push(
            `Asia/Kolkata ${year}: ${slot} ${kolkata[year]?.[slot]} is not Europe/Berlin's ${slot} date`,
          );
  return problems;
}

/** @param {number} year @param {number} month @param {number} week @returns {string} */
function nthSunday(year, month, week) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (7 - first.getUTCDay()) % 7;
  return formatDate(year, month, 1 + offset + (week - 1) * 7);
}

// --- the oracle --------------------------------------------------------------

/**
 * Daily instances from a local start, `count` of them, each keeping the wall
 * clock of `DTSTART`. A local time that does not exist produces no instance and
 * does not spend one of `count` (RFC 5545 § 3.3.10), except for `daily-existing`
 * where the wall clock exists every day and a gap is a table error.
 * @param {string} zone @param {number} localStart @param {number} count
 * @param {boolean} dropGaps
 * @returns {{instants: string[], gap: string | null}}
 */
function dailyInstances(zone, localStart, count, dropGaps) {
  /** @type {string[]} */
  const instants = [];
  for (let day = 0; instants.length < count && day < 400; day += 1) {
    const local = localStart + day * 86400;
    const resolved = resolveLocal(zone, local);
    if (resolved.kind === 'gap') {
      if (!dropGaps) return { instants, gap: formatWallClock(local) };
      continue;
    }
    instants.push(formatInstant(resolved.instant));
  }
  return { instants, gap: null };
}

/**
 * Re-derives every expected instant from ICU plus the RFC rules, and checks
 * that each case's kind is true of its own zone.
 * @param {TableCase[]} cases
 * @returns {string[]} One line per disagreement or contradiction; empty is a pass.
 */
export function oracleProblems(cases) {
  /** @type {string[]} */
  const problems = [];
  if (!Array.isArray(cases)) return ['the table must be an array of cases'];
  for (const item of cases) {
    if (!item || typeof item !== 'object') continue;
    const label = typeof item.id === 'string' ? item.id : 'unnamed case';
    const { zone, kind, input } = item;
    if (!ZONES.includes(zone) || !KINDS.includes(kind) || !input) continue;
    /** @type {string[] | null} */
    let computed = null;
    if (['skipped', 'repeated', 'control', 'view-zone'].includes(kind)) {
      const local = localSeconds(input.dtstart);
      if (local === null) continue;
      const resolved = resolveLocal(zone, local);
      /** @type {Record<string, string>} */
      const expectedKind = {
        skipped: 'gap',
        repeated: 'ambiguous',
        control: 'normal',
      };
      const wanted = expectedKind[kind];
      if (wanted && resolved.kind !== wanted)
        problems.push(
          `${label}: ${input.dtstart} is a ${resolved.kind} local time in ${zone}, not ${wanted}`,
        );
      if (kind === 'control' && transitionsOn(zone, caseDate(item)))
        problems.push(
          `${label}: ${zone} transitions on ${caseDate(item)}, so it is no control`,
        );
      computed = [formatInstant(resolved.instant)];
    } else if (['daily-existing', 'daily-skipped'].includes(kind)) {
      const local = localSeconds(input.dtstart);
      const rule = input.rrule;
      if (local === null || !rule) continue;
      const series = dailyInstances(
        zone,
        local,
        rule.count,
        kind === 'daily-skipped',
      );
      if (series.gap)
        problems.push(`${label}: ${series.gap} does not exist in ${zone}`);
      computed = series.instants;
    } else if (kind === 'all-day') {
      const date = input.date;
      const viewZone = input.viewZone;
      if (typeof date !== 'string' || typeof viewZone !== 'string') continue;
      const start = utcSeconds(
        Number(date.slice(0, 4)),
        Number(date.slice(4, 6)),
        Number(date.slice(6, 8)),
        0,
        0,
        0,
      );
      if (start === null) continue;
      computed = [
        formatInstant(resolveLocal(viewZone, start).instant),
        formatInstant(resolveLocal(viewZone, start + 86400).instant),
      ];
    }
    if (computed && item.expected)
      if (computed.join(',') !== item.expected.join(','))
        problems.push(
          `${label}: expected ${item.expected.join(' ')} but ICU and the RFC give ${computed.join(' ')}`,
        );
    const viewZone = input.viewZone;
    if (
      typeof viewZone === 'string' &&
      viewZone !== zone &&
      (kind === 'view-zone' || kind === 'all-day')
    ) {
      const date = caseDate(item);
      const here = transitionsOn(zone, date);
      const there = transitionsOn(viewZone, date);
      if (here === there)
        problems.push(
          `${label}: ${here ? 'both' : 'neither'} ${zone} nor ${viewZone} switches on ${date}, so the case tests nothing`,
        );
    }
  }
  return problems;
}

// --- entry point -------------------------------------------------------------

/**
 * @param {TableCase[]} [cases]
 * @param {{transitions?: typeof TRANSITIONS, controlDates?: typeof CONTROL_DATES}} [facts]
 * @returns {string[]}
 */
export function problems(cases = loadTable(), facts = {}) {
  return [
    ...shapeProblems(cases),
    ...coverageProblems(cases, facts),
    ...factProblems(facts),
    ...oracleProblems(cases),
  ];
}

/**
 * @param {{transitions?: typeof TRANSITIONS, controlDates?: typeof CONTROL_DATES}} [facts]
 * @returns {number} Process exit code.
 */
export function main(facts = {}) {
  /** @type {TableCase[]} */
  let cases;
  try {
    cases = loadTable();
  } catch (failure) {
    console.error(
      `E15-R02: ${failure instanceof Error ? failure.message : 'cannot read the table'}`,
    );
    return 1;
  }
  const failures = problems(cases, facts);
  for (const failure of failures) console.error(`E15-R02: ${failure}`);
  if (failures.length) {
    console.error(`E15-R02: ${failures.length} failure(s)`);
    return 1;
  }
  console.log(
    `E15-R02: ${cases.length} DST cases over ${ZONES.length} zones and ${YEARS.length} years, every expected instant re-derived from ICU, 0 failures`,
  );
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = main();
