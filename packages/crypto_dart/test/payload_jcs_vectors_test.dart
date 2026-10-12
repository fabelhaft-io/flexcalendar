/// `spec/crypto-vectors/payload-jcs-v1.json` — the payload of `spec/crypto.md`
/// §4: JCS serialisation and the member rules of both payload kinds.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto_dart/crypto_dart.dart';
import 'package:test/test.dart';

import 'vectors.dart';

void main() {
  final vectors = loadVectors('payload-jcs-v1.json');
  reportVectors('payload-jcs-v1.json', vectors);

  group('payload-jcs-v1.json', () {
    test('the file is non-empty and every op is handled', () {
      expect(vectors, isNotEmpty);
      expect(vectors.map((vector) => vector.op).toSet(), {
        'jcs_dumps',
        'validate_payload',
      });
    });

    for (final vector in vectors) {
      test('${vector.id} — ${vector.purpose}', () {
        switch (vector.op) {
          case 'jcs_dumps':
            _jcsDumps(vector);
          case 'validate_payload':
            _validatePayload(vector);
          default:
            fail('${vector.id}: no test is wired for op ${vector.op}');
        }
      });
    }
  });
}

void _jcsDumps(Vector vector) {
  final object = vector.inputs['object'];
  expect(utf8.decode(jcsEncode(object)), vector.expected['jcs']);
}

void _validatePayload(Vector vector) {
  final kind = vector.text('payload_kind') == 'event'
      ? PayloadKind.event
      : PayloadKind.calendar;
  // A `payload_text` or `payload_hex` input is raw bytes a JSON *object* cannot
  // express (a duplicate member name, a member order that is valid JSON but not
  // JCS, a byte string that is not UTF-8 at all).
  Uint8List bytes() {
    final text = vector.inputs['payload_text'];
    if (text is String) return utf8Bytes(text);
    final hex = vector.inputs['payload_hex'];
    if (hex is String) return hexToBytes(hex);
    return jcsEncode(vector.inputs['payload_object']);
  }

  // The sealing path serialises the object itself, so where the vector gives an
  // object the two entry points are checked against each other.
  final object = vector.inputs['payload_object'];
  final canSerialise = object is Map<String, Object?>;

  if (vector.isNegative) {
    expectRefusal(
      vector.pinnedError,
      () => validatePayload(bytes(), kind),
      '${vector.id} validate_payload',
    );
    if (canSerialise) {
      expectRefusal(
        vector.pinnedError,
        () => serialisePayload(object, kind),
        '${vector.id} serialisePayload',
      );
    }
    return;
  }
  final payload = bytes();
  final expected = vector.expected['jcs'];
  if (expected is String) {
    expect(utf8.decode(payload), expected, reason: 'the JCS bytes');
  }
  if (canSerialise) {
    expect(_hex(serialisePayload(object, kind)), _hex(payload));
  }
  expect(validatePayload(payload, kind), isA<Map<String, Object?>>());
}

String _hex(Uint8List bytes) {
  final out = StringBuffer();
  for (final byte in bytes) {
    out.write(byte.toRadixString(16).padLeft(2, '0'));
  }
  return out.toString();
}
