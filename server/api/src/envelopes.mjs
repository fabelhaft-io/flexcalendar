// --- E13-R02: the sidecar API -------------------------------------------------
//
// `GET /calendars/{calendarId}/envelopes` and
// `PUT /calendars/{calendarId}/envelopes/{uid}`: the bulk read and the write of
// the sealed envelopes `public.event_envelopes` holds, declared in
// `spec/openapi.yaml` first and here second, exactly as `src/calendars.mjs`,
// `src/events.mjs` and `src/changes.mjs` are. The structure is theirs too:
// `resolveUser`, an id checked against the canonical lowercase UUID shape
// **before** the store is asked, `findMembership` (a non-member is the 404 an
// unknown id gets), `sendProblem` / `sendCalDavProblem`, and
// `adapter.forUser(userId, {requestId: request.id})`.
//
// **The API never opens an envelope** (INV-07). It links no content-crypto
// library, it decrypts nothing, and no byte of an envelope reaches a log line, a
// problem body or an error. What it checks is exactly what a server can check
// without a key: the header (`0x01`, the epoch as a big-endian uint32 within
// `integer`), the size (the event envelope's 65,536 bytes, `spec/crypto.md`
// §1.1) and the transport encoding — all in `src/calendar-envelope.mjs`.
//
// **An envelope is only answered when a skeleton names it** (D-06,
// `spec/crypto.md` §5.1). For every `VEVENT` the stored object holds, its
// `X-CALFLEX-ENVELOPE-SHA256` and its canonical `RECURRENCE-ID`
// (`src/envelope-refs.mjs`) select the one row that may be returned. That is
// the read gate, and it is what makes a crash between D-06's write steps
// harmless: the previous skeleton still names the previous envelope.
//
// **The write is D-06's order.** The row is inserted first, then the stored
// skeleton is re-written with the new hash and the caller's `If-Match`, then
// the superseded row is garbage-collected. A crash between the first two steps
// leaves the old skeleton naming the old envelope, so the old version stays
// readable; the new row is an orphan no skeleton names, and the 24-hour sweep of
// `src/envelope-gc.mjs` removes it. The write never changes the object's times
// or rule: the envelope was sealed over the skeleton the collection holds, so
// only the hash property moves.
//
// Roles: `owner` and `editor` write, every member reads, and a caller who is
// not a member gets the 404 an unknown calendar gets. An id outside the
// canonical shape is that same 404 before CalDAV is asked (E03-R01), and a
// `uid` that is not the lowercase UUIDv4 this API writes is one too — a Private
// object is named `<uid>.ics` and only such a name can exist (E03-R11).

import { createHash } from 'node:crypto';
import { identity, resolveUser } from './auth.mjs';
import {
  ENVELOPE_HASH_PROPERTY,
  IcalError,
  describe,
  parse,
  serialise,
} from './ical-rmw.mjs';
import { decodeEventEnvelope } from './calendar-envelope.mjs';
import { changeToken, decodeChangeToken } from './changes.mjs';
import { createOrphanCollector } from './envelope-gc.mjs';
import { envelopeRefsOf, eventFor, refKey } from './envelope-refs.mjs';
import { problemResponse, sendCalDavProblem, sendProblem } from './problem.mjs';
import {
  CalDavError,
  syncTokenNumber,
  syncTokenText,
} from './caldav/adapter.mjs';

/**
 * One envelope, as the API answers with it. `spec/openapi.yaml`'s `Envelope`
 * schema is the identical document; `test/contract.test.mjs` holds the two
 * together. A tombstone — the uid of an object deleted since `since` — carries
 * only `uid` and `deleted`.
 */
