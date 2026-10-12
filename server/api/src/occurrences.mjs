// --- E05-R05: the windowed occurrence expansion ------------------------------
//
// `GET /calendars/{calendarId}/occurrences?from&to&tz` is the route
// (`src/occurrence-routes.mjs`); this module is the pure half of it:
// `expandOccurrences(objects, {from, to, tz})` takes the iCalendar texts a
// CalDAV `calendar-query` returned — one object per master and its overrides —
// and answers the expanded instances of the window `[from, to)`, each tagged
// with the master `uid`, the instance's `recurrenceId` and whether an override
// `VEVENT` defines it.
//
// **No I/O, no clock, no database, nothing registered anywhere.** The only
// inputs are the arguments and `src/zones.mjs`; a `TZID` is never registered in
// `ical.js`'s global `TimezoneService`, so one client's object can never
// redefine a zone for the process (E04-R04's note).
//
// ## `ical.js` does the arithmetic, `src/zones.mjs` owns every instant
//
// The library carries no zone database, and it is wrong on two single local
// times — a reading that does not exist, and one that occurs twice
// (`spec/ical-fixtures/dst/README.md`) — so **no instant this module returns
// comes out of `ical.js`**:
//
//   * The recurrence is expanded on **wall clocks**, in a floating copy of the
//     object (`floatingCopy` below): every `VTIMEZONE` removed, every `TZID`
//     parameter stripped. `ical.js` reads a `TZID` start as a real zone when the
//     object embeds the definition — every object this API writes does — and
//     then compares a floating `UNTIL` and a `Z` `RDATE`/`EXDATE` against true
//     instants, so a zone behind UTC loses its last instance and a `Z` `RDATE`
//     lands at the wrong wall clock. The copy has neither, so the iterator
//     yields exactly the wall-clock readings the rule names, in order, with
//     `RDATE` merged and `EXDATE` removed. That is the only thing the library is
//     asked for, and an answer is the same with and without an embedded
//     `VTIMEZONE`.
//   * Every wall clock is then turned into an instant by `instantOf` from
//     `src/zones.mjs` (RFC 5545 § 3.3.5 form 3, through ICU): a repeated
//     reading is the first occurrence, a reading that does not exist is read
//     with the offset before the gap. An all-day date becomes the midnights of
//     the **requested** zone, which is what makes a day 23, 24 or 25 hours long.
//   * A `UNTIL` beside a zone start is a UTC instant (RFC 5545 § 3.3.10), while
//     the expansion compares wall clocks; it is therefore converted once with
//     `localOf` on the copy, and every **rule** instance is tested against the
//     **instant** as well, so the boundary is the RFC's and not the library's.
//     An `RDATE` is not bounded by `UNTIL` (§ 3.3.10 bounds the rule only), and
//     an `RDATE` that names a rule instance is that one occurrence, not two.
//
// ## The ruling on RFC 5545 § 3.3.10
//
// RFC 5545 § 3.3.10 contradicts itself on a recurrence instance whose computed
// local time does not exist (its note says such an instance "MUST be ignored and
// MUST NOT be counted"; its closing paragraph reads it like an explicit
// DATE-TIME). The owner ruled on 2026-10-12 (`docs/02` § Recurrence): the
// instance is kept, counted, and read with the offset before the gap, which is
// the DST table's `expected` and what `sabre/vobject` does, so a stock app and
// our own app agree. `KEEP_NONEXISTENT_INSTANCES` below is the one switch; at
// `false` the instance would be dropped and still spend its `COUNT`, because
// the library counted it. A single `DTSTART` at such a time is never affected:
// § 3.3.5 form 3 reads it either way.
//
// ## The two rule families `ical.js` expands wrongly
//
// `spec/ical-fixtures/RULINGS.md` records that ical.js 2.2.1 gets `BYWEEKNO`
// and a yearly rule anchored on 29 February wrong. E05-R04 refuses both on
// write; an object a stock app wrote (Phase 4) can still hold one, so here such
// an object is reported in `unsupported` with reason `rrule-not-expanded` and
// expanded as nothing. Neither rule is hand-rolled, and neither is expanded by
// the library.
//
// ## What one occurrence is
//
// `{uid, recurrenceId, override, start, end, allDay, envelopeSha256}`.
// `start`/`end` are the instant in the requested `tz` (`{utc, local, tzid}`) or,
// for an all-day event, a `{date}` (no zone, no instant) whose `end` is the
// exclusive next date. `recurrenceId` is the instance's **original** start in the
// form the object stores it (`{date}`, `{utc}` or `{local, tzid}` with the
// instant beside it) — what E05-R06/R07 send back — and `null` for an event that
// does not recur. `envelopeSha256` is the `X-CALFLEX-ENVELOPE-SHA256` of the
// `VEVENT` that defines the instance: the master for a derived one, the
// override's own otherwise.
//
// **The window is half-open everywhere.** An instance is in `[from, to)` when
// its interval overlaps it (`start < to` and `end > from`); a zero-length
// instance is in when `from <= start < to`. An override replaces the master
// instance it names whether or not its own times are in the window, and is
// itself reported by its own times; `EXDATE` removes an instance; `RDATE` adds
// one. The answer is sorted by start instant, then `uid`, then `recurrenceId`.
//
// An object is `unsupported` — and contributes nothing — when its rule is one
// the library would mis-expand, when a `TZID` in it is not a zone ICU can read
// (a Windows name, say), or when its expansion would not stop inside
// `MAX_INSTANCES` instances from `DTSTART`. The route turns more than
// `MAX_OCCURRENCES` occurrences into a 422; an object this module cannot read at
// all is an `IcalError`, which the route answers as a 502.

