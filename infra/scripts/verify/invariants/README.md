# Invariant check registrations

Named `.json` files contain a nonempty array of command argument arrays. Checks
run from the repository root, in filename order, inherit the local stack
environment, and must exit nonzero on failure. Do not put secrets or event content
in registrations or output. `make verify-invariants` executes this registry;
`make verify` includes it after the package gates. These two checks need no stack.

## E02-R05 checks

- `INV-05.json`: conservative property-name search in `apps/*`,
  `packages/crypto_*` **and** `packages/crypto-*` (the web library uses the
  hyphenated layout). JavaScript/TypeScript, Dart, Kotlin, Java, Swift, Vue and
  Svelte source is checked, including tests. Whole tokens `EXDATE` and
  `RECURRENCE-ID` (with the hyphen) fail, case-insensitively; letters, digits,
  underscores and hyphens delimit neither end of a token. Identifiers such as
  `recurrence_id` and `recurrenceId` are allowed for cache fields and envelope AAD.
  This is a code-search tripwire for literal property names, not a semantic
  emission detector: comments and read-side property-name literals also match.
  Documentation and data fixtures are not code. Installed dependencies and
  generated build/cache directories, including Flutter's `.symlinks` and
  `ephemeral`, are excluded. Symlinks are skipped and never followed. There are
  no inline suppression markers. Computed/obfuscated property names still need
  review; the search does not replace recurrence-path tests.
- `INV-07.json`: all server Node manifests are roots of a pnpm lock traversal,
  including dev/optional dependencies, aliases, peer-resolution suffixes and local
  workspace links (even outside `server/`). Unreachable client/tooling dependencies
  do not fail. Both documents of pnpm 12's lock format are supported. Every PHP
  service's Composer lock is checked, including `packages-dev`. Dependencies'
  `require-dev` lists are not installed transitively by Composer and are not
  traversed. Missing importers/snapshots/lockfiles and malformed inputs fail closed.

INV-07 always denies known content-crypto families, even if accidentally
allow-listed. Other names are screened for `crypt`, `cipher`, `sodium`, `nacl`,
`aes`, `chacha`, `salsa`, `poly1305`, `25519`, `secp`, `elliptic`, `jose`, `jwe`,
`pgp`, `openssl`, `tls`, `ssl`, `hash`, `hmac`, `sha`, `argon`, `bcrypt`, `scrypt`
and `pbkdf`. The short names `aes`, `sha`, `tls`, `ssl`, `jwe`, `pgp` and `jose`
match only as segments delimited by the start/end of the name, `-`, `_`, `.`, `/`,
`@` or a digit (`sha256` matches; `shared-utils` does not). All other dependencies
pass without an allow-list entry.

`infra/scripts/invariant-dependencies.json` is a narrow **exact-name** allow-list
for crypto-looking dependencies, each requiring its own specific
non-content-crypto justification. Currently no npm or Composer package names in
the server trees match the heuristic, so those lists are empty. PHP platform
requirements retain their explicit approval list. OpenSSL is permitted for
transport TLS and `ext-hash` for integrity/authentication hashes, not for decrypting
event content. Do not automatically regenerate approvals from a new lockfile.
Built-in Node/PHP crypto usage is not proven safe by this dependency gate and
still requires code review. New dependency ecosystems would need an additional
reader before they can be used in server code.

Diagnostics name the repo-relative source/input path or dependency name and
version, never source lines, event data, manifest contents or parser exceptions.
The deliberately bad and good trees are stored as path/content maps in
`infra/scripts/fixtures/invariants-bad.json` and `invariants-good.json`. Unit tests
materialize each map in a short-lived directory under `os.tmpdir()` and run the
real CLI, asserting exact invariant-specific failures (not input/tooling errors)
or success. Positive cases cover current-tree success, allowed recurrence
identifiers, harmless new dependencies, symlinks, client-only crypto, peer
suffixes, workspace layouts and the TLS exception. Heuristic and malformed-input
tests check segmentation and fail-closed redaction. Root `test` runs these tests,
so `make verify` runs them before this registry without waiting for E02-R06.

Standalone checks:

```sh
node --test infra/scripts/invariants.test.mjs
make verify-invariants
```

INV-06 remains deferred to E07-R04, where the push payload builder is added.
