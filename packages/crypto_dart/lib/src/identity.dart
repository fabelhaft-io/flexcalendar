/// Identity fingerprints, safety numbers and the verification payload,
/// `spec/crypto.md` §6.8 (D-15).
///
/// Sealed boxes do not authenticate the sender, and members' public keys are
/// handed out by our server, which could substitute its own. Every user therefore
/// has an Ed25519 identity key, and D-15's authenticity comes from comparing a
/// value **out of band** — scanning a QR code in person or reading numbers aloud:
///
/// **Identity fingerprint** — 32 bytes, over **both** public keys, so that a
/// substituted sealing key is as visible as a substituted identity key:
///
/// ```
/// fingerprint = SHA-256("calflex-id-v1" ‖ x25519_pk(32) ‖ ed25519_pk(32))
/// ```
///
/// Canonical text: 64 lowercase hex digits, which is what an invite link carries
/// (E06-R09); display: eight groups of eight.
///
/// **Safety number** — 60 decimal digits, identical on both users' devices:
///
/// ```
/// d      = SHA-256("calflex-safety-v1" ‖ fp_a(32) ‖ fp_b(32))
/// digits = decimal(int_be(d) mod 10^60), zero-padded to exactly 60 digits
/// ```
///
/// The two fingerprints are ordered by bytewise ascending comparison of the raw 32
/// bytes before hashing, so both sides compute the same number whichever one scans
/// first.
///
/// **Key-verification payload** — what a user shows so the other can mark both keys
/// verified (E06-R09, D-15):
///
/// ```
/// calflex://verify/1?u=<user-id>&k=<b64u(ed25519_pk)>&x=<b64u(x25519_pk)>&f=<fingerprint hex>
/// ```
///
/// A scanner **MUST** recompute the fingerprint from `k` and `x` and refuse unless
/// it equals `f`; `f` is redundant by construction and included on purpose, which
/// makes the payload self-checking. With all four parameters the URI is 216 ASCII
/// bytes for our UUIDv4 lengths.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'encoding.dart';
import 'errors.dart';
import 'key_material.dart' show x25519PublicKeyBytes;

/// §6.8's fingerprint label, never length-prefixed (§0.1).
const String fingerprintLabel = 'calflex-id-v1';

/// §6.8's safety-number label.
const String safetyNumberLabel = 'calflex-safety-v1';

/// A fingerprint is a SHA-256 digest.
const int fingerprintBytes = 32;

/// The safety number's decimal length, `mod 10^60`.
const int safetyNumberDigits = 60;

/// The path segment of the one verification-payload version this implementation
/// knows.
const String verifyUriVersion = '1';

/// The scheme and path every verification payload starts with.
const String verifyUriPrefix = 'calflex://verify/';

/// The 32-byte fingerprint over both public keys (§6.8).
Uint8List fingerprint({
  required Uint8List x25519PublicKey,
  required Uint8List ed25519PublicKey,
}) {
  if (x25519PublicKey.length != x25519PublicKeyBytes ||
      ed25519PublicKey.length != 32) {
    throw const CryptoException(
      CryptoError.length,
      'a fingerprint covers a 32-byte sealing key and a 32-byte identity key',
    );
  }
  return Uint8List.fromList(
    sha256
        .convert(
          Uint8List.fromList([
            ...utf8.encode(fingerprintLabel),
            ...x25519PublicKey,
            ...ed25519PublicKey,
          ]),
        )
        .bytes,
  );
}

/// [fingerprint] as §6.8's canonical text: 64 lowercase hex digits.
String fingerprintHex({
  required Uint8List x25519PublicKey,
  required Uint8List ed25519PublicKey,
}) => encodeHex(
  fingerprint(
    x25519PublicKey: x25519PublicKey,
    ed25519PublicKey: ed25519PublicKey,
  ),
);

/// §6.8's display form of a fingerprint: eight groups of eight hex digits.
String groupFingerprint(String hex) => _group(hex, 8);

/// §6.8's 60-digit safety number for two users' fingerprints.
///
/// The fingerprints are sorted by their raw bytes before hashing, so the two
/// devices read the same number whatever order they compare in. Two identical
/// fingerprints (the same user's two screens) are hashed as the same value twice.
String safetyNumber({
  required Uint8List firstFingerprint,
  required Uint8List secondFingerprint,
}) {
  if (firstFingerprint.length != fingerprintBytes ||
      secondFingerprint.length != fingerprintBytes) {
    throw const CryptoException(
      CryptoError.length,
      'a fingerprint is 32 bytes',
    );
  }
  final low = _bytewiseFirst(firstFingerprint, secondFingerprint);
  final high = identical(low, firstFingerprint)
      ? secondFingerprint
      : firstFingerprint;
  final digest = sha256
      .convert(
        Uint8List.fromList([
          ...utf8.encode(safetyNumberLabel),
          ...low,
          ...high,
        ]),
      )
      .bytes;
  final value = _bigIntOf(digest) % BigInt.from(10).pow(safetyNumberDigits);
  return value.toString().padLeft(safetyNumberDigits, '0');
}

/// §6.8's display form of a safety number: twelve groups of five digits.
String groupSafetyNumber(String digits) => _group(digits, 5);

