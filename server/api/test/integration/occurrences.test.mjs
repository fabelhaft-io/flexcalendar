// --- E05-R05: the occurrence window against the local stack ------------------
//
// These tests run **inside** the stack (`make test-api-caldav`): the delegated
// listener has no published port, and the CalDAV service only accepts a request
// from the `delegation` network. `server/api/Dockerfile`'s `test` target is what
// runs them, as the `api-test` service.
//
// The app under test is the real one — the real hooks, the real Postgres store,
// the real D-05 adapter, the real CalDAV service with the E03-R09 write guard
// behind it — so the `calendar-query` this endpoint makes is the real report,
// answered by SabreDAV with its own recurrence engine, and the exact filter is
// the API's. That is the pair worth exercising end to end: `docs/02` § Recurrence
// says a stock app and our own app must not disagree about an `RRULE`.
//
// What the suite does:
//
//   * creates a Berlin weekly event and a UTC daily one through the API, both
//     across the 2026-10-25 fall-back, and asks for one window over both: the
//     instants are asserted in order, and the wall clock the viewer in Berlin is
//     shown for them, which is what a UTC instant alone cannot fail;
//   * takes an object the API itself wrote — a private weekly skeleton with its
//     generated `VTIMEZONE` — adds the `EXDATE` and the override `VEVENT` the
//     API's own field set never writes (INV-05), puts that through the **live**
//     guard as the caller, and reads the window that covers the override: it is
//     reported by its own times, with the master instance it names gone;
//   * reads a decade-long daily series and the window it reaches in 2026: a
//     `calendar-query` with a `time-range` would make the service's own engine
//     expand it to its instance bound and fail the whole report, so the report
//     carries no range and only the API's expansion decides;
//   * reads a calendar that also holds an hourly series from 2020: it is
//     `unsupported` with `too-many-instances` and the calendar's other events
//     are answered as usual.
//
// The suite seeds its own users and calendar and removes them again, so it can
// run twice in a row.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { after, before, test } from 'node:test';
import pg from 'pg';

import { buildApp } from '../../src/app.mjs';
import { createCalendarStore } from '../../src/calendar-store.mjs';
import { createCalDavAdapter } from '../../src/caldav/adapter.mjs';
import { readConfig } from '../../src/config.mjs';
import { createUserStore } from '../../src/store.mjs';

const databaseUrl = process.env.CALFLEX_DATABASE_URL;
const origin = process.env.CALFLEX_CALDAV_ORIGIN;
const delegationKeys = process.env.CALFLEX_DELEGATION_KEYS;

const ISSUER = 'https://auth.example.test';
const AUDIENCE = 'project-id';
/** The envelope hash a Private create needs; opaque to this suite. */
const HASH = 'c'.repeat(64);
/** The envelope hash the override VEVENT carries; opaque as well. */
const OVERRIDE_HASH = 'd'.repeat(64);

/**
 * An envelope of `length` bytes with the header the API's create requires
 * (first byte `1`, the epoch as a `uint32` at offset 1, at least 45 bytes) —
 * `test/integration/events.test.mjs`'s own `envelopeOf`.
 * @param {number} epoch @param {number} [length]
 */
function envelopeOf(epoch, length = 60) {
  const bytes = Buffer.alloc(Math.max(length, 45), 0xab);
  bytes[0] = 1;
  bytes.writeUInt32BE(epoch, 1);
  return bytes.toString('base64');
}

/** The subject this suite's user is identified by. */
const RUN = randomUUID();
const SUBJECT = `e05-r05-${RUN}`;

/** @type {pg.Pool} */
let pool;
/** @type {pg.Client} */
let verifier;
/** @type {ReturnType<typeof createCalDavAdapter>} */
let adapter;
/** @type {string} */
let userId;

/** A writable that keeps every log line the app writes. */
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

