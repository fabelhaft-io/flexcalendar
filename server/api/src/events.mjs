// --- E05-R04: the events API -------------------------------------------------
//
// `POST /calendars/{calendarId}/events`, `GET`, `PATCH` and
// `DELETE /calendars/{calendarId}/events/{uid}`: single-object CRUD, declared in
// `spec/openapi.yaml` first and here second, exactly as `src/calendars.mjs` is
// for E05-R03. The windowed list with expansion is E05-R05, the delta is
// E05-R08, and an edit to a recurring event is an intent (E05-R06/R07) — none of
// them is here.
//
// **CalDAV is the source of truth** (INV-01): the object name is `<uid>.ics`,
// the API stores no event field of its own, and every read answers the bytes the
// collection holds. `ical` is that raw text, byte for byte, `etag` is CalDAV's
// (also the `ETag` header), and `parsed` is the convenience view
// `src/ical-rmw.mjs` takes of the master `VEVENT` — which is what lets a client
// cache the canonical record (`docs/02` § Offline cache). On a Private calendar
// the object is the skeleton; the content is in the sidecar (E13-R02).
//
// **The client sends fields, never iCalendar** (INV-05). `src/ical-rmw.mjs`
// builds the object from `start`/`end`/`rrule`/`alarm`/`envelopeSha256`, the API
// mints the `UID` (`crypto.randomUUID()`, INV-03) and the `DTSTAMP`, and the
// fixed `PRODID` is ours. So a client can never write `EXDATE` or
// `RECURRENCE-ID`, and no value it sends reaches the text verbatim.
//
// **Writes carry a precondition.** Create writes with `If-None-Match: *`; update
// and delete need the caller's `If-Match` (428 without it) and forward it to
// CalDAV, which is the authority on whether it still matches. A `412` answers
// `412` with the current representation in the problem's `current` member, so
// the client can re-read, reapply and retry.
//
// Two rules are policy, and live here rather than in the module: until Phase 4
// every calendar is Private (ADR 0003), so a content field (`summary`,
// `description`, `location`, `attendees`) is refused with the fixed 422 — a
// Private calendar stores skeletons, and the guard of E03-R09 would refuse the
// write anyway — and an `envelopeSha256` is required on create. The adapter's
// own refusals (a guard precondition, a `401` on our delegation, a timeout) are
// mapped by `sendCalDavProblem` and never echo a value.
//
// Roles: `owner` and `editor` write, `viewer` reads, and a caller who is not a
// member gets the 404 an unknown calendar gets. An id or a `uid` outside the
// shape this API mints is that same 404, decided before CalDAV is asked:
// `calendarobjects.uid` is `VARCHAR(200)` and a lookup for anything else can
// only miss (E03-R01, E03-R10).
//
// The three small request helpers here — `readBody`, `ifMatchOf` and
// `responseSchema` — have the same shape as the private ones in
// `src/calendars.mjs`. They are repeated rather than shared on purpose: this
// requirement adds a route module, and E05-R03's stays untouched.

import { randomUUID } from 'node:crypto';
import { identity, resolveUser } from './auth.mjs';
import { eventSchema } from './event-schema.mjs';
import {
  IcalError,
  build,
  describe,
  parse,
  patch,
  serialise,
} from './ical-rmw.mjs';
import { problemResponse, sendCalDavProblem, sendProblem } from './problem.mjs';

/**
 * The fields a create takes. A member outside this list is a 422, never
 * ignored: a misspelled `alarm` must not look like a successful write.
 */
const CREATE_MEMBERS = [
  'start',
  'end',
  'rrule',
  'alarm',
  'envelopeSha256',
  'summary',
  'description',
  'location',
  'attendees',
];

/**
 * The fields a patch takes: the create list without `rrule` — a change to a
 * recurring event is an intent (E05-R06/R07). `uid`, `exdate` and `recurrenceId`
 * are outside it for the same reason: no request body ever carries the
 * recurrence itself (INV-05).
 */
const UPDATE_MEMBERS = CREATE_MEMBERS.filter((member) => member !== 'rrule');

/** The fields that hold event content, which a Private calendar stores sealed. */
const CONTENT_MEMBERS = ['summary', 'description', 'location', 'attendees'];

/** The roles that may write. Every member may read. */
const WRITE_ROLES = ['owner', 'editor'];

