// E15-R01: the round-trip gate over `spec/ical-fixtures/`.
//
// The corpus holds one `.ics` per case, in one directory per source: `ours/`
// (objects our own code writes — today that is the Private skeleton of E03-R09)
// and `synthetic/` (hand-written objects that imitate what stock apps emit).
// The captured directories of E15-R04 (`apple/`, `samsung/`, `google-davx5/`,
// `android-adapter/`, `thunderbird/`) are already part of the walk, so a
// capture joins the gate the day it lands. `rrule/` belongs to E15-R03 and is
// deliberately not a source here.
//
// Every fixture text goes through a `roundTrip(text) => text` function and the
// result is compared with the input. The default is `ICAL.parse` followed by
// `toString()` — the only read-modify-write path that exists today. E05-R04
// builds the API's read-modify-write module and passes it in here; nothing in
// this file assumes it, which is why the function is a parameter.
//
// Two things are asserted for every fixture (INV-02):
//
//   * semantic equality of the normalised object. Line folding, `CRLF`, the
//     order of properties and a `VALUE` that merely names the property's own
//     default are not semantic, so the output may differ there. A `DATE-TIME`
//     is compared as the instant it names, so the same moment written with a
//     `TZID` and with `Z` is one value; an all-day `DATE` is compared as its
//     date; a floating time keeps its own spelling because it names no instant.
//   * preservation: every component, property and parameter of the input is in
//     the output as well — per component path, property name and parameter
//     name, so a single lost `X-` parameter fails even when the value is
//     untouched. This is checked twice and independently: once on the
//     normalised model built with `ical.js`, and again on the raw content lines
//     of the two texts (`rawLines`). The raw pass exists because the normalised
//     model is built with the very engine the gate tests: a property or
//     parameter the engine drops at *parse* time is missing from both
//     normalised sides and would otherwise pass. The raw pass compares
//     component paths, property names and the sorted `NAME=value` parameters
//     only — never a property value, which is the normalised comparison's job.
//     It ignores `VALUE`, because the value type the normalised side compares is
//     exactly what `VALUE` names, and it normalises parameter-name case and
//     quoting, both of which `ical.js` legitimately rewrites. Where the two
//     passes describe the same difference the message is identical and appears
//     once.
//
// A violation names the fixture, the component path, the property or the
// parameter, and which side lacks it. It never prints a value: a value appears
// as its byte length and the first 12 hex digits of its SHA-256, so the gate
// can be re-run locally from its output without putting fixture content into a
// log line (`spec/ical-fixtures/README.md`).
//
// `ical.js` resolves a `TZID` through the document's own `VTIMEZONE` (the
// library carries no zone database), so a fixture registers exactly the zones
// it defines and removes them again afterwards, and a `TZID` that the object
// does not define is a failure rather than a silent fallback to floating time.
// The same check runs on the round trip's output, so an engine that drops a
// `VTIMEZONE` fails here instead of producing a document that no longer stands
// on its own.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ICAL from 'ical.js';

/** Absolute path of the round-trip corpus root. */
export const corpusRoot = fileURLToPath(
  new URL('../../../spec/ical-fixtures/', import.meta.url),
);

/**
 * One directory per source. `ours/` and `synthetic/` are E15-R01; the rest are
 * the captures of Phase 4 (E15-R04) and stay empty for now.
 */
export const SOURCE_DIRECTORIES = [
  'ours',
  'synthetic',
  'apple',
  'samsung',
  'google-davx5',
  'android-adapter',
  'thunderbird',
];

/** Suffix of the sidecar that names where a fixture's behaviour comes from. */
const SOURCE_NOTE_SUFFIX = '.source.md';

/**
 * A reason a fixture cannot be read as an iCalendar object. Its message carries
 * an id, a component or property name or a `TZID` — never a value.
 */
class CorpusViolation extends Error {}

/**
 * @typedef {object} Fixture
 * @property {string} source the source directory
 * @property {string} id `<source>/<file>` without the `.ics` suffix
 * @property {string} path absolute path of the `.ics` file
 * @property {string} notePath absolute path of its source note
 */

/**
 * Every fixture of the corpus, ordered by source and then by file name.
 * @param {string} [directory]
 * @returns {Fixture[]}
 */
