/// The libsodium instances this package uses, created once per isolate.
///
/// `sodium` builds libsodium 1.0.22 itself through a build hook that `dart test`
/// and `dart run` honour (E12-R02; `dart <file>.dart` does **not**). It is the
/// one crypto library the Dart library links: no hand-rolled primitive lives in
/// this package, and nothing under `server/**` links it either (INV-07).
///
/// **Never a password.** `sodium`'s sumo surface also carries `crypto_pwhash`,
/// which this package must never call (D-17, INV-12): the login password is
/// typed into our IdP and is an input to nothing here.
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:sodium/sodium.dart';
import 'package:sodium/sodium_sumo.dart';

Sodium? _sodium;
SodiumSumo? _sodiumSumo;

/// The standard libsodium instance: XChaCha20-Poly1305, sealed boxes, Ed25519,
/// HKDF-SHA-256, BLAKE2b and the CSPRNG.
///
/// `SodiumInit.init()` is synchronous on the VM and returns a `Future` only in a
/// browser build, which this package does not have: ADR 0002 puts the web client
/// on `packages/crypto-ts` (D-16).
Sodium get libSodium {
  final existing = _sodium;
  if (existing != null) return existing;
  final FutureOr<Sodium> initialised = SodiumInit.init();
  if (initialised is! Sodium) {
    throw StateError(
      'libsodium is built for the Dart VM here; the web library is crypto-ts',
    );
  }
  return _sodium = initialised;
}

/// The same libsodium, through the initialiser that also exposes
/// `crypto_scalarmult`.
///
/// Two formats need `crypto_scalarmult_base`: §6.2's check that an unwrapped
/// bundle's X25519 secret key derives the public key `user_keys` holds, and §6.6
/// step 3, where a recipient holds only its secret key and derives the public one
/// to call `crypto_box_seal_open(c, pk, sk)`. The standard `sodium` surface does
/// not expose it, and a browser build is out of scope here (D-16), so this is the
/// FFI sumo initialiser — it loads the **same** bundled libsodium 1.0.22, not a
/// second library (E12-R02 measured both: `docs/verification/crypto-libs-2026-10-12.md`).
///
/// Nothing else from the sumo surface is called. `pwhash` in particular is not
/// reachable from this package's own API (D-17, INV-12).
SodiumSumo get libSodiumSumo {
  final existing = _sodiumSumo;
  if (existing != null) return existing;
  final FutureOr<SodiumSumo> initialised = SodiumSumoInit.init();
  if (initialised is! SodiumSumo) {
    throw StateError(
      'libsodium is built for the Dart VM here; the web library is crypto-ts',
    );
  }
  return _sodiumSumo = initialised;
}

/// [count] bytes from the CSPRNG.
///
/// Every secret in this package — a keypair's seeds, the recovery code's 128
/// bits, a CCK, an AEAD nonce, a device-link ephemeral key — comes from here and
/// from nowhere else: never a counter, a timestamp, a password or a device
/// identifier (D-17, INV-12).
Uint8List randomBytes(int count) => libSodium.randombytes.buf(count);
