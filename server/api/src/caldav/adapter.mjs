// --- E05-R02: the API's CalDAV client adapter --------------------------------
//
// Every CalDAV request the API makes goes through this module. It is the only
// place that imports `tsdav`, that knows the internal listener's origin
// (`CALFLEX_CALDAV_ORIGIN`), the D-05 delegation keys
// (`CALFLEX_DELEGATION_KEYS`) or the `X-Calflex-Principal` header (ESLint
// enforces the import; `test/caldav-imports.test.mjs` enforces the rest).
//
// Authentication is D-05: the API is a service principal that speaks on behalf
// of a user. Each request carries a freshly signed `X-Calflex-Principal`
// header, exactly as E03-R01 defines it (`server/caldav/src/Delegation.php`):
//
//   v=1; k=<key-id>; p=<user id>; t=<unix seconds>; n=<nonce>; s=<signature>
//   s = base64url(HMAC-SHA256(key, "calflex-delegation-v1\n"
//                                + METHOD + "\n" + request-target + "\n"
//                                + p + "\n" + t + "\n" + n))
//
// `request-target` is the path and query *exactly as sent*, so the signature is
// computed from the URL object the request is actually made with — never from a
// string that is then re-serialised. The signer always uses the first key of
// `CALFLEX_DELEGATION_KEYS`; the service accepts any of them, so a key can be
// rotated by putting the new key in front and keeping the old one behind it.
//
// The module is deliberately quiet: it logs nothing, and no error it raises
// carries a URL, a header value, a key or a response body. The only response
// content that leaves here is the `cf:` precondition element names of a
// `DAV:error` (and the checked text of `cf:name`, which E05-R04 maps to its
// problem document), together with RFC 4791 § 5.3.2.1's fixed `max-instances`
// element (E03-R12).
//
// `node:crypto` is used for `createHmac` and `randomBytes`: authentication
// only. This module never touches event content beyond carrying it (INV-07: the
// server links no content-crypto library).

import { createHmac, randomBytes } from 'node:crypto';
import {
  calendarQuery,
  createObject,
  deleteObject,
  makeCalendar,
  propfind,
  syncCollection,
} from 'tsdav';

/**
 * The prefix SabreDAV builds its sync tokens with (RFC 6578; `Sync\Plugin`
 * `SYNCTOKEN_PREFIX`). `syncChanges` speaks it directly, and E05-R08's token
 * carries the same number under the API's own encoding.
 */
export const SYNC_TOKEN_PREFIX = 'http://sabre.io/ns/sync/';

/**
 * A sync number: a canonical non-negative decimal of at most 18 digits, so it
 * always fits the `bigint` the CalDAV service compares it as (a 19-digit value
 * can exceed a signed 64-bit and would make Postgres raise). Anything longer is
 * not a token this API minted and never reaches the service.
 */
const SYNC_NUMBER = /^(?:0|[1-9]\d{0,17})$/;

/**
 * `http://sabre.io/ns/sync/<n>` for a number that is already a canonical
 * decimal. Throws rather than building a URI the service would refuse, so a
 * caller can never hand CalDAV a value it did not mint here.
 * @param {string} number
 * @returns {string}
 */
export function syncTokenText(number) {
  if (typeof number !== 'string' || !SYNC_NUMBER.test(number)) {
    throw new CalDavError('invalid-token');
  }
  return `${SYNC_TOKEN_PREFIX}${number}`;
}

/**
 * The number out of one of those URIs, or `undefined` for anything else — a
 * numeric token of some other shape, a value that is not a string, and the
 * empty string included. Nothing here parses a client's own token: the only
 * strings this sees come back from the service.
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function syncTokenNumber(value) {
  if (typeof value !== 'string' || !value.startsWith(SYNC_TOKEN_PREFIX)) {
    return undefined;
  }
  const number = value.slice(SYNC_TOKEN_PREFIX.length);
  return SYNC_NUMBER.test(number) ? number : undefined;
}

/** The fixed display name a Private collection carries (D-18). */
export const PRIVATE_CALENDAR_DISPLAY_NAME = 'Private calendar';

/** The header the CalDAV service authenticates the API with (D-05). */
export const PRINCIPAL_HEADER = 'X-Calflex-Principal';

