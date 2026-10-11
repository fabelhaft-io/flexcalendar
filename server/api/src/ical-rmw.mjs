// --- E05-R04: the API's iCalendar read-modify-write path ---------------------
//
// One module parses iCalendar, one module writes it back: `parse`, `patch` and
// `serialise` on **`ical.js` 2.2.1**, the API's single iCalendar engine (D-01,
// ADR 0002, INV-05 — the client never hand-writes `EXDATE`/`RECURRENCE-ID`, and
// no RRULE expansion is hand-rolled anywhere). `src/events.mjs` is the only
// caller: create builds a skeleton with `build`, update reads the stored object
// and re-writes it with `patch`.
//
// **Everything the module does not touch survives untouched.** A component, a
// property, a parameter or an `X-` property it has never heard of — a
// `VTIMEZONE` included — is parsed, carried and serialised unchanged (INV-02).
// `test/ical-rmw.test.mjs` holds that promise with E15-R01's `checkRoundTrip`
// over `spec/ical-fixtures/`, first with a no-op patch and then field by field,
// so this module is the `roundTrip` the corpus gate was built to receive.
//
// Two properties of the design are worth stating, because both are load-bearing:
//
//   * **The module never converts a time.** It writes a `VALUE=DATE` date or a
//     `Z` instant, and it reads back what the object spells: a `TZID` time is
//     reported as its wall clock plus its `TZID`, never converted to an instant.
//     `ical.js` carries no zone database and is wrong on a skipped and on a
//     repeated local time (`spec/ical-fixtures/dst/README.md`); E05-R09 owns
//     zone handling. A read-modify-write therefore keeps a stored `TZID` time
//     exactly as it is and never invents one (INV-02, INV-04).
//   * **Nothing a caller sends reaches the text verbatim.** Every field is
//     parsed into an `ical.js` value and serialised from that value, and the
//     control characters the library writes through unescaped — a carriage
//     return above all — are refused. A value can therefore never become a
//     content line of its own. The field checks below are what make that true.
//
// **Only objects RFC 5545 allows are written.** `assertOrder` holds the two
// rules a field set can break without any one field being wrong: `start` and
// `end` are the same value type and the end is the later one (§ 3.8.2.2), and
// `setRecur` accepts exactly the rule parts § 3.3.10 names, refuses `BYWEEKNO`
// and a yearly 29-February start (`spec/ical-fixtures/RULINGS.md`, where
// `ical.js` 2.2.1 expands them wrongly) and checks `UNTIL`'s value type against
// the start. The routes call the first after a create and after a patch, so a
// patch is checked against the stored object too.
//
// Refusals are `IcalError`s. `kind` starts with `invalid-` when the caller's
// field cannot be written (the route answers 422), and names anything else when
// the *stored* text cannot be read (the route answers 502). A kind is a fixed
// word: no message, no value and no property content is ever raised from here.

import ICAL from 'ical.js';

/**
 * The `PRODID` of every object this API writes. It matches the `ours/` fixtures
 * of the round-trip corpus, which are the objects our own code produces.
 */
export const PRODID = '-//flexcalendar//Private skeleton//EN';

/** The property a `VEVENT` carries its sidecar envelope hash in (E03-R09). */
export const ENVELOPE_HASH_PROPERTY = 'x-calflex-envelope-sha256';

/** The alarm a skeleton carries; the write guard accepts exactly this one. */
export const ALARM_DESCRIPTION = 'Reminder';

/** `YYYY-MM-DD`, the all-day `VALUE=DATE` form. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `YYYYMMDDTHHMMSSZ`, the UTC instant INV-04 asks our own writes to carry. */
const INSTANT = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
/**
 * The characters an RRULE value may hold. RFC 5545 § 3.3.10's `recur` grammar
 * is names, digits and `; , = + - /`, and nothing else — in particular no
 * whitespace and no control character, so a value cannot end a content line.
 */
