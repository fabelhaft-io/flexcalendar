// --- E05-R04 test support: an in-memory CalDAV collection --------------------
//
// A CalDAV object store the events routes can be driven against without a
// container: the four calls `src/events.mjs` makes (`putObject`, `getObject`,
// `deleteObject` and, for the tests, `listObjects` is not needed), with the
// properties the routes depend on —
//
//   * `If-None-Match: *` creates only, `If-Match` updates or deletes only, and
//     either mismatch is the `412` the real service answers with (SabreDAO;
//     `server/caldav/tests/Integration/ServiceTest.php` holds the same three
//     cases against the real thing);
//   * a missing object is a `404` for a GET and a DELETE, exactly as Sabre's
//     `getNodeForPath` refuses before any precondition is looked at;
//   * **the write guard runs**: every PUT is checked against the Private
//     skeleton allow-list of `server/caldav/src/PrivateSkeleton.php` (E03-R09),
//     and a violation throws the `403` the service throws, with the
//     `cf:private-skeleton-only` precondition and the offending property name.
//     That is what makes "the object this API writes is a skeleton the guard
//     accepts" an assertion about behaviour rather than about reading the code.
//
// The guard here is a **double, not the authority**: the authority is the PHP
// class and its own suite. It is deliberately the same allow-list, so a field
// this API starts writing that the guard would refuse fails here first.
//
// Every method can be made to fail (`fail('putObject', error)`), which is how
// the suite reaches the paths where CalDAV refuses: a guard precondition, a
// hostile exception carrying a canary, a timeout.

import { CalDavError } from '../../src/caldav/adapter.mjs';
import { rawLines } from '../ical-roundtrip.mjs';

/** `server/caldav/src/PrivateSkeleton.php` § PROPERTIES, verbatim. */
/** @type {Record<string, string[]>} */
const PROPERTIES = {
  VCALENDAR: ['VERSION', 'PRODID', 'CALSCALE'],
  VTIMEZONE: ['TZID', 'LAST-MODIFIED', 'TZURL', 'X-LIC-LOCATION'],
  STANDARD: [
    'DTSTART',
    'TZOFFSETFROM',
    'TZOFFSETTO',
    'RRULE',
    'RDATE',
    'TZNAME',
  ],
  DAYLIGHT: [
    'DTSTART',
    'TZOFFSETFROM',
    'TZOFFSETTO',
    'RRULE',
    'RDATE',
    'TZNAME',
  ],
  VEVENT: [
    'UID',
    'DTSTAMP',
    'DTSTART',
    'DTEND',
    'DURATION',
    'RRULE',
    'RDATE',
    'EXDATE',
    'RECURRENCE-ID',
    'SEQUENCE',
    'CREATED',
    'LAST-MODIFIED',
    'X-CALFLEX-ENVELOPE-SHA256',
  ],
  VALARM: ['ACTION', 'TRIGGER', 'REPEAT', 'DURATION', 'UID', 'DESCRIPTION'],
};

/** …§ COMPONENTS, verbatim. */
/** @type {Record<string, string[]>} */
const COMPONENTS = {
  VCALENDAR: ['VEVENT', 'VTIMEZONE'],
  VEVENT: ['VALARM'],
  VTIMEZONE: ['STANDARD', 'DAYLIGHT'],
  VALARM: [],
  STANDARD: [],
  DAYLIGHT: [],
};

/** The properties whose parameters the guard recognises. */
const PARAMETERS = ['TZID', 'VALUE'];
/** The only `X-CALFLEX-ENVELOPE-SHA256` value the guard accepts (E03-R09). */
const ENVELOPE_HASH = /^[0-9a-f]{64}$/;

/** `VCALENDAR/VEVENT[0]` -> `VEVENT`; `VCALENDAR` -> `VCALENDAR`. @param {string} path */
const componentOf = (path) => {
  const segment = path.slice(path.lastIndexOf('/') + 1);
  const bracket = segment.indexOf('[');
  return bracket === -1 ? segment : segment.slice(0, bracket);
};

/**
 * The property name the Private write guard refuses `text` for, or undefined
 * when it is a skeleton the guard accepts. Mirrors the PHP walk: components
 * against their parent's list, properties and parameters per component, a
 * property group refused outright, and exactly one envelope hash per `VEVENT`.
 * @param {string} text
 * @returns {string | undefined}
 */
export function guardViolation(text) {
  /** @type {Map<string, number>} */
  const hashes = new Map();
  for (const line of rawLines(text)) {
    if (line.kind === 'end') continue;
    if (line.kind === 'begin') {
      const parent = line.path.includes('/')
        ? componentOf(line.path.slice(0, line.path.lastIndexOf('/')))
        : '';
      if (parent !== '' && !(COMPONENTS[parent] ?? []).includes(line.name)) {
        return line.name;
      }
      // Every VEVENT owes exactly one envelope hash, so every VEVENT is counted
      // from the moment it starts — a VEVENT with none is a violation too.
      if (line.name === 'VEVENT') hashes.set(line.path, 0);
      continue;
    }
    const component = componentOf(line.path);
    if (!(PROPERTIES[component] ?? []).includes(line.name)) return line.name;
    if (line.name.includes('.')) return 'UNLISTED';
    for (const parameter of line.parameters) {
      const name = parameter.slice(0, parameter.indexOf('='));
      const allowed =
        PARAMETERS.includes(name) ||
        (name === 'RANGE' && line.name === 'RECURRENCE-ID') ||
        (name === 'RELATED' && line.name === 'TRIGGER');
      if (!allowed) return name;
    }
    if (line.name === 'X-CALFLEX-ENVELOPE-SHA256') {
      if (!ENVELOPE_HASH.test(line.value)) return line.name;
      hashes.set(line.path, (hashes.get(line.path) ?? 0) + 1);
    }
  }
  for (const count of hashes.values()) {
    if (count !== 1) return 'X-CALFLEX-ENVELOPE-SHA256';
  }
  return undefined;
}

