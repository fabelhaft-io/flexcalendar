// --- E05-R05: the windowed occurrence endpoint -------------------------------
//
// `GET /calendars/{calendarId}/occurrences?from&to&tz`, declared in
// `spec/openapi.yaml` first and here second, exactly as `src/calendars.mjs`,
// `src/events.mjs` and `src/changes.mjs` are. It is the read our own clients
// cache: the expanded instances of one window, computed by the API's one
// recurrence authority (`src/occurrences.mjs` over `ical.js`), each tagged with
// the master `uid`, the instance's `recurrenceId` and whether an override
// `VEVENT` defines it. An edit to a recurring event is an intent (E05-R06/R07),
// and the `recurrenceId` a client sends back is the one this route reported.
//
// **The window is the caller's, half-open.** `from` and `to` are instants in the
// API's own form (`YYYYMMDDTHHMMSSZ`), `to` later than `from` and at most 1830
// days later — anything else is the fixed 422. `tz` is optional, an IANA name in
// its exact spelling (E05-R09), and defaults to `UTC`: every instant is reported
// in it, and an all-day event's day is that zone's midnights. A window that
// would answer more than `MAX_OCCURRENCES` instances is the 422
// `window-too-large` — there is no pagination, and a client that asks for five
// years of a minutely rule is told to ask for less rather than handed a slice it
// cannot tell from the whole.
//
// **The CalDAV read is the whole collection.** A `calendar-query` answers a
// `time-range` filter with the service's own recurrence engine
// (`sabre/vobject`), which expands every object it holds and fails the whole
// report once one series passes its instance bound — so a single long series
// would turn every window into a 502. The report therefore carries the
// `VCALENDAR`/`VEVENT` filters alone, and the window is decided by
// `src/occurrences.mjs`, the API's one authority.
//
// Roles: every member (`owner`, `editor` and `viewer`) reads, and a caller who
// is not a member gets the 404 an unknown calendar gets — an id outside the
// canonical shape included, decided before the store is asked.
//
// **The answer carries no content** (INV-01, INV-07): a `uid`, a
// `recurrenceId`, two times, an all-day flag and the envelope hash of the
// `VEVENT` that defines the instance. Never a `SUMMARY`, a description, a
// location or an attendee, and never a byte of the stored object.

import { identity, resolveUser } from './auth.mjs';
import { IcalError } from './ical-rmw.mjs';
import {
  MAX_OCCURRENCES,
  UNSUPPORTED_REASONS,
  expandOccurrences,
} from './occurrences.mjs';
import { problemResponse, sendCalDavProblem, sendProblem } from './problem.mjs';
import { isIanaZone } from './zones.mjs';

/**
 * One occurrence time, as the answer reports it: the instant, the wall clock the
 * requested zone reads for it, and that zone's name — or a `{date}` for an
 * all-day event, which has no instant of its own and is the requested zone's day
 * (§ 3.8.2.2, INV-04). `spec/openapi.yaml`'s `OccurrenceTime` is the identical
 * document; `test/contract.test.mjs` holds the two together.
 */
export const occurrenceTimeSchema = {
  type: 'object',
  description:
    'One occurrence time, in the zone the request asked for: the instant, the wall clock that zone reads for it, and the zone. An all-day occurrence is its `date` instead, because a day has no instant of its own and which instants it covers depends on the zone it is viewed from.',
  additionalProperties: false,
  properties: {
    date: {
      type: 'string',
      description:
        'An all-day date, `YYYY-MM-DD`; the end is the exclusive next date.',
    },
    utc: {
      type: 'string',
      description: 'The instant, `YYYYMMDDTHHMMSSZ`.',
    },
    tzid: {
      type: 'string',
      description:
        'The zone the request asked for, so the wall clock can be read back.',
    },
    local: {
      type: 'string',
      description:
        'The wall clock that zone reads for `utc`, `YYYYMMDDTHHMMSS`.',
    },
  },
};

