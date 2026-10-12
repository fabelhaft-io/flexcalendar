/// Device linking, `spec/crypto.md` §6.7 (E14-R08, D-17).
///
/// Linking hands the private keys from a device that has them to a new one, sealed
/// to an ephemeral X25519 key the new device generates and shows. The server is a
/// 5-minute, read-once rendezvous and holds nothing but the sealed blob.
///
/// **The QR payload the new device shows** — an ASCII URI:
///
/// ```
/// calflex://link/1?l=<link-id>&e=<b64u(32-byte ephemeral X25519 public key)>&c=<6 digits>
/// ```
///
/// **The short verification code** a human compares on the two screens:
///
/// ```
/// digest = SHA-256("calflex-link-code-v1" ‖ ephemeral_pk(32) ‖ identity_pk(32))
/// code   = decimal(int_be(digest[0:8]) mod 1_000_000), zero-padded to 6 digits
/// ```
///
/// A malicious server that substituted a different identity key produces a
/// different code on the two screens, which is the whole point of showing one: the
/// linking device **MUST** abort with [CryptoError.verify] if the code the user
/// confirmed does not equal the code it computes, and **MUST NOT** upload a bundle
/// until it matches.
///
/// **The key bundle the linking device uploads:**
///
/// ```
/// offset  size  field
///      0     1  version = 0x01
///      1     1  suite = 0x01
///      2    16  signer user id, raw UUIDv4 bytes (the linking device's owner)
///     18    32  recipient ephemeral X25519 public key (the new device's, raw)
///     50    32  crypto_box_seal ephemeral public key
///     82    16  crypto_box_easy Poly1305 tag — first, as in §6.6
///     98   105  crypto_box_easy ciphertext: the sealed KeyBundle
///    203    64  Ed25519 signature by the signing device's identity key
///               total 267 bytes
/// ```
///
/// `crypto_box_seal` carries no AAD, so the signature is the only binding: it pins
/// the user, the rendezvous id, the recipient's ephemeral key and the whole sealed
/// blob, so the server cannot replay this blob at a different ephemeral key or a
/// different link.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:sodium/sodium.dart';

import 'aad.dart' show frame;
import 'encoding.dart';
import 'errors.dart';
import 'key_bundle.dart';
import 'key_material.dart' show x25519PublicKeyBytes, x25519PublicKeyOf;
import 'libsodium.dart';
import 'sealed_box.dart';

/// §6.7's code label, never length-prefixed (§0.1).
const String linkCodeLabel = 'calflex-link-code-v1';

/// §6.7's signature label.
const String linkBundleLabel = 'calflex-link-bundle-v1';

/// The one bundle version this implementation writes or reads (§6.7).
const int linkBundleVersion = 0x01;

/// The one suite byte this implementation writes or reads (§6.7).
const int linkBundleSuite = 0x01;

/// The path segment of the one link-payload version this implementation knows.
const String linkUriVersion = '1';

/// The scheme and path every link payload starts with.
const String linkUriPrefix = 'calflex://link/';

/// `2 + 16 + 32 + 153 + 64`: the pinned bundle (§6.7).
const int linkBundleBytes = 267;

/// The offset of the recipient's ephemeral key inside a bundle.
const int linkBundleEphemeralOffset = 18;

/// The offset of the sealed box inside a bundle.
const int linkBundleSealedOffset = 50;

/// The offset of the signature inside a bundle.
const int linkBundleSignatureOffset = 203;

/// The six digits the two devices compare, from the new device's ephemeral key
/// and the user's identity key (§6.7).
///
/// The identity key is the Ed25519 **public** key: the linking device takes it
/// from its own keystore, the new device from `user_keys` (it is signed in, so it
/// can fetch it).
String linkCode({
  required Uint8List ephemeralPublicKey,
  required Uint8List identityPublicKey,
}) {
  if (ephemeralPublicKey.length != x25519PublicKeyBytes ||
      identityPublicKey.length != 32) {
    throw const CryptoException(
      CryptoError.encoding,
      'a link code covers a 32-byte ephemeral key and a 32-byte identity key',
    );
  }
  final digest = sha256
      .convert(
        Uint8List.fromList([
          ...utf8.encode(linkCodeLabel),
          ...ephemeralPublicKey,
          ...identityPublicKey,
        ]),
      )
      .bytes;
  return _modulo(digest.sublist(0, 8), 1000000).toString().padLeft(6, '0');
}