/**
 * The shape of a `calendars.id` (E03-R01), and of the `UID` this API mints
 * (INV-03) in its strict v4 form. Nothing else can name a row or an object — a
 * client can only ever have read one in this form — so a value outside it is
 * answered as the 404 an unknown one gets, before CalDAV is asked. A `UID` over
 * 200 characters never reaches CalDAV for the same reason:
 * `calendarobjects.uid` is `VARCHAR(200)` (E03-R10).
 */
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The object name of an event inside its collection. */
const objectName = (/** @type {string} */ uid) => `${uid}.ics`;

/**
 * A refusal every rule of this module shares: one status, one type, one body.
 * @param {import('fastify').FastifyReply} reply
 * @param {import('fastify').FastifyRequest} request
 */
function invalidInput(reply, request) {
  sendProblem(reply, 'invalid-input', { instance: request.id });
}

/**
 * The request body as a plain JSON object holding only `members`, or undefined.
 * A body that is not an object, or that carries a member the operation does not
 * take, is refused by the caller — never ignored. The values are `any`: every
 * one of them is checked where it is used, and this function checks only which
 * members are there.
 * @param {unknown} body
 * @param {string[]} members
 * @returns {Record<string, any> | undefined}
 */
function readBody(body, members) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }
  const record = /** @type {Record<string, unknown>} */ (body);
  for (const key of Object.keys(record)) {
    if (!members.includes(key)) return undefined;
  }
  return record;
}

/**
 * The `If-Match` a write has to carry, as CalDAV must receive it: the header
 * value itself, unchanged (RFC 9110 § 13.1.1 — a list of validators and `*` are
 * both allowed, and this API does not decide which of them matches; the store
 * does). `undefined` when the header is absent or empty, which is the 428.
 * @param {unknown} header
 * @returns {string | undefined}
 */
function ifMatchOf(header) {
  if (typeof header !== 'string') return undefined;
  const value = header.trim();
  return value === '' ? undefined : value;
}

/**
 * The response schema of one operation: every status it can answer with, each
 * error one declared `Problem`. The statuses are the whole set the contract
 * declares for the operation — no more (a status a route cannot send must not be
 * promised) and no fewer (the contract test compares both directions).
 * @param {Record<number, unknown>} successes
 * @param {number[]} problems
 */
function responseSchema(successes, problems) {
  /** @type {Record<number, unknown>} */
  const schema = { ...successes };
  for (const status of problems) schema[status] = problemResponse();
  return schema;
}

/** The refusals every authenticated operation of this module can answer with. */
const PROBLEMS = [401, 403, 405, 429, 500, 502, 503, 504];

/** The one success each operation answers with. */
const ok = () => ({ content: { 'application/json': { schema: eventSchema } } });

/**
 * `POST /calendars/{calendarId}/events`: 201 with `Location` and `ETag`. The
 * 409 is a `UID` collision, which the API can only answer as "try again"; the
 * rest are the body's own rules (400, 413, 415, 422).
 */
export const createEventResponses = responseSchema({ 201: ok() }, [
  ...PROBLEMS,
  400,
  409,
  413,
  415,
  422,
]);

/** `GET /calendars/{calendarId}/events/{uid}`. */
export const readEventResponses = responseSchema({ 200: ok() }, [
  ...PROBLEMS,
  404,
]);

/**
 * `PATCH /calendars/{calendarId}/events/{uid}`: a stale `If-Match` is a 412
 * that carries the current representation, and the body's own rules are the
 * same 400/413/415/422 set a create has.
 */
export const updateEventResponses = responseSchema({ 200: ok() }, [
  ...PROBLEMS,
  400,
  404,
  412,
  413,
  415,
  422,
  428,
]);

/** `DELETE /calendars/{calendarId}/events/{uid}`. */
export const deleteEventResponses = responseSchema({ 204: { content: {} } }, [
  ...PROBLEMS,
  404,
  412,
  428,
]);

/**
 * A `DTSTAMP` in the iCalendar UTC form. It is the only clock this module reads,
 * and it is always UTC — `toISOString` never consults the host's zone.
 * @param {Date} date
 * @returns {string}
 */
export function utcStamp(date) {
  return `${date
    .toISOString()
    .slice(0, 19)
    .replaceAll('-', '')
    .replaceAll(':', '')}Z`;
}

/**
 * The representation of a stored object: the bytes CalDAV holds, its `ETag`, and
 * the parsed view of its master `VEVENT`. `undefined` when the text is not an
 * object this API can describe — a collection holding something that is not a
 * `VEVENT` object is ours to notice, and the caller answers 502.
 * @param {string} text
 * @param {string | null | undefined} etag
 * @returns {{uid: string, etag: string | null, ical: string, parsed: any} | undefined}
 */
