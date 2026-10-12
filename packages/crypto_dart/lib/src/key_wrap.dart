/// The wrapped private key, `spec/crypto.md` §6.3.
///
/// ```
/// offset  size  field
///      0     1  version = 0x01
///      1     1  kind: 0x01 = recovery_code, 0x02 = escrow (reserved, §6.3.2)
///      2    24  nonce, from the CSPRNG, fresh per wrap
///     26     n  ciphertext (a KeyBundle, n = 105)
///    26+n    16  tag
///                total 147 bytes for kind 0x01
/// ```
///
/// AEAD: XChaCha20-Poly1305 with `key = KEK` and
///
/// ```
/// aad = "calflex-keywrap-v1" ‖ lp32(user_id) ‖ lp32(kind) ‖ lp32(suite)
/// ```
///
/// **Why an AEAD and not a sealed box.** ADR 0001's key wrapping is
/// `crypto_box_seal`, and that is what §6.6 and §6.7 use — but a sealed box needs
/// a *public* key, and `KEK_rc` is a symmetric HKDF output with no keypair behind
/// it. A symmetric KEK can only be used with a symmetric AEAD, so the wrap is
/// XChaCha20-Poly1305 with its own label, its own nonce and an AAD that binds the
/// owner and the kind.
///
/// A wrap therefore cannot be moved to another user's row or to another `kind`
/// ([CryptoError.auth]), and `escrow` (0x02) is reserved for Phase 7's HSM-backed
/// KEK and refused rather than guessed at ([CryptoError.unsupported], §6.3.2).
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:sodium/sodium.dart';

import 'aad.dart' show frame, nonceBytes, tagBytes;
import 'encoding.dart';
import 'errors.dart';
import 'key_bundle.dart';
import 'key_material.dart' show keySuite;
import 'libsodium.dart';

/// The one wrap version this implementation writes or reads (§6.3).
const int keyWrapVersion = 0x01;

/// §6.3's domain label, never length-prefixed (§0.1).
const String keyWrapLabel = 'calflex-keywrap-v1';

/// `1 + 1 + 24 + 16`: the fixed part of a wrap, with an empty ciphertext (§6.3.3).
const int minWrappedKeyBytes = 42;

/// The API's ceiling for a wrap: 512 bytes (§6.3.3).
const int maxWrappedKeyBytes = 512;

/// What a reader of version 1 demands of a `recovery_code` wrap (§6.3.3).
const int recoveryCodeWrapBytes =
    1 + 1 + nonceBytes + keyBundleBytes + tagBytes;

/// The `kind` column value a wrap is bound to (§6.3).
enum KeyWrapKind {
  /// The wrap a user's own recovery code opens (§6.4).
  recoveryCode('recovery_code', 0x01),

  /// Tier 1's escrow wrap: **reserved** for Phase 7 (E14-R01), never written or
  /// read by version 1 (§6.3.2).
  escrow('escrow', 0x02);

  const KeyWrapKind(this.name, this.byte);

  /// The ASCII column value the AAD binds.
  final String name;

  /// The kind byte in the wrap's header.
  final int byte;
}

/// Wraps [bundle] under [kek] with a fresh nonce from the CSPRNG.
///
/// [userId] is the **owner** of the wrap: its canonical lowercase UUIDv4 text is
/// bound into the AAD, so the server cannot move the wrap to another user's row.
Uint8List sealWrappedKey({
  required Uint8List kek,
  required String userId,
  required KeyWrapKind kind,
  required KeyBundle bundle,
}) => sealWrappedKeyWithNonce(
  kek: kek,
  userId: userId,
  kind: kind,
  bundle: bundle,
  nonce: randomBytes(nonceBytes),
);

