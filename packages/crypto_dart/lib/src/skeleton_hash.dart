/// `X-CALFLEX-ENVELOPE-SHA256`, `spec/crypto.md` §5.1 (D-06).
///
/// The property carries the SHA-256 of the **complete envelope bytes** — offset 0
/// through the last tag byte — as 64 lowercase hex digits. It is the read gate:
/// a client **MUST NOT** open an envelope before it has compared the property
/// against the bytes, because that is the only defence against a server that
/// serves the older envelope after a crash between the sidecar insert and the
/// skeleton `PUT`.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;

import 'errors.dart';

/// The skeleton property that carries the hash.
const String envelopeSha256Property = 'X-CALFLEX-ENVELOPE-SHA256';

final RegExp _lowerHex64 = RegExp(r'^[0-9a-f]{64}$');

/// The §5.1 text form of an envelope's digest: 64 lowercase hex digits.
String envelopeSha256Hex(Uint8List envelope) =>
    crypto.sha256.convert(envelope).toString();

/// Checks [propertyValue] against [envelope], refusing `E_SKELETON`.
///
/// Missing property, wrong length, uppercase or non-hex is `E_SKELETON`, as is a
/// digest that does not match: the property is the one thing that ties the
/// skeleton to the bytes about to be opened.
void verifyEnvelopeSha256({
  required String propertyValue,
  required Uint8List envelope,
}) {
  if (!_lowerHex64.hasMatch(propertyValue)) {
    throw const CryptoException(
      CryptoError.skeleton,
      'X-CALFLEX-ENVELOPE-SHA256 must be 64 lowercase hex digits',
    );
  }
  final expected = envelopeSha256Hex(envelope);
  if (!_constantTimeEquals(propertyValue, expected)) {
    throw const CryptoException(
      CryptoError.skeleton,
      'X-CALFLEX-ENVELOPE-SHA256 does not match these envelope bytes',
    );
  }
}

bool _constantTimeEquals(String a, String b) {
  if (a.length != b.length) return false;
  var difference = 0;
  for (var i = 0; i < a.length; i++) {
    difference |= a.codeUnitAt(i) ^ b.codeUnitAt(i);
  }
  return difference == 0;
}

/// The hex-encoded bytes of a SHA-256 digest, as `event_envelopes.envelope_sha256`
/// stores them (§5.1).
Uint8List envelopeSha256(Uint8List envelope) =>
    Uint8List.fromList(crypto.sha256.convert(envelope).bytes);

/// The bytes of a §5.1 property value, refusing a non-canonical text form.
Uint8List decodeEnvelopeSha256(String propertyValue) {
  if (!_lowerHex64.hasMatch(propertyValue)) {
    throw const CryptoException(
      CryptoError.skeleton,
      'X-CALFLEX-ENVELOPE-SHA256 must be 64 lowercase hex digits',
    );
  }
  final out = Uint8List(32);
  for (var i = 0; i < 32; i++) {
    out[i] = int.parse(propertyValue.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

/// The UTF-8 bytes of a text property, for a caller that keeps the skeleton as
/// bytes. Kept here so the package has one place that touches the property.
Uint8List utf8Bytes(String value) => Uint8List.fromList(utf8.encode(value));