const RECUR_VALUE = /^[A-Za-z0-9;,=+\-/]+$/;
/** The seven `FREQ` values RFC 5545 defines. */
const FREQUENCIES = [
  'SECONDLY',
  'MINUTELY',
  'HOURLY',
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'YEARLY',
];
/**
 * Every rule part RFC 5545 § 3.3.10 defines, and nothing else. A part outside
 * this list is a 422 rather than something the library drops while the write
 * looks successful: a misspelled part would change what the client meant without
 * a word, and a client never writes the recurrence itself (INV-05).
 */
const RECUR_PARTS = [
  'FREQ',
  'UNTIL',
  'COUNT',
  'INTERVAL',
  'BYSECOND',
  'BYMINUTE',
  'BYHOUR',
  'BYDAY',
  'BYMONTHDAY',
  'BYYEARDAY',
  'BYWEEKNO',
  'BYMONTH',
  'BYSETPOS',
  'WKST',
];
/** `UNTIL` of an all-day rule: a `DATE` (§ 3.3.10, `VALUE=DATE`). */
const UNTIL_DATE = /^\d{8}$/;
/** `UNTIL` of a timed rule: a UTC `DATE-TIME`; a local one would need a `TZID`. */
const UNTIL_INSTANT = /^\d{8}T\d{6}Z$/;
/** A rule part, as `name=value`. The name is a run of letters, the value is not empty. */
const RECUR_PART = /^([A-Za-z]+)=([^=]+)$/;
/** A positive integer, which `COUNT` and `INTERVAL` are (`1` is their default). */
const POSITIVE = /^[1-9]\d*$/;
/** The seven weekday codes `BYDAY` and `WKST` are built from. */
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
/**
 * The parts whose value is also RFC 5545's own default for it, so `ical.js`
 * omits them from what it writes back — `INTERVAL=1` and `WKST=MO`. Every other
 * part a client sent has to come back out; one the library cannot represent is a
 * 422 rather than a rule the client did not ask for.
 */
/** @type {Record<string, string>} */
const RECUR_DEFAULTS = { INTERVAL: '1', WKST: 'MO' };
/** The `UNTIL` value of a rule `ical.js` wrote, or undefined. */
const UNTIL_OF = /(?:^|;)UNTIL=([^;]+)/;
/** A URI-shaped `cal-address`: a scheme, a colon, and no separator after it. */
const CAL_ADDRESS = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s,;:]+$/;
/**
 * The `UID` this API mints (INV-03): a lowercase UUIDv4, and nothing else. The
 * module refuses to write any other one, so no code path can produce a `UID`
 * that is derived from content or that CalDAV's `VARCHAR(200)` column would
 * reject (E03-R10).
 */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/**
 * A control character a text value may not carry: every C0 control except the
 * line feed, plus DEL. `ical.js` escapes a line feed as `\n`, which is the RFC
 * 5545 § 3.3.11 escape for a line break *inside* a value — but it writes a
 * carriage return and a NUL through untouched, and a raw CR ends the content
 * line, which would let a value add a property of its own.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;

/**
 * A refusal from this module. `kind` is one fixed word — a caller's unusable
 * field (`invalid-…`) or stored text this module cannot read. The message holds
 * the kind and nothing else: never a property value, and never a byte of the
 * object.
 */
export class IcalError extends Error {
  /** @param {string} kind */
  constructor(kind) {
    super(`iCalendar ${kind}`);
    this.name = 'IcalError';
    this.kind = kind;
  }
}

/**
 * Reads one iCalendar text into a component. The caller owns the component and
 * may mutate it; every other caller's copy is a fresh parse.
 *
 * A `TZID` the document defines itself is **not** registered in ical.js's global
 * `TimezoneService`: registering one is process-wide state, and this module
 * never needs a zone resolution. Reading a `TZID` time back gives its wall clock
 * and its `TZID` name, which is what the object spells.
 *
 * @param {string} text
 * @returns {ICAL.Component}
 */
export function parse(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new IcalError('unparsable');
  }
  /** @type {ICAL.Component} */
  let calendar;
  try {
    calendar = new ICAL.Component(ICAL.parse(text));
  } catch {
    throw new IcalError('unparsable');
  }
  if (String(calendar.name ?? '').toUpperCase() !== 'VCALENDAR') {
    throw new IcalError('not-calendar');
  }
  return calendar;
}