/** The app, with the real stores, the real adapter and a captured log. */
function build() {
  const capture = captureLog();
  const app = buildApp({
    config: readConfig({
      CALFLEX_OIDC_ISSUER: ISSUER,
      CALFLEX_OIDC_BASE_URL: ISSUER,
      CALFLEX_OIDC_AUDIENCE: AUDIENCE,
      CALFLEX_DATABASE_URL: databaseUrl,
    }),
    oidc: {
      /** @param {string} value */
      async verify(value) {
        if (String(value).split('.')[1] !== SUBJECT)
          throw new Error('unknown token');
        return { sub: SUBJECT };
      },
      async userinfo() {
        throw new Error('userinfo is not part of this suite');
      },
    },
    audience: {
      async current() {
        return AUDIENCE;
      },
      async refresh() {
        return false;
      },
    },
    store: createUserStore(pool),
    calendars: createCalendarStore(pool),
    caldav: adapter,
    logger: { stream: capture.stream },
  });
  return { app, capture };
}

/**
 * One request as this suite's user.
 * @param {import('fastify').FastifyInstance} app
 * @param {string} method @param {string} url
 * @param {unknown} [payload]
 */
async function request(app, method, url, payload) {
  return /** @type {any} */ (
    await app.inject(
      /** @type {any} */ ({
        method,
        url,
        headers: {
          authorization: `Bearer a.${SUBJECT}.c`,
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json' }),
        },
        payload: payload === undefined ? undefined : JSON.stringify(payload),
      }),
    )
  );
}

/** Creates one Private calendar through the API and returns its id. */
async function calendar(/** @type {import('fastify').FastifyInstance} */ app) {
  const response = await request(app, 'POST', '/calendars', {
    mode: 'private',
    metaEnvelope: envelopeOf(1),
    metaEpoch: 1,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().id;
}

/** Creates one event through the API and returns it. */
async function event(
  /** @type {import('fastify').FastifyInstance} */ app,
  /** @type {string} */ calendarId,
  /** @type {Record<string, unknown>} */ body,
) {
  const response = await request(
    app,
    'POST',
    `/calendars/${calendarId}/events`,
    { envelopeSha256: HASH, ...body },
  );
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

/** One occurrence's instants, in order. */
const instants = (/** @type {any} */ response) =>
  response
    .json()
    .occurrences.map(
      (/** @type {any} */ occurrence) =>
        occurrence.start.utc ?? occurrence.start.date,
    );

/**
 * The stored object the API wrote, with the `EXDATE` and the override `VEVENT`
 * its own field set cannot write (INV-05): a second `VEVENT` of the same `UID`,
 * naming the instance it replaces and carrying an envelope hash of its own — the
 * E03-R09 guard wants exactly one per `VEVENT`.
 * @param {string} ical @param {string} uid
 * @returns {string}
 */
function withOverride(ical, uid) {
  const override = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261011T080100Z',
    `X-CALFLEX-ENVELOPE-SHA256:${OVERRIDE_HASH}`,
    'RECURRENCE-ID;TZID=Europe/Berlin:20261104T100000',
    'DTSTART;TZID=Europe/Berlin:20261104T120000',
    'DTEND;TZID=Europe/Berlin:20261104T130000',
    'SEQUENCE:1',
    'END:VEVENT',
    '',
  ].join('\r\n');
  const end = ical.indexOf('END:VEVENT');
  assert.ok(end > 0, 'the stored object carries a VEVENT');
  const withExdate = `${ical.slice(0, end)}EXDATE;TZID=Europe/Berlin:20261028T100000\r\n${ical.slice(end)}`;
  return withExdate.replace('END:VCALENDAR', `${override}END:VCALENDAR`);
}

before(async () => {
  assert.ok(
    databaseUrl,
    'CALFLEX_DATABASE_URL must be set for the stack suite',
  );
  assert.ok(origin, 'CALFLEX_CALDAV_ORIGIN must be set for the stack suite');
  assert.ok(
    delegationKeys,
    'CALFLEX_DELEGATION_KEYS must be set for the stack suite',
  );
  pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  verifier = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
  });
  await verifier.connect();
  adapter = createCalDavAdapter();
  const { rows } = await verifier.query(
    `INSERT INTO public.users (idp_subject, handle, email)
     VALUES ($1, $2, $3) RETURNING id`,
    [SUBJECT, `${SUBJECT}-handle`, `${SUBJECT}@example.invalid`],
  );
  userId = rows[0].id;
});