/// The QR payload the new device shows (§6.7).
///
/// The three parameters appear in `l`, `e`, `c` order; [code] is the six digits
/// [linkCode] computed for this ephemeral key.
String linkUri({
  required String linkId,
  required Uint8List ephemeralPublicKey,
  required String code,
}) {
  checkUuidV4(linkId);
  if (ephemeralPublicKey.length != x25519PublicKeyBytes) {
    throw const CryptoException(
      CryptoError.encoding,
      'an ephemeral public key is 32 bytes',
    );
  }
  if (!_codePattern.hasMatch(code)) {
    throw const CryptoException(
      CryptoError.encoding,
      'a verification code is six digits',
    );
  }
  return '$linkUriPrefix$linkUriVersion?l=$linkId'
      '&e=${encodeBase64Url(ephemeralPublicKey)}&c=$code';
}

/// What a link payload carries, after parsing (§6.7).
class LinkRequest {
  /// Wraps the three values a link payload carries.
  LinkRequest({
    required this.linkId,
    required this.ephemeralPublicKey,
    required this.code,
  });

  /// The `device_links` row's UUIDv4, canonical lowercase text.
  final String linkId;

  /// The new device's ephemeral X25519 public key, 32 raw bytes.
  final Uint8List ephemeralPublicKey;

  /// The six digits the human compares.
  final String code;
}

/// Parses a link payload: the path version, then the three parameters in order.
///
/// The version is checked first ([CryptoError.version]); a repeated, unknown,
/// missing or out-of-order parameter and a payload that is not a link URI at all
/// are [CryptoError.verify]; a `l` that is not a canonical lowercase UUIDv4 or an
/// `e` that is not 32 bytes of unpadded base64url — or a `c` that is not six digits
/// — are [CryptoError.encoding] (§0.3's canonical decimal).
///
/// Parsing does **not** verify the code: the linking device computes the code from
/// the new device's ephemeral key and the user's identity key and compares, which
/// is [checkLinkCode].
LinkRequest parseLinkUri(String uri) {
  if (!uri.startsWith(linkUriPrefix)) {
    throw const CryptoException(
      CryptoError.version,
      'not a calflex link payload',
    );
  }
  final rest = uri.substring(linkUriPrefix.length);
  final separator = rest.indexOf('?');
  if (separator < 0 || rest.substring(0, separator) != linkUriVersion) {
    throw const CryptoException(
      CryptoError.version,
      'an unknown link payload version',
    );
  }
  final parts = <String, String>{};
  for (final chunk in rest.substring(separator + 1).split('&')) {
    final equals = chunk.indexOf('=');
    final key = equals < 0 ? chunk : chunk.substring(0, equals);
    if (equals < 0 ||
        parts.containsKey(key) ||
        !_linkParameters.contains(key)) {
      throw const CryptoException(
        CryptoError.verify,
        'a repeated or unknown link parameter',
      );
    }
    parts[key] = chunk.substring(equals + 1);
  }
  if (parts.keys.join(',') != 'l,e,c') {
    throw const CryptoException(
      CryptoError.verify,
      'link parameters out of order or missing',
    );
  }
  final linkId = parts['l']!;
  checkUuidV4(linkId);
  final ephemeralPublicKey = decodeBase64Url(parts['e']!);
  if (ephemeralPublicKey.length != x25519PublicKeyBytes) {
    throw const CryptoException(
      CryptoError.encoding,
      'an ephemeral public key is 32 bytes',
    );
  }
  final code = parts['c']!;
  if (!_codePattern.hasMatch(code)) {
    throw const CryptoException(
      CryptoError.encoding,
      'a verification code is six digits',
    );
  }
  return LinkRequest(
    linkId: linkId,
    ephemeralPublicKey: ephemeralPublicKey,
    code: code,
  );
}