function representationOf(text, etag) {
  try {
    const calendar = parse(text);
    const parsed = describe(calendar);
    return { uid: parsed.uid, etag: etag ?? null, ical: text, parsed };
  } catch (error) {
    if (error instanceof IcalError) return undefined;
    throw error;
  }
}

/**
 * Installs the four operations. `buildApp` calls this after the auth routes and
 * after both global hooks, so every handler here has a verified token and a
 * resolved `users.id` behind it.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} dependencies
 * @param {{findBySubject: Function, createFirstSight: Function}} dependencies.store
 * @param {{userinfo: Function}} dependencies.oidc
 * @param {{findMembership: Function}} dependencies.calendars
 * @param {{forUser: (userId: string, options: {requestId?: string}) => {putObject: Function, getObject: Function, deleteObject: Function}}} dependencies.caldav
 */
export function registerEventRoutes(app, { store, oidc, calendars, caldav }) {
  /**
   * The caller's `users.id`, through the one function `GET /me` uses (E05-R01):
   * the first-sight rules and every refusal live there, not here.
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
   * The membership row the caller needs, or the refusal to answer with. A
   * calendar the caller is not a member of is the 404 an id that exists nowhere
   * gets (E03-R01); a member whose role cannot write is a 403 (E05-R03). The id
   * is checked before the store is asked: `calendars.id` is a `uuid` column and
   * anything else raises Postgres' `22P02`, which is a 500 for a request whose
   * real answer is "no such calendar".
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   * @param {string} userId
   * @param {string} calendarId
   * @param {{write?: boolean}} [options]
   * @returns {Promise<any>}
   */
  async function memberFor(
    request,
    reply,
    userId,
    calendarId,
    { write = false } = {},
  ) {
    if (!CANONICAL_UUID.test(calendarId)) {
      sendProblem(reply, 'not-found', { instance: request.id });
      return undefined;
    }
    const membership = await calendars.findMembership(calendarId, userId);
    if (membership === undefined) {
      sendProblem(reply, 'not-found', { instance: request.id });
      return undefined;
    }
    if (write && !WRITE_ROLES.includes(membership.role)) {
      sendProblem(reply, 'forbidden', { instance: request.id });
      return undefined;
    }
    return membership;
  }

  /**
   * The `uid` path parameter, or the refusal. Only a UUIDv4 this API could have
   * minted names an object here (INV-03); anything else — a longer `UID`
   * included — cannot exist and is the 404 an unknown one gets.
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   * @returns {string | undefined}
   */
  function uidOf(request, reply) {
    const { uid } = /** @type {{uid: string}} */ (request.params);
    if (!UUID_V4.test(uid)) {
      sendProblem(reply, 'not-found', { instance: request.id });
      return undefined;
    }
    return uid;
  }

  /**
   * The rules a body has to satisfy on this calendar, before anything is
   * written. `false` means "refused, the reply is already sent".
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   * @param {Record<string, unknown>} body
   * @param {any} membership
   * @param {{create: boolean}} options
   */
  function checkFields(request, reply, body, membership, { create }) {
    if (membership.mode === 'private') {
      // A Private calendar stores skeletons; its content is sealed in the
      // sidecar under the CCK (D-18, E03-R09). The guard would refuse such a
      // write anyway, and the client is told which rule broke instead.
      if (CONTENT_MEMBERS.some((member) => body[member] !== undefined)) {
        invalidInput(reply, request);
        return false;
      }
      // Exactly one envelope hash per VEVENT (E03-R09): a create without one
      // names no content, and a patch that removes one leaves the VEVENT
      // unsealed.
      if (create && typeof body.envelopeSha256 !== 'string') {
        invalidInput(reply, request);
        return false;
      }
      if (!create && body.envelopeSha256 === null) {
        invalidInput(reply, request);
        return false;
      }
    }
    return true;
  }

  /**
   * One field set applied to a component, or the fixed 422. A field the module
   * cannot write is the caller's mistake; anything else it raises is ours.
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   * @param {() => void} apply
   * @returns {boolean}
   */
  function applyFields(request, reply, apply) {
    try {
      apply();
      return true;
    } catch (error) {
      if (error instanceof IcalError && error.kind.startsWith('invalid-')) {
        invalidInput(reply, request);
        return false;
      }
      throw error;
    }
  }

  app.post(
    '/calendars/:calendarId/events',
    {
      config: { bearerAuth: true },
      schema: { response: createEventResponses },
    },
    async (request, reply) => {
      const user = await authenticated(request, reply);
      if (!user) return undefined;
      // A body that is not an object, carries a member the operation does not
      // take, or has no `start`, is a 422 before anything else happens.
      const body = readBody(request.body, CREATE_MEMBERS);
      if (body === undefined || body.start === undefined) {
        invalidInput(reply, request);
        return undefined;
      }
      const { calendarId } = /** @type {{calendarId: string}} */ (
        request.params
      );
      const membership = await memberFor(request, reply, user.id, calendarId, {
        write: true,
      });
      if (membership === undefined) return undefined;
      if (!checkFields(request, reply, body, membership, { create: true })) {
        return undefined;
      }

      // INV-03: the `UID` is minted here, random, never derived from content.
      const uid = randomUUID();
      /** @type {any} */
      let calendar;
      const built = applyFields(request, reply, () => {
        calendar = build({
          uid,
          dtstamp: utcStamp(new Date()),
          start: body.start,
          end: body.end ?? null,
          rrule: body.rrule ?? null,
          alarm: body.alarm ?? null,
          envelopeSha256: body.envelopeSha256 ?? null,
          summary: body.summary,
          description: body.description,
          location: body.location,
          attendees: body.attendees,
        });
      });
      if (!built) return undefined;
      const ical = serialise(calendar);
      const parsed = describe(calendar);

      const view = caldavFor(request, reply, user.id);
      if (!view) return undefined;
      /** @type {{status: number, etag?: string | null}} */
      let stored;
      try {
        stored = await view.putObject(calendarId, objectName(uid), ical, {
          ifNoneMatch: '*',
        });
      } catch (error) {
        // `If-None-Match: *` on a name that already exists is a 412 nobody sent:
        // two creates minted the same `UID`, which is ours, not the caller's.
        if (/** @type {any} */ (error)?.status === 412) {
          sendProblem(reply, 'conflict', { instance: request.id });
          return undefined;
        }
        sendCalDavProblem(reply, error, { instance: request.id });
        return undefined;
      }
      reply
        .code(201)
        .header('location', `/calendars/${calendarId}/events/${uid}`);
      if (stored.etag) reply.header('etag', stored.etag);
      return { uid, etag: stored.etag ?? null, ical, parsed };
    },
  );

  app.get(
    '/calendars/:calendarId/events/:uid',
    {
      config: { bearerAuth: true },
      schema: { response: readEventResponses },
    },
    async (request, reply) => {
      const user = await authenticated(request, reply);
      if (!user) return undefined;
      const uid = uidOf(request, reply);
      if (uid === undefined) return undefined;
      const { calendarId } = /** @type {{calendarId: string}} */ (
        request.params
      );
      const membership = await memberFor(request, reply, user.id, calendarId);
      if (membership === undefined) return undefined;
      const view = caldavFor(request, reply, user.id);
      if (!view) return undefined;
      /** @type {{etag?: string | null, data: string}} */
      let stored;
      try {
        stored = await view.getObject(calendarId, objectName(uid));
      } catch (error) {
        sendCalDavProblem(reply, error, { instance: request.id });
        return undefined;
      }
      const representation = representationOf(stored.data, stored.etag);
      if (representation === undefined) {
        // The collection holds an object this API cannot describe. Nothing about
        // it is the caller's fault, and nothing of it is echoed.
        sendProblem(reply, 'bad-gateway', { instance: request.id });
        return undefined;
      }
      if (representation.etag) reply.header('etag', representation.etag);
      return representation;
    },
  );

  app.patch(
    '/calendars/:calendarId/events/:uid',
    {
      config: { bearerAuth: true },
      schema: { response: updateEventResponses },
    },
    async (request, reply) => {
      const user = await authenticated(request, reply);
      if (!user) return undefined;
      const body = readBody(request.body, UPDATE_MEMBERS);
      if (body === undefined) {
        invalidInput(reply, request);
        return undefined;
      }
      // An update is a read-modify-write and needs the version it read
      // (RFC 9110 § 13.1.1): without `If-Match` there is nothing to be
      // optimistic against, and a valid request must not be answered as if it
      // were unconditional.
      const ifMatch = ifMatchOf(request.headers['if-match']);
      if (ifMatch === undefined) {
        sendProblem(reply, 'precondition-required', { instance: request.id });
        return undefined;
      }
      const uid = uidOf(request, reply);
      if (uid === undefined) return undefined;
      const { calendarId } = /** @type {{calendarId: string}} */ (
        request.params
      );
      const membership = await memberFor(request, reply, user.id, calendarId, {
        write: true,
      });
      if (membership === undefined) return undefined;
      if (!checkFields(request, reply, body, membership, { create: false })) {
        return undefined;
      }

      const view = caldavFor(request, reply, user.id);
      if (!view) return undefined;
      /** @type {{etag?: string | null, data: string}} */
      let stored;
      try {
        stored = await view.getObject(calendarId, objectName(uid));
      } catch (error) {
        sendCalDavProblem(reply, error, { instance: request.id });
        return undefined;
      }
      /** @type {any} */
      let calendar;
      /** @type {any} */
      let before;
      try {
        calendar = parse(stored.data);
        before = describe(calendar);
      } catch (error) {
        if (error instanceof IcalError) {
          sendProblem(reply, 'bad-gateway', { instance: request.id });
          return undefined;
        }
        throw error;
      }
      /** @type {Record<string, unknown>} */
      const changes = {};
      for (const member of UPDATE_MEMBERS) {
        if (body[member] !== undefined) changes[member] = body[member];
      }
      // RFC 5545 § 3.8.7.4: a revision that changes the object increments
      // `SEQUENCE`, and `DTSTAMP` says when this revision was made.
      changes.sequence = before.sequence + 1;
      changes.dtstamp = utcStamp(new Date());
      if (!applyFields(request, reply, () => patch(calendar, changes))) {
        return undefined;
      }
      const ical = serialise(calendar);
      const parsed = describe(calendar);

      /** @type {{status: number, etag?: string | null}} */
      let written;
      try {
        // The caller's own validator travels on, unchanged: whether it still
        // matches is the store's answer, never this module's guess.
        written = await view.putObject(calendarId, objectName(uid), ical, {
          ifMatch,
        });
      } catch (error) {
        if (/** @type {any} */ (error)?.status === 412) {
          await answerPreconditionFailed(request, reply, view, calendarId, uid);
          return undefined;
        }
        sendCalDavProblem(reply, error, { instance: request.id });
        return undefined;
      }
      if (written.etag) reply.header('etag', written.etag);
      return { uid: parsed.uid, etag: written.etag ?? null, ical, parsed };
    },
  );

  app.delete(
    '/calendars/:calendarId/events/:uid',
    {
      config: { bearerAuth: true },
      schema: { response: deleteEventResponses },
    },
    async (request, reply) => {
      const user = await authenticated(request, reply);
      if (!user) return undefined;
      const ifMatch = ifMatchOf(request.headers['if-match']);
      if (ifMatch === undefined) {
        sendProblem(reply, 'precondition-required', { instance: request.id });
        return undefined;
      }
      const uid = uidOf(request, reply);
      if (uid === undefined) return undefined;
      const { calendarId } = /** @type {{calendarId: string}} */ (
        request.params
      );
      const membership = await memberFor(request, reply, user.id, calendarId, {
        write: true,
      });
      if (membership === undefined) return undefined;
      const view = caldavFor(request, reply, user.id);
      if (!view) return undefined;
      try {
        await view.deleteObject(calendarId, objectName(uid), { ifMatch });
      } catch (error) {
        if (/** @type {any} */ (error)?.status === 412) {
          await answerPreconditionFailed(request, reply, view, calendarId, uid);
          return undefined;
        }
        sendCalDavProblem(reply, error, { instance: request.id });
        return undefined;
      }
      reply.code(204);
      return undefined;
    },
  );

  /**
   * A `412` from CalDAV: the caller's `If-Match` no longer names the object the
   * collection holds. The answer carries what it holds now, in the problem's
   * `current` member, so the client can reapply its change — and nothing else:
   * the request that lost the race is never in it. An object that vanished (or
   * cannot be read back) is answered without `current`.
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   * @param {any} view
   * @param {string} calendarId
   * @param {string} uid
   */
  async function answerPreconditionFailed(
    request,
    reply,
    view,
    calendarId,
    uid,
  ) {
    /** @type {unknown} */
    let current;
    try {
      const stored = await view.getObject(calendarId, objectName(uid));
      current = representationOf(stored.data, stored.etag);
    } catch {
      current = undefined;
    }
    sendProblem(reply, 'precondition-failed', {
      instance: request.id,
      current,
    });
  }
}