/**
 * The correlation ID header (E05-R10). It is *not* part of the delegation
 * signature: the service reads it, logs it with the request, and never lets it
 * change who the caller is.
 */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** The precondition namespace the CalDAV service answers with. */
export const FLEXCALDAV_NAMESPACE = 'https://flexcalendar.de/ns/caldav';

/** The namespace RFC 4791's own preconditions live in. */
export const CALDAV_NAMESPACE = 'urn:ietf:params:xml:ns:caldav';

/**
 * The one RFC 4791 precondition `parsePreconditions` reports. § 5.3.2.1's
 * `<C:max-instances/>` is the `403` a series over the collection's bound
 * answers with; the `C:` prefix is the RFC's own, not a namespace binding.
 */
export const MAX_INSTANCES_PRECONDITION = 'C:max-instances';

/** Hard response cap, so a hostile or broken listener cannot exhaust the API. */
export const RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * `parsePreconditions` reads at most this much of a response body. A `DAV:error`
 * from the CalDAV service is a few hundred bytes, and the only cost that grows
 * with the body would be paid by an attacker, so the rest is never scanned.
 */
export const PRECONDITION_SCAN_LIMIT_BYTES = 16 * 1024;

/** Per-request deadline. A signed request is never retried. */
export const REQUEST_TIMEOUT_MS = 10_000;

const MESSAGE_PREFIX = 'calflex-delegation-v1';
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OBJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_BYTES = /^[A-Za-z0-9+/]+={0,2}$/;
const CALDAV_TIME = /^\d{8}T\d{6}Z$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const PRECONDITION_NAME = /^[A-Z][A-Z0-9-]{0,63}$/;

/**
 * Errors carry a `kind` and the HTTP `status`; never a URL, a header value, a
 * key or a response body. `preconditions` holds the `cf:` element names of a
 * `DAV:error` body, in document order, with `cf:name`'s text in place of its
 * element name when that text is a well-formed property name, and RFC 4791's
 * fixed `max-instances` element as `C:max-instances` (E03-R12).
 */
export class CalDavError extends Error {
  /** @param {string} kind @param {number | null} [status] @param {string[]} [preconditions] */
  constructor(kind, status = null, preconditions = []) {
    super(
      [
        `CalDAV ${kind}`,
        status === null ? '' : ` (${status})`,
        preconditions.length > 0 ? `: ${preconditions.join(', ')}` : '',
      ].join(''),
    );
    this.name = 'CalDavError';
    this.kind = kind;
    this.status = status;
    this.preconditions = preconditions;
  }
}

/**
 * Parses `CALFLEX_DELEGATION_KEYS`: a comma-separated `<key-id>:<base64 key>`
 * list, each key at least 32 bytes, ids unique. The service applies the same
 * rules (`Delegation::keys`), so a configuration that starts the API also
 * starts the listener. The value itself never appears in the error.
 *
 * @param {string | undefined} config
 * @returns {{id: string, key: Buffer}[]}
 */
export function parseDelegationKeys(config) {
  if (typeof config !== 'string' || config.trim() === '') {
    throw new CalDavError('config');
  }
  /** @type {{id: string, key: Buffer}[]} */
  const keys = [];
  const seen = new Set();
  for (const entry of config.split(',')) {
    const separator = entry.indexOf(':');
    if (separator <= 0 || separator === entry.length - 1) {
      throw new CalDavError('config');
    }
    const id = entry.slice(0, separator);
    const encoded = entry.slice(separator + 1);
    if (!KEY_ID.test(id) || !KEY_BYTES.test(encoded) || seen.has(id)) {
      throw new CalDavError('config');
    }
    const key = Buffer.from(encoded, 'base64');
    // Round-trip the encoding so a non-canonical value is refused rather than
    // silently decoded to other bytes than the service would use.
    if (key.length < 32 || key.toString('base64') !== encoded) {
      throw new CalDavError('config');
    }
    seen.add(id);
    keys.push({ id, key });
  }
  if (keys.length === 0) throw new CalDavError('config');
  return keys;
}

/**
 * The pure signer: the E03-R01 vector function, exported so the tests can hold
 * it to `server/caldav/tests/Fixtures/delegation-vectors.json`.
 *
 * @param {{keyId: string, key: Buffer, principal: string, method: string, target: string, timestamp: number, nonce: string}} input
 * @returns {string}
 */