/// Wraps [bundle] under [kek] with a caller-supplied nonce.
///
/// **Test-only.** §6.3 pins a nonce in every wrap vector; nothing in the library
/// calls this, and it is not exported from `package:crypto_dart/crypto_dart.dart`
/// — a caller that picked its own nonce would be one mistake away from a
/// catastrophic reuse under one KEK.
Uint8List sealWrappedKeyWithNonce({
  required Uint8List kek,
  required String userId,
  required KeyWrapKind kind,
  required KeyBundle bundle,
  required Uint8List nonce,
}) {
  checkUuidV4(userId);
  if (kek.length != 32) {
    throw const CryptoException(CryptoError.length, 'a KEK is 32 bytes');
  }
  if (nonce.length != nonceBytes) {
    throw const CryptoException(CryptoError.length, 'a nonce is 24 bytes');
  }
  if (kind == KeyWrapKind.escrow) {
    // Version 1 defines no escrow format: writing one would claim a meaning the
    // bytes do not have (§6.3.2, E14-R01 owns the real one).
    throw const CryptoException(
      CryptoError.unsupported,
      'the escrow wrap is reserved for Phase 7',
    );
  }
  final key = SecureKey.fromList(libSodium, Uint8List.fromList(kek));
  final Uint8List cipher;
  try {
    cipher = libSodium.crypto.aeadXChaCha20Poly1305IETF.encrypt(
      message: bundle.toBytes(),
      nonce: nonce,
      key: key,
      additionalData: keyWrapAad(userId: userId, kind: kind),
    );
  } finally {
    key.dispose();
  }
  final out = Uint8List(recoveryCodeWrapBytes);
  out[0] = keyWrapVersion;
  out[1] = kind.byte;
  out.setRange(2, 26, nonce);
  out.setRange(26, out.length, cipher);
  return out;
}

/// Opens a wrap, in the order §6.3 pins: size bounds, version, the reserved kind,
/// the kind the caller asked for, and only then the AEAD.
///
/// Every AEAD failure — a wrong KEK, a flip anywhere, a wrap moved to another
/// user or another kind — is the same [CryptoError.auth], and no partial plaintext
/// is ever returned. The result must be passed to [KeyBundle.checkMatches] against
/// the `user_keys` row the caller fetched (§6.2).
KeyBundle openWrappedKey({
  required Uint8List kek,
  required String userId,
  required KeyWrapKind kind,
  required Uint8List wrapped,
}) {
  if (wrapped.length < minWrappedKeyBytes ||
      wrapped.length > maxWrappedKeyBytes) {
    throw CryptoException(
      CryptoError.length,
      'a wrap outside $minWrappedKeyBytes … $maxWrappedKeyBytes bytes',
    );
  }
  if (wrapped[0] != keyWrapVersion) {
    throw const CryptoException(CryptoError.version, 'an unknown wrap version');
  }
  final kindByte = wrapped[1];
  if (kindByte == KeyWrapKind.escrow.byte) {
    throw const CryptoException(
      CryptoError.unsupported,
      'the escrow wrap is reserved for Phase 7',
    );
  }
  if (kindByte != kind.byte) {
    throw const CryptoException(
      CryptoError.version,
      'a kind byte that contradicts the kind the caller asked for',
    );
  }
  if (kindByte == KeyWrapKind.recoveryCode.byte &&
      wrapped.length != recoveryCodeWrapBytes) {
    // §6.3.3: "A reader of version 1 with kind = 0x01 demands exactly 147."
    throw CryptoException(
      CryptoError.length,
      'a recovery_code wrap that is not $recoveryCodeWrapBytes bytes',
    );
  }
  checkUuidV4(userId);
  if (kek.length != 32) {
    throw const CryptoException(CryptoError.length, 'a KEK is 32 bytes');
  }
  final key = SecureKey.fromList(libSodium, Uint8List.fromList(kek));
  final Uint8List plain;
  try {
    plain = libSodium.crypto.aeadXChaCha20Poly1305IETF.decrypt(
      cipherText: Uint8List.sublistView(wrapped, 26),
      nonce: Uint8List.sublistView(wrapped, 2, 26),
      key: key,
      additionalData: keyWrapAad(userId: userId, kind: kind),
    );
  } on SodiumException {
    throw const CryptoException(
      CryptoError.auth,
      'the wrap does not authenticate',
    );
  } finally {
    key.dispose();
  }
  return KeyBundle.decode(plain);
}

/// §6.3's AAD: the label, the owner, the kind's ASCII column value and the suite.
///
/// The same framing every other message in the spec uses (§2.1), so a wrap's AAD
/// can never collide with an envelope's or a record's.
Uint8List keyWrapAad({required String userId, required KeyWrapKind kind}) =>
    frame(keyWrapLabel, [
      utf8.encode(userId),
      utf8.encode(kind.name),
      utf8.encode(keySuite),
    ]);
