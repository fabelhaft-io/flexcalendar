// --- E05-R03: the calendars API ----------------------------------------------
//
// `GET /calendars`, `POST /calendars`, `PATCH /calendars/{id}` and
// `DELETE /calendars/{id}`, the four operations of E05-R03, in
// `spec/openapi.yaml` first and here second.
//
// Until Phase 4 every calendar is Private (ADR 0003), and a Private calendar's
// name and colour exist only inside a client-sealed envelope under the CCK
// (D-18): the API stores the envelope opaquely in `calendars.meta_envelope` and
// the CalDAV collection carries the fixed display name `Private calendar`
// (E03-R09). The API never opens an envelope, never derives a key and never
// decrypts (INV-07) — the only thing it checks is what a server can check
// without one, in `src/calendar-envelope.mjs`.
//
// Two rules decide the shape of this module:
//
//   * **Create is rows first, collection second.** The CalDAV service answers
//     404 for a collection whose `calendars` row is not committed (E03-R08), so
//     the row and the owner's membership row are committed before `MKCALENDAR`
//     and removed again if it fails. Delete is the other way round: the
//     collection first, then the rows.
//   * **The version is the concurrency token.** A rename or recolour replaces
//     the envelope only when the `If-Match` version is still the row's, so two
//     clients cannot silently overwrite each other.
//
// Every request-derived refusal is the same 422 with a fixed body
// (`sendProblem(reply, 'invalid-input')`): no value — least of all an envelope
// byte — reaches a response body or a log line. The route schemas deliberately
// declare no request-body schema: a body that fails schema validation is a 400,
// and the rules above must answer 422, so they run in the handlers against the
// request's own fields.
//
// Not here: anything that expands or writes an event (E05-R04), sharing (E06)
// or a mode change (E13-R06, INV-10).

import { randomUUID } from 'node:crypto';
import { identity, resolveUser } from './auth.mjs';
import { decodeMetaEnvelope } from './calendar-envelope.mjs';
import { problemResponse, sendCalDavProblem, sendProblem } from './problem.mjs';

/**
 * One calendar, as the API answers with it. `spec/openapi.yaml`'s `Calendar`
 * schema is the identical document; `test/contract.test.mjs` holds the two
 * together. The envelope is standard base64 of the client's bytes, never a
 * decode of it (INV-07).
 */
export const calendarSchema = {
  type: 'object',
  description:
    'One calendar the caller is a member of. A Private calendar carries its sealed metadata envelope; the API never opens it (D-18).',
  required: [
    'id',
    'mode',
    'role',
    'version',
    'metaEnvelope',
    'metaEpoch',
    'createdAt',
    'updatedAt',
  ],
  additionalProperties: false,
  properties: {
    id: {
      type: 'string',
      description:
        'The `calendars.id` uuid, which is also the CalDAV collection href.',
    },
    mode: {
      type: 'string',
      description:
        'The calendar mode. Until Phase 4 every calendar is `private` (ADR 0003).',
    },
    role: {
      type: 'string',
      description:
        "The caller's role in `calendar_members`: `owner`, `editor` or `viewer`.",
    },
    version: {
      type: 'integer',
      description: 'The optimistic-concurrency version; also the `ETag`.',
    },
    metaEnvelope: {
      type: 'string',
      description:
        "A Private calendar's client-sealed metadata envelope, standard base64. Opaque to the API.",
    },
    metaEpoch: {
      type: 'integer',
      description: "The CCK epoch inside the envelope's header.",
    },
    createdAt: {
      type: 'string',
      description: 'When the calendar was created, ISO 8601.',
    },
    updatedAt: {
      type: 'string',
      description: 'When the calendar last changed, ISO 8601.',
    },
  },
};

/** The `GET /calendars` body. */
export const calendarListSchema = {
  type: 'object',
  description: 'The calendars the caller is a member of.',
  required: ['calendars'],
  additionalProperties: false,
  properties: {
    calendars: {
      type: 'array',
      items: calendarSchema,
      description:
        'Oldest first. A Private calendar the caller cannot see is not listed.',
    },
  },
};

/** The members `POST /calendars` may carry. */
const CREATE_MEMBERS = ['mode', 'metaEnvelope', 'metaEpoch', 'name', 'color'];

/** The members `PATCH /calendars/{id}` may carry: the envelope, and nothing else. */
const META_MEMBERS = ['metaEnvelope', 'metaEpoch', 'name', 'color'];

/** @param {number} version */
const etagFor = (version) => `"${version}"`;

/**
 * A refusal every rule below shares: one status, one type, one body.
 * @param {import('fastify').FastifyReply} reply
 * @param {import('fastify').FastifyRequest} request
 */
function invalidInput(reply, request) {
  sendProblem(reply, 'invalid-input', { instance: request.id });
}

/**
 * The request body as a plain JSON object holding only `members`, or undefined.
 * A body that is not an object, or that carries a member the operation does not
 * take, is refused by the caller — never ignored, so a misspelled `name` cannot
 * look like a successful rename.
 * @param {unknown} body
 * @param {string[]} members
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
 * The `If-Match` validators of the request: `[]` when the header is absent,
 * otherwise the list it carries. A weak validator never matches, which is what
 * RFC 9110 requires of `If-Match`.
 * @param {unknown} header
 * @returns {string[] | undefined}
 */