export function fixtures(directory = corpusRoot) {
  /** @type {Fixture[]} */
  const found = [];
  for (const source of SOURCE_DIRECTORIES) {
    const path = join(directory, source);
    if (!existsSync(path)) continue;
    const files = readdirSync(path)
      .filter((file) => file.endsWith('.ics'))
      .sort();
    for (const file of files) {
      const id = file.slice(0, -'.ics'.length);
      found.push({
        source,
        id: `${source}/${id}`,
        path: join(path, file),
        notePath: join(path, `${id}${SOURCE_NOTE_SUFFIX}`),
      });
    }
  }
  return found;
}

/**
 * @param {Fixture} fixture
 * @returns {string} the fixture's iCalendar text
 */
export function readFixture(fixture) {
  return readFileSync(fixture.path, 'utf8');
}

/**
 * Why a fixture has no usable source note, or an empty string when it has one.
 * A fixture imitates a behaviour that has to be attributable, and the note is
 * where the behaviour, the public document it comes from and what was invented
 * are named; a fixture without one is a failure, not a skip.
 * @param {Fixture} fixture
 * @returns {string}
 */
export function sourceNoteViolation(fixture) {
  if (!existsSync(fixture.notePath))
    return `${fixture.id}: no ${SOURCE_NOTE_SUFFIX} beside the fixture`;
  return readFileSync(fixture.notePath, 'utf8').trim()
    ? ''
    : `${fixture.id}: the source note is empty`;
}

/**
 * The read-modify-write path that exists today: parse, then serialise.
 * @param {string} text
 * @returns {string}
 */
export function defaultRoundTrip(text) {
  return new ICAL.Component(ICAL.parse(text)).toString();
}

/**
 * How a value is allowed to appear in a violation: its byte length and a short
 * hash of it, never the value itself.
 * @param {string} value
 * @returns {string}
 */
export function describeValue(value) {
  const text = String(value);
  const digest = createHash('sha256').update(text, 'utf8').digest('hex');
  return `sha256:${digest.slice(0, 12)} (${Buffer.byteLength(text, 'utf8')} bytes)`;
}

/**
 * The name an engine error is reported under. The message of an engine error
 * can quote the text it failed on, so only the error's name is repeated.
 * @param {unknown} error
 * @returns {string}
 */
function errorLabel(error) {
  if (error instanceof CorpusViolation) return error.message;
  return error instanceof Error ? error.name : 'unknown error';
}

/**
 * One value in comparable form.
 * @param {unknown} value
 * @returns {string}
 */
function canonicalValue(value) {
  if (value instanceof ICAL.Time) {
    if (value.isDate) return `date:${value.toICALString()}`;
    const tzid = value.zone?.tzid;
    if (tzid && tzid !== ICAL.Timezone.localTimezone.tzid)
      return `instant:${value.convertToZone(ICAL.Timezone.utcTimezone).toICALString()}`;
    return `floating:${value.toICALString()}`;
  }
  if (value instanceof ICAL.Duration) return `duration:${value.toString()}`;
  if (value instanceof ICAL.Period) return `period:${value.toICALString()}`;
  return `value:${String(value)}`;
}

/**
 * @typedef {object} CanonicalProperty
 * @property {string} name
 * @property {string} type the value type, `VALUE` resolved the way jCal stores it
 * @property {string[]} parameters `NAME=value`, sorted
 * @property {string[]} values
 */

/**
 * @param {ICAL.Property} property
 * @returns {CanonicalProperty}
 */
function canonicalProperty(property) {
  const declared =
    /** @type {Record<string, unknown>} */ (property.jCal[1]) ?? {};
  return {
    name: property.name.toUpperCase(),
    type: String(property.type ?? 'unknown'),
    parameters: Object.entries(declared)
      .map(
        ([name, value]) =>
          `${name.toUpperCase()}=${typeof value === 'string' ? value : JSON.stringify(value)}`,
      )
      .sort(),
    values: property.getValues().map(canonicalValue),
  };
}

