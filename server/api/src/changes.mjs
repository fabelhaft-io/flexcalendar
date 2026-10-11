// --- E05-R08: the delta endpoint ---------------------------------------------
//
// `GET /calendars/{calendarId}/changes?since=<token>`: WebDAV-Sync
// (`sync-collection`, RFC 6578) proxied for our own clients, declared in
// `spec/openapi.yaml` first and here second, exactly as `src/calendars.mjs` and
// `src/events.mjs` are. The structure is E05-R03/R04's: `resolveUser`, an id
// checked against the canonical lowercase UUID shape **before** the store is
// asked, `findMembership` (a non-member is the 404 an unknown id gets),
// `sendProblem` / `sendCalDavProblem`, and `adapter.forUser(userId,
// {requestId: request.id})`.
//
// **The answer is pointers, never content.** A change is `{uid, etag, deleted}`
// and nothing else: no `ical`, no `parsed`, no `SUMMARY`, no envelope. The
// client fetches what it needs with `GET …/events/{uid}` (E05-R05 windows it),
// and a client that reads this endpoint gets bytes it could have read from a
// push payload (INV-06 is about payloads, and this is the same shape). With no
// `since` the whole collection is reported as `deleted: false`, which is the
// initial load; with one, only what changed since that token.
//
// **The token is ours and bound to the calendar.** `since` is an opaque,
// client-opaque string this API minted: base64url of `<calendarId>:<n>`, where
// `<n>` is the number SabreDAV reported for the change the client last saw
// ("changed up to", E03-R10: `public.caldav_changes.sync_token` holds the same
// number). A client never builds one — and a `since` that is not in exactly
// that form, or that names another calendar, is answered `410` without asking
// CalDAV anything. A token the collection has never reached is `410` too:
// SabreDAV's PDO backend accepts any numeric token and echoes it back (it only
// queries `calendarchanges.synctoken >= n`, `lib/CalDAV/Backend/PDO.php`), so
// the check that a number is real is this API's, made against the collection's
// own current token (the adapter's `currentSyncToken`). That read only ever
// *refuses* one; the number an answer returns is the one the `sync-collection`
// report carried, so a write that lands between the report and the read cannot
// slip behind the client's cursor. `410` is the answer that tells the client to
// reload fully; it is the fixed problem document, and nothing of the request is
// in it.
//
// **A refused token is `410`, anything else CalDAV says keeps its meaning.** A
// `sync-collection` SabreDAV the service refuses comes back from the adapter as
// a `403` with no `cf:` precondition (SabreDAV's `InvalidSyncToken` carries the
// `DAV:valid-sync-token` element, which is not ours to forward), and that is
// mapped to the same `410`. Every other failure is `sendCalDavProblem`: a
// CalDAV `401` stays the `502` E03-R01 makes it, never the caller's `401`.
//
// **A deletion is a name, not a `UID`.** SabreDAV reports a tombstone by object
// name, and this API names an object it wrote `<uid>.ics` (E05-R04), so a name
// that is a UUIDv4 gives its own `uid`. Stored objects written by a stock app
// (Phase 4) need not be named after their `UID`; that seam — look the `uid` up
// in the `caldav_changes` outbox for the window, and leave the entry out
// entirely when the outbox cannot say — is `uidOfDeletion` below, and the
// README says what a Phase 4 client can expect of it.
//
// Roles: every member (`owner`, `editor`, `viewer`) reads. A non-member, an id
// outside the canonical shape and an unknown calendar are all the same 404.

import { identity, resolveUser } from './auth.mjs';
import { syncTokenNumber, syncTokenText } from './caldav/adapter.mjs';
import { IcalError, describe, parse } from './ical-rmw.mjs';
import { problemResponse, sendCalDavProblem, sendProblem } from './problem.mjs';

/**
 * One change, as the API answers with it. `spec/openapi.yaml`'s `Change` schema
 * is the identical document; `test/contract.test.mjs` holds the two together.
 * `etag` is present only for an object the collection holds now — a tombstone
 * has none, so a client cannot mistake a deletion for a stale copy.
 */
