# `packages/crypto_dart/` — Dart crypto core

**Owning epic:** [E12 — Crypto core and shared test vectors](../../docs/epics/E12-crypto-core.md).

- **What belongs here:** the Dart library that owns the key hierarchy — envelope
  seal/open (XChaCha20-Poly1305), user keypairs (X25519 sealing, Ed25519
  signing), the recovery code and its KEK via HKDF, device-link sealing, and
  calendar-content-key generation and sealing to a member (ADR 0001, ADR 0002,
  `spec/crypto.md`, Phase 2 of
  [`docs/04-implementation-phases.md`](../../docs/04-implementation-phases.md)).
- Consumed by [`apps/mobile`](../../apps/mobile/README.md) as a local Dart
  package. The Android Kotlin adapter repeats only *unwrap content key, open
  envelope*, and only if the optional Phase 8 mirroring (E16) ships.
- **Toolchain pin**
  ([E02-R02](../../docs/epics/E02-repo-tooling-ci.md)):
  [`pubspec.yaml`](pubspec.yaml) fixes the Dart SDK to `^3.13.5`, the version
  Flutter 3.47.6 ships (`apps/mobile/.fvmrc`).
- Held to the frozen vectors in
  [`spec/crypto-vectors/`](../../spec/crypto-vectors/README.md), byte-identical
  with [`packages/crypto-ts`](../crypto-ts/README.md).
- **Security:** `agent+review`; no key may be derived from the login password
  (D-17, INV-12).

## What is implemented (E12-R03)

The **envelope** half of `spec/crypto.md`: `seal`/`open` for the event envelope
and for the calendar-metadata envelope (D-18), built from the same bytes the
vectors pin.

| Piece | Spec |
|---|---|
| `sealEvent` / `openEvent`, `sealCalendarMetadata` / `openCalendarMetadata` | §1 |
| `EventSkeleton` / `CalendarSkeleton`, `frame`, the label and ceiling constants | §2 |
| `CanonicalTiming.fromProperties`, `canonicalTimeField`, `canonicalDuration`, `canonicalRrule`, `RecurrenceId`, `canonicalRecurrenceId`, `instantOf` | §3, §5.2 |
| `jcsSerialise` / `jcsEncode`, `serialisePayload`, `validatePayload` | §4 |
| `envelopeSha256Hex`, `verifyEnvelopeSha256` | §5.1 |
| `CryptoError` / `CryptoException` | §0.3 |

`openEvent`/`openCalendarMetadata` return the payload **bytes** — the plaintext
exactly as the wire defines it — and validate them per §4 before returning.
`validatePayload(bytes, kind)` turns them into the parsed object.

## What is implemented (E12-R04)

The **key hierarchy** of `spec/crypto.md` §6: the keypairs, the key bundle, the
recovery code and its KEK, the wrap of the private keys, device linking, the CCK
and its sealed, signed records, and the identity formats.

| Piece | Spec |
|---|---|
| `generateUserKeys`, `userKeysFromSeeds`, `UserKeys`, `x25519PublicKeyOf`, the size constants | §6.1 |
| `KeyBundle` (`toBytes`, `decode`, `matches`, `checkMatches`) | §6.2 |
| `recoveryPhrase`, `parseRecoveryPhrase`, `generateRecoveryPhrase`, `generateRecoveryEntropy`, `recoveryKek`, `recoveryKekFromPhrase`, `bip39EnglishWords` | §6.4, §6.3.1 |
| `sealWrappedKey` / `openWrappedKey`, `KeyWrapKind`, `keyWrapAad`, the size bounds | §6.3 |
| `generateCck`, `sealCckRecord` / `openCckRecord`, `CckRecord`, `cckRecordMessage` | §6.5, §6.6 |
| `linkCode`, `linkUri`, `parseLinkUri`, `checkLinkCode`, `sealLinkBundle` / `openLinkBundle`, `LinkRequest`, `linkBundleMessage` | §6.7 |
| `fingerprint` / `fingerprintHex` / `groupFingerprint`, `safetyNumber` / `groupSafetyNumber`, `verifyUri` / `parseVerifyUri`, `VerifiedIdentity` | §6.8 |
| `encodeHex` / `decodeHex`, `encodeBase64Url` / `decodeBase64Url`, `decodeUuidV4` / `encodeUuidV4` / `checkUuidV4` | §0.2 |

**Still to come:** Phase 5's `packages/crypto-ts` implements the operational subset
in TypeScript (D-16) against the same frozen vectors — that is where "a key
wrapped in Dart unwraps in TS and the reverse" is proved. Recovery-code
generation, Shamir splitting and escrow stay here.

### Facts worth keeping

- **The nonce is never a caller's choice.** `sealEvent` draws 24 bytes from
  libsodium's CSPRNG for every seal, and so do `sealWrappedKey`, `sealCckRecord`
  and `sealLinkBundle` (the last three also draw their sealed-box ephemeral key).
  The `…WithNonce` / `…WithEphemeralKey` forms exist so a vector test can
  reproduce a pinned blob byte for byte (§1.2 step 4, §6.6, §6.7); they live in
  `lib/src/` and are **not** exported from `lib/crypto_dart.dart`. Reusing a nonce
  under one key is a catastrophic failure, so nothing in the library calls them.
- **No key derives from the login password** (D-17, INV-12). Every secret comes
  from `randomBytes`, which is libsodium's CSPRNG and nothing else: never a
  counter, a timestamp, a password or a device identifier. Two tests scan the
  library's own source for a password-based KDF and for a password parameter, so a
  `pwhash` call or a new `password` argument fails the suite.
