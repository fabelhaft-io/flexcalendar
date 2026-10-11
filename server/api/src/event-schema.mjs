// --- E05-R04: the JSON schemas of an event ----------------------------------
//
// `spec/openapi.yaml` declares the identical documents; `test/contract.test.mjs`
// holds the two together, per operation and per status. They live in a module of
// their own because two owners need them: the events routes (`src/events.mjs`)
// as their response schemas, and the problem document (`src/problem.mjs`), whose
// 412 carries the current representation in its `current` member. Importing
// either of those from the other would be a cycle, and a cycle through
// `problemSchema` would be a load-order bug rather than a style question.
//
// Only the **responses** live here. A request body is validated by the route
// handlers, never by a route schema: a schema-refused body is a 400, and every
// rule of E05-R04 has to answer 422 — so the request bodies are declared in
// `spec/openapi.yaml` alone, exactly as E05-R03's `CalendarCreate` is.
//
// A nullable member is a union type (`type: ['null', string]`), written in the
// order the schema compiler stores it in: `ajv` sorts a `type` union, and the
// contract test compares the route's own schema with the spec's.

/**
 * One event time, in both directions. A write sends one of three forms:
 * `date` (`YYYY-MM-DD`, all-day), `utc` (`YYYYMMDDTHHMMSSZ`, an instant) or
 * `local` beside `tzid` — an IANA zone in its exact spelling and the wall clock
 * that zone reads. A read answers the form the stored object spells, and beside
 * a `TZID` time the instant that reading names (`utc`) when the zone resolves.
 * `null` appears in the parsed view when the object carries no such property.
 */
export const eventTimeSchema = {
  type: ['null', 'object'],
  description:
    'One event time. A write sends one of three forms: `date` (an all-day VALUE=DATE, `YYYY-MM-DD`), `utc` (an instant, `YYYYMMDDTHHMMSSZ`), or `local` together with `tzid` (an IANA zone in its exact spelling and the wall clock it reads, `YYYYMMDDTHHMMSS`). A read answers the form the stored property spells — `date`, `utc`, or `local` with the `tzid` beside it — and a `TZID` time also carries `utc`, the instant that reading names, when the zone resolves (E05-R09). `null` when the object carries no such property.',
  additionalProperties: false,
  properties: {
    date: {
      type: 'string',
      description: 'An all-day date, `YYYY-MM-DD`.',
    },
    utc: {
      type: 'string',
      description:
        'A UTC instant, `YYYYMMDDTHHMMSSZ`. On a `local` time it is computed from the zone, never converted back.',
    },
    tzid: {
      type: 'string',
      description:
        'The `TZID` the stored property names, unchanged, or the IANA zone a write names.',
    },
    local: {
      type: 'string',
      description:
        'The wall clock the stored property spells, `YYYYMMDDTHHMMSS`.',
    },
  },
};

/**
 * The single reminder a skeleton carries. The action and the description are
 * fixed (`ACTION:DISPLAY`, `DESCRIPTION:Reminder`, E03-R09); `trigger` is an
 * ISO 8601 duration, `-PT15M` for fifteen minutes before the start. A write
 * sends `null` to remove the reminder.
 */
export const eventAlarmSchema = {
  type: ['null', 'object'],
  description:
    'The reminder: an ISO 8601 duration trigger, e.g. `-PT15M` for fifteen minutes before the start. `null` in a write removes it, and `null` in a read means the object carries none. The action and description are fixed (`ACTION:DISPLAY`, `DESCRIPTION:Reminder`).',
  additionalProperties: false,
  required: ['trigger'],
  properties: {
    trigger: {
      type: 'string',
      description: 'An ISO 8601 duration, e.g. `-PT15M`.',
    },
  },
};

/**
 * The parsed convenience view of one event: what a client renders or compares
 * without parsing iCalendar itself. It carries no content and no override list;
 * the `ical` beside it is the whole object.
 */
export const eventParsedSchema = {
  type: 'object',
  description:
    'The master VEVENT, parsed. No content and no override list: the raw `ical` beside it is the whole object.',
  required: [
    'uid',
    'start',
    'end',
    'rrule',
    'alarm',
    'sequence',
    'envelopeSha256',
  ],
  additionalProperties: false,
  properties: {
    uid: {
      type: 'string',
      description: 'The master VEVENT `UID`, exactly as stored.',
    },
    start: eventTimeSchema,
    end: eventTimeSchema,
    rrule: {
      type: ['null', 'string'],
      description: 'The master `RRULE`, or null. Never written by a client.',
    },
    alarm: eventAlarmSchema,
    sequence: {
      type: 'integer',
      description: 'The master `SEQUENCE`; 0 when the object carries none.',
    },
    envelopeSha256: {
      type: ['null', 'string'],
      description:
        'The `X-CALFLEX-ENVELOPE-SHA256` of the master VEVENT, 64 lowercase hex digits, or null when it carries none (a Shared calendar object).',
    },
  },
};

/**
 * One event as the API answers with it. `ical` is the object the collection
 * stores, byte for byte, and `etag` is CalDAV's, which is also the `ETag`
 * response header — together they are what the offline cache keeps as the
 * canonical record (`docs/02` § Offline cache).
 */
export const eventSchema = {
  type: 'object',
  description:
    'One event: the raw iCalendar object the CalDAV collection stores (`ical`, byte for byte) and its `ETag`, plus a parsed convenience view. On a Private calendar the object is the skeleton, and the content lives in the sidecar (E13-R02).',
  required: ['uid', 'etag', 'ical', 'parsed'],
  additionalProperties: false,
  properties: {
    uid: {
      type: 'string',
      description: 'The `UID` of the stored object.',
    },
    etag: {
      type: ['null', 'string'],
      description:
        'The CalDAV `ETag`, quoted, or null when the store answered without one.',
    },
    ical: {
      type: 'string',
      description: 'The stored iCalendar object, byte for byte.',
    },
    parsed: eventParsedSchema,
  },
};