/**
 * Every component of a document by its path — `VCALENDAR`,
 * `VCALENDAR/VEVENT[0]`, `VCALENDAR/VEVENT[0]/VALARM[0]` — with the component's
 * properties by name. The index within a name is the document order among the
 * siblings that share it.
 * @param {ICAL.Component} calendar
 * @returns {Map<string, Map<string, CanonicalProperty[]>>}
 */
function indexDocument(calendar) {
  /** @type {Map<string, Map<string, CanonicalProperty[]>>} */
  const index = new Map();
  /**
   * @param {ICAL.Component} component
   * @param {string} path
   */
  const visit = (component, path) => {
    /** @type {Map<string, CanonicalProperty[]>} */
    const properties = new Map();
    for (const property of component.getAllProperties()) {
      const name = property.name.toUpperCase();
      const list = properties.get(name) ?? [];
      list.push(canonicalProperty(property));
      properties.set(name, list);
    }
    index.set(path, properties);
    /** @type {Map<string, ICAL.Component[]>} */
    const children = new Map();
    for (const child of component.getAllSubcomponents()) {
      const name = child.name.toUpperCase();
      const list = children.get(name) ?? [];
      list.push(child);
      children.set(name, list);
    }
    for (const [name, list] of children)
      list.forEach((child, position) =>
        visit(child, `${path}/${name}[${position}]`),
      );
  };
  visit(calendar, 'VCALENDAR');
  return index;
}

/**
 * One property of the input against the property of the output that holds the
 * same name at the same position.
 * @param {string} id
 * @param {string} where `<fixture>: <component path>: <PROPERTY>[<n>]`
 * @param {CanonicalProperty} input
 * @param {CanonicalProperty} output
 * @returns {string[]}
 */
function compareProperty(id, where, input, output) {
  const violations = [];
  for (const parameter of input.parameters)
    if (!output.parameters.includes(parameter))
      violations.push(
        `${where}: parameter ${parameter.split('=')[0]} is in the fixture but not in the output (fixture value ${describeValue(parameter.slice(parameter.indexOf('=') + 1))})`,
      );
  for (const parameter of output.parameters)
    if (!input.parameters.includes(parameter))
      violations.push(
        `${where}: parameter ${parameter.split('=')[0]} is in the output but not in the fixture (output value ${describeValue(parameter.slice(parameter.indexOf('=') + 1))})`,
      );
  if (input.type !== output.type)
    violations.push(
      `${where}: the value type is ${input.type} in the fixture and ${output.type} in the output`,
    );
  if (input.values.length !== output.values.length)
    violations.push(
      `${where}: the fixture has ${input.values.length} value(s), the output has ${output.values.length}`,
    );
  else
    input.values.forEach((value, position) => {
      const produced = output.values[position];
      if (value !== produced)
        violations.push(
          `${where}: value ${position} differs (fixture ${describeValue(value)}, output ${describeValue(produced)})`,
        );
    });
  return violations;
}

/**
 * @param {string} id
 * @param {Map<string, Map<string, CanonicalProperty[]>>} input
 * @param {Map<string, Map<string, CanonicalProperty[]>>} output
 * @returns {string[]}
 */
function compareDocuments(id, input, output) {
  const violations = [];
  const paths = [...new Set([...input.keys(), ...output.keys()])].sort();
  for (const path of paths) {
    const before = input.get(path);
    const after = output.get(path);
    if (!before) {
      violations.push(
        `${id}: ${path}: the component is in the output but not in the fixture`,
      );
      continue;
    }
    if (!after) {
      violations.push(
        `${id}: ${path}: the component is in the fixture but not in the output`,
      );
      continue;
    }
    const names = [...new Set([...before.keys(), ...after.keys()])].sort();
    for (const name of names) {
      const left = before.get(name) ?? [];
      const right = after.get(name) ?? [];
      const positions = Math.max(left.length, right.length);
      for (let position = 0; position < positions; position += 1) {
        const where = `${id}: ${path}: ${name}[${position}]`;
        const from = left[position];
        const to = right[position];
        if (!from)
          violations.push(
            `${where}: the property is in the output but not in the fixture`,
          );
        else if (!to)
          violations.push(
            `${where}: the property is in the fixture but not in the output`,
          );
        else violations.push(...compareProperty(id, where, from, to));
      }
    }
  }
  return violations;
}