after(async () => {
  if (!verifier) return;
  try {
    const { rows } = await verifier.query(
      'SELECT id, owner_id FROM public.calendars WHERE owner_id = $1',
      [userId],
    );
    for (const row of rows) {
      try {
        await adapter.forUser(row.owner_id).deleteCalendar(row.id);
      } catch {
        // Already deleted by the test that created it.
      }
    }
    await verifier.query('DELETE FROM public.calendars WHERE owner_id = $1', [
      userId,
    ]);
    await verifier.query('DELETE FROM public.users WHERE id = $1', [userId]);
  } finally {
    await verifier.end();
    await pool.end();
  }
});

test('a Berlin weekly and a UTC daily event across the fall-back, in one window', async () => {
  const { app } = build();
  try {
    const calendarId = await calendar(app);
    // Berlin's clocks go back on 2026-10-25: 10:00 local is 08:00Z before that
    // and 09:00Z after, and 06:00Z is a different wall clock either side.
    await event(app, calendarId, {
      start: { local: '20261021T100000', tzid: 'Europe/Berlin' },
      end: { local: '20261021T110000', tzid: 'Europe/Berlin' },
      rrule: 'FREQ=WEEKLY;COUNT=4',
    });
    await event(app, calendarId, {
      start: { utc: '20261024T060000Z' },
      end: { utc: '20261024T070000Z' },
      rrule: 'FREQ=DAILY;COUNT=4',
    });

    const response = await request(
      app,
      'GET',
      `/calendars/${calendarId}/occurrences?from=20261020T000000Z&to=20261112T000000Z&tz=Europe/Berlin`,
    );
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.deepEqual(body.unsupported, []);
    assert.deepEqual(instants(response), [
      '20261021T080000Z',
      '20261024T060000Z',
      '20261025T060000Z',
      '20261026T060000Z',
      '20261027T060000Z',
      '20261028T090000Z',
      '20261104T090000Z',
      '20261111T090000Z',
    ]);
    // The viewer's wall clock: the Berlin series keeps 10:00 local either side
    // of the transition, and the UTC series moves by the offset in force.
    const berlin = body.occurrences.find(
      (/** @type {any} */ occurrence) =>
        occurrence.start.utc === '20261028T090000Z',
    );
    assert.equal(berlin.start.local, '20261028T100000');
    const daily = body.occurrences.filter(
      (/** @type {any} */ occurrence) =>
        occurrence.recurrenceId.utc === '20261024T060000Z',
    );
    assert.equal(daily.length, 1);
    assert.equal(daily[0].start.local, '20261024T080000');
    const after = body.occurrences.find(
      (/** @type {any} */ occurrence) =>
        occurrence.start.utc === '20261027T060000Z',
    );
    assert.equal(after.start.local, '20261027T070000');
  } finally {
    await app.close();
  }
});