export const changeSchema = {
  type: 'object',
  description:
    'One changed object. It carries no event content: fetch the object itself for that.',
  required: ['uid', 'deleted'],
  additionalProperties: false,
  properties: {
    uid: {
      type: 'string',
      description:
        'The `VEVENT` `UID`, read from the object the collection holds. A tombstone names the `uid` of the object that was removed.',
    },
    deleted: {
      type: 'boolean',
      description:
        '`true` for a tombstone — the object is gone, and the entry carries no `etag` — and `false` for an object the collection holds now.',
    },
    etag: {
      type: 'string',
      description:
        'The CalDAV `ETag` of a present object. Absent on a tombstone.',
    },
  },
};

/**
 * The body of `GET /calendars/{calendarId}/changes`. `token` is opaque: the
 * client stores it and sends it back as `since`, and never builds one.
 */
export const changesSchema = {
  type: 'object',
  description:
    'The changes since a token, and the token that stands for that point in the collection. With no `since`, the whole collection is reported as present objects.',
  required: ['token', 'changes'],
  additionalProperties: false,
  properties: {
    token: {
      type: 'string',
      description:
        'The sync token to send back as `since` next time. Bound to this calendar; another calendar answers 410 for it.',
    },
    changes: {
      type: 'array',
      description:
        'One entry per changed object, a tombstone for a deletion. Empty when nothing changed since `since`.',
      items: changeSchema,
    },
  },
};

/**
 * The shape of a `calendars.id` (E03-R01), shared with the other routes: an id
 * outside it is the 404 an unknown id gets, decided before the store is asked.
 */
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The `UID`s this API mints (INV-03), in the strict v4 form. */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The unpadded base64url alphabet, which is all a token of ours uses. */
const TOKEN_ALPHABET = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * What a decoded token must be: a calendar id, a colon, and a canonical decimal
 * of at most 18 digits — the largest a `bigint` on the CalDAV side can hold, so
 * a number a client invents is refused here rather than raising there.
 */
const TOKEN = /^([0-9a-f-]{36}):(0|[1-9]\d{0,17})$/;

const OBJECT_SUFFIX = '.ics';

/**
 * A refusal every rule of this module shares: one status, one type, one body.
 * @param {import('fastify').FastifyReply} reply
 * @param {import('fastify').FastifyRequest} request
 * @param {'gone' | 'not-found'} slug
 */
function refuse(reply, request, slug) {
  sendProblem(reply, slug, { instance: request.id });
}

/**
 * The response schema of one operation: every status it can answer with, each
 * error one declared `Problem`, and no status a route cannot send. Copied from
 * `src/events.mjs` on purpose — this requirement adds a route module and leaves
 * E05-R04's alone.
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

/**
 * `GET /calendars/{calendarId}/changes`: 200 with the changes and the new
 * token, 404 for an unknown calendar or a non-member, 410 for a `since` that is
 * not a live token of this calendar.
 */
export const listChangesResponses = responseSchema(
  {
    200: {
      content: { 'application/json': { schema: changesSchema } },
    },
  },
  [...PROBLEMS, 404, 410],
);

/**
 * The object name in a change's `href`: everything after the last separator.
 * `''` when there is none, which names nothing and is left out by the caller.
 * @param {string} href
 * @returns {string}
 */
function nameOf(href) {
  const separator = href.lastIndexOf('/');
  return separator === -1 ? href : href.slice(separator + 1);
}

/** The name without the `.ics` this API appends, and nothing else. */
const bareName = (/** @type {string} */ name) =>
  name.endsWith(OBJECT_SUFFIX) ? name.slice(0, -OBJECT_SUFFIX.length) : name;

/**
 * The `uid` of a present object: the `UID` inside the object itself, which is
 * the authority (INV-01), with the object's name as the fallback for an object
 * this API cannot read — a collection that holds something else is the client's
 * problem only if it tries to read *it*, and a sync must still be able to move
 * past the object.
 * @param {string} data
 * @returns {string | undefined}
 */
function uidOfObject(data) {
  try {
    const calendar = parse(data);
    return describe(calendar).uid;
  } catch (error) {
    if (error instanceof IcalError) return undefined;
    throw error;
  }
}

