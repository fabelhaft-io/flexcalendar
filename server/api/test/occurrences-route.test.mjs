// --- E05-R05: the occurrence endpoint, without a database --------------------
//
// The route through the real `buildApp`: the real hooks, the real problem
// documents and the real response schema, against the in-memory calendar store
// and the in-memory CalDAV collection the other route suites use. The expansion
// itself is `src/occurrences.mjs` and is tested on its own
// (`test/occurrences.test.mjs`); what is under test here is the operation:
//
//   * the window is validated before CalDAV is asked anything, and every way it
//     can be wrong is the one fixed 422 — never a value of the request echoed
//     back;
//   * the padded window (`from - 1 day` .. `to + 1 day`) is what the CalDAV
//     `calendar-query` is asked for, so the service's own engine cannot filter
//     out an all-day day or a ±14 h offset;
//   * the answer is the expanded occurrences plus the objects that were left
//     out, and it carries no content (INV-01, INV-07);
//   * a window that would answer more occurrences than one answer may carry is
//     the 422 `window-too-large`;
//   * every role reads; a stranger, an unknown calendar and an id outside the
//     canonical shape are the 404 the other routes give; a known path under
//     another method is a 405 with `Allow`;
//   * a hostile exception from the store or the adapter is the fixed problem and
//     never reaches a body or a log line.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { test } from 'node:test';

import { buildApp } from '../src/app.mjs';
import { readConfig } from '../src/config.mjs';
import { MAX_OCCURRENCES } from '../src/occurrences.mjs';
import { createMemoryCalDavStore } from './support/caldav-store.mjs';
import { createMemoryCalendarStore } from './support/calendar-store.mjs';
import { assertProblem } from './support/problem.mjs';

const ISSUER = 'https://auth.example.test';
const AUDIENCE = 'project-id';
const OWNER = {
  id: '11111111-1111-4111-8111-111111111111',
  handle: 'alice',
  email: 'alice@example.test',
};
const EDITOR = {
  id: '22222222-2222-4222-8222-222222222222',
  handle: 'bob',
  email: 'bob@example.test',
};
const VIEWER = {
  id: '33333333-3333-4333-8333-333333333333',
  handle: 'carol',
  email: 'carol@example.test',
};
const STRANGER = {
  id: '44444444-4444-4444-8444-444444444444',
  handle: 'dave',
  email: 'dave@example.test',
};
const USERS = {
  owner: OWNER,
  editor: EDITOR,
  viewer: VIEWER,
  stranger: STRANGER,
};

/** A value that must never reach a body or a log line. */
const CANARY = 'CALFLEX_EVENT_CONTENT_CANARY';
/** A `UID` of the shape this API mints, so an object name looks like ours. */
const UID = '5d6c7b8a-9012-4ef3-8abc-0123456789ab';
const HASH = 'a'.repeat(64);

/** A three-segment token whose middle segment is the subject. */
const token = (/** @type {string} */ subject) => `a.${subject}.c`;

const oidc = {
  /** @param {string} value */
  async verify(value) {
    const subject = String(value).split('.')[1];
    if (!Object.hasOwn(USERS, subject)) throw new Error('unknown token');
    return { sub: subject };
  },
  async userinfo() {
    throw new Error('userinfo is not part of these tests');
  },
};

const usersStore = {
  /** @param {string} subject */
  async findBySubject(subject) {
    return /** @type {Record<string, any>} */ (USERS)[subject];
  },
  async createFirstSight() {
    throw new Error('first sight is not part of these tests');
  },
};

const audience = {
  async current() {
    return AUDIENCE;
  },
  async refresh() {
    return false;
  },
};