/**
 * Writes a component back to text, `CRLF`-folded as RFC 5545 § 3.1 asks.
 * @param {ICAL.Component} calendar
 * @returns {string}
 */
export function serialise(calendar) {
  return calendar.toString();
}

/**
 * The master `VEVENT`: the first one that is not an override, or the first one
 * when every `VEVENT` carries a `RECURRENCE-ID`. Overrides are left alone by
 * `patch`, so they survive an edit of their master byte for byte.
 * @param {ICAL.Component} calendar
 * @returns {ICAL.Component | undefined}
 */
export function master(calendar) {
  const events = calendar.getAllSubcomponents('vevent');
  return (
    events.find((event) => !event.hasProperty('recurrence-id')) ?? events[0]
  );
}

/**
 * The parsed convenience view of one object's master `VEVENT`: what a client
 * needs to render or compare an event without parsing iCalendar itself. It
 * carries no content — no `SUMMARY`, no `DESCRIPTION`, no `ATTENDEE` — and no
 * override list; the raw `ical` beside it is the whole object.
 *
 * A time is `{date}` (`YYYY-MM-DD`), `{utc}` (`YYYYMMDDTHHMMSSZ`) or `{local}`
 * with the `TZID` the property names when it names one. A `TZID` time is never
 * converted to an instant here (E05-R09 owns zones).
 *
 * @param {ICAL.Component} calendar
 * @returns {{uid: string, start: any, end: any, rrule: string | null, alarm: {trigger: string} | null, sequence: number, envelopeSha256: string | null}}
 */
export function describe(calendar) {
  const event = master(calendar);
  if (event === undefined) throw new IcalError('no-event');
  const uid = event.getFirstPropertyValue('uid');
  if (typeof uid !== 'string' || uid === '') throw new IcalError('no-uid');
  return {
    uid,
    start: timeOf(event, 'dtstart'),
    end: timeOf(event, 'dtend'),
    rrule: recurOf(event),
    alarm: alarmOf(event),
    sequence: sequenceOf(event),
    envelopeSha256: textOf(event, ENVELOPE_HASH_PROPERTY),
  };
}

/**
 * Reads a time property back in the shape `src/events.mjs` writes one.
 * @param {ICAL.Component} event
 * @param {string} name
 * @returns {{date: string} | {utc: string} | {local: string, tzid?: string} | null}
 */
function timeOf(event, name) {
  const property = event.getFirstProperty(name);
  if (!property) return null;
  const value = property.getFirstValue();
  if (!(value instanceof ICAL.Time)) throw new IcalError('unreadable-time');
  if (value.isDate) return { date: dateOf(value) };
  const fields = value.toJSON();
  const wall = compact(fields);
  const tzid = property.getParameter('tzid');
  if (typeof tzid === 'string' && tzid !== '') return { tzid, local: wall };
  // A floating time names no instant and carries no `Z`; INV-04 forbids our own
  // writes from producing one, but an object that arrived with one is reported
  // exactly as it is rather than guessed at.
  return value.zone === ICAL.Timezone.utcTimezone
    ? { utc: `${wall}Z` }
    : { local: wall };
}

/**
 * The master's `RRULE` as the rule string it spells, or null. Read from the
 * parsed recurrence, so a rule with an `UNTIL` in a zone comes back as the same
 * text the object carries.
 * @param {ICAL.Component} event
 * @returns {string | null}
 */
function recurOf(event) {
  const property = event.getFirstProperty('rrule');
  if (!property) return null;
  const value = property.getFirstValue();
  return value instanceof ICAL.Recur ? value.toString() : null;
}

/**
 * The `VALARM` of the master, or null. Only the trigger is part of the view:
 * the action and the description are ours (`ACTION:DISPLAY`,
 * `DESCRIPTION:Reminder`, E03-R09).
 * @param {ICAL.Component} event
 * @returns {{trigger: string} | null}
 */