/**
 * Unfold a text into its content lines: RFC 5545 § 3.1 folds a line by ending
 * it and starting the rest with one space or tab, so an unfolding removes that
 * break and keeps the leading character's remainder. Blank lines are dropped.
 * @param {string} text
 * @returns {string[]}
 */
function unfoldLines(text) {
  /** @type {string[]} */
  const lines = [];
  /** @type {string | null} */
  let current = null;
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if (/^[ \t]/.test(raw)) {
      if (current !== null) current += raw.slice(1);
      continue;
    }
    if (current !== null) lines.push(current);
    current = raw;
  }
  if (current !== null) lines.push(current);
  return lines.filter((line) => line.trim() !== '');
}

/**
 * One parameter in comparable form: `NAME=value`, name upper-cased, a quoted
 * value unquoted. `ical.js` writes parameter names in either case and drops the
 * quoting when it can, so both are normalised away here; a quoting-only
 * difference is not a difference.
 * @param {string} piece
 * @returns {string}
 */
function normaliseParameter(piece) {
  const equals = piece.indexOf('=');
  if (equals < 0) return piece.toUpperCase();
  const name = piece.slice(0, equals).toUpperCase();
  let value = piece.slice(equals + 1);
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
    value = value.slice(1, -1);
  return `${name}=${value}`;
}

/**
 * Split one content line into its name, parameters and value. A `;` outside a
 * quoted parameter value separates parameters; the first `:` outside a quoted
 * parameter value separates the value (so a quoted `X-` parameter value may
 * hold `;` and `:`, as Apple's structured location does).
 * @param {string} line
 * @returns {{name: string, parameters: string[], value: string}}
 */
function splitContentLine(line) {
  let quoted = false;
  let colon = line.length;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') quoted = !quoted;
    else if (character === ':' && !quoted) {
      colon = index;
      break;
    }
  }
  const head = line.slice(0, colon);
  const value = colon < line.length ? line.slice(colon + 1) : '';
  /** @type {string[]} */
  const pieces = [];
  let current = '';
  quoted = false;
  for (const character of head) {
    if (character === '"') {
      quoted = !quoted;
      current += character;
    } else if (character === ';' && !quoted) {
      pieces.push(current);
      current = '';
    } else current += character;
  }
  pieces.push(current);
  const name = (pieces.shift() ?? '').toUpperCase();
  const parameters = pieces.map(normaliseParameter).sort();
  return { name, parameters, value };
}

/**
 * @typedef {object} RawLine
 * @property {'begin' | 'end' | 'property'} kind
 * @property {string} path the component path with a sibling index, e.g. `VCALENDAR/VEVENT[0]`
 * @property {string} name the property name, or the component name on a BEGIN/END
 * @property {string[]} parameters `NAME=value`, sorted; empty on a BEGIN/END
 * @property {string} value the value text; empty on a BEGIN/END
 */

/**
 * Every content line of a document, unfolded, with its component path. The
 * sibling index of a component is its position among the siblings that share
 * its name, the way `indexDocument` numbers them, so the paths of the two
 * passes line up.
 * @param {string} text
 * @returns {RawLine[]}
 */
export function rawLines(text) {
  /** @type {RawLine[]} */
  const lines = [];
  /** @type {string[]} */
  const stack = [];
  /** @type {Map<string, number>} */
  const counters = new Map();
  for (const line of unfoldLines(text)) {
    const { name, parameters, value } = splitContentLine(line);
    if (name === 'BEGIN') {
      const component = value.toUpperCase();
      const parent = stack.length > 0 ? stack[stack.length - 1] : '';
      const key = `${parent}\u0000${component}`;
      const index = counters.get(key) ?? 0;
      counters.set(key, index + 1);
      const path = parent ? `${parent}/${component}[${index}]` : component;
      lines.push({
        kind: 'begin',
        path,
        name: component,
        parameters: [],
        value: '',
      });
      stack.push(path);
    } else if (name === 'END') {
      lines.push({
        kind: 'end',
        path: stack.pop() ?? '',
        name: value.toUpperCase(),
        parameters: [],
        value: '',
      });
    } else {
      lines.push({
        kind: 'property',
        path: stack[stack.length - 1] ?? '',
        name,
        parameters,
        value,
      });
    }
  }
  return lines;
}