/// Whether the code a user confirmed is the code these keys produce (§6.7).
///
/// The linking device aborts with [CryptoError.verify] when this is `false`, and
/// uploads nothing until it is `true`.
bool linkCodeMatches({
  required String code,
  required Uint8List ephemeralPublicKey,
  required Uint8List identityPublicKey,
}) =>
    code ==
    linkCode(
      ephemeralPublicKey: ephemeralPublicKey,
      identityPublicKey: identityPublicKey,
    );

/// [linkCodeMatches], but refusing with [CryptoError.verify] instead of returning
/// `false` — the code a user confirmed is compared out of band, so a mismatch is a
/// refusal, never a retry with different keys.
void checkLinkCode({
  required String code,
  required Uint8List ephemeralPublicKey,
  required Uint8List identityPublicKey,
}) {
  if (!linkCodeMatches(
    code: code,
    ephemeralPublicKey: ephemeralPublicKey,
    identityPublicKey: identityPublicKey,
  )) {
    throw const CryptoException(
      CryptoError.verify,
      'the confirmed code is not the one these keys produce',
    );
  }
}

/// Seals the bundle to the new device's ephemeral key and signs it with the
/// linking device's identity key (§6.7).
///
/// The sealed box draws a fresh ephemeral key on every call, so two links are
/// different bytes; [sealLinkBundleWithEphemeralKey] is the test-only form the
/// vectors pin.
Uint8List sealLinkBundle({
  required String userId,
  required String linkId,
  required Uint8List recipientEphemeralPublicKey,
  required KeyBundle bundle,
  required Uint8List signerEd25519SecretKey,
}) => sealLinkBundleWithEphemeralKey(
  userId: userId,
  linkId: linkId,
  recipientEphemeralPublicKey: recipientEphemeralPublicKey,
  bundle: bundle,
  signerEd25519SecretKey: signerEd25519SecretKey,
  ephemeralSecretKey: randomBytes(x25519PublicKeyBytes),
);

/// Seals the bundle under a caller-supplied ephemeral key.
///
/// **Test-only.** §6.7 pins the bundle a fixed ephemeral key produces so the seal
/// can be reproduced byte for byte; nothing in the library calls this, and it is
/// not exported from `package:crypto_dart/crypto_dart.dart`.
Uint8List sealLinkBundleWithEphemeralKey({
  required String userId,
  required String linkId,
  required Uint8List recipientEphemeralPublicKey,
  required KeyBundle bundle,
  required Uint8List signerEd25519SecretKey,
  required Uint8List ephemeralSecretKey,
}) {
  checkUuidV4(userId);
  checkUuidV4(linkId);
  if (recipientEphemeralPublicKey.length != x25519PublicKeyBytes) {
    throw const CryptoException(
      CryptoError.length,
      'an ephemeral public key is 32 bytes',
    );
  }
  if (signerEd25519SecretKey.length != 64) {
    throw const CryptoException(
      CryptoError.length,
      'an Ed25519 secret key is 64 bytes',
    );
  }
  final sealed = sealBox(
    message: bundle.toBytes(),
    recipientPublicKey: recipientEphemeralPublicKey,
    ephemeralSecretKey: ephemeralSecretKey,
  );
  final head = Uint8List(linkBundleSignatureOffset);
  head[0] = linkBundleVersion;
  head[1] = linkBundleSuite;
  head.setRange(2, 18, decodeUuidV4(userId));
  head.setRange(18, 50, recipientEphemeralPublicKey);
  head.setRange(linkBundleSealedOffset, linkBundleSignatureOffset, sealed);
  final signature = _sign(
    linkBundleMessage(
      userId: userId,
      linkId: linkId,
      recipientEphemeralPublicKey: recipientEphemeralPublicKey,
      head: head,
    ),
    signerEd25519SecretKey,
  );
  return Uint8List.fromList([...head, ...signature]);
}