function alarmOf(event) {
  const alarm = event.getFirstSubcomponent('valarm');
  if (!alarm) return null;
  const trigger = alarm.getFirstProperty('trigger');
  if (!trigger) return null;
  const value = trigger.getFirstValue();
  if (value instanceof ICAL.Duration) return { trigger: value.toString() };
  if (value instanceof ICAL.Time) return { trigger: value.toICALString() };
  return { trigger: String(value ?? '') };
}

/**
 * `SEQUENCE` as an integer. RFC 5545 § 3.8.7.4 makes it 0 when it is absent,
 * which is what `describe` reports for the object an event was created as.
 * @param {ICAL.Component} event
 * @returns {number}
 */
function sequenceOf(event) {
  const value = event.getFirstPropertyValue('sequence');
  return Number.isInteger(value) ? Number(value) : 0;
}

/**
 * A single-valued text property, or null when the object carries none.
 * @param {ICAL.Component} event
 * @param {string} name
 * @returns {string | null}
 */
function textOf(event, name) {
  const property = event.getFirstProperty(name);
  if (!property) return null;
  const value = property.getFirstValue();
  return typeof value === 'string' ? value : null;
}

/**
 * The clock a time property spells, as the object carries it: an all-day date,
 * an instant, a `TZID` wall clock or a floating one. Two clocks are comparable
 * only when they are the same shape: comparing across zones would be zone maths,
 * which this module never does (`spec/ical-fixtures/dst/README.md`, E05-R09).
 * `undefined` when the object carries no such property or holds a value that is
 * not a time at all.
 * @param {ICAL.Component} event
 * @param {string} name
 * @returns {{allDay: boolean, scale: string, key: string} | undefined}
 */
function clockOf(event, name) {
  const property = event.getFirstProperty(name);
  if (!property) return undefined;
  const value = property.getFirstValue();
  if (!(value instanceof ICAL.Time)) return undefined;
  if (value.isDate) {
    return {
      allDay: true,
      scale: 'date',
      key: dateOf(value).replaceAll('-', ''),
    };
  }
  const wall = compact(value.toJSON());
  const tzid = property.getParameter('tzid');
  if (typeof tzid === 'string' && tzid !== '') {
    return { allDay: false, scale: `tzid:${tzid}`, key: wall };
  }
  return value.zone === ICAL.Timezone.utcTimezone
    ? { allDay: false, scale: 'instant', key: `${wall}Z` }
    : { allDay: false, scale: 'floating', key: wall };
}

/**
 * Refuses a `DTSTART`/`DTEND` pair RFC 5545 forbids: the two are the same value
 * type (§ 3.8.2.2 — an all-day `VALUE=DATE` start is never paired with a
 * `DATE-TIME` end, or the other way round, INV-04), and the end is later than
 * the start. An end at or before its start is refused as well: a zero-length or
 * negative event is not something a client means to write.
 *
 * The routes call this after a create and after a patch, so a member the caller
 * did not send is checked against the stored object all the same. Two clocks in
 * forms this module cannot compare without a zone — a `Z` instant beside a
 * `TZID` wall clock, or two different `TZID`s — are left alone: E05-R09 owns
 * zone handling, and a stored object may legitimately mix them (INV-02).
 *
 * @param {ICAL.Component} calendar
 * @returns {ICAL.Component}
 */
export function assertOrder(calendar) {
  const event = master(calendar);
  if (event === undefined) throw new IcalError('no-event');
  const start = clockOf(event, 'dtstart');
  const end = clockOf(event, 'dtend');
  if (start === undefined || end === undefined) return calendar;
  if (start.allDay !== end.allDay) throw new IcalError('invalid-times');
  if (start.scale !== end.scale) return calendar;
  if (end.key <= start.key) throw new IcalError('invalid-times');
  return calendar;
}

