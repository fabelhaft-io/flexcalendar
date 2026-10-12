/// `spec/crypto-vectors/envelope-v1.json` — the envelope of `spec/crypto.md` §1
/// and the skeleton hash of §5.1.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto_dart/crypto_dart.dart';
import 'package:crypto_dart/src/envelope.dart' show sealEventWithNonce;
import 'package:test/test.dart';

import 'vectors.dart';

/// The event skeleton a vector's `inputs` describes.
EventSkeleton eventSkeletonOf(Vector vector) => EventSkeleton(
  calendarId: vector.text('calendar_id'),
  uid: vector.text('uid'),
  dtstart: vector.text('dtstart'),
  end: vector.text('end'),
  rrule: vector.text('rrule'),
  recurrenceId: recurrenceInput(vector),
);

void main() {
  final vectors = loadVectors('envelope-v1.json');
  reportVectors('envelope-v1.json', vectors);

  group('envelope-v1.json', () {
    test('the file is non-empty and every op is handled', () {
      expect(vectors, isNotEmpty);
      final ops = vectors.map((vector) => vector.op).toSet();
      expect(ops, {'seal_event', 'open_event', 'skeleton_hash'});
    });

    for (final vector in vectors) {
      test('${vector.id} — ${vector.purpose}', () {
        switch (vector.op) {
          case 'seal_event':
            _sealEvent(vector);
          case 'open_event':
            _openEvent(vector);
          case 'skeleton_hash':
            _skeletonHash(vector);
          default:
            fail('${vector.id}: no test is wired for op ${vector.op}');
        }
      });
    }
  });
}

void _sealEvent(Vector vector) {
  final skeleton = eventSkeletonOf(vector);
  final payload = vector.payloadObject();
  final epoch = vector.integer('epoch');
  Uint8List seal() => sealEventWithNonce(
    cck: vector.hex('cck_hex'),
    epoch: epoch,
    skeleton: skeleton,
    payload: payload,
    nonce: vector.hex('nonce_hex'),
  );

  if (vector.isNegative) {
    expectRefusal(vector.pinnedError, seal, '${vector.id} seal_event');
    return;
  }
  final envelope = seal();
  expect(
    utf8.decode(envelope, allowMalformed: true),
    isNot(contains('Physio')),
    reason: 'the envelope must not carry the plaintext',
  );
  if (vector.expected.containsKey('aad_hex')) {
    expect(
      _hex(skeleton.aad(epoch)),
      vector.expected['aad_hex'],
      reason: 'the AAD of §2.2',
    );
  }
  if (vector.expected.containsKey('envelope_hex')) {
    expect(_hex(envelope), vector.expected['envelope_hex']);
  }
  if (vector.expected.containsKey('envelope_bytes')) {
    expect(envelope.length, vector.expected['envelope_bytes']);
  }
  if (vector.expected.containsKey('epoch_field_hex')) {
    expect(
      _hex(Uint8List.sublistView(envelope, 1, 5)),
      vector.expected['epoch_field_hex'],
    );
  }
  if (vector.expected.containsKey('envelope_sha256_hex')) {
    expect(envelopeSha256Hex(envelope), vector.expected['envelope_sha256_hex']);
  }
  if (vector.expected.containsKey('payload_jcs')) {
    expect(utf8.decode(jcsEncode(payload)), vector.expected['payload_jcs']);
  }
}

void _openEvent(Vector vector) {
  final skeleton = eventSkeletonOf(vector);
  final envelope = vector.hex('envelope_hex');
  Uint8List open() => openEvent(
    cck: vector.hex('cck_hex'),
    envelope: envelope,
    skeleton: skeleton,
  );

  if (vector.isNegative) {
    expectRefusal(vector.pinnedError, open, '${vector.id} open_event');
    return;
  }
  final payload = open();
  final jcs = vector.expected['payload_jcs'];
  if (jcs is String) {
    expect(utf8.decode(payload), jcs);
  }
  final object = vector.expected['payload_object'];
  if (object != null) {
    expect(
      jsonDecode(utf8.decode(payload)),
      object,
      reason: 'the payload is exactly the object that was sealed',
    );
  }
}

void _skeletonHash(Vector vector) {
  if (vector.isNegative) {
    // §5.1: a missing property, a wrong length, uppercase or non-hex is
    // E_SKELETON — refused before any envelope is opened.
    final propertyValue = vector.text('property_value');
    expectRefusal(
      vector.pinnedError,
      () => verifyEnvelopeSha256(
        propertyValue: propertyValue,
        envelope: Uint8List(0),
      ),
      '${vector.id} skeleton_hash',
    );
    return;
  }
  final envelope = vector.hex('envelope_hex');
  final expected = vector.expected;
  final hex = envelopeSha256Hex(envelope);
  if (expected.containsKey('envelope_sha256_hex')) {
    expect(hex, expected['envelope_sha256_hex']);
  }
  if (expected.containsKey('hex_digits')) {
    expect(hex.length, expected['hex_digits']);
  }
  if (expected.containsKey('lowercase')) {
    expect(hex, hex.toLowerCase());
  }
  // The property carries that digest: a value that matches these bytes has to be
  // accepted, or §5.1's gate would refuse a good envelope.
  verifyEnvelopeSha256(propertyValue: hex, envelope: envelope);
}

String _hex(Uint8List bytes) {
  final out = StringBuffer();
  for (final byte in bytes) {
    out.write(byte.toRadixString(16).padLeft(2, '0'));
  }
  return out.toString();
}