import ICAL from 'ical.js';

import {
  ENVELOPE_HASH_PROPERTY,
  IcalError,
  describe,
  parse,
  timeOf,
} from './ical-rmw.mjs';
import { ZoneError, instantOf, localOf, resolves } from './zones.mjs';

/** How many instances one object may expand to before it is `unsupported`. */
export const MAX_INSTANCES = 50_000;

/** How many occurrences one answer may carry before the route refuses it. */
export const MAX_OCCURRENCES = 10_000;

/** The reasons a whole object can be left out of the answer. */
export const UNSUPPORTED_REASONS = Object.freeze([
  'too-many-instances',
  'unknown-zone',
  'rrule-not-expanded',
]);

const TOO_MANY_INSTANCES = 'too-many-instances';
const UNKNOWN_ZONE = 'unknown-zone';
const RULE_NOT_EXPANDED = 'rrule-not-expanded';

/**
 * The owner's ruling on RFC 5545 § 3.3.10 of 2026-10-12 (see the header):
 * `true` keeps an instance whose computed local time does not exist, read with
 * the offset before the gap. It is the whole of the switch — the other reading
 * drops the instance below and nothing else changes.
 */
export const KEEP_NONEXISTENT_INSTANCES = true;

/** `YYYYMMDDTHHMMSSZ`, the window bounds and every instant this module reports. */
const INSTANT = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
/** `BYWEEKNO` as a rule part, wherever it sits in the rule text. */
const BYWEEKNO = /(?:^|;)BYWEEKNO=/;
/** The `UNTIL` value of a rule text, and nothing else of it. */
const UNTIL = /(?:^|;)UNTIL=(\d{8}(?:T\d{6}Z)?)/;
/** The same value, for rewriting it in place. */
const UNTIL_VALUE = /UNTIL=\d{8}(?:T\d{6}Z)?/;
/** The `FREQ` of a rule text. */
const FREQ = /(?:^|;)FREQ=([A-Z]+)/;

/** @param {number} value @param {number} [width] */
function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