/** A writable that keeps every log line. */
function captureLog() {
  /** @type {string[]} */
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

/** One `VCALENDAR` around one or more `VEVENT`s, as a collection holds it. */
function objects(/** @type {string[][]} */ events) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//flexcalendar//E05-R05 test//EN',
    ...events.flatMap((lines) => [
      'BEGIN:VEVENT',
      `UID:${UID}`,
      'DTSTAMP:20260101T000000Z',
      `X-CALFLEX-ENVELOPE-SHA256:${HASH}`,
      ...lines,
      'END:VEVENT',
    ]),
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/**
 * The app, both in-memory stores, the CalDAV double, a captured log and one
 * Private calendar with an owner, an editor and a viewer.
 */
async function setup() {
  const capture = captureLog();
  /** @type {Record<string, unknown>[]} */
  const events = [];
  const calendars = createMemoryCalendarStore({ events });
  const caldav = createMemoryCalDavStore({ events });
  const app = buildApp({
    config: readConfig({
      CALFLEX_OIDC_ISSUER: ISSUER,
      CALFLEX_OIDC_BASE_URL: ISSUER,
      CALFLEX_OIDC_AUDIENCE: AUDIENCE,
    }),
    oidc,
    audience,
    store: usersStore,
    calendars,
    caldav,
    logger: { stream: capture.stream },
  });
  const calendarId = randomUUID();
  await calendars.createPrivate({
    id: calendarId,
    ownerId: OWNER.id,
    href: `/calendars/${OWNER.id}/${calendarId}/`,
    metaEnvelope: Buffer.alloc(45, 1),
    metaEpoch: 1,
  });
  calendars.addMember(calendarId, EDITOR.id, 'editor');
  calendars.addMember(calendarId, VIEWER.id, 'viewer');
  return { app, capture, calendars, caldav, events, calendarId };
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{url?: string, method?: string, subject?: string, headers?: Record<string, string>, payload?: unknown}} [options]
 */
async function call(
  app,
  { url, method = 'GET', subject, headers = {}, payload } = {},
) {
  return /** @type {any} */ (
    await app.inject(
      /** @type {any} */ ({
        method,
        url,
        headers:
          subject === undefined
            ? headers
            : { authorization: `Bearer ${token(subject)}`, ...headers },
        payload,
      }),
    )
  );
}

const occurrencesUrl = (
  /** @type {string} */ calendarId,
  /** @type {string} */ query,
) => `/calendars/${calendarId}/occurrences?${query}`;

test('the window is expanded, and the CalDAV read is padded by a day each side', async () => {
  const { app, caldav, events, calendarId } = await setup();
  try {
    caldav.seed(
      calendarId,
      `${UID}.ics`,
      objects([
        [
          'DTSTART:20260105T090000Z',
          'DTEND:20260105T100000Z',
          'RRULE:FREQ=DAILY;COUNT=3',
        ],
      ]),
    );
    const response = await call(app, {
      url: occurrencesUrl(
        calendarId,
        'from=20260106T000000Z&to=20260107T000000Z&tz=Europe/Berlin',
      ),
      subject: 'viewer',
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.deepEqual(body.unsupported, []);
    assert.deepEqual(
      body.occurrences.map((/** @type {any} */ o) => o.start.utc),
      ['20260106T090000Z'],
    );
    assert.deepEqual(body.occurrences[0].start, {
      utc: '20260106T090000Z',
      local: '20260106T100000',
      tzid: 'Europe/Berlin',
    });
    assert.deepEqual(body.occurrences[0].recurrenceId, {
      utc: '20260106T090000Z',
    });
    assert.equal(body.occurrences[0].override, false);
    assert.equal(body.occurrences[0].envelopeSha256, HASH);

    // The report this API asked for is wider than the window it was asked for
    // (E05-R05): the service's own engine answers its `time-range` filter.
    const read = /** @type {any} */ (
      events.filter((entry) => entry.op === 'listObjects')
    );
    assert.equal(read.length, 1);
    assert.equal(read[0].start, '20260105T000000Z');
    assert.equal(read[0].end, '20260108T000000Z');
  } finally {
    await app.close();
  }
});

test('`tz` defaults to UTC and every role reads', async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    caldav.seed(
      calendarId,
      `${UID}.ics`,
      objects([['DTSTART:20260105T090000Z', 'DTEND:20260105T100000Z']]),
    );
    for (const subject of ['owner', 'editor', 'viewer']) {
      const response = await call(app, {
        url: occurrencesUrl(
          calendarId,
          'from=20260105T000000Z&to=20260106T000000Z',
        ),
        subject,
      });
      assert.equal(response.statusCode, 200, `${subject}: ${response.body}`);
      assert.deepEqual(response.json().occurrences[0].start, {
        utc: '20260105T090000Z',
        local: '20260105T090000',
        tzid: 'UTC',
      });
    }
  } finally {
    await app.close();
  }
});

test('an object the expansion leaves out is reported, and the rest is answered', async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    caldav.seed(
      calendarId,
      `${UID}.ics`,
      objects([
        [
          'DTSTART;TZID=W. Europe Standard Time:20260105T090000',
          'DTEND;TZID=W. Europe Standard Time:20260105T100000',
          `SUMMARY:${CANARY}`,
        ],
      ]),
    );
    const response = await call(app, {
      url: occurrencesUrl(
        calendarId,
        'from=20260105T000000Z&to=20260106T000000Z',
      ),
      subject: 'owner',
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.deepEqual(body.occurrences, []);
    assert.equal(body.unsupported.length, 1);
    assert.equal(body.unsupported[0].uid, UID);
    assert.equal(body.unsupported[0].reason, 'unknown-zone');
    assert.match(body.unsupported[0].href, /\.ics$/);
    assert.ok(!response.body.includes(CANARY), response.body);
  } finally {
    await app.close();
  }
});

test('every way the window can be wrong is the one fixed 422', async () => {
  const { app, caldav, events, calendarId } = await setup();
  try {
    /** @type {string[]} */
    const queries = [
      // `from` and `to` are required.
      'to=20260106T000000Z',
      'from=20260105T000000Z',
      // …and in the API's own form.
      'from=2026-01-05T00:00:00Z&to=20260106T000000Z',
      'from=20260105T000000&to=20260106T000000Z',
      'from=20260105T000000Z&to=20260106T000000Z&extra=1',
      // A date that does not exist is not a rolled-forward one.
      'from=20260230T000000Z&to=20260301T000000Z',
      // `to` strictly later than `from`, and inside the window cap.
      'from=20260105T000000Z&to=20260105T000000Z',
      'from=20260106T000000Z&to=20260105T000000Z',
      'from=20260105T000000Z&to=20330105T000000Z',
      // `tz` is an IANA name in its exact spelling, or absent.
      'from=20260105T000000Z&to=20260106T000000Z&tz=europe/berlin',
      'from=20260105T000000Z&to=20260106T000000Z&tz=Mars/Olympus',
      'from=20260105T000000Z&to=20260106T000000Z&tz=',
      // A repeated parameter is not a window.
      'from=20260105T000000Z&from=20260106T000000Z&to=20260107T000000Z',
    ];
    for (const query of queries) {
      const response = await call(app, {
        url: occurrencesUrl(calendarId, query),
        subject: 'owner',
      });
      assert.equal(response.statusCode, 422, `${query}: ${response.body}`);
      assertProblem(response.json(), 'invalid-input');
    }
    // Not one of them reached the store or CalDAV.
    assert.deepEqual(
      events.filter((entry) =>
        ['listObjects', 'findMembership'].includes(String(entry.op)),
      ),
      [],
    );
    assert.deepEqual(caldav.calls, []);
  } finally {
    await app.close();
  }
});

test('a window over more occurrences than one answer carries is `window-too-large`', async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    caldav.seed(
      calendarId,
      `${UID}.ics`,
      objects([
        [
          'DTSTART:20260101T000000Z',
          'DTEND:20260101T000059Z',
          'RRULE:FREQ=MINUTELY;COUNT=11000',
        ],
      ]),
    );
    const response = await call(app, {
      url: occurrencesUrl(
        calendarId,
        'from=20260101T000000Z&to=20260108T000000Z',
      ),
      subject: 'owner',
    });
    assert.equal(response.statusCode, 422, response.body);
    assertProblem(response.json(), 'window-too-large');
    assert.ok(MAX_OCCURRENCES > 0);
    // One day narrower and the answer fits, which is the client's way out.
    const narrower = await call(app, {
      url: occurrencesUrl(
        calendarId,
        'from=20260201T000000Z&to=20260208T000000Z',
      ),
      subject: 'owner',
    });
    assert.equal(narrower.statusCode, 200, narrower.body);
    assert.deepEqual(narrower.json().occurrences, []);
  } finally {
    await app.close();
  }
});

