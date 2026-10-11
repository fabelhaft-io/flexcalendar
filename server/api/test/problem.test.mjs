// --- E05-R10: the problem model, without a request ---------------------------
//
// The table, the status normalisation and the CalDAV mapping, held to their
// contracts. The hostile-body case is the important one: the mapping must give
// the offending property *name* and nothing else, however the CalDAV body is
// dressed up.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';

import { CalDavError, parsePreconditions } from '../src/caldav/adapter.mjs';
import {
  PROBLEM_CONTENT_TYPE,
  PROBLEM_STATUS,
  PROBLEM_TYPE_BASE,
  PROBLEM_TYPES,
  classifyCalDavError,
  problemBody,
  problemForStatus,
  problemType,
  sendCalDavProblem,
  sendProblem,
} from '../src/problem.mjs';
import { assertMatchesSchema, specProblemSchema } from './support/problem.mjs';

const CANARY = 'CALFLEX-E05R10-PROBLEM-CANARY';

test('every kind has a stable type, a fixed title and a status', () => {
  const types = new Set();
  for (const [slug, entry] of Object.entries(PROBLEM_TYPES)) {
    assert.match(slug, /^[a-z][a-z0-9-]*$/);
    assert.equal(typeof entry.title, 'string');
    assert.ok(entry.title.length > 0);
    assert.ok(Number.isInteger(entry.status) && entry.status >= 400);
    const type = problemType(slug);
    assert.equal(type, `${PROBLEM_TYPE_BASE}${slug}`);
    assert.ok(!types.has(type), `duplicate type ${type}`);
    types.add(type);
    const body = problemBody(slug, { instance: 'abc' });
    assert.equal(body.type, type);
    assert.equal(body.title, entry.title);
    assert.equal(body.status, entry.status);
    assert.equal(body.instance, 'urn:uuid:abc');
    assertMatchesSchema(specProblemSchema, body);
  }
  assert.throws(() => problemType('nope'), /unknown problem type/);
  assert.throws(() => problemBody('nope'), /unknown problem type/);
});

test('a status is normalised to the kind that declares it', () => {
  for (const [status, slug] of PROBLEM_STATUS) {
    assert.equal(problemForStatus(status), slug, `${status}`);
    // Every status in the map really is in the table, and the two extra 403
    // kinds exist for the adapter's preconditions to choose.
    assert.equal(PROBLEM_TYPES[slug].status, status);
  }
  for (const slug of ['private-skeleton-only', 'unmapped-collection']) {
    assert.equal(PROBLEM_TYPES[slug].status, 403);
  }
  // An error thrown with an undocumented status becomes a documented one, and
  // an impossible status becomes a 500.
  assert.equal(problemForStatus(418), 'bad-request');
  assert.equal(problemForStatus(599), 'internal-error');
  assert.equal(problemForStatus(undefined), 'internal-error');
  assert.equal(problemForStatus('400'), 'internal-error');
  assert.equal(problemForStatus(99), 'internal-error');
});