test('a skeleton the API wrote, with an override added by hand, through the live guard', async () => {
  const { app } = build();
  try {
    const calendarId = await calendar(app);
    // A master the API itself writes: a private weekly skeleton with its own
    // generated `VTIMEZONE`. The API's field set never writes an `EXDATE` or a
    // `RECURRENCE-ID` (INV-05), so both are added to the stored text here — the
    // write the E03-R09 guard has to accept, and the read E05-R05 expands.
    const master = await event(app, calendarId, {
      start: { local: '20261014T100000', tzid: 'Europe/Berlin' },
      end: { local: '20261014T110000', tzid: 'Europe/Berlin' },
      rrule: 'FREQ=WEEKLY;BYDAY=WE;COUNT=6',
    });
    await adapter
      .forUser(userId)
      .putObject(
        calendarId,
        `${master.uid}.ics`,
        withOverride(master.ical, master.uid),
        { ifMatch: master.etag },
      );

    const response = await request(
      app,
      'GET',
      `/calendars/${calendarId}/occurrences?from=20261001T000000Z&to=20261201T000000Z&tz=Europe/Berlin`,
    );
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.deepEqual(body.unsupported, []);
    assert.deepEqual(instants(response), [
      '20261014T080000Z',
      '20261021T080000Z',
      '20261104T110000Z',
      '20261111T090000Z',
      '20261118T090000Z',
    ]);
    // The `EXDATE` removed 28 October, which is a plain consequence of the
    // stored text — nothing in the API's own field set could have written it.
    assert.ok(!instants(response).includes('20261028T080000Z'));

    // The override is reported by its own times, names the instance it replaced,
    // and carries its own envelope hash; the master's derived instances carry the
    // master's.
    const moved = body.occurrences[2];
    assert.equal(moved.override, true);
    assert.deepEqual(moved.recurrenceId, {
      tzid: 'Europe/Berlin',
      local: '20261104T100000',
      utc: '20261104T090000Z',
    });
    assert.deepEqual(moved.start, {
      utc: '20261104T110000Z',
      local: '20261104T120000',
      tzid: 'Europe/Berlin',
    });
    assert.equal(moved.envelopeSha256, OVERRIDE_HASH);
    assert.equal(body.occurrences[0].envelopeSha256, HASH);
  } finally {
    await app.close();
  }
});

test('a daily series from 2016 answers a 2026 window, whole-collection read', async () => {
  const { app } = build();
  try {
    const calendarId = await calendar(app);
    // An unbounded daily series a decade before the window: a `calendar-query`
    // with a `time-range` makes the service expand it with `sabre/vobject`,
    // which stops at 3,500 instances and fails the whole report — every other
    // event included. The report carries no range (E05-R05), so the API's own
    // expansion decides and the answer is 200.
    await event(app, calendarId, {
      start: { utc: '20161001T080000Z' },
      end: { utc: '20161001T090000Z' },
      rrule: 'FREQ=DAILY',
    });

    const response = await request(
      app,
      'GET',
      `/calendars/${calendarId}/occurrences?from=20261001T000000Z&to=20261101T000000Z&tz=UTC`,
    );
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.deepEqual(body.unsupported, []);
    assert.equal(body.occurrences.length, 31);
    assert.equal(body.occurrences[0].start.utc, '20261001T080000Z');
    assert.equal(body.occurrences[30].start.utc, '20261031T080000Z');
  } finally {
    await app.close();
  }
});

test('an hourly series from 2020 is unsupported, and the rest is answered', async () => {
  const { app } = build();
  try {
    const calendarId = await calendar(app);
    // ~56,000 instances separate 2020-01-01 from the window, more than the
    // API's own bound: the object is reported `too-many-instances` and the
    // calendar's other events are still answered.
    const hourly = await event(app, calendarId, {
      start: { utc: '20200101T000000Z' },
      end: { utc: '20200101T010000Z' },
      rrule: 'FREQ=HOURLY',
    });
    await event(app, calendarId, {
      start: { utc: '20261001T080000Z' },
      end: { utc: '20261001T090000Z' },
      rrule: 'FREQ=DAILY;COUNT=2',
    });

    const response = await request(
      app,
      'GET',
      `/calendars/${calendarId}/occurrences?from=20261001T000000Z&to=20261003T000000Z&tz=UTC`,
    );
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.deepEqual(
      body.unsupported.map((/** @type {any} */ entry) => entry.reason),
      ['too-many-instances'],
    );
    assert.equal(body.unsupported[0].uid, hourly.uid);
    assert.deepEqual(instants(response), [
      '20261001T080000Z',
      '20261002T080000Z',
    ]);
  } finally {
    await app.close();
  }
});
