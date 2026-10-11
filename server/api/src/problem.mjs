// --- E05-R10: RFC 9457 problem documents for the API -------------------------
//
// Every error the API answers with is a problem document (`Content-Type:
// application/problem+json`), built here and nowhere else. The table below is
// the whole model: one stable `type` URI and one fixed `title` per kind, each
// with the HTTP status it is sent as. Clients switch on `type`; `title` is
// human copy and may be reworded.
//
// Nothing in a body is derived from the request or from an exception: no path,
// no query value, no header, no validation message, no `pg` message, no CalDAV
// body. `instance` names the request's correlation ID, which is the only
// request-specific value that ever leaves here, and it is a UUID we minted.
// Event content must never reach a body, a log line or an error message
// (INV-01, INV-07).

import { eventSchema } from './event-schema.mjs';

/** The media type of every error body the API sends. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * The base URI every problem `type` is under. The slug after it is stable:
 * clients switch on `type`, never on `title` or `status`.
 */
export const PROBLEM_TYPE_BASE = 'https://flexcalendar.de/problems/';

/**
 * The table of problem kinds. `status` is the HTTP status the kind is sent as,
 * and `reply.code()` is set from it, so a body's `status` member and the status
 * line always agree.
 * @type {Record<string, {status: number, title: string}>}
 */
export const PROBLEM_TYPES = {
  'bad-request': { status: 400, title: 'Bad request' },
  unauthorized: { status: 401, title: 'Authentication required' },
  forbidden: { status: 403, title: 'Forbidden' },
  'private-skeleton-only': {
    status: 403,
    title: 'Private calendars store skeletons only',
  },
  'unmapped-collection': { status: 403, title: 'Calendar is not mapped' },
  'not-found': { status: 404, title: 'Not found' },
  'method-not-allowed': { status: 405, title: 'Method not allowed' },
  conflict: { status: 409, title: 'Conflict' },
  gone: { status: 410, title: 'Gone' },
  'precondition-failed': { status: 412, title: 'Precondition failed' },
  'payload-too-large': { status: 413, title: 'Payload too large' },
  'unsupported-media-type': {
    status: 415,
    title: 'Unsupported media type',
  },
  'invalid-input': { status: 422, title: 'Rejected input' },
  'precondition-required': {
    status: 428,
    title: 'Precondition required',
  },
  'rate-limited': { status: 429, title: 'Too many requests' },
  'internal-error': { status: 500, title: 'Internal server error' },
  'bad-gateway': { status: 502, title: 'Upstream request failed' },
  unavailable: { status: 503, title: 'Service unavailable' },
  'upstream-timeout': { status: 504, title: 'Upstream request timed out' },
};

/**
 * The `Problem` schema. `server/api/src/auth.mjs` uses it as the response
 * schema of every error status, `spec/openapi.yaml` declares the identical
 * document, and the contract test holds the two together. `property` is the
 * one extension member: the offending property name a Private-skeleton write
 * was refused for, never its value (E03-R09). `current` is the second, and
 * E05-R04's: the representation the store holds when a write lost a race, so a
 * 412 can hand back what to reapply the change to (RFC 9110 § 13.1.1). It is
 * the stored object, never the rejected request.
 */
export const problemSchema = {
  type: 'object',
  description:
    'An RFC 9457 problem document. `type` is stable per kind; `title` is fixed copy; `instance` is `urn:uuid:<the request correlation ID>`.',
  required: ['type', 'title', 'status', 'instance'],
  additionalProperties: false,
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    instance: { type: 'string' },
    property: { type: 'string' },
    current: eventSchema,
  },
};

/** The `instance` of a problem whose request ID could not be established. */
const NIL_UUID = '00000000-0000-4000-8000-000000000000';

/** The fixed precondition element a Private-skeleton refusal carries. */
const SKELETON_PRECONDITION = 'cf:private-skeleton-only';
/** …and the one an unmapped collection carries. */
const UNMAPPED_PRECONDITION = 'cf:unmapped-collection';
/** The only shape of a property name the guard ever emits (E03-R09). */
const PROPERTY_NAME = /^[A-Z][A-Z0-9-]{0,63}$/;

/** @param {string} slug */
export function problemType(slug) {
  if (!Object.hasOwn(PROBLEM_TYPES, slug)) {
    throw new Error(`unknown problem type: ${slug}`);
  }
  return `${PROBLEM_TYPE_BASE}${slug}`;
}

/**
 * The problem document for a kind. `property` is copied only when the caller
 * passes one, so a refusal cannot carry an empty extension member.
 * @param {string} slug
 * @param {{instance?: string, property?: string, current?: unknown}} [options]
 */
export function problemBody(slug, { instance, property, current } = {}) {
  const entry = PROBLEM_TYPES[slug];
  if (entry === undefined) throw new Error(`unknown problem type: ${slug}`);
  /** @type {{type: string, title: string, status: number, instance: string, property?: string, current?: unknown}} */
  const body = {
    type: problemType(slug),
    title: entry.title,
    status: entry.status,
    instance: `urn:uuid:${instance ?? NIL_UUID}`,
  };
  if (property !== undefined) body.property = property;
  if (current !== undefined) body.current = current;
  return body;
}

/**
 * The Fastify response schema for one problem status. A fresh copy per call, so
 * two routes sharing a status cannot share the compiler's view of the schema.
 */
export function problemResponse() {
  return {
    content: {
      [PROBLEM_CONTENT_TYPE]: { schema: structuredClone(problemSchema) },
    },
  };
}

