/// The two keypairs a user has, `spec/crypto.md` §6.1 (D-15, D-17).
///
/// | Key | Primitive | Size |
/// |---|---|---|
/// | `x25519_sk` / `x25519_pk` | `crypto_box_keypair` (Curve25519) | 32 / 32 |
/// | `ed25519_sk` / `ed25519_pk` | `crypto_sign_keypair` (Ed25519) | 64 / 32 |
///
/// The X25519 key seals (a CCK record, a device-link bundle); the Ed25519 key is
/// the **identity** key that signs them (D-15). `ed25519_sk` is libsodium's form:
/// the 32-byte seed followed by the 32-byte public key.
///
/// - Generated on the device with the platform CSPRNG. Never derived from a
///   password, a recovery code or a device identifier (D-17, INV-12).
/// - `user_keys` holds only the two public keys. A blob whose unwrapped key
///   material disagrees with those public keys is refused with
///   [CryptoError.payload] — see [KeyBundle.checkMatches].
/// - Private keys live in Keystore/Keychain-backed storage (E12-R06). This
///   package holds them as bytes and wipes nothing it did not allocate; the
///   [SecureKey] it creates for one libsodium call is disposed in a `finally`.
library;

import 'dart:typed_data';

import 'package:sodium/sodium.dart';

import 'errors.dart';
import 'libsodium.dart';

/// `crypto_box_SECRETKEYBYTES`.
const int x25519SecretKeyBytes = 32;

/// `crypto_box_PUBLICKEYBYTES`.
const int x25519PublicKeyBytes = 32;

/// `crypto_sign_PUBLICKEYBYTES`.
const int ed25519PublicKeyBytes = 32;

/// `crypto_sign_SEEDBYTES`: the 32 random bytes an identity key is made from.
const int ed25519SeedBytes = 32;

/// `crypto_sign_SECRETKEYBYTES`: the seed followed by the public key.
const int ed25519SecretKeyBytes = 64;

/// The ASCII name of §6.1's pair, bound into a wrap's AAD (§6.3).
const String keySuite = 'x25519-ed25519-v1';

/// A user's keypair: the X25519 sealing key and the Ed25519 identity key.
class UserKeys {
  /// Wraps existing key material, copying both keys.
  UserKeys({
    required Uint8List x25519SecretKey,
    required Uint8List ed25519SecretKey,
  }) : x25519SecretKey = _copyOf(
         x25519SecretKey,
         x25519SecretKeyBytes,
         'an X25519 secret key',
       ),
       ed25519SecretKey = _copyOf(
         ed25519SecretKey,
         ed25519SecretKeyBytes,
         'an Ed25519 secret key',
       );

  /// The 32-byte X25519 secret key (`crypto_box_SECRETKEYBYTES`).
  final Uint8List x25519SecretKey;

  /// The 64-byte Ed25519 secret key: the 32-byte seed, then the public key.
  final Uint8List ed25519SecretKey;

  /// `crypto_scalarmult_base(x25519_sk)`: the key a CCK record is sealed to.
  Uint8List get x25519PublicKey => x25519PublicKeyOf(x25519SecretKey);

  /// `ed25519_sk[32:64]`: the identity public key (D-15).
  Uint8List get ed25519PublicKey =>
      Uint8List.fromList(ed25519SecretKey.sublist(32, 64));
}

/// `crypto_scalarmult_base(sk)`: the public key an X25519 secret key derives.
///
/// libsodium clamps the scalar inside `crypto_scalarmult_base`, which is exactly
/// what `crypto_box_keypair` does when it generates the pair, so this is the
/// public half of any X25519 secret key — and the derivation §6.2 demands on
/// unwrap and §6.6 step 3 needs when a caller holds only its secret key.
Uint8List x25519PublicKeyOf(Uint8List secretKey) {
  if (secretKey.length != x25519SecretKeyBytes) {
    throw _wrongLength('an X25519 secret key');
  }
  final key = _secureKey(secretKey);
  try {
    return libSodiumSumo.crypto.scalarmult.base(n: key);
  } finally {
    key.dispose();
  }
}

/// A fresh keypair from the CSPRNG: the device's keys, generated once.
UserKeys generateUserKeys() {
  final sealing = libSodium.crypto.box.keyPair();
  try {
    final identity = libSodium.crypto.sign.keyPair();
    try {
      return UserKeys(
        x25519SecretKey: sealing.secretKey.extractBytes(),
        ed25519SecretKey: identity.secretKey.extractBytes(),
      );
    } finally {
      identity.dispose();
    }
  } finally {
    sealing.dispose();
  }
}

/// The keypair a device restores from its stored seeds.
///
/// **Not a password.** [x25519SecretKey] and [ed25519Seed] are the random bytes
/// [generateUserKeys] drew once; a client keeps them in Keystore/Keychain-backed
/// storage (D-17, INV-12). Nothing here derives a key from a login secret, and
/// there is no entry point that takes one.
UserKeys userKeysFromSeeds({
  required Uint8List x25519SecretKey,
  required Uint8List ed25519Seed,
}) {
  if (x25519SecretKey.length != x25519SecretKeyBytes) {
    throw _wrongLength('an X25519 secret key');
  }
  if (ed25519Seed.length != ed25519SeedBytes) {
    throw _wrongLength('an Ed25519 seed');
  }
  final seed = _secureKey(ed25519Seed);
  try {
    final identity = libSodium.crypto.sign.seedKeyPair(seed);
    try {
      return UserKeys(
        x25519SecretKey: x25519SecretKey,
        ed25519SecretKey: identity.secretKey.extractBytes(),
      );
    } finally {
      identity.dispose();
    }
  } finally {
    seed.dispose();
  }
}

/// The same bytes as a libsodium [SecureKey], so no libsodium call is handed a
/// plain list.
SecureKey _secureKey(Uint8List bytes) =>
    SecureKey.fromList(libSodium, Uint8List.fromList(bytes));

Uint8List _copyOf(Uint8List value, int length, String what) {
  if (value.length != length) throw _wrongLength(what);
  return Uint8List.fromList(value);
}

CryptoException _wrongLength(String what) =>
    CryptoException(CryptoError.length, '$what is not the pinned size');