/**
 * The `uid` of a tombstone. This API names an object `<uid>.ics`, so a name
 * that is a UUIDv4 carries its own answer; a name that is not (a stock app's
 * object, Phase 4) can only come from the outbox, and only when that window
 * holds exactly one deletion — guessing between several is worse than saying
 * "unknown", which leaves the entry out and costs the client one full reload.
 * @param {string} name
 * @param {string[]} candidates the `uid`s the outbox reports deleted in the window
 * @returns {string | undefined}
 */
function uidOfTombstone(name, candidates) {
  const bare = bareName(name);
  if (UUID_V4.test(bare)) return bare;
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Installs the one operation. `buildApp` calls this after the auth routes and
 * after both global hooks, so every handler here has a verified token and a
 * resolved `users.id` behind it.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} dependencies
 * @param {{findBySubject: Function, createFirstSight: Function}} dependencies.store
 * @param {{userinfo: Function}} dependencies.oidc
 * @param {{findMembership: Function, deletedUidsBetween: (calendarId: string, from: string, to: string) => Promise<{uid: string}[]>}} dependencies.calendars
 * @param {{forUser: (userId: string, options: {requestId?: string}) => {syncChanges: (calendarId: string, token?: string) => Promise<{syncToken: string | null, changed: any[]}>, currentSyncToken: (calendarId: string) => Promise<string>}}} dependencies.caldav
 */
