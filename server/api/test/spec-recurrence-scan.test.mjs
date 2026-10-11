// --- E05-R04: the contract never names a property a client must not write ----
//
// The INV-05 check in `infra/scripts/invariants.mjs` scans the *generated* API
// clients for the two property names that belong to the API's recurrence
// authority and to nobody else, and `make gen` copies `spec/openapi.yaml`'s
// descriptions straight into their doc comments. The spec is therefore the
// place to hold the gate: this test applies the scan's own expression to
// `spec/openapi.yaml`, so `make verify-server-api` fails here — before the
// clients are regenerated — when a description starts naming one of them.
//
// The expression is copied from the invariant check on purpose: that check is
// the authority, and it only walks `apps/` and `packages/crypto-*`, so nothing
// else keeps the spec itself clean.
//
// The failure names the line, never the text: the point is to reword the
// description, and a diff of the spec is where the words live.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('the spec names no property a client must never write (INV-05)', () => {
  const spec = readFileSync(
    new URL('../../../spec/openapi.yaml', import.meta.url),
    'utf8',
  );
  const forbidden = /(?<![\w-])(?:EXDATE|RECURRENCE-ID)(?![\w-])/i;
  const line = spec.split('\n').findIndex((text) => forbidden.test(text));
  assert.equal(
    line,
    -1,
    `spec/openapi.yaml:${line + 1} names a property a client never writes (INV-05); reword the description`,
  );
});