/**
 * @param {{events?: Record<string, unknown>[]}} [seed]
 */
export function createMemoryCalDavStore(seed = {}) {
  /** @type {Map<string, {ics: string, etag: string}>} */
  const objects = new Map();
  /** @type {Map<string, Error>} */
  const failures = new Map();
  /** One-shot failures: the next call of the method throws, then it is healed. */
  /** @type {Map<string, Error>} */
  const once = new Map();
  /** @type {Record<string, unknown>[]} */
  const events = seed.events ?? [];
  /** The users each view was built for, in order. */
  /** @type {{userId: string, requestId?: string}[]} */
  const calls = [];
  /** Every property name the guard refused a PUT for, in order. */
  /** @type {string[]} */
  const refusals = [];
  let etags = 0;

  /** @param {string} calendarId @param {string} name */
  const keyOf = (calendarId, name) => `${calendarId}\u0000${name}`;

  /** @param {string} method */
  const guard = (method) => {
    const failure = once.get(method);
    if (failure) {
      once.delete(method);
      throw failure;
    }
    const lasting = failures.get(method);
    if (lasting) throw lasting;
  };

  return {
    /** The stored objects, for assertions about what a route left behind. */
    objects,
    events,
    calls,
    refusals,
    /**
     * Seeds an object directly, as a collection that already held one would —
     * without the guard, so a test can store something the API has to cope with.
     * @param {string} calendarId @param {string} name @param {string} ics
     */
    seed(calendarId, name, ics) {
      etags += 1;
      objects.set(keyOf(calendarId, name), { ics, etag: `"${etags}"` });
      return `"${etags}"`;
    },
    /** @param {string} calendarId @param {string} name */
    stored(calendarId, name) {
      return objects.get(keyOf(calendarId, name));
    },
    /**
     * Makes one method throw from now on. Passing no error restores it.
     * @param {string} method @param {Error} [error]
     */
    fail(method, error = new Error(`${method} failed`)) {
      failures.set(method, error);
      return;
    },
    /**
     * Makes the next call of one method throw, and only that one — the shape a
     * race has: an object that was there when a request read it and is gone by
     * the time the answer is assembled.
     * @param {string} method @param {Error} [error]
     */
    failOnce(method, error = new Error(`${method} failed`)) {
      once.set(method, error);
    },
    /** @param {string} method */
    heal(method) {
      failures.delete(method);
      once.delete(method);
    },

    /** @param {string} userId @param {{requestId?: string}} [options] */
    forUser(userId, options = {}) {
      calls.push({ userId, requestId: options.requestId });
      events.push({ op: 'forUser', userId });
      return {
        /** @param {string} calendarId */
        async makeCalendar(calendarId) {
          events.push({ op: 'makeCalendar', calendarId });
          return { status: 201 };
        },
        /** @param {string} calendarId */
        async deleteCalendar(calendarId) {
          events.push({ op: 'deleteCalendar', calendarId });
          return { status: 204 };
        },

        /**
         * @param {string} calendarId @param {string} name @param {string} ics
         * @param {{ifMatch?: string, ifNoneMatch?: string}} [options]
         */
        async putObject(calendarId, name, ics, options = {}) {
          events.push({
            op: 'putObject',
            calendarId,
            name,
            ifMatch: options.ifMatch,
            ifNoneMatch: options.ifNoneMatch,
            ics,
          });
          guard('putObject');
          const key = keyOf(calendarId, name);
          const existing = objects.get(key);
          if (options.ifNoneMatch === '*' && existing !== undefined) {
            throw new CalDavError('precondition-failed', 412);
          }
          if (
            options.ifMatch !== undefined &&
            (existing === undefined || existing.etag !== options.ifMatch)
          ) {
            throw new CalDavError('precondition-failed', 412);
          }
          const violation = guardViolation(ics);
          if (violation !== undefined) {
            refusals.push(violation);
            throw new CalDavError('forbidden', 403, [
              'cf:private-skeleton-only',
              violation,
            ]);
          }
          etags += 1;
          const etag = `"${etags}"`;
          objects.set(key, { ics, etag });
          return { status: existing === undefined ? 201 : 204, etag };
        },

        /** @param {string} calendarId @param {string} name */
        async getObject(calendarId, name) {
          events.push({ op: 'getObject', calendarId, name });
          guard('getObject');
          const object = objects.get(keyOf(calendarId, name));
          if (object === undefined) throw new CalDavError('not-found', 404);
          return { status: 200, etag: object.etag, data: object.ics };
        },

        /**
         * @param {string} calendarId @param {string} name
         * @param {{ifMatch?: string}} [options]
         */
        async deleteObject(calendarId, name, options = {}) {
          events.push({
            op: 'deleteObject',
            calendarId,
            name,
            ifMatch: options.ifMatch,
          });
          guard('deleteObject');
          const key = keyOf(calendarId, name);
          const object = objects.get(key);
          if (object === undefined) throw new CalDavError('not-found', 404);
          if (
            options.ifMatch !== undefined &&
            object.etag !== options.ifMatch
          ) {
            throw new CalDavError('precondition-failed', 412);
          }
          objects.delete(key);
          return { status: 204 };
        },
      };
    },
  };
}
