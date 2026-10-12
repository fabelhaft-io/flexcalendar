/// The key bundle, `spec/crypto.md` §6.2: the plaintext of a wrap (§6.3) and of
/// a device link (§6.7).
///
/// ```
/// offset  size  field
///      0     1  version = 0x01
///      1     4  u32 BE length of x25519_sk = 32
///      5    32  x25519_sk
///     37     4  u32 BE length of ed25519_sk = 64
///     41    64  ed25519_sk
///                total 105 bytes
/// ```
///
/// Both lengths are fixed; anything else is [CryptoError.length] (the length
/// prefixes exist so a later version can add a key type without a second
/// format). A version byte this implementation does not know is
/// [CryptoError.version].
///
/// One parser serves both callers — a recovery-code wrap and a device-link
/// bundle — because the plaintext is the same TLV, so there is one set of checks
/// to get wrong rather than two.
library;

import 'dart:typed_data';

import 'errors.dart';
import 'key_material.dart';

/// `1 + 4 + 32 + 4 + 64`.
const int keyBundleBytes = 105;

/// The one bundle version this implementation writes or reads (§6.2).
const int keyBundleVersion = 0x01;

/// The two private keys as §6.2 spells them.
class KeyBundle {
  /// Wraps existing key material, copying both keys.
  KeyBundle({
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

  /// The same bundle as a device's keypair (§6.1).
  KeyBundle.fromUserKeys(UserKeys keys)
    : x25519SecretKey = Uint8List.fromList(keys.x25519SecretKey),
      ed25519SecretKey = Uint8List.fromList(keys.ed25519SecretKey);

  /// Parses the 105-byte TLV, in this order: total length, both field lengths,
  /// the version byte.
  ///
  /// Both checks are length checks, so a truncated bundle and a bundle whose
  /// first key claims 31 bytes are the same refusal ([CryptoError.length]) — a
  /// caller cannot use them to probe a stored blob.
  factory KeyBundle.decode(Uint8List bundle) {
    if (bundle.length != keyBundleBytes) {
      throw _wrongLength(
        'a key bundle outside the pinned $keyBundleBytes bytes',
      );
    }
    final x25519Length = _u32At(bundle, 1);
    final ed25519Length = _u32At(bundle, 37);
    if (x25519Length != x25519SecretKeyBytes ||
        ed25519Length != ed25519SecretKeyBytes) {
      throw _wrongLength('a key bundle with a key of the wrong length');
    }
    if (bundle[0] != keyBundleVersion) {
      throw const CryptoException(
        CryptoError.version,
        'an unknown key bundle version',
      );
    }
    return KeyBundle(
      x25519SecretKey: Uint8List.sublistView(bundle, 5, 37),
      ed25519SecretKey: Uint8List.sublistView(bundle, 41, 105),
    );
  }

  /// The 32-byte X25519 secret key.
  final Uint8List x25519SecretKey;

  /// The 64-byte Ed25519 secret key: the seed, then the public key.
  final Uint8List ed25519SecretKey;

  /// `crypto_scalarmult_base(x25519_sk)`.
  Uint8List get x25519PublicKey => x25519PublicKeyOf(x25519SecretKey);

  /// `ed25519_sk[32:64]`.
  Uint8List get ed25519PublicKey =>
      Uint8List.fromList(ed25519SecretKey.sublist(32, 64));

  /// The §6.2 bytes, ready to be wrapped or sealed.
  Uint8List toBytes() {
    final out = Uint8List(keyBundleBytes);
    out[0] = keyBundleVersion;
    _writeU32(out, 1, x25519SecretKeyBytes);
    out.setRange(5, 37, x25519SecretKey);
    _writeU32(out, 37, ed25519SecretKeyBytes);
    out.setRange(41, 105, ed25519SecretKey);
    return out;
  }

  /// Whether this bundle is the key material of the `user_keys` row the caller
  /// fetched.
  ///
  /// `crypto_scalarmult_base(x25519_sk)` must equal [x25519PublicKey] and
  /// `ed25519_sk[32:64]` must equal [ed25519PublicKey]. This is the check that
  /// catches a server that swapped a stored blob between users (§6.2).
  bool matches({
    required Uint8List x25519PublicKey,
    required Uint8List ed25519PublicKey,
  }) {
    if (x25519PublicKey.length != x25519PublicKeyBytes ||
        ed25519PublicKey.length != ed25519PublicKeyBytes) {
      throw _wrongLength('an expected public key of the wrong size');
    }
    return _constantTimeEquals(this.x25519PublicKey, x25519PublicKey) &&
        _constantTimeEquals(this.ed25519PublicKey, ed25519PublicKey);
  }

  /// [matches], but refusing with [CryptoError.payload] instead of returning
  /// `false`, which is the code §6.2 gives this failure.
  void checkMatches({
    required Uint8List x25519PublicKey,
    required Uint8List ed25519PublicKey,
  }) {
    if (!matches(
      x25519PublicKey: x25519PublicKey,
      ed25519PublicKey: ed25519PublicKey,
    )) {
      throw const CryptoException(
        CryptoError.payload,
        'unwrapped key material does not match the public keys it claims',
      );
    }
  }
}

int _u32At(Uint8List bytes, int offset) =>
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3];

void _writeU32(Uint8List bytes, int offset, int value) {
  bytes[offset] = (value >> 24) & 0xff;
  bytes[offset + 1] = (value >> 16) & 0xff;
  bytes[offset + 2] = (value >> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

Uint8List _copyOf(Uint8List value, int length, String what) {
  if (value.length != length) throw _wrongLength(what);
  return Uint8List.fromList(value);
}

CryptoException _wrongLength(String what) =>
    CryptoException(CryptoError.length, what);

/// A comparison whose timing does not depend on where two keys first differ.
///
/// The values are public keys, so a timing leak is not a secret leak today; the
/// constant-time form costs nothing and keeps the check honest if it is ever
/// reused for something else.
bool _constantTimeEquals(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  var difference = 0;
  for (var i = 0; i < a.length; i++) {
    difference |= a[i] ^ b[i];
  }
  return difference == 0;
}