function ifMatchValidators(header) {
  if (typeof header !== 'string') return undefined;
  const validators = header
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  return validators.length === 0 ? undefined : validators;
}

/**
 * @param {string[]} validators
 * @param {number} version
 */
const matchesVersion = (validators, version) =>
  validators.some((value) => value === '*' || value === etagFor(version));

/**
 * The response members of a stored calendar.
 * @param {any} row
 */
function toCalendar(row) {
  return {
    id: row.id,
    mode: row.mode,
    role: row.role,
    version: row.version,
    metaEnvelope: row.metaEnvelope,
    metaEpoch: row.metaEpoch,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The response schema of one operation: every status it can answer with, each
 * error one declared `Problem`. The statuses are the whole set the contract
 * declares for the operation — no more (a status a route cannot send must not
 * be promised) and no fewer (the contract test compares both directions).
 * @param {Record<number, unknown>} successes
 * @param {number[]} problems
 */
function responseSchema(successes, problems) {
  /** @type {Record<number, unknown>} */
  const schema = { ...successes };
  for (const status of problems) schema[status] = problemResponse();
  return schema;
}

/** The refusals every authenticated operation can answer with. */
const AUTH_PROBLEMS = [401, 403, 405, 409, 429, 500, 502, 503];
/** …plus the two the CalDAV call itself adds (a timeout, a response body). */
const CALDAV_PROBLEMS = [...AUTH_PROBLEMS, 504].sort((a, b) => a - b);

/** `GET /calendars` */
export const listCalendarsResponses = responseSchema(
  { 200: { content: { 'application/json': { schema: calendarListSchema } } } },
  AUTH_PROBLEMS,
);

/**
 * `POST /calendars`: a malformed body is Fastify's 400, an oversized one 413,
 * a body with another media type 415, and every rule of E05-R03 a 422.
 */
export const createCalendarResponses = responseSchema(
  { 201: { content: { 'application/json': { schema: calendarSchema } } } },
  [400, ...CALDAV_PROBLEMS, 413, 415, 422].sort((a, b) => a - b),
);

/** `PATCH /calendars/{id}`: 428 without `If-Match`, 412 when it is stale. */
export const patchCalendarResponses = responseSchema(
  { 200: { content: { 'application/json': { schema: calendarSchema } } } },
  [400, ...CALDAV_PROBLEMS, 404, 412, 413, 415, 422, 428].sort((a, b) => a - b),
);

/** `DELETE /calendars/{id}`: the collection and the rows are gone. */
export const deleteCalendarResponses = responseSchema(
  { 204: { content: {} } },
  [...CALDAV_PROBLEMS, 404].sort((a, b) => a - b),
);

/**
 * Installs the four operations. `buildApp` calls this after the auth routes and
 * after both global hooks, so every handler here has a verified token and a
 * resolved `users.id` behind it.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} dependencies
 * @param {{findBySubject: Function, createFirstSight: Function}} dependencies.store
 * @param {{userinfo: Function}} dependencies.oidc
 * @param {{listForMember: Function, findMembership: Function, createPrivate: Function, replaceMeta: Function, remove: Function}} dependencies.calendars
 * @param {{forUser: (userId: string, options: {requestId?: string}) => {makeCalendar: Function, deleteCalendar: Function}}} dependencies.caldav
 */
export function registerCalendarRoutes(
  app,
  { store, oidc, calendars, caldav },
) {
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
   * which is ours and not the caller's: it is answered before any row is written.
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

  app.get(
    '/calendars',
    {
      config: { bearerAuth: true },
      schema: { response: listCalendarsResponses },
    },
    async (request, reply) => {
      const user = await authenticated(request, reply);
      if (!user) return undefined;
      const rows = await calendars.listForMember(user.id);
      return { calendars: rows.map(toCalendar) };
    },
  );

  app.post(
    '/calendars',
    {
      config: { bearerAuth: true },
      schema: { response: createCalendarResponses },
    },
    async (request, reply) => {
      const user = await authenticated(request, reply);
      if (!user) return undefined;
      const body = readBody(request.body, CREATE_MEMBERS);
      // Create requires an explicit `mode`; there is no default (ADR 0001).
      if (body === undefined || body.mode === undefined) {
        invalidInput(reply, request);
        return undefined;
      }
      // Until Phase 4 only `private` exists (ADR 0003); `shared` and
      // `published` are Phase 4 and `published` comes from E06-R06.
      if (body.mode !== 'private') {
        invalidInput(reply, request);
        return undefined;
      }
      // A Private calendar's name and colour live in the envelope, never in a
      // plaintext column or a CalDAV property (D-18): a plaintext field is
      // refused rather than ignored.
      if (body.name !== undefined || body.color !== undefined) {
        invalidInput(reply, request);
        return undefined;
      }
      const metaEnvelope = decodeMetaEnvelope(
        body.metaEnvelope,
        body.metaEpoch,
      );
      if (metaEnvelope === undefined) {
        invalidInput(reply, request);
        return undefined;
      }

      const calendarId = randomUUID();
      const view = caldavFor(request, reply, user.id);
      if (!view) return undefined;
      // (a) The rows first, committed: the collection is invisible without them.
      const row = await calendars.createPrivate({
        id: calendarId,
        ownerId: user.id,
        href: `/calendars/${user.id}/${calendarId}/`,
        metaEnvelope,
        metaEpoch: /** @type {number} */ (body.metaEpoch),
      });
      // (b) Then the collection.
      try {
        await view.makeCalendar(calendarId);
      } catch (error) {
        // (c) Compensation: the id is already handed out, so a half-created
        // calendar is deleted rather than left for the next request to trip on.
        try {
          await calendars.remove(calendarId);
        } catch (/** @type {any} */ compensationError) {
          request.log.error({ err: error }, 'calendar_create_failed');
          request.log.error(
            { err: compensationError },
            'calendar_compensation_failed',
          );
          sendProblem(reply, 'internal-error', { instance: request.id });
          return undefined;
        }
        sendCalDavProblem(reply, error, { instance: request.id });
        return undefined;
      }
      reply
        .code(201)
        .header('location', `/calendars/${calendarId}`)
        .header('etag', etagFor(row.version));
      return toCalendar(row);
    },
  );

  app.patch(
    '/calendars/:id',
    {
      config: { bearerAuth: true },
      schema: { response: patchCalendarResponses },
    },
    async (request, reply) => {
      const user = await authenticated(request, reply);
      if (!user) return undefined;
      // A plaintext `name` or `color` on a Private calendar is a 422, exactly as
      // it is on create (D-18).
      const body = readBody(request.body, META_MEMBERS);
      if (
        body === undefined ||
        body.name !== undefined ||
        body.color !== undefined
      ) {
        invalidInput(reply, request);
        return undefined;
      }
      const metaEnvelope = decodeMetaEnvelope(
        body.metaEnvelope,
        body.metaEpoch,
      );
      if (metaEnvelope === undefined) {
        invalidInput(reply, request);
        return undefined;
      }
      // A rename is a read-modify-write and needs the version it read
      // (RFC 9110 § 13.1.1): without `If-Match` there is nothing to be
      // optimistic against, and a valid request must not be answered as if it
      // were unconditional.
      const validators = ifMatchValidators(request.headers['if-match']);
      if (validators === undefined) {
        sendProblem(reply, 'precondition-required', { instance: request.id });
        return undefined;
      }
      const { id } = /** @type {{id: string}} */ (request.params);
      // A calendar the caller is not a member of is a 404, the same answer an
      // id that exists nowhere gets (E03-R01). A member who is not the owner
      // may see it, so that one is a 403.
      const membership = await calendars.findMembership(id, user.id);
      if (membership === undefined) {
        sendProblem(reply, 'not-found', { instance: request.id });
        return undefined;
      }
      if (membership.role !== 'owner') {
        sendProblem(reply, 'forbidden', { instance: request.id });
        return undefined;
      }
      if (!matchesVersion(validators, membership.version)) {
        sendProblem(reply, 'precondition-failed', { instance: request.id });
        return undefined;
      }
      const updated = await calendars.replaceMeta({
        calendarId: id,
        expectedVersion: membership.version,
        metaEnvelope,
        metaEpoch: /** @type {number} */ (body.metaEpoch),
      });
      // The version moved between the read and the write: another request won.
      if (updated === undefined) {
        sendProblem(reply, 'precondition-failed', { instance: request.id });
        return undefined;
      }
      reply.header('etag', etagFor(updated.version));
      return toCalendar({ ...updated, role: membership.role });
    },
  );

  app.delete(
    '/calendars/:id',
    {
      config: { bearerAuth: true },
      schema: { response: deleteCalendarResponses },
    },
    async (request, reply) => {
      const user = await authenticated(request, reply);
      if (!user) return undefined;
      const { id } = /** @type {{id: string}} */ (request.params);
      const membership = await calendars.findMembership(id, user.id);
      if (membership === undefined) {
        sendProblem(reply, 'not-found', { instance: request.id });
        return undefined;
      }
      if (membership.role !== 'owner') {
        sendProblem(reply, 'forbidden', { instance: request.id });
        return undefined;
      }
      const view = caldavFor(request, reply, user.id);
      if (!view) return undefined;
      // The collection first: while the rows exist the owner can reach it, and
      // a 404 means someone else already removed it, which is the state this
      // request wanted.
      try {
        await view.deleteCalendar(id);
      } catch (/** @type {any} */ error) {
        if (error?.kind !== 'not-found' && error?.status !== 404) {
          sendCalDavProblem(reply, error, { instance: request.id });
          return undefined;
        }
      }
      // Then the rows; the membership row cascades. A failure here answers 5xx
      // and leaves the collection gone, so the client's retry finishes the job.
      await calendars.remove(id);
      reply.code(204);
      return undefined;
    },
  );
}