/// The payload a user shows so the other can mark both keys verified (§6.8).
///
/// `f` is computed here, so the payload can never carry a fingerprint that does
/// not cover `k` and `x`.
String verifyUri({
  required String userId,
  required Uint8List x25519PublicKey,
  required Uint8List ed25519PublicKey,
}) {
  checkUuidV4(userId);
  if (x25519PublicKey.length != x25519PublicKeyBytes ||
      ed25519PublicKey.length != 32) {
    throw const CryptoException(
      CryptoError.length,
      'a verification payload carries two 32-byte public keys',
    );
  }
  return '$verifyUriPrefix$verifyUriVersion?u=$userId'
      '&k=${encodeBase64Url(ed25519PublicKey)}'
      '&x=${encodeBase64Url(x25519PublicKey)}'
      '&f=${fingerprintHex(x25519PublicKey: x25519PublicKey, ed25519PublicKey: ed25519PublicKey)}';
}

/// What a scanned verification payload says, after the fingerprint check (§6.8).
class VerifiedIdentity {
  /// Wraps the four values a verification payload carries.
  VerifiedIdentity({
    required this.userId,
    required this.x25519PublicKey,
    required this.ed25519PublicKey,
    required this.fingerprintHex,
  });

  /// The user's canonical lowercase UUIDv4.
  final String userId;

  /// The user's X25519 sealing key, 32 raw bytes.
  final Uint8List x25519PublicKey;

  /// The user's Ed25519 identity key, 32 raw bytes.
  final Uint8List ed25519PublicKey;

  /// The recomputed fingerprint, 64 lowercase hex digits.
  final String fingerprintHex;
}

/// Parses a verification payload and recomputes the fingerprint (§6.8).
///
/// The version is checked first ([CryptoError.version]); a repeated, unknown,
/// missing or out-of-order parameter, and a fingerprint that does not cover the
/// two keys, are [CryptoError.verify] — the payload is self-checking, so a
/// mismatch means it was assembled by something that does not hold both keys, and
/// it is refused rather than repaired. A `u` that is not a canonical lowercase
/// UUIDv4, a `k`/`x` that is not 32 bytes of unpadded base64url, and an `f` that is
/// not 64 lowercase hex digits are [CryptoError.encoding]; a key of the wrong
/// length is [CryptoError.length].
VerifiedIdentity parseVerifyUri(String uri) {
  if (!uri.startsWith(verifyUriPrefix)) {
    throw const CryptoException(
      CryptoError.version,
      'not a calflex verification payload',
    );
  }
  final rest = uri.substring(verifyUriPrefix.length);
  final separator = rest.indexOf('?');
  if (separator < 0 || rest.substring(0, separator) != verifyUriVersion) {
    throw const CryptoException(
      CryptoError.version,
      'an unknown verification payload version',
    );
  }
  final parts = <String, String>{};
  for (final chunk in rest.substring(separator + 1).split('&')) {
    final equals = chunk.indexOf('=');
    final key = equals < 0 ? chunk : chunk.substring(0, equals);
    if (equals < 0 ||
        parts.containsKey(key) ||
        !_verifyParameters.contains(key)) {
      throw const CryptoException(
        CryptoError.verify,
        'a repeated or unknown verification parameter',
      );
    }
    parts[key] = chunk.substring(equals + 1);
  }
  if (parts.keys.join(',') != 'u,k,x,f') {
    throw const CryptoException(
      CryptoError.verify,
      'verification parameters out of order or missing',
    );
  }
  final userId = parts['u']!;
  checkUuidV4(userId);
  final ed25519PublicKey = decodeBase64Url(parts['k']!);
  final x25519PublicKey = decodeBase64Url(parts['x']!);
  if (ed25519PublicKey.length != 32 || x25519PublicKey.length != 32) {
    throw const CryptoException(
      CryptoError.length,
      'a verification payload carries two 32-byte public keys',
    );
  }
  final claimed = parts['f']!;
  if (!_fingerprintPattern.hasMatch(claimed)) {
    throw const CryptoException(
      CryptoError.encoding,
      'a fingerprint is 64 lowercase hex digits',
    );
  }
  final computed = fingerprintHex(
    x25519PublicKey: x25519PublicKey,
    ed25519PublicKey: ed25519PublicKey,
  );
  if (computed != claimed) {
    throw const CryptoException(
      CryptoError.verify,
      'the fingerprint does not cover the keys it is attached to',
    );
  }
  return VerifiedIdentity(
    userId: userId,
    x25519PublicKey: x25519PublicKey,
    ed25519PublicKey: ed25519PublicKey,
    fingerprintHex: computed,
  );
}

/// The parameters a verification payload carries, in order (§6.8).
const List<String> _verifyParameters = ['u', 'k', 'x', 'f'];

final RegExp _fingerprintPattern = RegExp(r'^[0-9a-f]{64}$');

/// [value] in groups of [size], single spaces, as §6.8's display forms ask.
String _group(String value, int size) {
  final groups = <String>[];
  for (var start = 0; start < value.length; start += size) {
    groups.add(value.substring(start, (start + size).clamp(0, value.length)));
  }
  return groups.join(' ');
}

/// [first] or [second], whichever is smaller comparing raw bytes ascending.
Uint8List _bytewiseFirst(Uint8List first, Uint8List second) {
  for (var i = 0; i < first.length; i++) {
    if (first[i] != second[i]) {
      return first[i] < second[i] ? first : second;
    }
  }
  return first;
}

/// The unsigned big-endian integer of a 32-byte digest.
BigInt _bigIntOf(List<int> bytes) {
  var value = BigInt.zero;
  for (final byte in bytes) {
    value = (value << 8) | BigInt.from(byte);
  }
  return value;
}