test('a caller who is not a member, an unknown calendar and a bad id are the 404', async () => {
  const { app, caldav, calendarId } = await setup();
  try {
    for (const url of [
      occurrencesUrl(calendarId, 'from=20260105T000000Z&to=20260106T000000Z'),
      occurrencesUrl(randomUUID(), 'from=20260105T000000Z&to=20260106T000000Z'),
      occurrencesUrl('not-a-uuid', 'from=20260105T000000Z&to=20260106T000000Z'),
    ]) {
      const response = await call(app, { url, subject: 'stranger' });
      assert.equal(response.statusCode, 404, response.body);
      assertProblem(response.json(), 'not-found');
    }
    assert.deepEqual(caldav.calls, []);
  } finally {
    await app.close();
  }
});

test('a known path under another method is a 405 with `Allow`', async () => {
  const { app, calendarId } = await setup();
  try {
    const response = await call(app, {
      url: `/calendars/${calendarId}/occurrences`,
      method: 'POST',
      subject: 'owner',
      payload: {},
    });
    assert.equal(response.statusCode, 405, response.body);
    assertProblem(response.json(), 'method-not-allowed');
    assert.match(String(response.headers.allow), /GET/);
  } finally {
    await app.close();
  }
});

test('a hostile failure from the store or the adapter never reaches the body or a log', async () => {
  const { app, capture, calendars, caldav, calendarId } = await setup();
  try {
    const query = 'from=20260105T000000Z&to=20260106T000000Z';
    // The store: the fixed 500.
    calendars.fail('findMembership', new Error(CANARY));
    const storeFailure = await call(app, {
      url: occurrencesUrl(calendarId, query),
      subject: 'owner',
    });
    assert.equal(storeFailure.statusCode, 500, storeFailure.body);
    assertProblem(storeFailure.json(), 'internal-error');
    assert.ok(!storeFailure.body.includes(CANARY), storeFailure.body);
    calendars.heal('findMembership');

    // The adapter: the fixed 502, like every other unreadable upstream answer.
    caldav.fail('listObjects', new Error(CANARY));
    const adapterFailure = await call(app, {
      url: occurrencesUrl(calendarId, query),
      subject: 'owner',
    });
    assert.equal(adapterFailure.statusCode, 502, adapterFailure.body);
    assertProblem(adapterFailure.json(), 'bad-gateway');
    assert.ok(!adapterFailure.body.includes(CANARY), adapterFailure.body);

    // An object the collection holds but this API cannot read is ours as well:
    // the bytes, the canary and the object name never come back.
    caldav.heal('listObjects');
    caldav.seed(
      calendarId,
      'not-a-calendar.ics',
      `BEGIN:VCALENDAR\r\nX-PAYLOAD:${CANARY}\r\nEND:VCALENDAR\r\n`,
    );
    const unreadable = await call(app, {
      url: occurrencesUrl(calendarId, query),
      subject: 'owner',
    });
    assert.equal(unreadable.statusCode, 502, unreadable.body);
    assertProblem(unreadable.json(), 'bad-gateway');
    assert.ok(!unreadable.body.includes(CANARY), unreadable.body);

    assert.ok(!capture.text().includes(CANARY), capture.text());
  } finally {
    await app.close();
  }
});
