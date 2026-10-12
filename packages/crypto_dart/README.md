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

**Still to come:** E12-R04 adds the key hierarchy (keypairs, the recovery code and
its KEK, sealed CCK records, device linking). Here the calendar content key is a
parameter.

### Facts worth keeping

- **The nonce is never a caller's choice.** `sealEvent` draws 24 bytes from
  libsodium's CSPRNG for every seal. `sealEventWithNonce` and
  `sealCalendarMetadataWithNonce` exist so a vector test can seal
  deterministically (§1.2 step 4); they live in `lib/src/envelope.dart` and are
  **not** exported from `lib/crypto_dart.dart`. Reusing a nonce under one key is
  a catastrophic failure, so nothing in the library calls them.
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
- **Dependencies:** `sodium` 4.1.1+2 (XChaCha20-Poly1305 and the CSPRNG; E12-R02
  found `sodium_libs` is discontinued and only re-exports it), `timezone` 0.11.2
  (`TZID` handling, ADR 0002) and `crypto` 3.0.7 (SHA-256 for §5.1). `sodium`
  builds libsodium 1.0.22 through a build hook, which `dart test` and `dart run`
  honour — `dart <file>.dart` does **not**.
- **`pubspec.lock`:** pinned by `dart pub get` and present in the worktree, but
  the root `.gitignore` ignores `packages/*/pubspec.lock` by E02-R02's decision.
  See E12-R03's review record.

## Tests

`dart test` runs the frozen vectors **from the repository**, never from a copy:
`test/vectors.dart` reads `../../spec/crypto-vectors/`. Five files contribute
(120 vectors in total), each asserted to its expected bytes or its exact error
code, and each test file fails if its file contributes none:

| File | Vectors |
|---|---|
| `envelope-v1.json` | 32 |
| `aad-v1.json` | 21 |
| `canonical-timing-v1.json` | 37 |
| `payload-jcs-v1.json` | 23 |
| `metadata-envelope-v1.json` | 7 |

`test/envelope_behaviour_test.dart` covers what a vector cannot: the public
entry points that draw their own nonce, the layout of the header, and that a
flipped tag bit, a wrong key, a changed AAD and the wrong envelope kind are one
indistinguishable refusal.

Run the package gate with `make verify-packages-crypto_dart`.