/** @param {number} epochSeconds @returns {string} `YYYYMMDDTHHMMSSZ` */
function instantString(epochSeconds) {
  const date = new Date(epochSeconds * 1000);
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(
    date.getUTCDate(),
  )}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(
    date.getUTCSeconds(),
  )}Z`;
}

/**
 * Epoch seconds of a `YYYYMMDDTHHMMSSZ` instant. The route validates the window
 * before this is called; a value outside the form is the module's own refusal
 * rather than a silently rolled date.
 * @param {string} instant
 * @returns {number}
 */
function epochOf(instant) {
  const match = typeof instant === 'string' ? INSTANT.exec(instant) : null;
  if (!match) throw new ZoneError('invalid-instant');
  return (
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    ) / 1000
  );
}

/** `YYYYMMDD` -> the epoch milliseconds of that UTC midnight. @param {string} compact */
function midnight(compact) {
  return Date.UTC(
    Number(compact.slice(0, 4)),
    Number(compact.slice(4, 6)) - 1,
    Number(compact.slice(6, 8)),
  );
}

/** `YYYYMMDD` moved by whole days, normalised. @param {string} compact @param {number} days */
function addDays(compact, days) {
  const date = new Date(midnight(compact) + days * 86_400_000);
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

/** `YYYY-MM-DD` -> `YYYYMMDD`. @param {string} date */
const compactDate = (date) => date.replaceAll('-', '');

/** `YYYYMMDD` -> `YYYY-MM-DD`. @param {string} compact */
function dashedDate(compact) {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

/**
 * The wall clock one `ical.js` value spells, as the fields it carries — never as
 * an instant. A date value is `YYYYMMDD`, a date-time `YYYYMMDDTHHMMSS`; its
 * zone (floating, or UTC for a `Z` time) is deliberately ignored, because every
 * instant this module reports is computed from these fields and the zone the
 * object names.
 * @param {ICAL.Time} value
 * @returns {string}
 */
function wallClockOf(value) {
  const fields = value.toJSON();
  const date = `${pad(fields.year, 4)}${pad(fields.month)}${pad(fields.day)}`;
  if (value.isDate) return date;
  return `${date}T${pad(fields.hour)}${pad(fields.minute)}${pad(
    fields.second,
  )}`;
}

/**
 * The `ICAL.Time` one compact wall clock spells, **floating**: the reading names
 * no zone, which is what an `ical.js` rule needs to expand on wall clocks.
 * @param {string} wall `YYYYMMDDTHHMMSS`
 * @returns {ICAL.Time}
 */
function floatingTime(wall) {
  return ICAL.Time.fromData({
    year: Number(wall.slice(0, 4)),
    month: Number(wall.slice(4, 6)),
    day: Number(wall.slice(6, 8)),
    hour: Number(wall.slice(9, 11)),
    minute: Number(wall.slice(11, 13)),
    second: Number(wall.slice(13, 15)),
  });
}

/**
 * A cheap, ICU-free proxy for the instant one wall clock names: its fields read
 * as if they were UTC, off by at most the zone's offset. It exists only for the
 * cost guard below, where a two-day margin dwarfs every offset; it is never
 * reported and never decides an answer.
 * @param {string} wall `YYYYMMDD` or `YYYYMMDDTHHMMSS`
 * @returns {number} epoch seconds
 */
function proxyEpoch(wall) {
  const date = midnight(wall.slice(0, 8)) / 1000;
  if (wall.length === 8) return date;
  return (
    date +
    Number(wall.slice(9, 11)) * 3600 +
    Number(wall.slice(11, 13)) * 60 +
    Number(wall.slice(13, 15))
  );
}

/**
 * The master `VEVENT` of a calendar: the first one without a `RECURRENCE-ID`,
 * or the first one when every `VEVENT` carries one — `src/ical-rmw.mjs`'s
 * `master()`. A calendar this module is called with always holds one
 * (`describe` has already refused the object otherwise).
 * @param {ICAL.Component} calendar
 * @returns {ICAL.Component}
 */
function masterOf(calendar) {
  const events = calendar.getAllSubcomponents('vevent');
  return /** @type {ICAL.Component} */ (
    events.find((event) => !event.hasProperty('recurrence-id')) ?? events[0]
  );
}

/**
 * A **floating** copy of one parsed object: every `VTIMEZONE` removed and every
 * `TZID` parameter stripped, so `ical.js` reads each start as a wall clock with
 * no zone to attach and expands on wall clocks alone.
 *
 * It is what makes the expansion independent of whether the object carries its
 * own `VTIMEZONE`: with one embedded, the library attaches a real zone to a
 * `TZID` start and then compares the floating `UNTIL` and the `Z` `RDATE`/
 * `EXDATE` this API's objects carry against true instants — dropping an instance
 * beside `UNTIL` in a zone behind UTC, placing a `Z` `RDATE` at the wrong wall
 * clock and never matching a `Z` `EXDATE`.
 *
 * @param {ICAL.Component} calendar
 * @returns {ICAL.Component}
 */
function floatingCopy(calendar) {
  const working = new ICAL.Component(calendar.toJSON());
  for (const vtimezone of working.getAllSubcomponents('vtimezone')) {
    working.removeSubcomponent(vtimezone);
  }
  for (const event of working.getAllSubcomponents('vevent')) {
    for (const property of event.getAllProperties()) {
      property.removeParameter('tzid');
    }
  }
  return working;
}

/**
 * Rewrites a `RDATE`/`EXDATE` property of a zoned master in place: every value
 * that names a `Z` instant becomes the wall clock the master's own zone reads
 * for it, so a floating expansion places it where its instant is (an `RDATE`) or
 * removes the instance it names (an `EXDATE`). A `VALUE=DATE` value names a day
 * and is left alone.
 * @param {ICAL.Property} property
 * @param {string} tzid
 */
function toWallClocks(property, tzid) {
  const values = property.getValues().map((value) => {
    if (!(value instanceof ICAL.Time) || value.isDate) return value;
    if (value.zone !== ICAL.Timezone.utcTimezone) return value;
    return floatingTime(localOf(`${wallClockOf(value)}Z`, tzid));
  });
  property.setValues(values);
}

/** @typedef {{date?: string, utc?: string, local?: string, tzid?: string}} TimeShape */
/** @typedef {{kind: 'date' | 'utc' | 'zoned' | 'floating', tzid?: string}} Anchor */
/**
 * @typedef {object} Interval
 * @property {boolean} allDay
 * @property {number} startInstant
 * @property {number} endInstant
 * @property {any} start the reported start
 * @property {any} end the reported end
 */

/**
 * The instant one **stored** time names: `{utc}` is itself, a `{local}` beside a
 * `TZID` is RFC 5545 § 3.3.5 form 3 through that zone, and a floating reading is
 * read in `tz`, the zone the caller is looking at the calendar from — the RFC's
 * "local time of the observer". `undefined` when the `TZID` is one the resolver
 * cannot read (the caller reports the object as `unknown-zone` instead).
 * @param {TimeShape} shape
 * @param {string} tz
 * @returns {number | undefined}
 */
function storedInstant(shape, tz) {
  // A `TZID` shape carries `utc` beside the wall clock, so the `TZID` has to be
  // tested first: the wall clock is the authority and the instant is derived
  // from it (E05-R09).
  if (typeof shape.tzid === 'string') {
    if (!resolves(shape.tzid)) return undefined;
    return epochOf(instantOf(/** @type {string} */ (shape.local), shape.tzid));
  }
  if (typeof shape.utc === 'string') return epochOf(shape.utc);
  return epochOf(instantOf(/** @type {string} */ (shape.local), tz));
}

/**
 * The interval one stored `DTSTART`/`DTEND` pair covers, in instants, plus the
 * two values the answer reports. An all-day day is the requested zone's
 * midnights, which is what makes it 23, 24 or 25 hours long; a timed start adds
 * the event's own exact duration. A missing, mismatched or earlier `DTEND` is a
 * zero-length instance (RFC 5545 § 3.8.2.2 leaves `DTEND` optional and forbids
 * an end at or before the start; E05-R04 refuses both on write) — and an object
 * that carries a `DURATION` instead of a `DTEND` is read as one too, which is a
 * follow-up with the requirement rather than a guess here.
 * @param {TimeShape} start @param {TimeShape | null} end @param {string} tz
 * @returns {Interval}
 */
function intervalOf(start, end, tz) {
  if (typeof start.date === 'string') {
    const from = compactDate(start.date);
    const days =
      end !== null && typeof end.date === 'string'
        ? Math.max(
            1,
            (midnight(compactDate(end.date)) - midnight(from)) / 86_400_000,
          )
        : 1;
    const to = addDays(from, days);
    return {
      allDay: true,
      start: { date: dashedDate(from) },
      end: { date: dashedDate(to) },
      startInstant: epochOf(instantOf(`${from}T000000`, tz)),
      endInstant: epochOf(instantOf(`${to}T000000`, tz)),
    };
  }
  const startInstant = storedInstant(start, tz) ?? 0;
  const raw =
    end === null ? startInstant : (storedInstant(end, tz) ?? startInstant);
  const endInstant = Math.max(startInstant, raw);
  return {
    allDay: false,
    start: instantTime(startInstant, tz),
    end: instantTime(endInstant, tz),
    startInstant,
    endInstant,
  };
}

/**
 * One instant as the answer reports it: the instant, the viewer's wall clock for
 * it in the requested zone, and that zone's name.
 * @param {number} epochSeconds @param {string} tz
 */
function instantTime(epochSeconds, tz) {
  const utc = instantString(epochSeconds);
  return { utc, local: localOf(utc, tz), tzid: tz };
}

/**
 * Whether an interval overlaps the half-open window `[from, to)`. A zero-length
 * interval is in when its start is (`from <= start < to`), which the overlap
 * test alone would get wrong.
 * @param {{startInstant: number, endInstant: number}} interval
 * @param {number} from @param {number} to
 */
function overlaps(interval, from, to) {
  const { startInstant, endInstant } = interval;
  if (endInstant > startInstant) return startInstant < to && endInstant > from;
  return startInstant >= from && startInstant < to;
}

/**
 * What a stored start time says about how the series is anchored — and, for a
 * `TZID` no resolver can read (a Windows name a stock app wrote, say), the
 * reason the whole object is left out.
 * @param {TimeShape | null} start
 * @returns {Anchor | {reason: string}}
 */
function anchorOf(start) {
  if (start === null) throw new IcalError('no-start');
  if (typeof start.date === 'string') return { kind: 'date' };
  // A `TZID` time is a `{tzid, local, utc}` shape; the zone decides how the
  // expansion's wall clocks are read, so it is tested before `utc`.
  if (typeof start.tzid === 'string') {
    return resolves(start.tzid)
      ? { kind: 'zoned', tzid: start.tzid }
      : { reason: UNKNOWN_ZONE };
  }
  if (typeof start.utc === 'string') return { kind: 'utc' };
  return { kind: 'floating' };
}

/** @param {unknown} anchor @returns {boolean} */
const isAnchor = (anchor) =>
  typeof (/** @type {any} */ (anchor).kind) === 'string';

/**
 * The wall clock a generated instance sits at, turned into the instant the
 * anchor's zone (or the requested zone, for a floating start) reads for it.
 * @param {string} wall
 * @param {Anchor} anchor
 * @param {string} tz
 * @returns {number}
 */
function generatedInstant(wall, anchor, tz) {
  if (anchor.kind === 'utc') return epochOf(`${wall}Z`);
  return epochOf(
    instantOf(
      wall,
      anchor.kind === 'zoned' ? /** @type {string} */ (anchor.tzid) : tz,
    ),
  );
}

/**
 * The `recurrenceId` of a generated instance: the instance's original start in
 * the form the object stores it, so E05-R06/R07 can send it straight back.
 * @param {string} wall
 * @param {Anchor} anchor
 * @returns {TimeShape}
 */
function recurrenceIdOf(wall, anchor) {
  if (anchor.kind === 'date') return { date: dashedDate(wall) };
  if (anchor.kind === 'utc') return { utc: `${wall}Z` };
  if (anchor.kind === 'zoned') {
    return {
      tzid: anchor.tzid,
      local: wall,
      utc: instantOf(wall, /** @type {string} */ (anchor.tzid)),
    };
  }
  return { local: wall };
}

/**
 * The key a generated instance and an override's `RECURRENCE-ID` are matched on:
 * the wall clock the master's own zone reads for that instant. A `RECURRENCE-ID`
 * that spells the same zone (what a stock app writes) matches on its own fields,
 * so a reading that does not exist or occurs twice still matches itself.
 * @param {TimeShape} shape
 * @param {Anchor} anchor
 * @param {string} tz
 * @returns {string | undefined}
 */
function keyOfShape(shape, anchor, tz) {
  if (anchor.kind === 'date') {
    if (typeof shape.date === 'string') return `D${compactDate(shape.date)}`;
    if (typeof shape.utc === 'string')
      return `D${localOf(shape.utc, tz).slice(0, 8)}`;
    return typeof shape.local === 'string'
      ? `D${shape.local.slice(0, 8)}`
      : undefined;
  }
  if (
    typeof shape.local === 'string' &&
    shape.tzid === anchor.tzid &&
    anchor.kind === 'zoned'
  ) {
    return `T${shape.local}`;
  }
  // A floating master reads its instances in the requested zone, and a
  // `RECURRENCE-ID` that spells no zone names the same wall clock. Comparing
  // the instant here would leave the master's instance behind for any `tz` but
  // `UTC`, so it is the wall clock that matches.
  if (
    typeof shape.local === 'string' &&
    shape.tzid === undefined &&
    anchor.kind === 'floating'
  ) {
    return `T${shape.local}`;
  }
  if (
    typeof shape.utc === 'string' &&
    anchor.kind === 'utc' &&
    shape.tzid === undefined
  ) {
    return `T${shape.utc.slice(0, 15)}`;
  }
  const instant = storedInstant(shape, tz);
  if (instant === undefined) return undefined;
  if (anchor.kind === 'zoned') {
    return `T${localOf(instantString(instant), /** @type {string} */ (anchor.tzid))}`;
  }
  if (anchor.kind === 'floating') {
    return `T${localOf(instantString(instant), tz)}`;
  }
  return `T${instantString(instant).slice(0, 15)}`;
}

/** The key of an instance the expansion generated. @param {string} wall @param {Anchor} anchor */
const keyOfWall = (wall, anchor) =>
  anchor.kind === 'date' ? `D${wall}` : `T${wall}`;

/**
 * Whether `ical.js` 2.2.1 would expand this rule wrongly, or whether it is one
 * this module must not expand at all: `BYWEEKNO`, and a yearly rule anchored on
 * 29 February (`spec/ical-fixtures/RULINGS.md`).
 * @param {string} rule the rule text
 * @param {TimeShape} start the master's own start
 * @returns {boolean}
 */
function refusedRule(rule, start) {
  if (BYWEEKNO.test(rule)) return true;
  if (FREQ.exec(rule)?.[1] !== 'YEARLY') return false;
  const wall =
    typeof start.date === 'string' ? compactDate(start.date) : start.local;
  return typeof wall === 'string' && wall.slice(4, 8) === '0229';
}

/**
 * Whether a reading the expansion produced exists in the expansion's zone. It is
 * `instantOf` and back: the reading that does not occur is the one whose instant
 * reads as another wall clock.
 * @param {string} wall @param {string} tzid
 * @returns {boolean}
 */
function existsIn(wall, tzid) {
  return localOf(instantOf(wall, tzid), tzid) === wall;
}

/** The `X-CALFLEX-ENVELOPE-SHA256` of one `VEVENT`, or null. @param {ICAL.Component} event */
function envelopeOf(event) {
  const value = event.getFirstPropertyValue(ENVELOPE_HASH_PROPERTY);
  return typeof value === 'string' ? value : null;
}

/**
 * One occurrence, in the order the answer is sorted: by the instant it starts
 * at, then the `uid`, then its `recurrenceId`.
 * @typedef {object} Entry
 * @property {any} occurrence
 * @property {number} startInstant
 * @property {string} sortKey
 */

/**
 * Expand every override `VEVENT` of one object, and collect the master keys they
 * replace. Every occurrence carries the object's master `uid`. An override is
 * reported by its own times — and only when they overlap the window — but it
 * removes the master instance it names whatever its own times are.
 * @param {ICAL.Component[]} overrides
 * @param {Set<string>} replaced
 * @param {Anchor} anchor
 * @param {{from: number, to: number, tz: string}} window
 * @param {string} uid
 * @returns {{entries: Entry[]} | {reason: string}}
 */
function expandOverrides(overrides, replaced, anchor, window, uid) {
  const { from, to, tz } = window;
  /** @type {Entry[]} */
  const entries = [];
  for (const override of overrides) {
    const recurrence = timeOf(override, 'recurrence-id');
    const key =
      recurrence === null ? undefined : keyOfShape(recurrence, anchor, tz);
    if (key !== undefined) replaced.add(key);
    const start = timeOf(override, 'dtstart');
    if (start === null) continue;
    const end = timeOf(override, 'dtend');
    if (unreadableZone(start, end)) return { reason: UNKNOWN_ZONE };
    const interval = intervalOf(start, end, tz);
    if (!overlaps(interval, from, to)) continue;
    const recurrenceId = recurrence ?? null;
    entries.push({
      startInstant: interval.startInstant,
      sortKey: JSON.stringify(recurrenceId),
      occurrence: {
        uid,
        recurrenceId,
        override: true,
        start: interval.start,
        end: interval.end,
        allDay: interval.allDay,
        envelopeSha256: envelopeOf(override),
      },
    });
  }
  return { entries };
}

/**
 * Whether either stored time names a `TZID` no resolver can read. Such an object
 * is not expanded at all: the reading is not something this API may guess at.
 * @param {TimeShape | null} start @param {TimeShape | null} end
 */
function unreadableZone(start, end) {
  return [start, end].some(
    (shape) =>
      shape !== null && typeof shape.tzid === 'string' && !resolves(shape.tzid),
  );
}

/**
 * The expansion of one stored object.
 * @param {{href: string, ical: string}} object
 * @param {{from: number, to: number, tz: string}} window
 * @returns {{entries: Entry[]} | {unsupported: {uid: string, reason: string}}}
 */
function expandObject(object, window) {
  const { from, to, tz } = window;
  const calendar = parse(object.ical);
  const parsed = describe(calendar);
  /** @param {string} reason */
  // The `uid` names the object to a client; its CalDAV path stays here.
  const unsupported = (reason) => ({
    unsupported: { uid: parsed.uid, reason },
  });

  const events = calendar.getAllSubcomponents('vevent');
  // `src/ical-rmw.mjs`'s `master()`: the first VEVENT without a `RECURRENCE-ID`,
  // or the first one when every VEVENT carries one.
  const master = masterOf(calendar);
  const anchor = anchorOf(parsed.start);
  if (!isAnchor(anchor)) return unsupported(/** @type {any} */ (anchor).reason);
  const zone = /** @type {Anchor} */ (anchor);
  if (unreadableZone(parsed.start, parsed.end))
    return unsupported(UNKNOWN_ZONE);

  const hasRule = master.hasProperty('rrule');
  const hasRdate = master.hasProperty('rdate');
  if (hasRule && parsed.rrule === null) return unsupported(RULE_NOT_EXPANDED);
  if (
    typeof parsed.rrule === 'string' &&
    refusedRule(parsed.rrule, /** @type {TimeShape} */ (parsed.start))
  ) {
    return unsupported(RULE_NOT_EXPANDED);
  }

  /** @type {Entry[]} */
  const entries = [];
  /** @type {Set<string>} */
  const replaced = new Set();
  const overrides = events.filter(
    (event) => event !== master && event.hasProperty('recurrence-id'),
  );
  const fromOverrides = expandOverrides(
    overrides,
    replaced,
    zone,
    { from, to, tz },
    parsed.uid,
  );
  if ('reason' in fromOverrides) return unsupported(fromOverrides.reason);
  entries.push(...fromOverrides.entries);

  const masterInterval = intervalOf(
    /** @type {TimeShape} */ (parsed.start),
    /** @type {TimeShape | null} */ (parsed.end),
    tz,
  );
  const recurring = hasRule || hasRdate;
  const duration = masterInterval.endInstant - masterInterval.startInstant;
  const masterWall = anchorWall(/** @type {TimeShape} */ (parsed.start), zone);

  // The floating working copy the library expands (see `floatingCopy`). It has
  // no `VTIMEZONE` and no `TZID`, so `ical.js` iterates wall clocks only.
  const working = floatingCopy(calendar);
  const workingMaster = /** @type {ICAL.Component} */ (masterOf(working));

  // A `UNTIL` beside a zone start is a UTC instant, and the expansion compares
  // wall clocks: convert it once, so the library stops at the right instance,
  // and then test every rule instance against the instant as well (below).
  const until = untilOf(parsed.rrule, zone);
  if (until !== undefined && zone.kind === 'zoned') {
    const converted = localOf(until, /** @type {string} */ (zone.tzid));
    /** @type {ICAL.Property} */ (
      workingMaster.getFirstProperty('rrule')
    ).setValue(
      ICAL.Recur.fromString(
        /** @type {string} */ (parsed.rrule).replace(
          UNTIL_VALUE,
          `UNTIL=${converted}`,
        ),
      ),
    );
  }
  // A `Z` `RDATE`/`EXDATE` on a zoned master is an instant, and the floating
  // expansion speaks wall clocks: rewrite it to the wall clock the master's own
  // zone reads for it, and remember which wall clocks the `RDATE`s name, so an
  // `RDATE` beside `UNTIL` is kept (the rule is what `UNTIL` bounds) and an
  // `RDATE` that repeats a rule instance is that occurrence, not a second one.
  /** @type {Set<string>} */
  const rdateWalls = new Set();
  if (zone.kind === 'zoned') {
    for (const property of workingMaster.getAllProperties('rdate')) {
      toWallClocks(property, /** @type {string} */ (zone.tzid));
    }
    for (const property of workingMaster.getAllProperties('exdate')) {
      toWallClocks(property, /** @type {string} */ (zone.tzid));
    }
  }
  for (const property of workingMaster.getAllProperties('rdate')) {
    for (const value of property.getValues()) {
      if (value instanceof ICAL.Time) rdateWalls.add(wallClockOf(value));
    }
  }
  const untilEpoch = until === undefined ? undefined : epochOf(until);

  // The cost of an old series: an instance whose wall clock is more than two
  // days (plus the event's own length) before the window can never overlap it,
  // so the ICU work for it is skipped. `ical.js` keeps iterating, and two days
  // is more than twice the widest offset, so nothing in the answer moves.
  const cutoff = from - (2 * 86_400 + Math.max(0, duration));

  /** @type {Set<string>} */
  const emitted = new Set();
  let iterations = 0;
  let capped = false;
  try {
    const iterator = new ICAL.Event(workingMaster).iterator();
    let next = iterator.next();
    while (next) {
      iterations += 1;
      if (iterations > MAX_INSTANCES) {
        capped = true;
        break;
      }
      const wall = wallClockOf(next);
      if (proxyEpoch(wall) < cutoff) {
        next = iterator.next();
        continue;
      }
      const instant =
        zone.kind === 'date'
          ? epochOf(instantOf(`${wall}T000000`, tz))
          : generatedInstant(wall, zone, tz);
      // The instances are non-decreasing, so the first one past the window ends
      // the expansion; an unbounded rule therefore stops here rather than at the
      // cap.
      if (instant > to) break;
      // RFC 5545 § 3.3.10's two readings of an instance whose computed local
      // time does not exist. `KEEP_NONEXISTENT_INSTANCES` is the whole switch:
      // `true` keeps the instance (read with the offset before the gap, below),
      // `false` drops it — and it still spent its `COUNT`, because the library
      // counted it, which is the table's `expected` reading. The master's own
      // `DTSTART` is never dropped: § 3.3.5 form 3 reads an explicit value
      // either way. A `Z` time and an all-day date always exist.
      const keep =
        zone.kind === 'date' ||
        zone.kind === 'utc' ||
        KEEP_NONEXISTENT_INSTANCES ||
        wall === masterWall ||
        existsIn(
          wall,
          zone.kind === 'zoned' ? /** @type {string} */ (zone.tzid) : tz,
        );
      // `UNTIL` bounds the rule only: an `RDATE` past it stays. The instance
      // test beside it is the RFC's boundary even where the library's own
      // wall-clock comparison reads a different instant.
      const past =
        !rdateWalls.has(wall) &&
        untilEpoch !== undefined &&
        instant > untilEpoch;
      const key = keyOfWall(wall, zone);
      if (keep && !past && !replaced.has(key) && !emitted.has(wall)) {
        emitted.add(wall);
        const interval =
          zone.kind === 'date'
            ? dateInterval(wall, duration, tz)
            : {
                allDay: false,
                start: instantTime(instant, tz),
                end: instantTime(instant + duration, tz),
                startInstant: instant,
                endInstant: instant + duration,
              };
        if (overlaps(interval, from, to)) {
          const recurrenceId = recurring ? recurrenceIdOf(wall, zone) : null;
          entries.push({
            startInstant: interval.startInstant,
            sortKey: JSON.stringify(recurrenceId),
            occurrence: {
              uid: parsed.uid,
              recurrenceId,
              override: false,
              start: interval.start,
              end: interval.end,
              allDay: interval.allDay,
              envelopeSha256: parsed.envelopeSha256,
            },
          });
        }
      }
      next = iterator.next();
    }
  } catch (error) {
    if (error instanceof IcalError) throw error;
    // A rule the library cannot iterate is a rule this module does not expand;
    // that is never the caller's fault and never a 500.
    return unsupported(RULE_NOT_EXPANDED);
  }
  if (capped) return unsupported(TOO_MANY_INSTANCES);
  return { entries };
}

/**
 * The interval of one generated all-day instance: `duration` seconds is a whole
 * number of days, and the day is the requested zone's midnight to midnight.
 * @param {string} wall `YYYYMMDD`
 * @param {number} duration seconds (a whole number of days)
 * @param {string} tz
 * @returns {Interval}
 */
function dateInterval(wall, duration, tz) {
  const days = Math.round(duration / 86_400) || 1;
  const to = addDays(wall, Math.max(1, days));
  return {
    allDay: true,
    start: { date: dashedDate(wall) },
    end: { date: dashedDate(to) },
    startInstant: epochOf(instantOf(`${wall}T000000`, tz)),
    endInstant: epochOf(instantOf(`${to}T000000`, tz)),
  };
}

/**
 * The master's own `DTSTART` wall clock, in the same form `wallClockOf` gives
 * the expansion's instances (`YYYYMMDD` for a date, `YYYYMMDDTHHMMSS` otherwise).
 * @param {TimeShape} start @param {Anchor} anchor
 * @returns {string}
 */
function anchorWall(start, anchor) {
  if (anchor.kind === 'date')
    return compactDate(/** @type {string} */ (start.date));
  const wall = /** @type {string} */ (start.local ?? start.utc?.slice(0, 15));
  return wall;
}

/**
 * The `UNTIL` instant of a timed rule, when it carries one. A `DATE` `UNTIL`
 * (the all-day form) is compared by the expansion itself and has no instant
 * here; an anchor already in UTC or floating is in the same scale as the rule,
 * so the library's own comparison is the RFC's.
 * @param {string | null} rule
 * @param {Anchor} anchor
 * @returns {string | undefined}
 */
function untilOf(rule, anchor) {
  if (rule === null) return undefined;
  if (anchor.kind !== 'zoned') return undefined;
  const value = UNTIL.exec(rule)?.[1];
  return value !== undefined && value.endsWith('Z') ? value : undefined;
}

/**
 * The windowed expansion of a set of stored objects.
 * @param {Array<{href: string, ical: string}>} objects
 * @param {{from: string, to: string, tz: string}} window
 * @returns {{occurrences: any[], unsupported: Array<{uid: string, reason: string}>}}
 */
export function expandOccurrences(objects, { from, to, tz }) {
  const fromEpoch = epochOf(from);
  const toEpoch = epochOf(to);
  /** @type {Entry[]} */
  const entries = [];
  /** @type {Array<{uid: string, reason: string}>} */
  const unsupported = [];
  for (const object of objects) {
    const result = expandObject(object, {
      from: fromEpoch,
      to: toEpoch,
      tz,
    });
    if ('unsupported' in result) {
      unsupported.push(result.unsupported);
      continue;
    }
    entries.push(...result.entries);
  }
  entries.sort(compareEntries);
  return { occurrences: entries.map((entry) => entry.occurrence), unsupported };
}

/** @param {Entry} left @param {Entry} right */
function compareEntries(left, right) {
  if (left.startInstant !== right.startInstant) {
    return left.startInstant - right.startInstant;
  }
  const leftUid = String(left.occurrence.uid);
  const rightUid = String(right.occurrence.uid);
  if (leftUid !== rightUid) return leftUid < rightUid ? -1 : 1;
  return left.sortKey < right.sortKey
    ? -1
    : left.sortKey > right.sortKey
      ? 1
      : 0;
}
