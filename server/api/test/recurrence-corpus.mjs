// E15-R03: expand the recurrence corpus with the API's engine (ical.js).
//
// The corpus is `spec/ical-fixtures/rrule/`: one `.ics` per case and an
// `.expected.json` golden beside it. Every fixture is expanded over one fixed
// five-year window in UTC and normalised to a sorted list of starts, so the
// result can be compared with the CalDAV service's `sabre/vobject` expansion.
// Nothing here reads the wall clock.
//
// Normalisation (the same rules are implemented once more in PHP, in
// `server/caldav/tests/RecurrenceCorpus.php`):
//   * a timed occurrence is the UTC instant of its start, `YYYYMMDDTHHMMSSZ`;
//   * an all-day occurrence is its date, `YYYYMMDD`;
//   * the window is half-open, `2026-01-01T00:00:00Z <= start < 2031-01-01T00:00:00Z`;
//   * an override (`RECURRENCE-ID` VEVENT) is reported in `overrides` with the
//     start it moved to and the master occurrence key it replaced; that key is
//     removed from `occurrences`; the override counts when the key it replaces
//     is inside the window, and its own start may be outside it;
//   * durations are dropped, and which instance an override replaced is only
//     kept as the `replaces` key.
//
// A fixture whose engine disagrees with its golden is acceptable only when
// `spec/ical-fixtures/RULINGS.md` records exactly that deviation and names the
// other engine as right; `goldenViolation` is the one implementation of that
// rule, and `infra/scripts/corpus-compare.mjs` enforces the mirror image over
// the two engines.
//
// `ical.js` resolves a `TZID` through the document's own `VTIMEZONE` (there is
// no zone database in the library), so each fixture registers exactly the
// `VTIMEZONE` components it carries and removes them again afterwards — no
// zone is registered globally from anywhere else, and a fixture that uses a
// `TZID` it does not define fails instead of falling back to floating time.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ICAL from 'ical.js';

/** Absolute path of the recurrence corpus directory. */
export const corpusDirectory = fileURLToPath(
  new URL('../../../spec/ical-fixtures/rrule/', import.meta.url),
);

/** Absolute path of the human-readable rulings file. */
export const rulingsPath = fileURLToPath(
  new URL('../../../spec/ical-fixtures/RULINGS.md', import.meta.url),
);

/** This engine's key in the comparison and in `RULINGS.md`. */
export const ENGINE = 'icaljs';

/** First instant of the fixed window (inclusive), in canonical UTC form. */
export const WINDOW_START = '20260101T000000Z';

/** End of the fixed window (exclusive), as the first canonical date outside it. */
export const WINDOW_END_DATE = '20310101';

/** Hard stop for a rule the window never bounds. */
const MAX_ITERATIONS = 20000;

/**
 * @typedef {object} OverrideEntry
 * @property {string} start
 * @property {string} replaces
 */

/**
 * @typedef {object} FixtureExpansion
 * @property {string} fixture
 * @property {string[]} occurrences
 * @property {OverrideEntry[]} overrides
 */

/**
 * @typedef {object} Difference
 * @property {'occurrences' | 'overrides'} type
 * @property {number} index
 * @property {string | null} actual
 * @property {string | null} expected
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

/** @param {string} [directory] @returns {string[]} fixture ids, sorted */
export function fixtureIds(directory = corpusDirectory) {
  return readdirSync(directory)
    .filter((file) => file.endsWith('.ics'))
    .map((file) => file.slice(0, -'.ics'.length))
    .sort();
}

/** @param {string} id @param {string} [directory] @returns {string} */
export function readFixture(id, directory = corpusDirectory) {
  return readFileSync(join(directory, `${id}.ics`), 'utf8');
}

/**
 * @param {string} id
 * @param {string} [directory]
 * @returns {FixtureExpansion | null} the golden, or null when absent
 */
