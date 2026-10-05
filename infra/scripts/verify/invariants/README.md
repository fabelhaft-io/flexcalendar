# Invariant check registrations

Named `.json` files contain a nonempty array of command argument arrays. Checks
run from the repository root, in filename order, inherit the local stack
environment, and must exit nonzero on failure. Do not put secrets or event content
in registrations or output. `make verify-invariants` executes this registry;
`make verify` includes it after the package gates. These two checks need no stack.

## E02-R05 checks

- `INV-05.json`: conservative source search in `apps/*`, `packages/crypto_*`
  **and** `packages/crypto-*` (the web library uses the hyphenated layout).
  JavaScript/TypeScript, Dart, Kotlin, Java, Swift, Vue and Svelte source is checked,
  including tests. Case-insensitive `EXDATE`, `RECURRENCE-ID`, `recurrence_id` and
  `recurrenceId` references fail. This deliberately includes comments and read-side
  references: it is a code-search tripwire, not a semantic emission detector.
  Documentation and data fixtures are not code. Installed dependencies and generated
  build/cache directories are excluded; checked-tree symlinks fail closed. There
  are no inline suppression markers. Computed/obfuscated property names still need
  review; the search does not replace recurrence-path tests.
- `INV-07.json`: all server Node manifests are roots of a pnpm lock traversal,
  including dev/optional dependencies, aliases, peer-resolution suffixes and local
  workspace links (even outside `server/`). Unreachable client/tooling dependencies
  do not fail. Both documents of pnpm 12's lock format are supported. Every PHP
  service's Composer lock is checked, including `packages-dev`. Dependencies'
  `require-dev` lists are not installed transitively by Composer and are not
  traversed. Missing importers/snapshots/lockfiles and malformed inputs fail closed.

`infra/scripts/invariant-dependencies.json` is an **exact-name** allow-list with
non-content-crypto justifications. New server dependencies (including transitives)
require review and a justification here; do not automatically regenerate approvals
from a new lockfile. Known content-crypto families are denied even if accidentally
allow-listed. PHP platform dependencies also require explicit approval. OpenSSL
is permitted for transport TLS and `ext-hash` for integrity/authentication hashes,
not for decrypting event content. Built-in Node/PHP crypto usage is not proven safe
by this dependency gate and still requires code review. New dependency ecosystems
would need an additional reader before they can be used in server code.

Diagnostics never print source lines, event data, manifests, or parser exceptions.
The deliberately bad trees are stored as path/content maps in
`infra/scripts/fixtures/invariants-bad.json`. Unit tests materialize each map in a
short-lived directory under `infra/scripts/` and run the real CLI, asserting exit
1 and the exact invariant-specific diagnostic (not an input/tooling error).
Positive cases cover current-tree success, client-only crypto, peer suffixes,
workspace layouts, and the TLS exception; malformed input tests verify fail-closed
redaction. Root `test` runs these tests, so `make verify` runs them before this
registry without waiting for E02-R06.

Standalone checks:

```sh
node --test infra/scripts/invariants.test.mjs
make verify-invariants
```

INV-06 remains deferred to E07-R04, where the push payload builder is added.