test('the CalDAV mapping covers every kind and never forwards a body', () => {
  const hostile = Buffer.from(
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<d:error xmlns:d="DAV:" xmlns:cf="https://flexcalendar.de/ns/caldav">',
      '  <cf:private-skeleton-only>',
      '    <cf:name>SUMMARY</cf:name>',
      `    <cf:value>${CANARY}</cf:value>`,
      `    <cf:evil attr="${CANARY}">${CANARY}</cf:evil>`,
      '  </cf:private-skeleton-only>',
      '</d:error>',
    ].join('\n'),
  );
  const cases = [
    // A CalDAV 401 is **not** the caller's 401 (E05-R03): the bearer token was
    // verified before the route ran, so a refusal from the listener means our
    // own delegation failed. Answering 401 would sign a validated client out,
    // so it is a 502 like every other unreadable upstream answer.
    [new CalDavError('unauthorized', 401), 'bad-gateway'],
    [new CalDavError('not-found', 404), 'not-found'],
    [new CalDavError('conflict', 409), 'conflict'],
    [new CalDavError('precondition-failed', 412), 'precondition-failed'],
    [new CalDavError('unsupported-media-type', 415), 'unsupported-media-type'],
    [new CalDavError('server', 500), 'bad-gateway'],
    [new CalDavError('server', 503), 'unavailable'],
    [new CalDavError('failed', 400), 'bad-gateway'],
    // Failures the adapter raised before a CalDAV answer.
    [new CalDavError('timeout'), 'upstream-timeout'],
    [new CalDavError('network'), 'bad-gateway'],
    [new CalDavError('protocol'), 'bad-gateway'],
    [new CalDavError('oversize', 200), 'bad-gateway'],
    [new CalDavError('config'), 'internal-error'],
    [new CalDavError('invalid-name'), 'internal-error'],
    // A 403 without a precondition is a plain forbidden.
    [new CalDavError('forbidden', 403), 'forbidden'],
    [
      new CalDavError('forbidden', 403, parsePreconditions(hostile)),
      'private-skeleton-only',
    ],
    [
      new CalDavError('forbidden', 403, [
        'cf:unmapped-collection',
        'calendars/x/y/',
      ]),
      'unmapped-collection',
    ],
  ];
  for (const [error, problem] of /** @type {[CalDavError, string][]} */ (
    cases
  )) {
    const classified = classifyCalDavError(error);
    assert.equal(classified.problem, problem, error.kind);
  }

  // The property name is the only extension member, it is the already-filtered
  // name, and no byte of the hostile body survives anywhere in the document.
  const classified = classifyCalDavError(
    new CalDavError('forbidden', 403, parsePreconditions(hostile)),
  );
  assert.equal(classified.property, 'SUMMARY');
  const body = problemBody(classified.problem, {
    instance: 'abc',
    property: classified.property,
  });
  assert.equal(body.property, 'SUMMARY');
  const serialised = JSON.stringify(body);
  assert.ok(!serialised.includes(CANARY), serialised);
  assert.ok(!serialised.includes('cf:'), serialised);
  assertMatchesSchema(specProblemSchema, body);

  // A `cf:name` that is not a property name never becomes one.
  // A name the guard's grammar refuses (a lowercase letter, a colon) is
  // dropped by the adapter, so it cannot become an extension member.
  const smuggled = Buffer.from(
    '<d:error xmlns:d="DAV:" xmlns:cf="https://flexcalendar.de/ns/caldav">' +
      '<cf:private-skeleton-only><cf:name>calflex-e05r10:problem canary</cf:name></cf:private-skeleton-only>' +
      '</d:error>',
  );
  const loose = classifyCalDavError(
    new CalDavError('forbidden', 403, parsePreconditions(smuggled)),
  );
  assert.deepEqual(loose, { problem: 'private-skeleton-only' });

  // Something that is not a CalDavError at all is still a problem.
  for (const value of [undefined, null, 'boom', new Error(CANARY)]) {
    const result = classifyCalDavError(value);
    assert.equal(result.problem, 'bad-gateway');
    assert.equal(result.property, undefined);
  }
});

test('the answers really are problem+json responses', async () => {
  const app = Fastify({ logger: false });
  app.get('/own', async (request, reply) => {
    sendProblem(reply, 'unavailable');
    return reply;
  });
  app.get('/caldav', async (request, reply) => {
    sendCalDavProblem(
      reply,
      new CalDavError('forbidden', 403, [
        'cf:private-skeleton-only',
        'SUMMARY',
      ]),
    );
    return reply;
  });
  try {
    const own = await app.inject('/own');
    assert.equal(own.statusCode, 503);
    assert.equal(
      String(own.headers['content-type']).split(';')[0],
      PROBLEM_CONTENT_TYPE,
    );
    assertMatchesSchema(specProblemSchema, own.json());

    const caldav = await app.inject('/caldav');
    assert.equal(caldav.statusCode, 403);
    assert.equal(caldav.json().type, problemType('private-skeleton-only'));
    assert.equal(caldav.json().property, 'SUMMARY');
    assert.ok(!caldav.body.includes('cf:'), caldav.body);
  } finally {
    await app.close();
  }
});
