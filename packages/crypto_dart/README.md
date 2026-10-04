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
  Flutter 3.47.6 ships (`apps/mobile/.fvmrc`). The library and its dependencies
  (`sodium_libs`, …) arrive with E12.
- Held to the frozen vectors in
  [`spec/crypto-vectors/`](../../spec/crypto-vectors/README.md), byte-identical
  with [`packages/crypto-ts`](../crypto-ts/README.md).
- **Security:** `agent+review`; no key may be derived from the login password
  (D-17, INV-12).