/**
 * The instance's original start, in the form the stored object spells it — the
 * same three forms an event time takes. `null` for an event that does not recur.
 * It is what E05-R06/R07 send back to address "this occurrence", so it is
 * reported and never written (INV-05).
 */
export const recurrenceIdSchema = {
  type: ['null', 'object'],
  description:
    'The original start of this instance, in the form the stored object spells it: `date` for an all-day occurrence, `utc` for an instant, or `local` beside the `tzid` it is written in, with `utc` the instant that reading names. `null` for an event that does not recur. It is what an edit intent sends back to address this occurrence (E05-R06/R07), never something a client writes.',
  additionalProperties: false,
  properties: {
    date: {
      type: 'string',
      description: 'An all-day date, `YYYY-MM-DD`.',
    },
    utc: {
      type: 'string',
      description: 'A UTC instant, `YYYYMMDDTHHMMSSZ`.',
    },
    tzid: {
      type: 'string',
      description:
        'The `TZID` the stored property names, or the zone the reading is written in.',
    },
    local: {
      type: 'string',
      description:
        'The wall clock the stored property spells, `YYYYMMDDTHHMMSS`.',
    },
  },
};

/**
 * One expanded instance. `recurrenceId` is the instance's **original** start in
 * the form the stored object spells it — what E05-R06/R07 send back to address
 * "this occurrence" — and `null` for an event that does not recur.
 * `envelopeSha256` is the sidecar hash of the `VEVENT` that defines the
 * instance: the master for a derived one, the override's own otherwise.
 */
export const occurrenceSchema = {
  type: 'object',
  description:
    'One expanded occurrence. It carries no content: fetch the event itself for that. An override VEVENT is a second occurrence with `override` true and the `recurrenceId` it replaces.',
  required: [
    'uid',
    'recurrenceId',
    'override',
    'start',
    'end',
    'allDay',
    'envelopeSha256',
  ],
  additionalProperties: false,
  properties: {
    uid: {
      type: 'string',
      description: 'The `UID` of the master VEVENT.',
    },
    recurrenceId: recurrenceIdSchema,
    override: {
      type: 'boolean',
      description:
        '`true` when an override VEVENT defines this occurrence, `false` for one the rule of the master VEVENT derives.',
    },
    start: occurrenceTimeSchema,
    end: occurrenceTimeSchema,
    allDay: {
      type: 'boolean',
      description:
        '`true` for an all-day occurrence, whose `start` and `end` are dates rather than instants.',
    },
    envelopeSha256: {
      type: ['null', 'string'],
      description:
        'The `X-CALFLEX-ENVELOPE-SHA256` of the VEVENT that defines this occurrence, or null when it carries none.',
    },
  },
};

/**
 * One object the expansion left out, and why. `too-many-instances` is a rule
 * whose expansion would not stop inside the API's own bound, `unknown-zone` a
 * stored `TZID` the zone database cannot read (a Windows name, say), and
 * `rrule-not-expanded` one of the two rule families `ical.js` 2.2.1 expands
 * wrongly (`spec/ical-fixtures/RULINGS.md`) — the object is answered as nothing
 * rather than expanded wrongly.
 */
export const unsupportedSchema = {
  type: 'object',
  description:
    'One stored object the expansion left out, with the reason. It is not an error: the rest of the window is answered as usual.',
  required: ['uid', 'reason'],
  additionalProperties: false,
  properties: {
    uid: {
      type: 'string',
      description: 'The `UID` of the master VEVENT of the object.',
    },
    reason: {
      type: 'string',
      enum: [...UNSUPPORTED_REASONS],
      description: 'Why the object was not expanded.',
    },
  },
};