export function registerChangeRoutes(app, { store, oidc, calendars, caldav }) {
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
   * The membership row the caller needs, or the refusal to answer with. Every
   * member may read, so the role decides nothing here: a calendar the caller is
   * not a member of is the 404 an id that exists nowhere gets (E03-R01), and
   * the id is checked before the store is asked.
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   * @param {string} userId
   * @param {string} calendarId
   */
  async function memberFor(request, reply, userId, calendarId) {
    if (!CANONICAL_UUID.test(calendarId)) {
      refuse(reply, request, 'not-found');
      return undefined;
    }
    const membership = await calendars.findMembership(calendarId, userId);
    if (membership === undefined) {
      refuse(reply, request, 'not-found');
      return undefined;
    }
    return membership;
  }

  /**
   * A `403` with no `cf:` precondition out of `sync-collection` is SabreDAV's
   * `InvalidSyncToken` (`DAV:valid-sync-token`, RFC 6578 § 3.2) — the one
   * refusal of a token the service itself makes, and the only `403` a `REPORT`
   * on a collection the caller can read has. It is a `410`: the token is gone,
   * and the client reloads. Everything else keeps its own problem.
   * @param {unknown} error
   */
  function refusedToken(error) {
    if (error === null || typeof error !== 'object') return false;
    const refusal = /** @type {Record<string, unknown>} */ (error);
    const forbidden = refusal.kind === 'forbidden' || refusal.status === 403;
    return (
      forbidden &&
      Array.isArray(refusal.preconditions) &&
      refusal.preconditions.length === 0
    );
  }

  /**
   * A token this API minted, decoded: the calendar it names and the number
   * SabreDAV reported for it. `undefined` for anything else — a value that is
   * not a string, a string outside the alphabet, a body that does not decode to
   * exactly `<calendar id>:<number>`.
   * @param {unknown} value
   * @returns {{calendarId: string, number: string} | undefined}
   */
  function readSince(value) {
    if (typeof value !== 'string' || !TOKEN_ALPHABET.test(value)) {
      return undefined;
    }
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const match = TOKEN.exec(decoded);
    return match === null
      ? undefined
      : { calendarId: match[1], number: match[2] };
  }

  /**
   * The token for a point in a collection. The number is canonical decimal
   * (never a JS float), so base64url of the text is what the client stores.
   * @param {string} calendarId
   * @param {string} number
   */
  const mint = (calendarId, number) =>
    Buffer.from(`${calendarId}:${number}`).toString('base64url');

  /**
   * One change entry, or `undefined` when this API cannot name its `uid` (a
   * tombstone whose object name is not the `UID` and that the outbox cannot
   * resolve).
   * @param {{href: string, deleted: boolean, etag: string, data: string}} change
   * @param {string[]} candidates
   * @returns {{uid: string, deleted: boolean, etag?: string} | undefined}
   */
  function entryFor(change, candidates) {
    const name = nameOf(change.href);
    if (name === '') return undefined;
    if (change.deleted) {
      const uid = uidOfTombstone(name, candidates);
      return uid === undefined ? undefined : { uid, deleted: true };
    }
    const uid = uidOfObject(change.data) ?? bareName(name);
    /** @type {{uid: string, deleted: boolean, etag?: string}} */
    const entry = { uid, deleted: false };
    // A present object without an `ETag` is not an `ETag` of `""`: the member
    // is left out rather than invented.
    if (typeof change.etag === 'string' && change.etag !== '') {
      entry.etag = change.etag;
    }
    return entry;
  }

  app.get(
    '/calendars/:calendarId/changes',
    {
      config: { bearerAuth: true },
      schema: { response: listChangesResponses },
    },
    async (request, reply) => {
      const user = await authenticated(request, reply);
      if (!user) return undefined;
      const { calendarId } = /** @type {{calendarId: string}} */ (
        request.params
      );
      const membership = await memberFor(request, reply, user.id, calendarId);
      if (membership === undefined) return undefined;

      // The token is checked before CalDAV is asked anything, so a value the
      // client built itself never reaches the service, not even to be refused
      // there. A malformed one and another calendar's are the same 410.
      const raw = /** @type {{since?: unknown}} */ (request.query).since;
      const since = raw === undefined ? undefined : readSince(raw);
      if (
        raw !== undefined &&
        (since === undefined || since.calendarId !== calendarId)
      ) {
        refuse(reply, request, 'gone');
        return undefined;
      }

      const view = caldavFor(request, reply, user.id);
      if (!view) return undefined;

      /** @type {{syncToken: string | null, changed: any[]}} */
      let report;
      try {
        report = await view.syncChanges(
          calendarId,
          since === undefined ? undefined : syncTokenText(since.number),
        );
      } catch (error) {
        if (refusedToken(error)) {
          refuse(reply, request, 'gone');
          return undefined;
        }
        sendCalDavProblem(reply, error, { instance: request.id });
        return undefined;
      }

      // **The number the report itself carries.** SabreDAV computes it together
      // with the changes it returns, so it is the position those changes belong
      // to. Nothing read later may replace it: the report and the `PROPFIND`
      // below are two requests, and a write that lands between them moves the
      // collection on — a client handed the later number would store a position
      // past a change the report never mentioned and skip it for good.
      const number = syncTokenNumber(report.syncToken);
      if (number === undefined) {
        // A `207` without a readable sync token cannot be turned into a cursor
        // that means anything, and inventing one would make the next request
        // lie. Nothing of the response is echoed.
        sendProblem(reply, 'bad-gateway', { instance: request.id });
        return undefined;
      }

      // A number the collection never reached is not a token: SabreDAV accepts
      // one and echoes it back (see the header), so the report cannot tell "in
      // sync" from "never minted" — the collection's own number does. It is
      // read only when the report held no change, because a number behind the
      // collection is answered with the changes in between; and it can only
      // *refuse* a token, never move the answer's.
      if (since !== undefined && report.changed.length === 0) {
        /** @type {string} */
        let current;
        try {
          current = await view.currentSyncToken(calendarId);
        } catch (error) {
          sendCalDavProblem(reply, error, { instance: request.id });
          return undefined;
        }
        if (BigInt(since.number) > BigInt(current)) {
          refuse(reply, request, 'gone');
          return undefined;
        }
      }

      // The outbox is only consulted when a tombstone's name is not the `UID`
      // (Phase 4); before that, every deletion resolves from its name alone.
      const unresolved = report.changed.filter(
        (change) =>
          change.deleted === true &&
          !UUID_V4.test(bareName(nameOf(change.href))),
      );
      /** @type {string[]} */
      let candidates = [];
      if (unresolved.length > 0) {
        const rows = await calendars.deletedUidsBetween(
          calendarId,
          since?.number ?? '0',
          number,
        );
        candidates = rows.map((row) => row.uid);
      }

      /** @type {{uid: string, deleted: boolean, etag?: string}[]} */
      const changes = [];
      for (const change of report.changed) {
        const entry = entryFor(change, candidates);
        if (entry !== undefined) changes.push(entry);
      }

      return { token: mint(calendarId, number), changes };
    },
  );
}
