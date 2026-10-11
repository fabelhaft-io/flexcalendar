// --- E05-R03: the 405 table --------------------------------------------------
//
// `Allow` is only right if the path really is registered under another method:
// the table is fed by Fastify's own `onRoute` hook, and the not-found handler
// reads it. A parameter must match exactly one non-empty segment — otherwise
// `/calendars//` would answer 405 for a path that has no route at all, and a
// client would be told to retry with a method that cannot work either.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAllowRegistry, matchesTemplate, pathOf } from '../src/allow.mjs';

test('a template matches one concrete path, parameters included', () => {
  assert.ok(matchesTemplate('/healthz', '/healthz'));
  assert.ok(!matchesTemplate('/healthz', '/healthzz'));
  assert.ok(!matchesTemplate('/healthz', '/healthz/'));
  assert.ok(matchesTemplate('/calendars/:id', '/calendars/abc'));
  // A parameter is one non-empty segment, never two and never none.
  assert.ok(!matchesTemplate('/calendars/:id', '/calendars/'));
  assert.ok(!matchesTemplate('/calendars/:id', '/calendars/a/b'));
  assert.ok(!matchesTemplate('/calendars/:id', '/calendars'));
  assert.ok(!matchesTemplate('/calendars', '/calendars/1'));
  assert.ok(matchesTemplate('/a/:b/c', '/a/x/c'));
  assert.ok(!matchesTemplate('/a/:b/c', '/a/x/d'));
});

test('the registry answers the methods of a path, and nothing for an unknown one', () => {
  const allow = createAllowRegistry();
  assert.equal(allow.allowFor('/anything'), undefined);
  allow.add('/me', 'GET');
  allow.add('/me', 'HEAD');
  allow.add('/calendars', ['GET', 'HEAD']);
  allow.add('/calendars', 'POST');
  allow.add('/calendars/:id', 'PATCH');
  allow.add('/calendars/:id', 'DELETE');

  // Sorted, so two instances answer the same header.
  assert.deepEqual(allow.allowFor('/me'), ['GET', 'HEAD']);
  assert.deepEqual(allow.allowFor('/calendars?from=1'), [
    'GET',
    'HEAD',
    'POST',
  ]);
  assert.deepEqual(allow.allowFor('/calendars/1'), ['DELETE', 'PATCH']);
  // `/calendars/1/` is another path, and one no route matches.
  assert.equal(allow.allowFor('/calendars/1/'), undefined);
  assert.equal(allow.allowFor('/calendars/1/extra'), undefined);
  assert.equal(allow.allowFor('/nothing'), undefined);
  assert.equal(allow.allowFor(''), undefined);
  assert.equal(allow.allowFor(undefined), undefined);
  // Re-adding a method does not duplicate it.
  allow.add('/me', 'get');
  assert.deepEqual(allow.allowFor('/me'), ['GET', 'HEAD']);
});

test('a URL is reduced to its path', () => {
  assert.equal(pathOf('/me?x=1'), '/me');
  assert.equal(pathOf('/me'), '/me');
  assert.equal(pathOf(''), '');
  assert.equal(pathOf(undefined), '');
});