/** The body of `GET /calendars/{calendarId}/occurrences`. */
export const occurrencesSchema = {
  type: 'object',
  description:
    'The expanded occurrences of the window, sorted by start instant, and the objects that were left out.',
  required: ['occurrences', 'unsupported'],
  additionalProperties: false,
  properties: {
    occurrences: {
      type: 'array',
      description:
        'One entry per instance that overlaps the window, including the override VEVENTs.',
      items: occurrenceSchema,
    },
    unsupported: {
      type: 'array',
      description:
        'The stored objects that were not expanded, and why. Empty when every object was.',
      items: unsupportedSchema,
    },
  },
};

/** The shape of a `calendars.id` (E03-R01), as the other routes check it. */
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `YYYYMMDDTHHMMSSZ`, the only window bound this API takes. */
const INSTANT = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
/** The longest window one request may ask for (1830 days, about five years). */
const MAX_WINDOW_SECONDS = 1830 * 86_400;
/** The only query members this operation takes. */
const QUERY_MEMBERS = ['from', 'to', 'tz'];
/** The default viewing zone. */
const DEFAULT_TZ = 'UTC';

/** The refusals every authenticated operation of this module can answer with. */
const PROBLEMS = [401, 403, 405, 429, 500, 502, 503, 504];

/**
 * The response schema of the one operation: every status it can answer with —
 * the 404 an unknown calendar gets, and the 422 a bad or oversized window gets.
 */
export const listOccurrencesResponses = (() => {
  /** @type {Record<number, unknown>} */
  const schema = {
    200: { content: { 'application/json': { schema: occurrencesSchema } } },
  };
  for (const status of [...PROBLEMS, 404, 422])
    schema[status] = problemResponse();
  return schema;
})();

/**
 * Epoch seconds of a window bound, or undefined when it is not one: the form is
 * the API's own, and a date it spells has to exist (`20260230T…` does not
 * become 2 March).
 * @param {unknown} value
 * @returns {number | undefined}
 */
function epochOf(value) {
  const match = typeof value === 'string' ? INSTANT.exec(value) : null;
  if (!match) return undefined;
  const fields = match.slice(1).map(Number);
  const milliseconds = Date.UTC(
    fields[0],
    fields[1] - 1,
    fields[2],
    fields[3],
    fields[4],
    fields[5],
  );
  const date = new Date(milliseconds);
  const same =
    date.getUTCFullYear() === fields[0] &&
    date.getUTCMonth() === fields[1] - 1 &&
    date.getUTCDate() === fields[2] &&
    date.getUTCHours() === fields[3] &&
    date.getUTCMinutes() === fields[4] &&
    date.getUTCSeconds() === fields[5];
  return same ? milliseconds / 1000 : undefined;
}

/**
 * The window one query names, or undefined when it is not a window this API
 * answers. `from` and `to` are required instants, `to` later than `from` and at
 * most 1830 days later; `tz` is optional and must be an IANA name in its exact
 * spelling. A member the operation does not take is refused rather than
 * ignored, as a body member outside an event's field set is: a misspelled `tz`
 * must not look like a successful read.
 * @param {{from?: unknown, to?: unknown, tz?: unknown}} query
 * @returns {{from: string, to: string, tz: string} | undefined}
 */
function readWindow(query) {
  if (query === null || typeof query !== 'object') return undefined;
  for (const member of Object.keys(query)) {
    if (!QUERY_MEMBERS.includes(member)) return undefined;
  }
  const from = epochOf(query.from);
  const to = epochOf(query.to);
  if (from === undefined || to === undefined) return undefined;
  if (to <= from || to - from > MAX_WINDOW_SECONDS) return undefined;
  const tz = query.tz === undefined ? DEFAULT_TZ : query.tz;
  if (!isIanaZone(tz)) return undefined;
  return {
    from: /** @type {string} */ (query.from),
    to: /** @type {string} */ (query.to),
    tz: /** @type {string} */ (tz),
  };
}