/**
 * A document's raw properties by component path and then by name, in document
 * order. `VALUE` is left out: it names the value type, which is what the
 * normalised comparison compares.
 * @param {string} text
 * @returns {Map<string, Map<string, string[][]>>}
 */
function rawIndex(text) {
  /** @type {Map<string, Map<string, string[][]>>} */
  const index = new Map();
  for (const line of rawLines(text)) {
    if (line.kind === 'begin') {
      if (!index.has(line.path)) index.set(line.path, new Map());
      continue;
    }
    if (line.kind !== 'property') continue;
    const properties = index.get(line.path);
    if (!properties) continue;
    const list = properties.get(line.name) ?? [];
    list.push(line.parameters.filter((p) => !p.startsWith('VALUE=')));
    properties.set(line.name, list);
  }
  return index;
}

/**
 * Compare the raw content lines of two texts — the independent check that does
 * not go through the engine under test. Per component path it compares the
 * multiset of (property name, sorted `NAME=value` parameters); a value is never
 * compared here. The messages match the normalised comparison's wording, so a
 * difference both passes see is reported once.
 * @param {string} id
 * @param {string} fixtureText
 * @param {string} outputText
 * @returns {string[]}
 */
export function compareRawContent(id, fixtureText, outputText) {
  const before = rawIndex(fixtureText);
  const after = rawIndex(outputText);
  const violations = [];
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const path of paths) {
    const left = before.get(path);
    const right = after.get(path);
    if (!left) {
      violations.push(
        `${id}: ${path}: the component is in the output but not in the fixture`,
      );
      continue;
    }
    if (!right) {
      violations.push(
        `${id}: ${path}: the component is in the fixture but not in the output`,
      );
      continue;
    }
    const names = [...new Set([...left.keys(), ...right.keys()])].sort();
    for (const name of names) {
      const from = left.get(name) ?? [];
      const to = right.get(name) ?? [];
      const positions = Math.max(from.length, to.length);
      for (let position = 0; position < positions; position += 1) {
        const where = `${id}: ${path}: ${name}[${position}]`;
        const fixtureParameters = from[position];
        const outputParameters = to[position];
        if (!fixtureParameters) {
          violations.push(
            `${where}: the property is in the output but not in the fixture`,
          );
          continue;
        }
        if (!outputParameters) {
          violations.push(
            `${where}: the property is in the fixture but not in the output`,
          );
          continue;
        }
        for (const parameter of fixtureParameters)
          if (!outputParameters.includes(parameter))
            violations.push(
              `${where}: parameter ${parameter.split('=')[0]} is in the fixture but not in the output (fixture value ${describeValue(parameter.slice(parameter.indexOf('=') + 1))})`,
            );
        for (const parameter of outputParameters)
          if (!fixtureParameters.includes(parameter))
            violations.push(
              `${where}: parameter ${parameter.split('=')[0]} is in the output but not in the fixture (output value ${describeValue(parameter.slice(parameter.indexOf('=') + 1))})`,
            );
      }
    }
  }
  return violations;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The properties whose value has to name an instant or be an all-day `DATE`. */
const TIME_PROPERTIES = new Set([
  'DTSTART',
  'DTEND',
  'RECURRENCE-ID',
  'EXDATE',
  'RDATE',
]);

/**
 * The INV-03 / INV-04 checks an `ours/` fixture has to satisfy: every `UID` is
 * a lowercase random UUIDv4 (`crypto.randomUUID()`, what our own code writes)
 * and every time carries an IANA `TZID`, a trailing `Z` or `VALUE=DATE` — never
 * a floating time. Only the `VEVENT`s are checked: the `DTSTART` of a
 * `VTIMEZONE` observance is a local wall-clock time by construction and is not
 * an event time. A violation names the property, never a value.
 * @param {string} id
 * @param {string} text
 * @returns {string[]}
 */