export function readExpected(id, directory = corpusDirectory) {
  const path = join(directory, `${id}.expected.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/**
 * Canonical spelling of one occurrence start.
 * @param {ICAL.Time} value
 * @returns {string}
 */
export function canonicalTime(value) {
  if (value.isDate) return value.toICALString();
  return value.convertToZone(ICAL.Timezone.utcTimezone).toICALString();
}

/**
 * The DATE or DATE-TIME value of a property.
 * @param {ICAL.Property} property
 * @param {string} id
 * @returns {ICAL.Time}
 */
function timeValue(property, id) {
  const value = property.getFirstValue();
  if (!(value instanceof ICAL.Time))
    throw new Error(`${id}: ${property.name} is not a DATE or DATE-TIME value`);
  return value;
}

/**
 * The window is half-open at UTC midnight, so the date part decides.
 * @param {string} canonical
 * @returns {boolean}
 */
export function inWindow(canonical) {
  const date = canonical.slice(0, 8);
  return date >= WINDOW_START.slice(0, 8) && date < WINDOW_END_DATE;
}

/**
 * One comparison value: an occurrence is its canonical start, an override is
 * `<start>|<replaces>`.
 * @param {string | OverrideEntry} entry
 * @returns {string}
 */
export function differenceValue(entry) {
  return typeof entry === 'string' ? entry : `${entry.start}|${entry.replaces}`;
}

/**
 * @param {'occurrences' | 'overrides'} type
 * @param {Array<string | OverrideEntry>} actual
 * @param {Array<string | OverrideEntry>} expected
 * @returns {Difference | null}
 */
function compareList(type, actual, expected) {
  const length = Math.max(actual.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    const left = index < actual.length ? differenceValue(actual[index]) : null;
    const right =
      index < expected.length ? differenceValue(expected[index]) : null;
    if (left !== right) return { type, index, actual: left, expected: right };
  }
  return null;
}

/**
 * The first place two expansions differ: occurrences first, then overrides.
 * @param {FixtureExpansion} actual
 * @param {FixtureExpansion} expected
 * @returns {Difference | null}
 */
export function firstDifference(actual, expected) {
  return (
    compareList('occurrences', actual.occurrences, expected.occurrences) ??
    compareList('overrides', actual.overrides, expected.overrides)
  );
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {string}
 */
function requiredString(value, what) {
  if (typeof value !== 'string' || !value)
    throw new Error(`RULINGS.md: ${what} must be a non-empty string`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {string | null}
 */
function nullableString(value, what) {
  if (value !== null && typeof value !== 'string')
    throw new Error(`RULINGS.md: ${what} must be a string or null`);
  return value;
}

/**
 * Parse and validate the fenced JSON block of `spec/ical-fixtures/RULINGS.md`.
 * @param {string} text
 * @returns {Ruling[]}
 */
export function parseRulings(text) {
  const match = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  if (!match) throw new Error('RULINGS.md has no fenced json ruling block');
  const decoded = JSON.parse(match[1]);
  if (!decoded || !Array.isArray(decoded.rulings))
    throw new Error('RULINGS.md: rulings must be an array');
  /** @type {Ruling[]} */
  const rulings = [];
  const seen = new Set();
  for (const [position, entry] of decoded.rulings.entries()) {
    const where = `ruling ${position + 1}`;
    if (typeof entry !== 'object' || entry === null)
      throw new Error(`RULINGS.md: ${where} is not an object`);
    const ruling = /** @type {Record<string, unknown>} */ (entry);
    const fixture = requiredString(ruling.fixture, `${where} fixture`);
    if (seen.has(fixture))
      throw new Error(`RULINGS.md: duplicate ruling for ${fixture}`);
    seen.add(fixture);
    const difference = ruling.firstDifference;
    if (typeof difference !== 'object' || difference === null)
      throw new Error(`RULINGS.md: ${fixture} has no firstDifference object`);
    const fields = /** @type {Record<string, unknown>} */ (difference);
    const type = requiredString(fields.type, `${fixture} firstDifference.type`);
    if (type !== 'occurrences' && type !== 'overrides')
      throw new Error(
        `RULINGS.md: ${fixture} firstDifference.type is not occurrences or overrides`,
      );
    const index = fields.index;
    if (!Number.isInteger(index) || /** @type {number} */ (index) < 0)
      throw new Error(
        `RULINGS.md: ${fixture} firstDifference.index is not a non-negative integer`,
      );
    const correct = requiredString(ruling.correct, `${fixture} correct`);
    if (correct !== 'icaljs' && correct !== 'vobject')
      throw new Error(
        `RULINGS.md: ${fixture} correct is not icaljs or vobject`,
      );
    rulings.push({
      fixture,
      type,
      index: /** @type {number} */ (index),
      icaljs: nullableString(
        fields.icaljs,
        `${fixture} firstDifference.icaljs`,
      ),
      vobject: nullableString(
        fields.vobject,
        `${fixture} firstDifference.vobject`,
      ),
      rfc: requiredString(ruling.rfc, `${fixture} rfc`),
      correct,
      note: typeof ruling.note === 'string' ? ruling.note : '',
    });
  }
  return rulings;
}

/**
 * @param {string} [path]
 * @returns {Map<string, Ruling>} rulings keyed by fixture id
 */
export function readRulings(path = rulingsPath) {
  return new Map(
    parseRulings(readFileSync(path, 'utf8')).map((ruling) => [
      ruling.fixture,
      ruling,
    ]),
  );
}

/**
 * Whether one engine's expansion of one fixture is acceptable: it must match
 * the golden, or deviate from it exactly as `RULINGS.md` records and be named
 * as the wrong engine there. A ruling that no longer describes a real
 * deviation is a violation too, so a fixed engine cannot leave it behind.
 * @param {object} input
 * @param {string} input.id
 * @param {FixtureExpansion} input.actual
 * @param {FixtureExpansion} input.expected
 * @param {Ruling | null} [input.ruling]
 * @param {'icaljs' | 'vobject'} [input.engine]
 * @returns {string} an empty string when acceptable, otherwise the reason
 */
export function goldenViolation({
  id,
  actual,
  expected,
  ruling = null,
  engine = ENGINE,
}) {
  const other = engine === 'icaljs' ? 'vobject' : 'icaljs';
  const difference = firstDifference(actual, expected);
  if (!difference)
    return ruling && ruling.correct !== engine
      ? `${id}: the ruling records a deviation that ${engine} no longer produces`
      : '';
  const detail = `${difference.type} ${difference.index}: ${engine} gives ${
    difference.actual ?? '(absent)'
  }, golden says ${difference.expected ?? '(absent)'}`;
  if (!ruling) return `${id}: ${detail}, and RULINGS.md has no ruling for it`;
  if (ruling.correct === engine)
    return `${id}: ${detail}, but the ruling names ${engine} as right`;
  if (ruling.type !== difference.type || ruling.index !== difference.index)
    return `${id}: ${detail}, but the ruling records ${ruling.type} ${ruling.index}`;
  if (ruling[engine] !== difference.actual)
    return `${id}: ${detail}, but the ruling records ${engine} at ${ruling[engine] ?? '(absent)'}`;
  if (ruling[other] !== difference.expected)
    return `${id}: ${detail}, but the ruling records ${other} at ${ruling[other] ?? '(absent)'}`;
  return '';
}

/**
 * Register the document's own `VTIMEZONE`s and check that every `TZID` a
 * `VEVENT` uses is defined in that same document.
 * @param {ICAL.Component} calendar
 * @param {string} id
 * @returns {string[]} the TZIDs that were registered
 */
function registerDocumentTimezones(calendar, id) {
  const registered = [];
  for (const zone of calendar.getAllSubcomponents('vtimezone')) {
    const tzid = zone.getFirstPropertyValue('tzid');
    if (typeof tzid !== 'string' || !tzid)
      throw new Error(`${id}: VTIMEZONE without a TZID`);
    ICAL.TimezoneService.register(zone);
    registered.push(tzid);
  }
  for (const event of calendar.getAllSubcomponents('vevent')) {
    for (const name of ['dtstart', 'dtend', 'recurrence-id', 'exdate']) {
      for (const property of event.getAllProperties(name)) {
        const tzid = property.getParameter('tzid');
        if (typeof tzid === 'string' && tzid && !registered.includes(tzid))
          throw new Error(
            `${id}: ${name.toUpperCase()} uses TZID=${tzid}, which the document does not define`,
          );
      }
    }
  }
  return registered;
}

/**
 * Expand one fixture over the fixed window.
 * @param {string} id
 * @param {string} [directory]
 * @returns {FixtureExpansion}
 */
export function expandFixture(id, directory = corpusDirectory) {
  return expandText(id, readFixture(id, directory));
}

/**
 * Expand one fixture's iCalendar text over the fixed window.
 * @param {string} id
 * @param {string} text
 * @returns {FixtureExpansion}
 */
export function expandText(id, text) {
  const calendar = new ICAL.Component(ICAL.parse(text));
  const registered = registerDocumentTimezones(calendar, id);
  try {
    const events = calendar.getAllSubcomponents('vevent');
    const masters = events.filter(
      (event) => !event.hasProperty('recurrence-id'),
    );
    const overrides = events.filter((event) =>
      event.hasProperty('recurrence-id'),
    );
    if (masters.length !== 1)
      throw new Error(
        `${id}: expected exactly one master VEVENT, found ${masters.length}`,
      );
    const master = masters[0];
    if (master === undefined)
      throw new Error(`${id}: expected exactly one master VEVENT`);

    /** @type {string[]} */
    const occurrences = [];
    const iterator = new ICAL.Event(master).iterator();
    let guard = 0;
    let next = iterator.next();
    while (next && guard < MAX_ITERATIONS) {
      guard += 1;
      const canonical = canonicalTime(next);
      if (canonical.slice(0, 8) >= WINDOW_END_DATE) break;
      if (inWindow(canonical)) occurrences.push(canonical);
      next = iterator.next();
    }
    if (guard >= MAX_ITERATIONS)
      throw new Error(
        `${id}: recurrence expansion did not terminate inside ${MAX_ITERATIONS} instances`,
      );

    /** @type {OverrideEntry[]} */
    const overrideEntries = [];
    /** @type {Set<string>} */
    const replaced = new Set();
    for (const override of overrides) {
      const recurrenceId = override.getFirstProperty('recurrence-id');
      if (!recurrenceId)
        throw new Error(`${id}: override VEVENT without a RECURRENCE-ID`);
      const startProperty = override.getFirstProperty('dtstart');
      if (!startProperty)
        throw new Error(`${id}: override VEVENT without a DTSTART`);
      const replaces = canonicalTime(timeValue(recurrenceId, id));
      replaced.add(replaces);
      if (inWindow(replaces))
        overrideEntries.push({
          start: canonicalTime(timeValue(startProperty, id)),
          replaces,
        });
    }

    return {
      fixture: id,
      occurrences: occurrences
        .filter((occurrence) => !replaced.has(occurrence))
        .sort(),
      overrides: overrideEntries.sort((left, right) =>
        left.replaces < right.replaces ? -1 : 1,
      ),
    };
  } finally {
    for (const tzid of registered) ICAL.TimezoneService.remove(tzid);
  }
}

/**
 * Write every fixture's normalised expansion as `<id>.json` under `directory`.
 * @param {string} directory
 * @returns {string[]} the paths written
 */
export function writeCorpusOutput(directory) {
  mkdirSync(directory, { recursive: true });
  /** @type {string[]} */
  const written = [];
  for (const id of fixtureIds()) {
    const path = join(directory, `${id}.json`);
    writeFileSync(path, `${JSON.stringify(expandFixture(id), null, 2)}\n`);
    written.push(path);
  }
  return written;
}
