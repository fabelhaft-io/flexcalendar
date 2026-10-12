/// Sealed boxes, as `spec/crypto.md` §6.6 and §6.7 spell them out.
///
/// libsodium's `crypto_box_seal` draws a fresh ephemeral key on every call, so a
/// *sealing* vector can never be deterministic (see
/// `spec/crypto-vectors/gen/README.md` § Determinism). The vectors therefore pin
/// a box built with a fixed ephemeral key:
///
/// ```
/// sealed = epk(32) ‖ crypto_box_easy(m, nonce, recipient_pk, esk)
/// epk    = crypto_scalarmult_base(esk)
/// nonce  = BLAKE2b(epk ‖ recipient_pk) with a **24-byte output length**
/// ```
///
/// The nonce is **not** BLAKE2b-256: libsodium asks BLAKE2b for
/// `crypto_box_NONCEBYTES` bytes, and a 24-byte BLAKE2b output is a different
/// function from the first 24 bytes of a 32-byte one. The `easy` output puts the
/// Poly1305 **tag first**, then the ciphertext, so the whole box is
/// `epk ‖ tag ‖ c`.
///
/// [sealBox] takes the ephemeral secret key so a test can reproduce a pinned box;
/// the callers of this package draw that key from the CSPRNG.
library;

import 'dart:typed_data';

import 'package:sodium/sodium.dart';

import 'errors.dart';
import 'libsodium.dart';

/// `crypto_box_PUBLICKEYBYTES`.
const int sealedBoxPublicKeyBytes = 32;

/// `crypto_box_MACBYTES`: the Poly1305 tag at the front of the `easy` output.
const int sealedBoxTagBytes = 16;

/// The 80 bytes a sealed 32-byte CCK occupies: `epk(32) ‖ tag(16) ‖ c(32)`.
const int sealedBoxOverheadBytes = sealedBoxPublicKeyBytes + sealedBoxTagBytes;

/// A sealed box under a caller-supplied ephemeral key (§6.6's pinned form).
///
/// **Not for production callers:** a caller that picked its own ephemeral key
/// would be one mistake away from reusing a nonce under one recipient key. The
/// public entry points of this package draw [ephemeralSecretKey] from the CSPRNG.
Uint8List sealBox({
  required Uint8List message,
  required Uint8List recipientPublicKey,
  required Uint8List ephemeralSecretKey,
}) {
  if (recipientPublicKey.length != sealedBoxPublicKeyBytes) {
    throw const CryptoException(
      CryptoError.length,
      'a recipient public key is 32 bytes',
    );
  }
  if (ephemeralSecretKey.length != sealedBoxPublicKeyBytes) {
    throw const CryptoException(
      CryptoError.length,
      'an ephemeral secret key is 32 bytes',
    );
  }
  final ephemeral = SecureKey.fromList(
    libSodium,
    Uint8List.fromList(ephemeralSecretKey),
  );
  try {
    final ephemeralPublicKey = libSodiumSumo.crypto.scalarmult.base(
      n: ephemeral,
    );
    final nonce = libSodium.crypto.genericHash.call(
      message: Uint8List.fromList([
        ...ephemeralPublicKey,
        ...recipientPublicKey,
      ]),
      outLen: libSodium.crypto.box.nonceBytes,
    );
    final box = libSodium.crypto.box.easy(
      message: message,
      nonce: nonce,
      publicKey: recipientPublicKey,
      secretKey: ephemeral,
    );
    return Uint8List.fromList([...ephemeralPublicKey, ...box]);
  } finally {
    ephemeral.dispose();
  }
}

/// Opens a sealed box with the recipient's keypair.
///
/// libsodium's `crypto_box_seal_open(c, pk, sk)` takes the **public** key before
/// the secret one, and reads the ephemeral key from the first 32 bytes of [sealed]
/// — so [recipientPublicKey] must be `crypto_scalarmult_base(sk)` of the same
/// secret key, which is what the callers derive when a caller holds only its
/// secret key (§6.6 step 3, §6.7).
///
/// Every failure — the wrong recipient, a flipped byte, a truncated box — is
/// [CryptoError.auth], and no partial plaintext is ever returned.
Uint8List openSealedBox({
  required Uint8List sealed,
  required Uint8List recipientPublicKey,
  required Uint8List recipientSecretKey,
}) {
  if (sealed.length < sealedBoxOverheadBytes) {
    throw const CryptoException(
      CryptoError.length,
      'a sealed box shorter than its ephemeral key and tag',
    );
  }
  if (recipientPublicKey.length != sealedBoxPublicKeyBytes ||
      recipientSecretKey.length != sealedBoxPublicKeyBytes) {
    throw const CryptoException(
      CryptoError.length,
      'a recipient key of the wrong size',
    );
  }
  final secret = SecureKey.fromList(
    libSodium,
    Uint8List.fromList(recipientSecretKey),
  );
  try {
    return libSodium.crypto.box.sealOpen(
      cipherText: sealed,
      publicKey: recipientPublicKey,
      secretKey: secret,
    );
  } on SodiumException {
    throw const CryptoException(
      CryptoError.auth,
      'the sealed box does not authenticate for this recipient',
    );
  } finally {
    secret.dispose();
  }
}