/**
 * Answers a refusal. The status comes from the table, never from the caller, so
 * a body's `status` and the status line cannot drift apart. `instance` defaults
 * to the request's correlation ID; headers already on the reply
 * (`WWW-Authenticate`, `Retry-After`) are left alone.
 * @param {import('fastify').FastifyReply} reply
 * @param {string} slug
 * @param {{instance?: string, property?: string, current?: unknown}} [options]
 */
export function sendProblem(reply, slug, options = {}) {
  const entry = PROBLEM_TYPES[slug];
  if (entry === undefined) throw new Error(`unknown problem type: ${slug}`);
  const instance =
    options.instance ?? /** @type {any} */ (reply.request)?.id ?? undefined;
  reply
    .code(entry.status)
    .type(PROBLEM_CONTENT_TYPE)
    .send(problemBody(slug, { ...options, instance }));
}

/**
 * The one kind per HTTP status. Three kinds share 403 — a generic refusal and
 * the two Private-write preconditions — and only the generic one is chosen by
 * status alone: the adapter's `preconditions` decide the other two.
 */
export const PROBLEM_STATUS = new Map([
  [400, 'bad-request'],
  [401, 'unauthorized'],
  [403, 'forbidden'],
  [404, 'not-found'],
  [405, 'method-not-allowed'],
  [409, 'conflict'],
  [410, 'gone'],
  [412, 'precondition-failed'],
  [413, 'payload-too-large'],
  [415, 'unsupported-media-type'],
  [422, 'invalid-input'],
  [428, 'precondition-required'],
  [429, 'rate-limited'],
  [500, 'internal-error'],
  [502, 'bad-gateway'],
  [503, 'unavailable'],
  [504, 'upstream-timeout'],
]);

/**
 * The problem a Fastify or route error is answered with. The status is
 * normalised to a kind in the table, so the reply's status is always the one
 * the body names — an error thrown with some other status becomes a 400 (or a
 * 500 above 499) rather than an undocumented status line.
 * @param {unknown} status
 */
export function problemForStatus(status) {
  if (
    typeof status !== 'number' ||
    !Number.isInteger(status) ||
    status < 400 ||
    status > 599
  ) {
    return 'internal-error';
  }
  return (
    PROBLEM_STATUS.get(status) ??
    (status >= 500 ? 'internal-error' : 'bad-request')
  );
}

/**
 * The problem a `CalDavError` becomes. The adapter's `kind` and `status` decide
 * it and the adapter's already-filtered `preconditions` may add the offending
 * property name — the CalDAV body itself is never forwarded, and nothing here
 * reads a message, a URL or a response body.
 *
 * A CalDAV `401` is **not** the caller's 401 (E03-R01): the bearer token was
 * already verified before any route ran, so a 401 from the listener means our
 * own delegation failed — a bad key, or a service whose database is down and
 * which "answers 401 like a denial". Answering 401 here would sign a correctly
 * authenticated client out, so it is a 502 like every other unreadable upstream
 * answer.
 *
 * @param {unknown} error a `CalDavError`-shaped value
 * @returns {{problem: string, property?: string}}
 */
export function classifyCalDavError(error) {
  const kind =
    error !== null &&
    typeof error === 'object' &&
    typeof (/** @type {any} */ (error).kind) === 'string'
      ? /** @type {any} */ (error).kind
      : '';
  const raw = /** @type {any} */ (error)?.status;
  const status = Number.isInteger(raw) ? raw : null;
  const preconditions = Array.isArray(/** @type {any} */ (error)?.preconditions)
    ? /** @type {any} */ (error).preconditions
    : [];

  // Failures the adapter raised before or instead of a CalDAV answer.
  if (kind === 'timeout') return { problem: 'upstream-timeout' };
  if (kind === 'network' || kind === 'protocol' || kind === 'oversize') {
    return { problem: 'bad-gateway' };
  }
  // A misconfiguration or a bad argument is ours, not the caller's.
  if (kind === 'config' || kind.startsWith('invalid-')) {
    return { problem: 'internal-error' };
  }

  if (status === 403) {
    const index = preconditions.indexOf(SKELETON_PRECONDITION);
    if (index !== -1) {
      const name = preconditions[index + 1];
      const property =
        typeof name === 'string' && PROPERTY_NAME.test(name) ? name : undefined;
      return property === undefined
        ? { problem: 'private-skeleton-only' }
        : { problem: 'private-skeleton-only', property };
    }
    if (preconditions.includes(UNMAPPED_PRECONDITION)) {
      return { problem: 'unmapped-collection' };
    }
    return { problem: 'forbidden' };
  }

  switch (status) {
    case 401:
      return { problem: 'bad-gateway' };
    case 404:
      return { problem: 'not-found' };
    case 409:
      return { problem: 'conflict' };
    case 410:
      return { problem: 'gone' };
    case 412:
      return { problem: 'precondition-failed' };
    case 415:
      return { problem: 'unsupported-media-type' };
    case 503:
      return { problem: 'unavailable' };
    default:
      return { problem: 'bad-gateway' };
  }
}

/**
 * Answers a `CalDavError` as a problem. E05-R03 and E05-R04 call this: it is the
 * only mapping from the adapter's refusals to a response body.
 * @param {import('fastify').FastifyReply} reply
 * @param {unknown} error
 * @param {{instance?: string}} [options]
 */
export function sendCalDavProblem(reply, error, { instance } = {}) {
  const { problem, property } = classifyCalDavError(error);
  sendProblem(reply, problem, { instance, property });
}
