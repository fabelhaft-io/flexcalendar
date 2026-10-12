/// The transport encodings of `spec/crypto.md` §0.2, and the one identifier rule
/// every format in the key hierarchy binds.
///
/// A decoder here is **canonical or nothing**: `hex` refuses uppercase, odd
/// length and any other character; `b64u` refuses `=` and anything outside the
/// URL-safe alphabet; a UUID must be the lowercase RFC 4122 §3 text of a **v4**
/// identifier (INV-03). Every refusal is [CryptoError.encoding], and a refusal
/// never echoes the offending bytes.
///
/// `spec/crypto.md` §0.2 gives each decoder its code, and the vectors pin them:
/// `identity-verify-qr-uppercase-fingerprint`, `identity-verify-qr-padded-key`,
/// `link-qr-padded-key-refused`, `link-qr-bad-uuid` and
/// `identity-verify-qr-bad-uuid`.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'errors.dart';

/// The canonical lowercase UUIDv4 text of §0.2 / INV-03.
///
/// `aad.dart` carries its own copy of this pattern for the AAD's field check
/// (E12-R03); both are the same rule, and neither is a v1/v3/v5/v7 form.
final RegExp uuidV4Pattern = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
);

final RegExp _hexPattern = RegExp(r'^[0-9a-f]*$');
final RegExp _base64UrlPattern = RegExp(r'^[A-Za-z0-9_-]*$');

/// Lowercase hex of [bytes], the encoding §0.2 pins.
String encodeHex(List<int> bytes) {
  final out = StringBuffer();
  for (final byte in bytes) {
    out.write(byte.toRadixString(16).padLeft(2, '0'));
  }
  return out.toString();
}

/// Decodes canonical lowercase hex, or refuses with [CryptoError.encoding].
Uint8List decodeHex(String value) {
  if (value.length.isOdd || !_hexPattern.hasMatch(value)) {
    throw const CryptoException(
      CryptoError.encoding,
      'not canonical lowercase hex',
    );
  }
  final out = Uint8List(value.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(value.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

/// Unpadded base64url of [bytes], the encoding §0.2 pins for a `calflex://`
/// payload.
String encodeBase64Url(List<int> bytes) =>
    base64Url.encode(bytes).replaceAll('=', '');

/// Decodes canonical unpadded base64url, or refuses with [CryptoError.encoding].
///
/// A padded input is refused rather than trimmed: §0.2 says a decoder must
/// refuse a string whose re-encoding differs from the input, and a `=` is a
/// different string.
Uint8List decodeBase64Url(String value) {
  if (!_base64UrlPattern.hasMatch(value) || value.length % 4 == 1) {
    throw const CryptoException(
      CryptoError.encoding,
      'not canonical unpadded base64url',
    );
  }
  final Uint8List decoded;
  try {
    decoded = base64Url.decode(value.padRight((value.length + 3) & ~3, '='));
  } on FormatException {
    throw const CryptoException(
      CryptoError.encoding,
      'not canonical unpadded base64url',
    );
  }
  if (encodeBase64Url(decoded) != value) {
    throw const CryptoException(
      CryptoError.encoding,
      'not canonical unpadded base64url',
    );
  }
  return decoded;
}

/// The 16 raw bytes of a canonical lowercase UUIDv4's text.
Uint8List decodeUuidV4(String value) {
  if (!uuidV4Pattern.hasMatch(value)) {
    throw const CryptoException(
      CryptoError.encoding,
      'an identifier that is not a canonical lowercase UUIDv4',
    );
  }
  final raw = Uint8List(16);
  var index = 0;
  for (final part in value.split('-')) {
    for (var i = 0; i < part.length; i += 2) {
      raw[index++] = int.parse(part.substring(i, i + 2), radix: 16);
    }
  }
  return raw;
}

/// The canonical text of a raw UUIDv4's 16 bytes, dashes inserted in the order
/// of the hex digits (§0.2: "no byte-order change").
String encodeUuidV4(Uint8List raw) {
  if (raw.length != 16) {
    throw const CryptoException(CryptoError.length, 'a raw UUID is 16 bytes');
  }
  final hex = encodeHex(raw);
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

/// Refuses anything that is not a canonical lowercase UUIDv4.
void checkUuidV4(String value) => decodeUuidV4(value);