- **`crypto_scalarmult_base` comes from the sumo initialiser, not a second
  library.** §6.2's unwrap check and §6.6 step 3 both need it, and the standard
  `sodium` surface does not expose it. `libSodiumSumo` loads the **same** bundled
  libsodium 1.0.22 through the FFI sumo entry point (E12-R02 measured both:
  `docs/verification/crypto-libs-2026-10-12.md`). Nothing else from that surface is
  called, and a browser build is out of scope here (D-16).
- **Sealed boxes are `epk ‖ tag ‖ c`.** libsodium's `crypto_box_easy` puts the
  Poly1305 tag **first**, and the seal nonce is BLAKE2b at a **24-byte** output
  length (`crypto_box_NONCEBYTES`), which is a different function from the first 24
  bytes of a BLAKE2b-256 digest. `sealBox` and `openSealedBox` are the one place
  both live, so §6.6's and §6.7's boxes cannot drift apart. `crypto_box_seal_open`
  takes the **public** key before the secret one, so a caller that holds only its
  secret key derives the public one first (`x25519PublicKeyOf`).
- **The word list is vendored, not linked.** `lib/src/bip39-english.txt` is
  BIP-0039's `english.txt` verbatim (2048 lines, LF terminated, MIT; SHA-256
  `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`), and
  `lib/src/bip39_english.dart` is the same list as a Dart constant because a
  Flutter app has no repository to read from. A test hashes the file against the
  pinned value and asserts the constant equals its lines, so the two cannot drift.
- **One parser for one TLV.** A recovery-code wrap (§6.3) and a device-link bundle
  (§6.7) carry the same 105-byte `KeyBundle`, so both go through
  `KeyBundle.decode`, and both callers pass the result to `checkMatches` against
  the `user_keys` row — the check that catches a server that swapped a stored blob
  between users.
- **A record's signature covers who signed it.** §6.6's message binds the
  calendar, the recipient, the epoch and the record's first 98 bytes, which include
  the signer's id, because `calendar_keys` has no `signer` column. `openCckRecord`
  returns the signer id it found; the caller **MUST** compare it with the identity
  key it verified (D-15, E13-R05).
- **A zone database is used, and never for the AAD's timing fields.** Fields 5
  and 6 bind the `TZID` and the wall clock, so a tzdata update cannot make stored
  envelopes unreadable (§3.5). The `timezone` package (ADR 0002) is used only
  where a real instant is needed: §5.2's canonical `recurrence_id` of a zoned
  occurrence, and §3.4's cross-check. §3.4's answer is RFC 5545's, which is
  *not* what `timezone` computes by itself (it follows Java and Joda): the
  pre-transition offset for both the spring gap and the autumn overlap is
  selected explicitly.
- **The recurrence id is a value, never a parsed line.** An override's id reaches
  the library as a `RecurrenceId` — the `date`, `utc` or `local`+`tzid` object the
  API reports (E05) — and the library computes §5.2's canonical field from it. The
  library never names or parses the stored property, because a client addresses an
  occurrence with the id the server gave it and never writes one itself (INV-05).
- **The extra-date line is not bound** (§2.6): the AAD has no field for it, and
  the vectors prove the master's AAD is unchanged when the skeleton gains it.
- **Dependencies:** `sodium` 4.1.1+2 (XChaCha20-Poly1305, sealed boxes, Ed25519,
  HKDF-SHA-256, BLAKE2b, `crypto_scalarmult` through the sumo entry point and the
  CSPRNG; E12-R02 found `sodium_libs` is discontinued and only re-exports it),
  `timezone` 0.11.2 (`TZID` handling, ADR 0002) and `crypto` 3.0.7 (§5.1's SHA-256
  and §6.7/§6.8's labels). `sodium` builds libsodium 1.0.22 through a build hook,
  which `dart test` and `dart run` honour — `dart <file>.dart` does **not**.
- **`pubspec.lock`:** pinned by `dart pub get` and present in the worktree, but
  the root `.gitignore` ignores `packages/*/pubspec.lock` by E02-R02's decision.
  See E12-R03's review record.

## Tests

`dart test` runs the frozen vectors **from the repository**, never from a copy:
`test/vectors.dart` reads `../../spec/crypto-vectors/`. Nine files contribute
(171 vectors in total), each asserted to its expected bytes or its exact error
code, and each test file fails if its file contributes none:

| File | Vectors |
|---|---|
| `envelope-v1.json` | 32 |
| `aad-v1.json` | 21 |
| `canonical-timing-v1.json` | 37 |
| `payload-jcs-v1.json` | 23 |
| `metadata-envelope-v1.json` | 7 |
| `keys-v1.json` | 22 |
| `cck-records-v1.json` | 11 |
| `device-link-v1.json` | 16 |
| `identity-v1.json` | 12 |

`test/envelope_behaviour_test.dart` and
`test/key_hierarchy_behaviour_test.dart` cover what a vector cannot: the public
entry points that draw their own nonce or ephemeral key, the round trips a device
performs, and the two prohibitions the requirement states as prose (no key from a
login secret, INV-12).

Two vectors are labelled with a sealer's `op` but carry an opener's `inputs`
(`cck-record-sealed-to-other-key`, `link-bundle-sealed-to-other-key`). The tests
route them through the opener, exactly as `spec/crypto-vectors/gen/generate.py`'s
own `RUN_BY_VECTOR_ID` re-routes a vector whose `op` is a coarse grouping.

Run the package gate with `make verify-packages-crypto_dart`.