export function skeletonViolations(id, text) {
  /** @type {string[]} */
  const violations = [];
  for (const line of rawLines(text)) {
    if (line.kind !== 'property') continue;
    if (!line.path.includes('VEVENT[')) continue;
    if (line.name === 'UID' && !UUID_V4.test(line.value))
      violations.push(`${id}: ${line.path}: UID is not a lowercase UUIDv4`);
    if (!TIME_PROPERTIES.has(line.name)) continue;
    const hasTzid = line.parameters.some((p) => p.startsWith('TZID='));
    const isDate = line.parameters.includes('VALUE=DATE');
    const utc = line.value
      .split(',')
      .every((value) => /^\d{8}T\d{6}Z$/.test(value));
    if (!hasTzid && !isDate && !utc)
      violations.push(
        `${id}: ${line.path}: ${line.name} carries neither TZID, Z nor VALUE=DATE`,
      );
  }
  return violations;
}

/**
 * Read one document and register the `VTIMEZONE`s it carries, so the zones are
 * its own and nothing else's. The message of the thrown `CorpusViolation` names
 * a component, property or `TZID`, never a value; the caller prefixes the
 * fixture id.
 * @param {string} text
 * @returns {{calendar: ICAL.Component, registered: string[]}}
 */
function openDocument(text) {
  let root;
  try {
    root = new ICAL.Component(ICAL.parse(text));
  } catch (error) {
    throw new CorpusViolation(
      `the text could not be parsed as iCalendar (${errorLabel(error)})`,
    );
  }
  if (root.name.toUpperCase() !== 'VCALENDAR')
    throw new CorpusViolation(
      `the root component is ${root.name.toUpperCase()}, not VCALENDAR`,
    );
  const zones = root.getAllSubcomponents('vtimezone');
  const tzids = zones.map((zone) => {
    const tzid = zone.getFirstPropertyValue('tzid');
    if (typeof tzid !== 'string' || !tzid)
      throw new CorpusViolation('a VTIMEZONE has no TZID');
    return tzid;
  });
  /** @type {ICAL.Component[]} */
  const components = [root];
  for (let position = 0; position < components.length; position += 1)
    for (const child of components[position]?.getAllSubcomponents() ?? [])
      components.push(child);
  for (const component of components)
    for (const property of component.getAllProperties()) {
      const tzid = property.getParameter('tzid');
      if (typeof tzid === 'string' && tzid && !tzids.includes(tzid))
        throw new CorpusViolation(
          `${property.name.toUpperCase()} uses TZID=${tzid}, which the object does not define`,
        );
    }
  for (const zone of zones) ICAL.TimezoneService.register(zone);
  return { calendar: root, registered: tzids };
}

/**
 * Round-trip one fixture text and report every difference between the text and
 * what the round trip produced from it.
 * @param {object} input
 * @param {string} input.id the fixture id, used in the violations
 * @param {string} input.text the fixture's iCalendar text
 * @param {(text: string) => string} [input.roundTrip]
 * @returns {string[]} violations, empty when the round trip lost nothing
 */
export function checkRoundTrip({ id, text, roundTrip = defaultRoundTrip }) {
  /** @type {string[]} */
  const registered = [];
  try {
    let before;
    let after;
    try {
      before = openDocument(text);
      registered.push(...before.registered);
    } catch (error) {
      return [`${id}: the fixture is not usable (${errorLabel(error)})`];
    }
    let produced;
    try {
      produced = roundTrip(text);
    } catch (error) {
      return [`${id}: the round trip failed (${errorLabel(error)})`];
    }
    if (typeof produced !== 'string')
      return [`${id}: the round trip did not return iCalendar text`];
    try {
      after = openDocument(produced);
      registered.push(...after.registered);
    } catch (error) {
      return [
        `${id}: the output does not stand on its own (${errorLabel(error)})`,
      ];
    }
    try {
      const normalised = compareDocuments(
        id,
        indexDocument(before.calendar),
        indexDocument(after.calendar),
      );
      // The independent raw pass catches what the normalised one cannot: a
      // property or parameter the engine dropped while parsing, which is then
      // absent from both normalised sides. It reports the same wording for the
      // same difference, so the dedup keeps each difference once.
      const raw = compareRawContent(id, text, produced);
      return [...new Set([...normalised, ...raw])];
    } catch (error) {
      return [
        `${id}: the object could not be normalised (${errorLabel(error)})`,
      ];
    }
  } finally {
    for (const tzid of registered) ICAL.TimezoneService.remove(tzid);
  }
}