export const envelopeSchema = {
  type: 'object',
  description:
    'One sealed envelope as the sidecar holds it, with the metadata that selects it. Opaque to the API, which never opens one (INV-07). A tombstone — the uid of an object deleted since `since` — is an entry carrying only `uid` and `deleted`.',
  required: ['uid', 'deleted'],
  additionalProperties: false,
  properties: {
    uid: {
      type: 'string',
      description: 'The `VEVENT` `UID` the envelope belongs to.',
    },
    deleted: {
      type: 'boolean',
      description:
        '`true` for the uid of an object deleted since `since`, which has no envelope any more; `false` for an envelope a skeleton names.',
    },
    recurrenceId: {
      type: ['null', 'string'],
      description:
        'The canonical recurrence identity of the `VEVENT` this envelope belongs to, `spec/crypto.md` §5.2, or null for the master.',
    },
    epoch: {
      type: 'integer',
      description: 'The CCK epoch the envelope header carries.',
    },
    envelopeSha256: {
      type: 'string',
      description:
        'The SHA-256 of the complete envelope bytes, 64 lowercase hex digits, which is the value the skeleton carries.',
    },
    envelope: {
      type: 'string',
      description: 'The sealed envelope bytes, standard base64 and opaque.',
    },
  },
};

/** The body of `GET /calendars/{calendarId}/envelopes`. */
export const envelopeListSchema = {
  type: 'object',
  description:
    'The envelopes of one read, and the token that stands for the point in the collection they were read at.',
  required: ['token', 'envelopes'],
  additionalProperties: false,
  properties: {
    token: {
      type: 'string',
      description:
        'The sync token of the point this answer was read at, to send back as `since` next time. Bound to this calendar.',
    },
    envelopes: {
      type: 'array',
      description:
        'One entry per envelope a skeleton names, plus a tombstone per object deleted since `since`.',
      items: envelopeSchema,
    },
  },
};

/** The body of `PUT /calendars/{calendarId}/envelopes/{uid}`. */
export const envelopeWriteSchema = {
  type: 'object',
  description:
    'One envelope to store. The API checks its header, its size and that `envelopeSha256` is the SHA-256 of the bytes sent, and nothing else.',
  required: ['envelope', 'epoch', 'envelopeSha256'],
  additionalProperties: false,
  properties: {
    envelope: {
      type: 'string',
      description:
        'The sealed envelope bytes in standard base64: version `0x01`, the big-endian uint32 epoch, the 24-byte nonce, ciphertext and tag. At least 45 bytes, at most 65,536.',
    },
    epoch: {
      type: 'integer',
      description:
        'The CCK epoch, which must equal the epoch the envelope header carries and be 0 through 2147483647.',
    },
    envelopeSha256: {
      type: 'string',
      description:
        'The SHA-256 of the complete envelope bytes, 64 lowercase hex digits. The API refuses bytes that do not hash to it.',
    },
    recurrenceId: {
      type: ['null', 'string'],
      description:
        'The canonical recurrence identity of the `VEVENT` this envelope belongs to, `spec/crypto.md` §5.2, or null or absent for the master.',
    },
  },
};

/** The answer to a write. */
export const envelopeStampSchema = {
  type: 'object',
  description:
    'The envelope that was committed, its key, and the skeleton `ETag` the commit left.',
  required: ['uid', 'recurrenceId', 'epoch', 'envelopeSha256', 'etag'],
  additionalProperties: false,
  properties: {
    uid: {
      type: 'string',
      description: 'The `VEVENT` `UID` the envelope belongs to.',
    },
    recurrenceId: {
      type: ['null', 'string'],
      description:
        'The canonical recurrence identity this envelope belongs to, or null for the master.',
    },
    epoch: {
      type: 'integer',
      description: 'The CCK epoch the envelope header carries.',
    },
    envelopeSha256: {
      type: 'string',
      description:
        'The SHA-256 of the stored envelope bytes, 64 lowercase hex digits.',
    },
    etag: {
      type: ['null', 'string'],
      description:
        'The CalDAV `ETag` of the skeleton the commit wrote, or null when the store answered without one.',
    },
  },
};

/**
 * The shape of a `calendars.id` (E03-R01): an id outside it is the 404 an
 * unknown id gets, decided before the store is asked.
 */
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The `UID`s this API writes (INV-03, E03-R11), in the strict v4 form. */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The canonical `RECURRENCE-ID` text of `spec/crypto.md` §5.2. */
const RECURRENCE_ID = /^[0-9]{8}(T[0-9]{6}Z)?$/;

/** The text form of an envelope's SHA-256 (`spec/crypto.md` §5.1). */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The longest `uid` `calendarobjects.uid` holds (E03-R10). */
const MAX_UID = 200;