/**
 * Builds the object a create writes: a fresh `VCALENDAR` holding one `VEVENT`
 * and, when one was asked for, one `VALARM`. `uid` and `dtstamp` are the
 * caller's — the API mints both (INV-03) — and the order of the properties is
 * the order the `ours/` corpus fixtures carry.
 *
 * @param {object} fields
 * @param {string} fields.uid the `UID` (a UUIDv4 the API minted, INV-03)
 * @param {string} fields.dtstamp the `DTSTAMP`, `YYYYMMDDTHHMMSSZ`
 * @param {{date?: string, utc?: string}} fields.start
 * @param {{date?: string, utc?: string} | null} [fields.end]
 * @param {string | null} [fields.rrule]
 * @param {{trigger: string} | null} [fields.alarm]
 * @param {string | null} [fields.envelopeSha256]
 * @param {number | null} [fields.sequence]
 * @param {string | undefined} [fields.summary]
 * @param {string | undefined} [fields.description]
 * @param {string | undefined} [fields.location]
 * @param {string[] | undefined} [fields.attendees]
 * @returns {ICAL.Component}
 */
export function build(fields) {
  if (typeof fields?.uid !== 'string' || !UUID_V4.test(fields.uid)) {
    throw new IcalError('invalid-uid');
  }
  if (fields.start === undefined) throw new IcalError('invalid-start');
  const calendar = new ICAL.Component(['vcalendar', [], []]);
  calendar.addPropertyWithValue('version', '2.0');
  calendar.addPropertyWithValue('prodid', PRODID);
  const event = new ICAL.Component('vevent');
  event.addPropertyWithValue('uid', fields.uid);
  event.addPropertyWithValue(
    'dtstamp',
    instant(fields.dtstamp, 'invalid-dtstamp'),
  );
  calendar.addSubcomponent(event);
  patch(calendar, {
    start: fields.start,
    end: fields.end,
    rrule: fields.rrule,
    alarm: fields.alarm,
    envelopeSha256: fields.envelopeSha256,
    sequence: fields.sequence ?? undefined,
    // Phase 4's content fields. A Private calendar refuses them before a
    // request gets here (E03-R09 stores skeletons); a Shared one keeps them.
    ...(fields.summary === undefined ? {} : { summary: fields.summary }),
    ...(fields.description === undefined
      ? {}
      : { description: fields.description }),
    ...(fields.location === undefined ? {} : { location: fields.location }),
    ...(fields.attendees === undefined ? {} : { attendees: fields.attendees }),
  });
  return calendar;
}

/**
 * Applies one change set to the master `VEVENT` of an object and answers with
 * the same calendar. A member that is absent from `changes` is left alone; a
 * member that is `null` removes the property; `attendees: []` removes every
 * `ATTENDEE`. Nothing else in the document is touched, overrides included.
 *
 * @param {ICAL.Component} calendar
 * @param {object} changes
 * @param {{date?: string, utc?: string} | null} [changes.start]
 * @param {{date?: string, utc?: string} | null} [changes.end]
 * @param {string | null} [changes.rrule]
 * @param {{trigger: string} | null} [changes.alarm]
 * @param {string | null} [changes.envelopeSha256]
 * @param {string | null} [changes.summary]
 * @param {string | null} [changes.description]
 * @param {string | null} [changes.location]
 * @param {string[] | null} [changes.attendees]
 * @param {number} [changes.sequence]
 * @param {string} [changes.dtstamp]
 * @returns {ICAL.Component}
 */
export function patch(calendar, changes) {
  const event = master(calendar);
  if (event === undefined) throw new IcalError('no-event');

  if (changes.dtstamp !== undefined) {
    setTime(event, 'dtstamp', instant(changes.dtstamp, 'invalid-dtstamp'));
  }
  if (changes.start !== undefined) {
    setTime(event, 'dtstart', timeField(changes.start, 'invalid-start'));
  }
  if (changes.end !== undefined) {
    // `null` is how a caller says "this event has no `DTEND`"; a `DTSTART` is
    // not optional, so `null` there is refused by `timeField`.
    setTime(
      event,
      'dtend',
      changes.end === null ? null : timeField(changes.end, 'invalid-end'),
    );
  }
  if (changes.rrule !== undefined) setRecur(event, changes.rrule);
  if (changes.envelopeSha256 !== undefined) {
    setText(
      event,
      ENVELOPE_HASH_PROPERTY,
      hash(changes.envelopeSha256, 'invalid-envelope'),
    );
  }
  if (changes.summary !== undefined) {
    setText(event, 'summary', text(changes.summary, 'invalid-summary'));
  }
  if (changes.description !== undefined) {
    setText(
      event,
      'description',
      text(changes.description, 'invalid-description'),
    );
  }
  if (changes.location !== undefined) {
    setText(event, 'location', text(changes.location, 'invalid-location'));
  }
  if (changes.attendees !== undefined) setAttendees(event, changes.attendees);
  if (changes.sequence !== undefined) setSequence(event, changes.sequence);
  if (changes.alarm !== undefined) setAlarm(event, changes.alarm);

  return calendar;
}

