# `infra/crypto-libs-check/` — E12-R02 library capability check

**Owning epic:** [E12 — Crypto core and shared test vectors](../../docs/epics/E12-crypto-core.md) § E12-R02.
**Recorded result:** [`docs/verification/crypto-libs-2026-10-12.md`](../../docs/verification/crypto-libs-2026-10-12.md).

ADR 0002 § Consequences says to **verify** that the crypto libraries cover XChaCha20-Poly1305-IETF,
`crypto_box_seal`, Ed25519 and HKDF "rather than assume it". These three probes are that verification: each one *calls*
every primitive, prints the same `name=value` lines, and compares the bytes. They are run once, by hand, and their
output is recorded in the verification doc; they are not a test suite for the product and not part of `make verify`.

| Directory | Target | Run it with | Status |
|---|---|---|---|
| `dart_vm/` | the Dart VM, via the `sodium` package (the binding `packages/crypto_dart` will use) | `dart run bin/probe.dart`, plus `dart test` and `dart run bin/system_libsodium.dart` | run in the agent sandbox, passing |
| `flutter/` | an Android emulator or device, via `sodium_libs` (the package ADR 0001 names) | `flutter test integration_test -d <device-id>` (host-only checks: `flutter analyze`, `flutter test`) | written, resolved and analysed; **the Android run is the reviewer's** — no Android SDK in the agent sandbox |
| `node/` | Node 24, via `libsodium-wrappers` and `libsodium-wrappers-sumo` | `npm install && node probe.mjs && node probe-sumo.mjs && node compare-exports.mjs` | run in the agent sandbox, passing |

You need the pinned toolchain on `PATH`: Flutter 3.47.6 / Dart 3.13.5 ([`apps/mobile/.fvmrc`](../../apps/mobile/.fvmrc)),
Node 24 and npm. `dart run bin/probe.dart` (not `dart bin/probe.dart`) is required — `sodium` 4.x builds libsodium
1.0.22 from the source archive it vendors through a build hook, and only `dart run`/`dart test`/`flutter` honour it.

## What each probe checks

By calling it, never by looking for a symbol: XChaCha20-Poly1305-IETF encrypt/decrypt with associated data, and a
flipped tag byte *and* a flipped AAD byte must fail; `crypto_box_seal`/`_open` round trip and the wrong recipient must
fail; Ed25519 detached sign/verify and a flipped message byte must fail; HKDF-SHA-256 against RFC 5869 (test case 1's
PRK, and A.3 end to end) and `crypto_kdf` (`derive_from_key`, BLAKE2b); `randombytes_buf`; and the library's own
`sodium_version_string`. The results are byte-comparable because every key, nonce, message and Ed25519 seed is a
**fixed, invented test value** — sealed boxes and the RNG are randomised, so only their round trips and lengths are
compared. The frozen expectations are in `frozenValues` (`dart_vm/lib/checks.dart` and the copy under `flutter/lib/`),
and every probe asserts them.

## Rules these probes obey

- **No key derives from a password** (D-17, INV-12): no probe calls `crypto_pwhash`/Argon2id or derives anything from a
  password. The primitive is only *listed* for presence, and each probe prints `crypto_pwhash.called=no`.
- **No secrets**: every key, nonce, message and seed is an invented constant in the source, labelled as such.
- **Nothing under `server/**`** (INV-07): these probes are `infra/` and `docs/` only.
- **Not a workspace member**: `node/` is deliberately not in `pnpm-workspace.yaml`, so the root `package.json` and
  `pnpm-lock.yaml` are untouched, and no `node_modules/`, `.dart_tool/`, `build/` or probe lockfile is committed
  (see [`.gitignore`](.gitignore)). `sodium_libs`/`sodium` are consumed from pub.dev; nothing is vendored.

## Note on `sodium_libs`

`sodium_libs` 4.0.1 is deprecated on pub.dev and its `lib/` is a one-line re-export of `sodium` (see the probe's
`pubspec.yaml` comment). The Flutter probe keeps depending on it on purpose — that is the package ADR 0001 names, and
the probe shows the re-export really does deliver every primitive on Android. New code should depend on `sodium`
4.1.1+2 directly; the finding is recorded in
[`docs/verification/crypto-libs-2026-10-12.md`](../../docs/verification/crypto-libs-2026-10-12.md) § 4–5.