/**
 * The sentinel the collection reader throws for a token the collection never
 * reached; the route answers it as the same 410 a malformed token gets.
 */
const REFUSED_TOKEN = Symbol('refused-sync-token');

/** The members a write body carries; anything else is a 422, never ignored. */
const WRITE_MEMBERS = ['envelope', 'epoch', 'envelopeSha256', 'recurrenceId'];

/** The roles that may write. Every member may read. */
const WRITE_ROLES = ['owner', 'editor'];

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
 * The response schema of one operation: every status it can answer with, each
 * error one declared `Problem`. Copied from `src/events.mjs` on purpose — this
 * requirement adds a route module and leaves E05-R04's alone.
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
const ok = (/** @type {unknown} */ schema) => ({
  content: { 'application/json': { schema } },
});

/**
 * `GET /calendars/{calendarId}/envelopes`: 200 with the envelopes a skeleton
 * names and the token for them; 404 for an unknown calendar or a non-member;
 * 410 for a `since` that is not a live token of this calendar; 422 for a
 * request that names both `uid` and `since`.
 */
export const listEnvelopesResponses = responseSchema(
  { 200: ok(envelopeListSchema) },
  [...PROBLEMS, 404, 410, 422],
);

/**
 * `PUT /calendars/{calendarId}/envelopes/{uid}`: 200 with the key that was
 * committed, 404 for an unknown calendar or object, 412 for a stale
 * `If-Match`, 428 without one, and the body's own rules are 400/413/415/422.
 */
export const writeEnvelopeResponses = responseSchema(
  { 200: ok(envelopeStampSchema) },
  [...PROBLEMS, 400, 404, 412, 413, 415, 422, 428],
);

/**
 * The body as a plain JSON object holding only `members`, or undefined. A body
 * that is not an object, or that carries a member the operation does not take,
 * is refused by the caller — never ignored. The values are `any`: this checks
 * only which members are there.
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
 * value itself, unchanged. `undefined` when it is absent or empty (the 428).
 * @param {unknown} header
 * @returns {string | undefined}
 */
function ifMatchOf(header) {
  if (typeof header !== 'string') return undefined;
  const value = header.trim();
  return value === '' ? undefined : value;
}

/**
 * The `uid` query values, or undefined when the query names none. Each has to
 * be a non-empty string no longer than `calendarobjects.uid` (E03-R10); a value
 * that is not is the fixed 422. `null` means "refused, the reply is sent".
 * @param {unknown} value
 * @returns {string[] | undefined | null}
 */
function uidsOf(value) {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value];
  /** @type {string[]} */
  const uids = [];
  for (const entry of list) {
    if (typeof entry !== 'string' || entry === '' || entry.length > MAX_UID) {
      return null;
    }
    // A name asked for twice names one object; the read is of a set.
    if (!uids.includes(entry)) uids.push(entry);
  }
  return uids.length === 0 ? undefined : uids;
}

/** The bare object name without the `.ics` this API appends. */
const bareName = (/** @type {string} */ name) =>
  name.endsWith('.ics') ? name.slice(0, -'.ics'.length) : name;

/** The object name in an href: everything after the last separator. */
function nameOf(/** @type {string} */ href) {
  const separator = href.lastIndexOf('/');
  return separator === -1 ? href : href.slice(separator + 1);
}

/**
 * Installs the two operations. `buildApp` calls this after the other route
 * modules and after both global hooks, so every handler here has a verified
 * token and a resolved `users.id` behind it.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} dependencies
 * @param {{findBySubject: Function, createFirstSight: Function}} dependencies.store
 * @param {{userinfo: Function}} dependencies.oidc
 * @param {{findMembership: Function}} dependencies.calendars
 * @param {{forUser: (userId: string, options: {requestId?: string}) => any}} dependencies.caldav
 * @param {{insert: Function, list: Function, deleteSuperseded: Function, listStaleBefore: Function, deleteExact: Function}} dependencies.envelopes
 */
