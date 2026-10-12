/// `spec/crypto-vectors/identity-v1.json` — identity fingerprints, safety numbers
/// and the verification payload of `spec/crypto.md` §6.8 (D-15).
///
/// The display forms are pinned here too: the fingerprint's eight groups of eight
/// hex digits and the safety number's twelve groups of five digits are what a user
/// reads aloud, so a library that computes the right value and prints it wrong is
/// still wrong.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:crypto_dart/crypto_dart.dart';
import 'package:test/test.dart';

import 'vectors.dart';

void main() {
  final vectors = loadVectors('identity-v1.json');
  reportVectors('identity-v1.json', vectors);

  for (final vector in vectors) {
    test('${vector.id} — ${vector.purpose}', () {
      switch (vector.op) {
        case 'fingerprint':
          final x25519PublicKey = vector.hex('x25519_pk_hex');
          final ed25519PublicKey = vector.hex('ed25519_pk_hex');
          final computed = fingerprint(
            x25519PublicKey: x25519PublicKey,
            ed25519PublicKey: ed25519PublicKey,
          );
          final hex = encodeHex(computed);
          expect(hex, vector.expected['fingerprint_hex']);
          expect(hex.length, fingerprintBytes * 2);
          final digits = vector.expected['hex_digits'];
          if (digits != null) expect(hex.length, digits);
          final grouped = vector.expected['grouped'];
          if (grouped != null) expect(groupFingerprint(hex), grouped);
          final label = vector.expected['label'];
          if (label != null) expect(label, fingerprintLabel);
          // §6.8's message: the label and both keys, concatenated — no framing.
          final message = vector.expected['message_hex'];
          if (message != null) {
            expect(
              encodeHex(
                Uint8List.fromList([
                  ...utf8.encode(fingerprintLabel),
                  ...x25519PublicKey,
                  ...ed25519PublicKey,
                ]),
              ),
              message,
            );
          }
          expect(
            fingerprintHex(
              x25519PublicKey: x25519PublicKey,
              ed25519PublicKey: ed25519PublicKey,
            ),
            vector.expected['fingerprint_hex'],
          );
        case 'safety_number':
          final number = safetyNumber(
            firstFingerprint: vector.hex('first_fingerprint_hex'),
            secondFingerprint: vector.hex('second_fingerprint_hex'),
          );
          expect(number, vector.expected['safety_number']);
          expect(number.length, safetyNumberDigits);
          final digits = vector.expected['digits'];
          if (digits != null) expect(number.length, digits);
          final grouped = vector.expected['grouped'];
          if (grouped != null) expect(groupSafetyNumber(number), grouped);
        case 'verify_uri':
          final uri = verifyUri(
            userId: vector.text('user_id'),
            x25519PublicKey: vector.hex('x25519_pk_hex'),
            ed25519PublicKey: vector.hex('ed25519_pk_hex'),
          );
          expect(uri, vector.expected['uri']);
          expect(utf8.encode(uri).length, vector.expected['ascii_bytes']);
          expect(uri.codeUnits.every((unit) => unit < 128), isTrue);
        case 'parse_verify_uri':
          if (vector.isPositive) {
            final parsed = parseVerifyUri(vector.text('uri'));
            expect(parsed.userId, vector.expected['user_id']);
            expect(
              encodeHex(parsed.ed25519PublicKey),
              vector.expected['ed25519_pk_hex'],
            );
            expect(
              encodeHex(parsed.x25519PublicKey),
              vector.expected['x25519_pk_hex'],
            );
            expect(parsed.fingerprintHex, vector.expected['fingerprint_hex']);
          } else {
            expectRefusal(
              vector.pinnedError,
              () => parseVerifyUri(vector.text('uri')),
              vector.id,
            );
          }
        default:
          throw StateError('${vector.id}: no handler for op ${vector.op}');
      }
    });
  }

  test('a substituted sealing key changes the fingerprint (D-15)', () {
    final x25519PublicKey = hexToBytes(
      '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13',
    );
    final ed25519PublicKey = hexToBytes(
      'a09aa5f47a6759802ff955f8dc2d2a14a5c99d23be97f864127ff9383455a4f0',
    );
    final substituted = Uint8List.fromList([
      ...x25519PublicKey.sublist(0, 31),
      0x00,
    ]);
    expect(
      fingerprintHex(
        x25519PublicKey: x25519PublicKey,
        ed25519PublicKey: ed25519PublicKey,
      ),
      isNot(
        fingerprintHex(
          x25519PublicKey: substituted,
          ed25519PublicKey: ed25519PublicKey,
        ),
      ),
    );
  });

  test('two identical fingerprints are hashed as the same value twice', () {
    // §6.8: "Two identical fingerprints (the same user's two screens) are hashed as
    // the same value twice." Composed here from the label and the digest directly,
    // so a library that deduplicated them (or hashed one) fails.
    final fp = hexToBytes(
      '60570e7d0a49224003cfc8640d7286d3bef9196f76721e5329decb9122f8f71b',
    );
    final digest = sha256
        .convert(
          Uint8List.fromList([...utf8.encode(safetyNumberLabel), ...fp, ...fp]),
        )
        .bytes;
    var value = BigInt.zero;
    for (final byte in digest) {
      value = (value << 8) | BigInt.from(byte);
    }
    expect(
      safetyNumber(firstFingerprint: fp, secondFingerprint: fp),
      (value % BigInt.from(10).pow(safetyNumberDigits)).toString().padLeft(
        safetyNumberDigits,
        '0',
      ),
    );
  });
}