/// Verifies the signature and opens the bundle on the new device (§6.7).
///
/// The new device checks length, version and suite, verifies the signature with
/// the signer's `ed25519_pk` from `user_keys`, then opens the sealed box with its
/// own ephemeral secret key — and validates the [KeyBundle], which the caller
/// passes to [KeyBundle.checkMatches] against the `user_keys` row.
///
/// [userId] is the linking device's owner: it is part of the signed message, so a
/// bundle for another account is refused with [CryptoError.signature]. The key the
/// message binds as the recipient is the one the blob **records**
/// (`blob[18:50]`), so a blob replayed unchanged at another device still verifies
/// its signature and is refused by the seal ([CryptoError.auth]), while a blob
/// whose recorded key was rewritten after signing fails the signature.
KeyBundle openLinkBundle({
  required Uint8List blob,
  required String userId,
  required String linkId,
  required Uint8List ephemeralSecretKey,
  required Uint8List signerEd25519PublicKey,
}) {
  if (blob.length != linkBundleBytes) {
    throw CryptoException(
      CryptoError.length,
      'a link bundle that is not $linkBundleBytes bytes',
    );
  }
  if (blob[0] != linkBundleVersion) {
    throw const CryptoException(
      CryptoError.version,
      'an unknown link bundle version',
    );
  }
  if (blob[1] != linkBundleSuite) {
    throw const CryptoException(
      CryptoError.unsupported,
      'a link bundle suite this version does not implement',
    );
  }
  checkUuidV4(userId);
  checkUuidV4(linkId);
  if (signerEd25519PublicKey.length != 32) {
    throw const CryptoException(
      CryptoError.length,
      'an Ed25519 public key is 32 bytes',
    );
  }
  final recipientEphemeralPublicKey = Uint8List.sublistView(
    blob,
    linkBundleEphemeralOffset,
    linkBundleSealedOffset,
  );
  final verified = libSodium.crypto.sign.verifyDetached(
    message: linkBundleMessage(
      userId: userId,
      linkId: linkId,
      recipientEphemeralPublicKey: recipientEphemeralPublicKey,
      head: Uint8List.sublistView(blob, 0, linkBundleSignatureOffset),
    ),
    signature: Uint8List.sublistView(
      blob,
      linkBundleSignatureOffset,
      linkBundleBytes,
    ),
    publicKey: signerEd25519PublicKey,
  );
  if (!verified) {
    throw const CryptoException(
      CryptoError.signature,
      'the link bundle is not signed by that identity key',
    );
  }
  // §6.7: the caller derives its public key from its ephemeral secret key, and
  // libsodium reads the seal's ephemeral key from the box itself.
  final ephemeralPublicKey = x25519PublicKeyOf(ephemeralSecretKey);
  final plain = openSealedBox(
    sealed: Uint8List.sublistView(
      blob,
      linkBundleSealedOffset,
      linkBundleSignatureOffset,
    ),
    recipientPublicKey: ephemeralPublicKey,
    recipientSecretKey: ephemeralSecretKey,
  );
  return KeyBundle.decode(plain);
}

/// §6.7's `sig_msg`: the owner, the rendezvous id, the recipient's ephemeral key
/// and the bundle's first 203 bytes.
Uint8List linkBundleMessage({
  required String userId,
  required String linkId,
  required Uint8List recipientEphemeralPublicKey,
  required Uint8List head,
}) => frame(linkBundleLabel, [
  utf8.encode(userId),
  utf8.encode(linkId),
  recipientEphemeralPublicKey,
  head,
]);

/// The parameters a link payload carries, in order (§6.7).
const List<String> _linkParameters = ['l', 'e', 'c'];

final RegExp _codePattern = RegExp(r'^\d{6}$');

Uint8List _sign(Uint8List message, Uint8List ed25519SecretKey) {
  final key = SecureKey.fromList(
    libSodium,
    Uint8List.fromList(ed25519SecretKey),
  );
  try {
    return libSodium.crypto.sign.detached(message: message, secretKey: key);
  } finally {
    key.dispose();
  }
}

/// `int_be(bytes) mod [modulus]`, computed byte by byte so a 64-bit digest prefix
/// cannot overflow a machine word: only the remainder is carried, and modular
/// arithmetic is exact for every prefix.
int _modulo(List<int> bytes, int modulus) {
  var remainder = 0;
  for (final byte in bytes) {
    remainder = (remainder * 256 + byte) % modulus;
  }
  return remainder;
}