/**
 * `DTSTAMP` (and every time this module writes into a `DATE-TIME` value):
 * `YYYYMMDDTHHMMSSZ`, checked against the calendar the way `Time` stores it, so
 * `20260230T…` is refused rather than rolled into March.
 * @param {unknown} value
 * @param {string} kind
 * @returns {ICAL.Time}
 */
function instant(value, kind) {
  const match = typeof value === 'string' ? INSTANT.exec(value) : null;
  if (!match) throw new IcalError(kind);
  const time = ICAL.Time.fromDateTimeString(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`,
  );
  if (`${compact(time.toJSON())}Z` !== value) throw new IcalError(kind);
  return time;
}

/**
 * One time field of a request: `{date}` (`YYYY-MM-DD`, all-day) or `{utc}`
 * (`YYYYMMDDTHHMMSSZ`, an instant) — exactly one member, and nothing else. A
 * `TZID` is refused with the same kind: until E05-R09 lands, a write carrying
 * one is a 422 (INV-04), while a stored `TZID` time is read and round-tripped
 * untouched.
 * @param {unknown} value
 * @param {string} kind
 * @returns {ICAL.Time}
 */
function timeField(value, kind) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new IcalError(kind);
  }
  const field = /** @type {Record<string, unknown>} */ (value);
  const members = Object.keys(field);
  if (members.length !== 1) throw new IcalError(kind);
  if (members[0] === 'date') {
    const match = typeof field.date === 'string' ? DATE.exec(field.date) : null;
    if (!match) throw new IcalError(kind);
    const date = ICAL.Time.fromDateString(/** @type {string} */ (field.date));
    // `fromDateString` rolls an impossible date forward (`2026-02-30` becomes
    // 2 March), so the value has to come back out of the library as it went in.
    if (dateOf(date) !== field.date) throw new IcalError(kind);
    return date;
  }
  if (members[0] === 'utc') return instant(field.utc, kind);
  throw new IcalError(kind);
}

/**
 * Replaces a time property, or removes it when the value is null.
 * @param {ICAL.Component} event
 * @param {string} name
 * @param {ICAL.Time | null} value
 */
function setTime(event, name, value) {
  event.removeAllProperties(name);
  if (value === null) return;
  event.addPropertyWithValue(name, value);
}

/**
 * Replaces a text property, or removes it when the value is null (`ical.js`
 * escapes the value on the way out, so a newline in it stays inside the value).
 * @param {ICAL.Component} event
 * @param {string} name
 * @param {string | null} value
 */
function setText(event, name, value) {
  event.removeAllProperties(name);
  if (value === null) return;
  event.addPropertyWithValue(name, value);
}

/**
 * A text value, or null to remove the property. A control character other than
 * a line feed is refused: `ical.js` escapes a line feed, but a raw carriage
 * return ends the content line and would let the value add a property.
 * @param {unknown} value
 * @param {string} kind
 * @returns {string | null}
 */
function text(value, kind) {
  if (value === null) return null;
  if (typeof value !== 'string' || CONTROL.test(value)) {
    throw new IcalError(kind);
  }
  return value;
}

/**
 * The envelope hash the write guard checks (E03-R09): 64 lowercase hex digits.
 * @param {unknown} value
 * @param {string} kind
 * @returns {string | null}
 */
function hash(value, kind) {
  if (value === null) return null;
  const checked = text(value, kind);
  if (checked === null || !/^[0-9a-f]{64}$/.test(checked)) {
    throw new IcalError(kind);
  }
  return checked;
}

/**
 * Replaces the `RRULE`. The value is a rule string the client asked for; it is
 * parsed into an `ical.js` recurrence and serialised from that, so only the
 * grammar's own characters can reach the text.
 *
 * Every part is checked before the library sees it (RFC 5545 § 3.3.10):
 * `FREQ` is required and first, only the parts the RFC names are accepted, and
 * none of them twice — an unknown part is a 422 rather than something the
 * library drops silently. `COUNT` and `UNTIL` are mutually exclusive, and
 * `UNTIL` has the value type of the start: a `DATE` for an all-day rule, a UTC
 * `DATE-TIME` for a timed one. Two families `ical.js` 2.2.1 expands wrongly are
 * refused rather than expanded (`spec/ical-fixtures/RULINGS.md`): any rule
 * naming `BYWEEKNO`, and a yearly rule whose start is 29 February.
 *
 * Nothing else is accepted silently: a part whose value is not the shape the
 * RFC gives it (`COUNT` and `INTERVAL` are positive integers, `WKST` is a
 * weekday), a part `ical.js` would drop rather than write — `COUNT=0` would turn
 * a bounded rule unbounded — and an `UNTIL` the library rolls forward from an
 * impossible date are all the same 422. Only a part whose value is the RFC's own
 * default itself (`INTERVAL=1`, `WKST=MO`) may leave the written rule.
 *
 * @param {ICAL.Component} event
 * @param {unknown} value
 */
function setRecur(event, value) {
  event.removeAllProperties('rrule');
  if (value === null) return;
  if (typeof value !== 'string' || !RECUR_VALUE.test(value)) {
    throw new IcalError('invalid-rrule');
  }
  /** @type {Map<string, string>} */
  const parts = new Map();
  for (const [index, part] of value.split(';').entries()) {
    const match = RECUR_PART.exec(part);
    if (!match) throw new IcalError('invalid-rrule');
    const name = match[1].toUpperCase();
    if (!RECUR_PARTS.includes(name)) throw new IcalError('invalid-rrule');
    if (parts.has(name)) throw new IcalError('invalid-rrule');
    if (index === 0 && name !== 'FREQ') throw new IcalError('invalid-rrule');
    parts.set(name, match[2]);
  }
  const freq = parts.get('FREQ');
  if (freq === undefined || !FREQUENCIES.includes(freq.toUpperCase())) {
    throw new IcalError('invalid-rrule');
  }
  if (parts.has('COUNT') && parts.has('UNTIL')) {
    throw new IcalError('invalid-rrule');
  }
  if (parts.has('BYWEEKNO')) throw new IcalError('invalid-rrule');
  for (const name of ['COUNT', 'INTERVAL']) {
    const value = parts.get(name);
    if (value !== undefined && !POSITIVE.test(value)) {
      throw new IcalError('invalid-rrule');
    }
  }
  const wkst = parts.get('WKST');
  if (wkst !== undefined && !WEEKDAYS.includes(wkst.toUpperCase())) {
    throw new IcalError('invalid-rrule');
  }
  const start = event.getFirstProperty('dtstart')?.getFirstValue();
  if (!(start instanceof ICAL.Time)) throw new IcalError('invalid-rrule');
  const until = parts.get('UNTIL');
  if (until !== undefined) {
    const shape = start.isDate ? UNTIL_DATE : UNTIL_INSTANT;
    if (!shape.test(until)) throw new IcalError('invalid-rrule');
  }
  if (
    freq.toUpperCase() === 'YEARLY' &&
    start.month === 2 &&
    start.day === 29
  ) {
    throw new IcalError('invalid-rrule');
  }
  /** @type {ICAL.Recur} */
  let recur;
  try {
    recur = ICAL.Recur.fromString(value);
  } catch {
    throw new IcalError('invalid-rrule');
  }
  const written = String(recur);
  const kept = new Set(
    written.split(';').map((part) => part.slice(0, part.indexOf('='))),
  );
  for (const [name, part] of parts) {
    if (kept.has(name) || RECUR_DEFAULTS[name] === part.toUpperCase()) continue;
    throw new IcalError('invalid-rrule');
  }
  // The library normalises a value it cannot represent in place — it rolls
  // `20260230` to 2 March — so the one rule part this module writes verbatim has
  // to come back out exactly as it went in.
  if (until !== undefined && UNTIL_OF.exec(written)?.[1] !== until) {
    throw new IcalError('invalid-rrule');
  }
  event.addPropertyWithValue('rrule', recur);
}

/**
 * Replaces the single `VALARM` a skeleton carries. The action and the
 * description are fixed (E03-R09 accepts only `DESCRIPTION:Reminder`); the
 * trigger is an ISO 8601 duration, written as `ical.js` serialises the parsed
 * duration so nothing else can reach the line.
 * @param {ICAL.Component} event
 * @param {unknown} value
 */
function setAlarm(event, value) {
  for (const alarm of event.getAllSubcomponents('valarm')) {
    event.removeSubcomponent(alarm);
  }
  if (value === null) return;
  if (
    value === undefined ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new IcalError('invalid-alarm');
  }
  const field = /** @type {Record<string, unknown>} */ (value);
  if (Object.keys(field).length !== 1 || typeof field.trigger !== 'string') {
    throw new IcalError('invalid-alarm');
  }
  /** @type {ICAL.Duration} */
  let duration;
  try {
    duration = ICAL.Duration.fromString(field.trigger);
  } catch {
    throw new IcalError('invalid-alarm');
  }
  const alarm = new ICAL.Component('valarm');
  alarm.addPropertyWithValue('action', 'DISPLAY');
  alarm.addPropertyWithValue('trigger', duration);
  alarm.addPropertyWithValue('description', ALARM_DESCRIPTION);
  event.addSubcomponent(alarm);
}

/**
 * Replaces every `ATTENDEE` with the list the caller sent, or removes them all
 * when the list is empty. A `cal-address` is not a text value, so it is checked
 * rather than escaped: a scheme, a colon, and no separator after it.
 * @param {ICAL.Component} event
 * @param {unknown} value
 */
function setAttendees(event, value) {
  event.removeAllProperties('attendee');
  if (value === null) return;
  if (!Array.isArray(value)) throw new IcalError('invalid-attendees');
  for (const address of value) {
    if (typeof address !== 'string' || !CAL_ADDRESS.test(address)) {
      throw new IcalError('invalid-attendees');
    }
    event.addPropertyWithValue('attendee', address);
  }
}

/**
 * Sets `SEQUENCE`. The update path bumps it (RFC 5545 § 3.8.7.4: a revision
 * that changes the object increments it), which is the caller's decision, not
 * this module's.
 * @param {ICAL.Component} event
 * @param {unknown} value
 */
function setSequence(event, value) {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new IcalError('invalid-sequence');
  }
  event.removeAllProperties('sequence');
  event.addPropertyWithValue('sequence', Number(value));
}

/** @param {number} value @param {number} width */
const pad = (value, width) => String(value).padStart(width, '0');

/**
 * The `YYYYMMDDTHHMMSS` wall clock of a time, from the fields `Time` holds —
 * never through a zone conversion.
 * @param {any} fields the fields `ICAL.Time#toJSON()` answers with
 * @returns {string}
 */
function compact(fields) {
  return (
    `${pad(fields.year, 4)}${pad(fields.month, 2)}${pad(fields.day, 2)}` +
    `T${pad(fields.hour, 2)}${pad(fields.minute, 2)}${pad(fields.second, 2)}`
  );
}

/**
 * The `YYYY-MM-DD` of an all-day `Time`.
 * @param {ICAL.Time} value
 * @returns {string}
 */
function dateOf(value) {
  const fields = value.toJSON();
  return `${pad(fields.year, 4)}-${pad(fields.month, 2)}-${pad(fields.day, 2)}`;
}