/**
 * Installs the operation. `buildApp` calls this after the auth routes and after
 * both global hooks, so every handler here has a verified token and a resolved
 * `users.id` behind it.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} dependencies
 * @param {{findBySubject: Function, createFirstSight: Function}} dependencies.store
 * @param {{userinfo: Function}} dependencies.oidc
 * @param {{findMembership: Function}} dependencies.calendars
 * @param {{forUser: (userId: string, options: {requestId?: string}) => {listObjects: Function}}} dependencies.caldav
 */
export function registerOccurrenceRoutes(
  app,
  { store, oidc, calendars, caldav },
) {
  /**
   * The caller's `users.id`, through the one function `GET /me` uses (E05-R01).
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   */
  async function authenticated(request, reply) {
    const user = await resolveUser({ request, reply, store, oidc });
    if (!user) return undefined;
    /** @type {any} */ (request).user = {
      id: user.id,
      sub: identity(request).sub,
    };
    return user;
  }

  /**
   * The CalDAV view of the caller. Building it can fail on a bad configuration,
   * which is ours and not the caller's.
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   * @param {string} userId
   */
  function caldavFor(request, reply, userId) {
    try {
      return caldav.forUser(userId, { requestId: request.id });
    } catch (error) {
      sendCalDavProblem(reply, error, { instance: request.id });
      return undefined;
    }
  }

  /**
   * The membership row the caller needs, or the refusal to answer with. Every
   * member may read, so the role decides nothing: a calendar the caller is not a
   * member of is the 404 an id that exists nowhere gets (E03-R01), and the id is
   * checked before the store is asked.
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   * @param {string} userId
   * @param {string} calendarId
   */
  async function memberFor(request, reply, userId, calendarId) {
    if (!CANONICAL_UUID.test(calendarId)) {
      sendProblem(reply, 'not-found', { instance: request.id });
      return undefined;
    }
    const membership = await calendars.findMembership(calendarId, userId);
    if (membership === undefined) {
      sendProblem(reply, 'not-found', { instance: request.id });
      return undefined;
    }
    return membership;
  }

  app.get(
    '/calendars/:calendarId/occurrences',
    {
      config: { bearerAuth: true },
      schema: { response: listOccurrencesResponses },
    },
    async (request, reply) => {
      const user = await authenticated(request, reply);
      if (!user) return undefined;
      const query =
        /** @type {{from?: unknown, to?: unknown, tz?: unknown}} */ (
          request.query
        );
      const window = readWindow(query);
      if (window === undefined) {
        sendProblem(reply, 'invalid-input', { instance: request.id });
        return undefined;
      }
      const { calendarId } = /** @type {{calendarId: string}} */ (
        request.params
      );
      const membership = await memberFor(request, reply, user.id, calendarId);
      if (membership === undefined) return undefined;
      const view = caldavFor(request, reply, user.id);
      if (!view) return undefined;

      /** @type {Array<{href: string, etag?: string | null, data: string}>} */
      let stored;
      try {
        // The whole collection, with no `time-range`: a ranged report is
        // answered by the service's own engine (`sabre/vobject`), which expands
        // every series it holds and fails the whole report once one of them
        // passes its instance bound — so one long series would take the entire
        // calendar down to a 502. The exact filter is `src/occurrences.mjs`.
        stored = await view.listObjects(calendarId);
      } catch (error) {
        sendCalDavProblem(reply, error, { instance: request.id });
        return undefined;
      }

      /** @type {{occurrences: any[], unsupported: any[]}} */
      let answer;
      try {
        answer = expandOccurrences(
          stored.map((object) => ({ href: object.href, ical: object.data })),
          window,
        );
      } catch (error) {
        // An object this API cannot read is ours, not the caller's — and
        // nothing of it is echoed (INV-01, INV-07).
        if (error instanceof IcalError) {
          sendProblem(reply, 'bad-gateway', { instance: request.id });
          return undefined;
        }
        throw error;
      }
      if (answer.occurrences.length > MAX_OCCURRENCES) {
        sendProblem(reply, 'window-too-large', { instance: request.id });
        return undefined;
      }
      return answer;
    },
  );
}