export function delegationHeader({
  keyId,
  key,
  principal,
  method,
  target,
  timestamp,
  nonce,
}) {
  const signature = createHmac('sha256', key)
    .update(
      `${MESSAGE_PREFIX}\n${method}\n${target}\n${principal}\n${timestamp}\n${nonce}`,
      'utf8',
    )
    .digest('base64url');
  return `v=1; k=${keyId}; p=${principal}; t=${timestamp}; n=${nonce}; s=${signature}`;
}

/** 16 random bytes, base64url without padding: the 22 characters the service requires. */
export function randomNonce() {
  return randomBytes(16).toString('base64url');
}

/**
 * The signed `request-target`: the path and query of the URL, exactly as the
 * WHATWG `URL` parser serialises them. The service verifies the signature over
 * the raw `REQUEST_URI` it received, so this is never a separately built string.
 *
 * @param {URL | string} input
 * @param {string | URL} [base]
 * @returns {string}
 */
export function delegationTarget(input, base) {
  const url = input instanceof URL ? input : new URL(String(input), base);
  return `${url.pathname}${url.search}`;
}

/**
 * @param {string} value
 * @param {string} label
 * @returns {string}
 */
function assertUuid(value, label) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    throw new CalDavError(`invalid-${label}`);
  }
  return value;
}

/**
 * The object name goes into the request path, so it is checked here, before any
 * request exists. No separators, no dot segments, no control characters.
 *
 * @param {string} value
 * @returns {string}
 */
function assertObjectName(value) {
  if (typeof value !== 'string' || !OBJECT_NAME.test(value)) {
    throw new CalDavError('invalid-name');
  }
  return value;
}

/**
 * An optional ETag precondition. `undefined` means "no precondition"; anything
 * that is not a string is refused rather than coerced into a header value.
 *
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function precondition(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new CalDavError('invalid-precondition');
  return value;
}

/**
 * `time-range` takes the iCalendar UTC form (`20260101T000000Z`). The ISO form
 * instants arrive in is accepted too; the conversion is a UTC reformat, never
 * zoned arithmetic.
 *
 * @param {string} value
 * @param {string} label
 * @returns {string}
 */
function assertCalDavTime(value, label) {
  if (typeof value === 'string' && CALDAV_TIME.test(value)) return value;
  if (typeof value === 'string' && ISO_TIME.test(value)) {
    const instant = new Date(value);
    if (!Number.isNaN(instant.getTime())) {
      return `${instant.toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '')}Z`;
    }
  }
  throw new CalDavError(`invalid-${label}`);
}

/**
 * @param {number} code
 * @returns {boolean}
 */
function isNameStart(code) {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x5f // _
  );
}

/**
 * @param {number} code
 * @returns {boolean}
 */
function isNamePart(code) {
  return (
    isNameStart(code) ||
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2e || // .
    code === 0x2d || // -
    code === 0x3a // :
  );
}

/**
 * @param {number} code
 * @returns {boolean}
 */