export function registerEnvelopeRoutes(
  app,
  { store, oidc, calendars, caldav, envelopes },
) {
  /** The collector's clock is the real one; a test seeds an old row instead. */
  const collector = createOrphanCollector({ store: envelopes });

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
   * The membership row the caller needs, or the refusal to answer with (sent
   * already). A calendar the caller is not a member of is the 404 an id that
   * exists nowhere gets (E03-R01).
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
   * The `uid` path parameter, or the refusal (sent already). Only a UUIDv4 this
   * API could have written names a Private object (E03-R11), so anything else
   * cannot exist and is the 404 an unknown one gets.
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
   * The representation of a stored object: the bytes CalDAV holds, its `ETag`,
   * and the parsed view of its master `VEVENT`. `undefined` when the text is
   * not an object this API can describe.
   * @param {string} text
   * @param {string | null | undefined} etag
   */
  function representationOf(text, etag) {
    try {
      const parsed = describe(parse(text));
      return { uid: parsed.uid, etag: etag ?? null, ical: text, parsed };
    } catch (error) {
      if (error instanceof IcalError) return undefined;
      throw error;
    }
  }

  /**
   * The object the collection holds, parsed, or the refusal (sent already).
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   * @param {any} view
   * @param {string} calendarId
   * @param {string} uid
   * @returns {Promise<{stored: {data: string, etag?: string | null}, calendar: import('ical.js').default.Component} | undefined>}
   */
  async function objectFor(request, reply, view, calendarId, uid) {
    /** @type {{data: string, etag?: string | null}} */
    let stored;
    try {
      stored = await view.getObject(calendarId, objectName(uid));
    } catch (error) {
      sendCalDavProblem(reply, error, { instance: request.id });
      return undefined;
    }
    try {
      return { stored, calendar: parse(stored.data) };
    } catch (error) {
      if (error instanceof IcalError) {
        sendProblem(reply, 'bad-gateway', { instance: request.id });
        return undefined;
      }
      throw error;
    }
  }

  /**
   * A `412` from CalDAV: the caller's `If-Match` no longer names the object the
   * collection holds. The answer carries what it holds now, in the problem's
   * `current` member, so the client can re-read, re-seal and retry — and
   * nothing of the request that lost the race.
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
    } catch (error) {
      if (/** @type {any} */ (error)?.status === 404) {
        sendProblem(reply, 'not-found', { instance: request.id });
        return;
      }
      current = undefined;
    }
    sendProblem(reply, 'precondition-failed', {
      instance: request.id,
      current,
    });
  }

  app.get(
    '/calendars/:calendarId/envelopes',
    {
      config: { bearerAuth: true },
      schema: { response: listEnvelopesResponses },
    },
    async (request, reply) => {
      const user = await authenticated(request, reply);
      if (!user) return undefined;
      const { calendarId } = /** @type {{calendarId: string}} */ (
        request.params
      );
      const membership = await memberFor(request, reply, user.id, calendarId);
      if (membership === undefined) return undefined;

      const query = /** @type {{uid?: unknown, since?: unknown}} */ (
        request.query
      );
      const uids = uidsOf(query.uid);
      if (uids === null) {
        invalidInput(reply, request);
        return undefined;
      }
      // `uid` and `since` name different sets of objects; a request that names
      // both does not say which one it wants.
      if (uids !== undefined && query.since !== undefined) {
        invalidInput(reply, request);
        return undefined;
      }
      // A token the client built itself, or one minted for another calendar,
      // never reaches CalDAV — and never has its value echoed back.
      const since =
        query.since === undefined ? undefined : decodeChangeToken(query.since);
      if (query.since !== undefined && since === undefined) {
        sendProblem(reply, 'gone', { instance: request.id });
        return undefined;
      }
      if (since !== undefined && since.calendarId !== calendarId) {
        sendProblem(reply, 'gone', { instance: request.id });
        return undefined;
      }

      const view = caldavFor(request, reply, user.id);
      if (!view) return undefined;

      /**
       * The present objects to read the hash gate over, and the uid of every
       * object deleted since the token. `token` is the point of the collection
       * the answer belongs to.
       * @type {{token: string, objects: {uid: string, data: string}[], deletedUids: string[]}}
       */
      let read;
      try {
        read = await readCollection(view, calendarId, { since, uids });
      } catch (error) {
        if (error === REFUSED_TOKEN) {
          sendProblem(reply, 'gone', { instance: request.id });
          return undefined;
        }
        sendCalDavProblem(reply, error, { instance: request.id });
        return undefined;
      }

      // The envelope keys the skeletons name, read once: they are the read
      // gate, and the `uid`s they carry are the rows worth asking the store
      // for. An object written by a stock app (Phase 4) need not be named after
      // its `UID`, so the object's name is a candidate too.
      const refsByObject = read.objects.map((object) => ({
        refs: envelopeRefsOf(object.data),
      }));
      /** @type {Set<string>} */
      const candidateSet = new Set(read.objects.map((object) => object.uid));
      for (const { refs } of refsByObject)
        for (const ref of refs) candidateSet.add(ref.uid);
      const rows = await envelopes.list(
        calendarId,
        since === undefined && uids === undefined
          ? undefined
          : [...candidateSet],
      );
      /** @type {Map<string, any>} */
      const byKey = new Map();
      for (const row of rows)
        byKey.set(refKey(row.uid, row.recurrenceId, row.envelopeSha256), row);

      /** @type {{uid: string, deleted: boolean, recurrenceId?: string | null, epoch?: number, envelopeSha256?: string, envelope?: string}[]} */
      const entries = [];
      /** @type {Set<string>} */
      const seen = new Set();
      for (const { refs } of refsByObject) {
        for (const ref of refs) {
          const key = refKey(ref.uid, ref.recurrenceId, ref.envelopeSha256);
          if (seen.has(key)) continue;
          const row = byKey.get(key);
          if (row === undefined) continue;
          seen.add(key);
          entries.push({
            uid: row.uid,
            deleted: false,
            recurrenceId: row.recurrenceId,
            epoch: row.epoch,
            envelopeSha256: row.envelopeSha256,
            envelope: row.envelope,
          });
        }
      }
      for (const uid of read.deletedUids) {
        if (seen.has(uid)) continue;
        seen.add(uid);
        entries.push({ uid, deleted: true });
      }

      return { token: read.token, envelopes: entries };
    },
  );

  /**
   * The objects one read is about. Three modes, mutually exclusive by the
   * caller: a `since` delta, a `uid` list, or the whole collection.
   *
   * A delta reuses E05-R08's cursor exactly: the same token, the same
   * `sync-collection`, and the same refusal of a number the collection never
   * reached (SabreDAV accepts any numeric token and echoes it back, so the
   * collection's own number is what tells "in sync" from "never minted"). A
   * tombstone names its object, so its uid is the bare name when that name is
   * the UUIDv4 this API writes.
   *
   * @param {any} view
   * @param {string} calendarId
   * @param {{since?: {number: string}, uids?: string[]}} options
   */
  async function readCollection(view, calendarId, { since, uids }) {
    if (uids !== undefined) {
      /** @type {{uid: string, data: string}[]} */
      const objects = [];
      for (const uid of uids) {
        try {
          const stored = await view.getObject(calendarId, objectName(uid));
          objects.push({ uid, data: stored.data });
        } catch (error) {
          // A named uid the collection does not hold is not an error: a bulk
          // read answers the objects that exist. Anything else is.
          if (/** @type {any} */ (error)?.status !== 404) throw error;
        }
      }
      const token = await view.currentSyncToken(calendarId);
      return {
        token: changeToken(calendarId, token),
        objects,
        deletedUids: [],
      };
    }

    /** @type {{syncToken: string | null, changed: any[]}} */
    const report = await view.syncChanges(
      calendarId,
      since === undefined ? undefined : syncTokenText(since.number),
    );
    const number = syncTokenNumber(report.syncToken);
    // A `207` without a readable sync token cannot become a cursor that means
    // anything, and inventing one would make the next request lie.
    if (number === undefined) throw new CalDavError('protocol');
    // A number the collection never reached is not a token. The report cannot
    // tell "in sync" from "never minted", so the collection's own number does;
    // it can only refuse one, never move the answer's.
    if (since !== undefined && report.changed.length === 0) {
      const current = await view.currentSyncToken(calendarId);
      if (BigInt(since.number) > BigInt(current)) throw REFUSED_TOKEN;
    }

    /** @type {{uid: string, data: string}[]} */
    const objects = [];
    /** @type {string[]} */
    const deletedUids = [];
    for (const change of report.changed) {
      const bare = bareName(nameOf(change.href));
      if (change.deleted) {
        if (UUID_V4.test(bare)) deletedUids.push(bare);
        continue;
      }
      if (bare === '') continue;
      objects.push({ uid: bare, data: change.data });
    }
    return { token: changeToken(calendarId, number), objects, deletedUids };
  }

  app.put(
    '/calendars/:calendarId/envelopes/:uid',
    {
      config: { bearerAuth: true },
      schema: { response: writeEnvelopeResponses },
    },
    async (request, reply) => {
      const user = await authenticated(request, reply);
      if (!user) return undefined;
      const body = readBody(request.body, WRITE_MEMBERS);
      if (
        body === undefined ||
        body.envelope === undefined ||
        body.epoch === undefined ||
        body.envelopeSha256 === undefined
      ) {
        invalidInput(reply, request);
        return undefined;
      }
      // A write commits the skeleton, so it needs the version it read
      // (RFC 9110 § 13.1.1): without `If-Match` the commit is unconditional.
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

      // The header, the size and the transport encoding, and nothing else: the
      // API never opens an envelope (INV-07).
      const bytes = decodeEventEnvelope(body.envelope, body.epoch);
      if (bytes === undefined) {
        invalidInput(reply, request);
        return undefined;
      }
      if (
        typeof body.envelopeSha256 !== 'string' ||
        !SHA256_HEX.test(body.envelopeSha256)
      ) {
        invalidInput(reply, request);
        return undefined;
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      // The hash the skeleton will carry has to be the hash of the bytes that
      // are stored, or the read gate would never answer this envelope.
      if (digest !== body.envelopeSha256) {
        invalidInput(reply, request);
        return undefined;
      }
      /** @type {string | null} */
      let recurrenceId = null;
      if (body.recurrenceId !== undefined && body.recurrenceId !== null) {
        if (
          typeof body.recurrenceId !== 'string' ||
          !RECURRENCE_ID.test(body.recurrenceId)
        ) {
          invalidInput(reply, request);
          return undefined;
        }
        recurrenceId = body.recurrenceId;
      }

      const view = caldavFor(request, reply, user.id);
      if (!view) return undefined;
      const read = await objectFor(request, reply, view, calendarId, uid);
      if (read === undefined) return undefined;
      const target = eventFor(read.calendar, recurrenceId);
      if (target === undefined) {
        // The object holds no `VEVENT` with that recurrence identity, so an
        // envelope stored for it could never be opened.
        invalidInput(reply, request);
        return undefined;
      }
      // Only the hash property moves: the envelope was sealed over the skeleton
      // the collection already holds (its times and rule are bound into the AAD,
      // `spec/crypto.md` §2.2), so nothing else about the object may change.
      target.removeAllProperties(ENVELOPE_HASH_PROPERTY);
      target.addPropertyWithValue(ENVELOPE_HASH_PROPERTY, digest);
      const ical = serialise(read.calendar);

      // D-06 step 1: the row first, so a crash before the `PUT` leaves the old
      // skeleton naming the old envelope.
      await envelopes.insert({
        calendarId,
        uid,
        recurrenceId,
        envelopeSha256: digest,
        epoch: body.epoch,
        envelope: bytes,
      });

      /** @type {{status: number, etag?: string | null}} */
      let written;
      try {
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

      // D-06 step 3: the rows this skeleton no longer names are garbage.
      await envelopes.deleteSuperseded({
        calendarId,
        uid,
        recurrenceId,
        keepSha256: digest,
      });
      // The 24-hour orphan sweep: rows a crash left behind are invisible to the
      // read gate already, and this is where an old one is finally removed. A
      // failure here must not fail the write it followed.
      try {
        await collector.sweep({ calendarId, view });
      } catch {
        // Nothing about a sweep failure belongs to this request's answer.
      }

      if (written.etag) reply.header('etag', written.etag);
      return {
        uid,
        recurrenceId,
        epoch: body.epoch,
        envelopeSha256: digest,
        etag: written.etag ?? null,
      };
    },
  );
}