function isSpace(code) {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * The `name="value"` (or `name='value'`) pairs of one tag's attribute text, in
 * one forward pass. The scan never backtracks or re-reads a character, so a
 * hostile attribute list costs its own length and no more.
 *
 * @param {string} text
 * @returns {[string, string][]}
 */
function attributePairs(text) {
  /** @type {[string, string][]} */
  const pairs = [];
  const length = text.length;
  let index = 0;
  while (index < length) {
    if (isSpace(text.charCodeAt(index)) || text.charCodeAt(index) === 0x2f) {
      index += 1;
      continue;
    }
    const nameStart = index;
    while (index < length) {
      const code = text.charCodeAt(index);
      if (isSpace(code) || code === 0x3d) break;
      index += 1;
    }
    const name = text.slice(nameStart, index);
    while (index < length && isSpace(text.charCodeAt(index))) index += 1;
    if (text.charCodeAt(index) !== 0x3d) continue;
    index += 1;
    while (index < length && isSpace(text.charCodeAt(index))) index += 1;
    const quote = text.charCodeAt(index);
    if (quote !== 0x22 && quote !== 0x27) continue;
    index += 1;
    const valueStart = index;
    while (index < length && text.charCodeAt(index) !== quote) index += 1;
    if (name !== '') pairs.push([name, text.slice(valueStart, index)]);
    if (index < length) index += 1;
  }
  return pairs;
}

/**
 * The tags of a document, in one forward pass: `<name …>`, `</name>` and
 * `<name … />`. An XML prologue, a comment, text and any `<` that does not open
 * a tag are skipped. The scan advances monotonically and never re-reads a
 * character, so a body of angle brackets costs its own length; a tag that is
 * never closed ends the scan, because everything behind it is inside it.
 *
 * @param {string} xml
 * @returns {{start: number, end: number, closing: boolean, name: string, attributes: string, selfClosing: boolean}[]}
 */
function tagsOf(xml) {
  /** @type {{start: number, end: number, closing: boolean, name: string, attributes: string, selfClosing: boolean}[]} */
  const tags = [];
  const length = xml.length;
  let index = 0;
  for (;;) {
    const start = xml.indexOf('<', index);
    if (start === -1) return tags;
    let cursor = start + 1;
    const closing = xml.charCodeAt(cursor) === 0x2f;
    if (closing) cursor += 1;
    const nameStart = cursor;
    if (cursor < length && isNameStart(xml.charCodeAt(cursor))) {
      cursor += 1;
      while (cursor < length && isNamePart(xml.charCodeAt(cursor))) cursor += 1;
    }
    if (cursor === nameStart) {
      index = start + 1;
      continue;
    }
    const attributesStart = cursor;
    let quote = 0;
    let end = -1;
    while (cursor < length) {
      const code = xml.charCodeAt(cursor);
      if (quote !== 0) {
        if (code === quote) quote = 0;
      } else if (code === 0x22 || code === 0x27) {
        quote = code;
      } else if (code === 0x3e) {
        end = cursor;
        break;
      }
      cursor += 1;
    }
    if (end === -1) return tags;
    const attributes = xml.slice(attributesStart, end);
    tags.push({
      start,
      end,
      closing,
      name: xml.slice(nameStart, attributesStart),
      attributes,
      // `<name …/>`: the slash is the last character before the `>`.
      selfClosing: attributes.endsWith('/'),
    });
    index = end + 1;
  }
}

/**
 * Extracts the precondition element names from a `DAV:error` body.
 *
 * The scan is intentionally narrow: it reads at most
 * `PRECONDITION_SCAN_LIMIT_BYTES` of the body, it reports only elements of the
 * two namespaces it knows — the CalDAV service's own `cf:` namespace and, as a
 * single fixed name, RFC 4791's `{urn:ietf:params:xml:ns:caldav}max-instances`
 * — only when the root element is `{DAV:}error`, and it resolves namespace
 * prefixes properly instead of trusting a prefix. Element local names and
 * `cf:name`'s text are both held to their grammars, and the CalDAV element's
 * text and attributes are never read at all, so a body cannot smuggle free
 * text, an attribute value or event content out through the error. It is linear
 * in the length of what it reads: a body of angle brackets is hostile traffic,
 * not a reason to burn the API's event loop.
 *
 * @param {Buffer} body
 * @returns {string[]}
 */
export function parsePreconditions(body) {
  const xml = body.subarray(0, PRECONDITION_SCAN_LIMIT_BYTES).toString('utf8');
  if (xml === '') return [];
  /** @type {{prefix: string, local: string, namespace: string, text: string}[]} */
  const elements = [];
  /** @type {{prefix: string, local: string, namespace: string, text: string}[]} */
  const stack = [];
  /** @type {Map<string, string>[]} */
  const namespaces = [
    new Map([
      ['d', 'DAV:'],
      ['xml', 'http://www.w3.org/XML/1998/namespace'],
    ]),
  ];
  let root = null;
  let cursor = 0;
  for (const tag of tagsOf(xml)) {
    if (stack.length > 0)
      stack[stack.length - 1].text += xml.slice(cursor, tag.start);
    cursor = tag.end + 1;
    const separator = tag.name.indexOf(':');
    const prefix = separator === -1 ? '' : tag.name.slice(0, separator);
    const local = separator === -1 ? tag.name : tag.name.slice(separator + 1);
    if (tag.closing) {
      const open = stack.pop();
      if (open === undefined) return [];
      if (open.prefix !== prefix || open.local !== local) return [];
      continue;
    }
    const scope = new Map(namespaces[namespaces.length - 1]);
    for (const [name, value] of attributePairs(tag.attributes)) {
      if (name === 'xmlns') scope.set('', value);
      else if (name.startsWith('xmlns:')) scope.set(name.slice(6), value);
    }
    const element = {
      prefix,
      local,
      namespace: scope.get(prefix) ?? '',
      text: '',
    };
    elements.push(element);
    if (root === null) root = element;
    if (!tag.selfClosing) {
      stack.push(element);
      namespaces.push(scope);
    }
  }
  if (root === null || root.namespace !== 'DAV:' || root.local !== 'error')
    return [];
  const found = [];
  for (const element of elements) {
    if (element.namespace === FLEXCALDAV_NAMESPACE) {
      if (element.local === 'name') {
        const name = element.text.trim();
        if (PRECONDITION_NAME.test(name)) found.push(name);
        continue;
      }
      found.push(`cf:${element.local}`);
      continue;
    }
    // RFC 4791 § 5.3.2.1's `max-instances` is the one CalDAV-namespace element
    // this reports. It is a fixed name: its text and its attributes are never
    // read, so nothing a body writes can leave through it.
    if (
      element.namespace === CALDAV_NAMESPACE &&
      element.local === 'max-instances'
    ) {
      found.push(MAX_INSTANCES_PRECONDITION);
    }
  }
  return found;
}

/**
 * @param {number} status
 * @param {Buffer} body
 * @returns {CalDavError}
 */
function statusError(status, body) {
  // One kind for every 401: a database outage on the service looks the same as
  // a bad key from here, and the service log is where the difference lives.
  if (status === 401) return new CalDavError('unauthorized', 401);
  if (status === 403)
    return new CalDavError('forbidden', 403, parsePreconditions(body));
  if (status === 404) return new CalDavError('not-found', 404);
  if (status === 409) return new CalDavError('conflict', 409);
  if (status === 412) return new CalDavError('precondition-failed', 412);
  if (status === 415) return new CalDavError('unsupported-media-type', 415);
  if (status >= 500) return new CalDavError('server', status);
  return new CalDavError('failed', status);
}

/**
 * Reads a response body with a hard cap.
 *
 * @param {Response} response
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
async function readLimited(response, limit) {
  const stream = response.body;
  if (stream === null) return Buffer.alloc(0);
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new CalDavError('oversize', response.status);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Turns a transport response into either a successful one or a `CalDavError`.
 * The body is read here, once, so the cap and the error classification see the
 * same bytes; a caller reads the returned response again through `text()`.
 *
 * @param {Response} response
 * @param {number} limit
 * @returns {Promise<Response>}
 */
async function checkResponse(response, limit) {
  const status = response.status;
  const body = await readLimited(response, limit);
  // `redirect: 'manual'` hands a redirect back instead of following it; a
  // redirect is an error here, never a second request.
  if (status >= 300 && status < 400) throw new CalDavError('redirect', status);
  if (status < 200 || status >= 300) throw statusError(status, body);
  const headers = new Headers(response.headers);
  // The body was already decompressed and re-measured, so the origin's framing
  // headers would describe the wrong bytes.
  for (const name of [
    'content-length',
    'content-encoding',
    'transfer-encoding',
  ]) {
    headers.delete(name);
  }
  return new Response(body.byteLength === 0 ? null : Uint8Array.from(body), {
    status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * @param {string} target
 * @returns {string}
 */
function targetPath(target) {
  try {
    const url = new URL(target);
    return `${url.pathname}${url.search}`;
  } catch {
    return target.startsWith('/') ? target : `/${target}`;
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function textOf(value) {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    if (typeof record._cdata === 'string') return record._cdata;
    if (typeof record._text === 'string') return record._text;
  }
  return '';
}

/**
 * @param {unknown} error
 * @returns {CalDavError}
 */
function asCalDavError(error) {
  // tsdav reports some protocol problems with messages that quote the response.
  // Those never leave this module: they become a fixed, body-free error.
  return error instanceof CalDavError ? error : new CalDavError('protocol');
}

/**
 * The D-05-authenticated `fetch` the tsdav calls are given. A fresh nonce and
 * timestamp are minted per request and the header signs the URL this function
 * sends — `pathname` and `search` are taken from the same `URL` object. A
 * relative target is resolved against the configured origin; anything whose
 * origin is not that origin is refused before it is signed or sent. Exported so
 * the tests can reach both of those decisions directly.
 *
 * @param {{origin: URL, principal: string, keyId: string, key: Buffer, transport: typeof fetch, now: () => number, nonce: () => string, limit: number, timeout: number, requestId?: string}} config
 * @returns {typeof fetch}
 */
export function signedFetchFor(config) {
  const {
    origin,
    principal,
    keyId,
    key,
    transport,
    now,
    nonce,
    limit,
    timeout,
    requestId,
  } = config;
  return async (input, init = {}) => {
    const url =
      input instanceof URL
        ? new URL(input.href)
        : new URL(String(input), origin);
    if (url.origin !== origin.origin) throw new CalDavError('invalid-target');
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    headers.set(
      PRINCIPAL_HEADER,
      delegationHeader({
        keyId,
        key,
        principal,
        method,
        target: delegationTarget(url),
        timestamp: Math.floor(now() / 1000),
        nonce: nonce(),
      }),
    );
    // The caller's correlation ID, for the service's access log. Signed nothing
    // and authenticated nothing: it is logged beside the refusal, never used to
    // decide one.
    if (requestId !== undefined) {
      headers.set(REQUEST_ID_HEADER, requestId);
    }
    let response;
    try {
      response = await transport(url, {
        ...init,
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      const name =
        error !== null && typeof error === 'object' && 'name' in error
          ? String(error.name)
          : '';
      throw new CalDavError(
        name === 'TimeoutError' || name === 'AbortError'
          ? 'timeout'
          : 'network',
      );
    }
    return await checkResponse(response, limit);
  };
}

/**
 * @param {string | undefined} value
 * @returns {URL}
 */
function parseOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new CalDavError('config');
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new CalDavError('config');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new CalDavError('config');
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new CalDavError('config');
  }
  return url;
}

/**
 * Creates the adapter. `CALFLEX_CALDAV_ORIGIN` and `CALFLEX_DELEGATION_KEYS`
 * are read here and nowhere else in the service, and both are validated once,
 * at creation — so a caller that builds the adapter at start-up fails fast
 * instead of on a user's first request. Tests pass `origin` and `keys` in.
 *
 * @param {{origin?: string, keys?: string, fetch?: typeof fetch, now?: () => number, nonce?: () => string, limit?: number, timeout?: number}} [config]
 */
export function createCalDavAdapter(config = {}) {
  const origin = parseOrigin(
    config.origin ?? process.env.CALFLEX_CALDAV_ORIGIN,
  );
  const keys = parseDelegationKeys(
    config.keys ?? process.env.CALFLEX_DELEGATION_KEYS,
  );
  const transport = config.fetch ?? globalThis.fetch;
  if (typeof transport !== 'function') throw new CalDavError('config');
  const now = config.now ?? Date.now;
  const nonce = config.nonce ?? randomNonce;
  const limit = config.limit ?? RESPONSE_LIMIT_BYTES;
  const timeout = config.timeout ?? REQUEST_TIMEOUT_MS;
  const first = keys[0];

  return {
    origin: origin.origin,
    /**
     * The CalDAV view of one user. `userId` is the `users.id` the request is
     * made for; it is the `p` of the delegation header, so an id that is not a
     * UUIDv4 is refused before any request exists.
     *
     * Hrefs are `/calendars/<userId>/<calendarId>/…`. Object names are checked
     * here because they are path segments.
     *
     * `options.requestId` is the caller's correlation ID (`request.id`). When
     * it is present every CalDAV call carries it as `X-Request-Id`, so the
     * service's access log and the API's request line name the same request;
     * an id that is not a UUIDv4 is refused before any request exists.
     *
     * @param {string} userId
     * @param {{requestId?: string}} [options]
     */
    forUser(userId, options = {}) {
      const principal = assertUuid(userId, 'userId');
      const requestId =
        options.requestId === undefined
          ? undefined
          : assertUuid(options.requestId, 'requestId');
      const signed = signedFetchFor({
        origin,
        principal,
        keyId: first.id,
        key: first.key,
        transport,
        now,
        nonce,
        limit,
        timeout,
        requestId,
      });
      const home = `/calendars/${principal}/`;
      /** @param {string} calendarId */
      const collection = (calendarId) =>
        `${home}${assertUuid(calendarId, 'calendarId')}/`;
      /** @param {string} path */
      const absolute = (path) => new URL(path, origin).href;

      return {
        userId: principal,
        home,

        /**
         * `MKCALENDAR` of a Private collection (D-18: the fixed display name is
         * the only property the write guard allows).
         *
         * @param {string} calendarId
         */
        async makeCalendar(calendarId) {
          const url = absolute(collection(calendarId));
          const responses = await (async () => {
            try {
              return await makeCalendar({
                url,
                props: { 'd:displayname': PRIVATE_CALENDAR_DISPLAY_NAME },
                fetch: signed,
              });
            } catch (error) {
              throw asCalDavError(error);
            }
          })();
          return { status: responses[0]?.status ?? null };
        },

        /**
         * `DELETE` of the collection itself. Not part of the first event
         * routes, but a calendar that is created has to be removable, and the
         * integration suite removes what it created — the CalDAV service's own
         * tests do the same.
         *
         * @param {string} calendarId
         */
        async deleteCalendar(calendarId) {
          const url = absolute(collection(calendarId));
          const response = await signed(url, { method: 'DELETE' });
          return { status: response.status };
        },

        /**
         * `PUT` of one iCalendar object. `ifNoneMatch: '*'` creates only, an
         * `ifMatch` ETag updates only; either mismatch is a `412`.
         *
         * @param {string} calendarId
         * @param {string} name
         * @param {string} ics
         * @param {{ifMatch?: string, ifNoneMatch?: string}} [options]
         */
        async putObject(calendarId, name, ics, options = {}) {
          const url = absolute(collection(calendarId) + assertObjectName(name));
          if (typeof ics !== 'string' || ics === '')
            throw new CalDavError('invalid-body');
          /** @type {Record<string, string>} */
          const headers = { 'content-type': 'text/calendar; charset=utf-8' };
          const ifMatch = precondition(options.ifMatch);
          const ifNoneMatch = precondition(options.ifNoneMatch);
          if (ifMatch !== undefined) headers['If-Match'] = ifMatch;
          if (ifNoneMatch !== undefined) headers['If-None-Match'] = ifNoneMatch;
          const response = await (async () => {
            try {
              return await createObject({
                url,
                data: ics,
                headers,
                fetch: signed,
              });
            } catch (error) {
              throw asCalDavError(error);
            }
          })();
          return {
            status: response.status,
            etag: response.headers.get('etag'),
          };
        },

        /**
         * `GET` of one object: the bytes the CalDAV service stores, without the
         * XML round-trip a `calendar-query` would put them through.
         *
         * @param {string} calendarId
         * @param {string} name
         */
        async getObject(calendarId, name) {
          const url = absolute(collection(calendarId) + assertObjectName(name));
          const response = await signed(url, { method: 'GET' });
          return {
            status: response.status,
            etag: response.headers.get('etag'),
            data: await response.text(),
          };
        },

        /**
         * `DELETE` of one object, optionally conditioned on an ETag.
         *
         * @param {string} calendarId
         * @param {string} name
         * @param {{ifMatch?: string}} [options]
         */
        async deleteObject(calendarId, name, options = {}) {
          const url = absolute(collection(calendarId) + assertObjectName(name));
          if (
            options.ifMatch !== undefined &&
            typeof options.ifMatch !== 'string'
          ) {
            throw new CalDavError('invalid-precondition');
          }
          const response = await (async () => {
            try {
              return await deleteObject({
                url,
                etag: options.ifMatch,
                fetch: signed,
              });
            } catch (error) {
              throw asCalDavError(error);
            }
          })();
          return { status: response.status };
        },

        /**
         * `calendar-query`. With a `range` the report carries the `VEVENT`
         * `time-range` filter as well: `start`/`end` are iCalendar UTC instants
         * (`20260101T000000Z`) or ISO 8601 ones, and either is refused when it
         * is not a time. **Without** one, the filter is the `VCALENDAR`/
         * `VEVENT` component filter alone, so the service answers the whole
         * collection and the caller's own expansion decides the window — a
         * `time-range` makes the service iterate every series with its own
         * engine, and one long series fails the entire report.
         *
         * The returned `href`s are the server's paths, unchanged.
         *
         * `data` is the `calendar-data` an XML report carries it in, so it is
         * **LF-normalised**: the service strips the `\r` bytes out of the value
         * so they cannot disturb the XML. `getObject` is the call that returns
         * an object's stored bytes exactly.
         *
         * @param {string} calendarId
         * @param {{start: string, end: string}} [range]
         */
        async listObjects(calendarId, range) {
          const url = absolute(collection(calendarId));
          /** @type {Record<string, unknown>} */
          const filter = {
            'comp-filter': {
              _attributes: { name: 'VCALENDAR' },
              'comp-filter': { _attributes: { name: 'VEVENT' } },
            },
          };
          if (range !== undefined) {
            const start = assertCalDavTime(range?.start, 'start');
            const end = assertCalDavTime(range?.end, 'end');
            /** @type {any} */ (filter['comp-filter'])['comp-filter'][
              'time-range'
            ] = { _attributes: { start, end } };
          }
          const responses = await (async () => {
            try {
              return await calendarQuery({
                url,
                props: { 'd:getetag': {}, 'c:calendar-data': {} },
                filters: [filter],
                depth: '1',
                fetch: signed,
              });
            } catch (error) {
              throw asCalDavError(error);
            }
          })();
          return responses
            .filter(
              (response) =>
                typeof response.href === 'string' && response.href !== '',
            )
            .map((response) => ({
              href: targetPath(/** @type {string} */ (response.href)),
              etag: textOf(response.props?.getetag),
              data: textOf(response.props?.calendarData),
            }));
        },

        /**
         * `sync-collection`. Without a token the service answers the full
         * collection; with one, only the changes since it.
         *
         * Each changed entry carries `deleted` (a `404` response node), its
         * ETag and, when the object is present, its iCalendar data. A report's
         * own node for the collection (Sabre answers a truncated sync with one)
         * is not a change and is left out.
         *
         * Like `listObjects`, `data` is the `calendar-data` of an XML report and
         * is therefore **LF-normalised** (the service strips the `\r` bytes);
         * `getObject` returns an object's stored bytes exactly.
         *
         * @param {string} calendarId
         * @param {string} [token]
         */
        async syncChanges(calendarId, token) {
          const path = collection(calendarId);
          const url = absolute(path);
          if (token !== undefined && typeof token !== 'string') {
            throw new CalDavError('invalid-token');
          }
          const responses = await (async () => {
            try {
              return await syncCollection({
                url,
                props: { 'd:getetag': {}, 'c:calendar-data': {} },
                syncLevel: 1,
                syncToken: token,
                fetch: signed,
              });
            } catch (error) {
              throw asCalDavError(error);
            }
          })();
          const multistatus = responses[0]?.raw?.multistatus;
          return {
            syncToken: textOf(multistatus?.syncToken) || null,
            changed: responses
              .filter(
                (response) =>
                  typeof response.href === 'string' &&
                  response.href !== '' &&
                  targetPath(response.href) !== path,
              )
              .map((response) => ({
                href: targetPath(/** @type {string} */ (response.href)),
                // `404` (a deleted object) or the report's own status for a
                // present one; `deleted` is what a caller acts on.
                status: response.status,
                deleted: response.status === 404,
                etag: textOf(response.props?.getetag),
                data: textOf(response.props?.calendarData),
              })),
          };
        },

        /**
         * The collection's current sync number, read with a `PROPFIND` of
         * `{DAV:}sync-token` at depth 0 — the property SabreDAV's sync plugin
         * answers with `http://sabre.io/ns/sync/<n>` and nothing else. It is the
         * number a `sync-collection` reports after the collection's most recent
         * change, so a client's token can be checked against it before it is
         * trusted (E05-R08).
         *
         * The number comes back as a canonical decimal string: a sync token can
         * exceed what a JS number holds exactly, and the caller compares it to
         * another such string.
         *
         * @param {string} calendarId
         * @returns {Promise<string>}
         */
        async currentSyncToken(calendarId) {
          const url = absolute(collection(calendarId));
          const responses = await (async () => {
            try {
              return await propfind({
                url,
                props: { 'd:sync-token': {} },
                depth: '0',
                fetch: signed,
              });
            } catch (error) {
              throw asCalDavError(error);
            }
          })();
          const number = syncTokenNumber(responses[0]?.props?.syncToken);
          // A `207` that carries no sync token is a service this API cannot
          // read, never a token: nothing derived from it leaves here.
          if (number === undefined) throw new CalDavError('protocol');
          return number;
        },
      };
    },
  };
}
