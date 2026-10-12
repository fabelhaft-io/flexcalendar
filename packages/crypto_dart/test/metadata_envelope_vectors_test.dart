/// `spec/crypto-vectors/metadata-envelope-v1.json` — the calendar-metadata
/// envelope of `spec/crypto.md` §1.4 and §4.3 (D-18).
///
/// A Private calendar's name and colour are sealed under the CCK, so the server
/// stores only opaque bytes; the two envelope kinds are told apart by the AAD
/// label and nothing else, which is what `metadata-open-as-event` and
/// `event-open-as-metadata` pin.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto_dart/crypto_dart.dart';
import 'package:crypto_dart/src/envelope.dart'
    show sealCalendarMetadataWithNonce;
import 'package:test/test.dart';

import 'vectors.dart';

void main() {
  final vectors = loadVectors('metadata-envelope-v1.json');
  reportVectors('metadata-envelope-v1.json', vectors);

  group('metadata-envelope-v1.json', () {
    test('the file is non-empty and every op is handled', () {
      expect(vectors, isNotEmpty);
      expect(vectors.map((vector) => vector.op).toSet(), {
        'seal_metadata',
        'open_metadata',
        'build_aad',
      });
    });

    for (final vector in vectors) {
      test('${vector.id} — ${vector.purpose}', () {
        switch (vector.op) {
          case 'seal_metadata':
            _seal(vector);
          case 'open_metadata':
            _open(vector);
          case 'build_aad':
            expect(
              _hex(
                CalendarSkeleton(calendarId: vector.text('calendar_id'))
                    .aad(vector.integer('epoch')),
              ),
              vector.expected['aad_hex'],
            );
          default:
            fail('${vector.id}: no test is wired for op ${vector.op}');
        }
      });
    }
  });
}

void _seal(Vector vector) {
  final epoch = vector.integer('epoch');
  final skeleton = CalendarSkeleton(calendarId: vector.text('calendar_id'));
  final payload = vector.payloadObject();
  Uint8List seal() => sealCalendarMetadataWithNonce(
    cck: vector.hex('cck_hex'),
    epoch: epoch,
    skeleton: skeleton,
    payload: payload,
    nonce: vector.hex('nonce_hex'),
  );

  if (vector.isNegative) {
    expectRefusal(vector.pinnedError, seal, '${vector.id} seal_metadata');
    return;
  }
  final envelope = seal();
  final expected = vector.expected;
  if (expected.containsKey('aad_hex')) {
    expect(_hex(skeleton.aad(epoch)), expected['aad_hex']);
  }
  if (expected.containsKey('envelope_hex')) {
    expect(_hex(envelope), expected['envelope_hex']);
  }
  if (expected.containsKey('envelope_bytes')) {
    expect(envelope.length, expected['envelope_bytes']);
  }
  if (expected.containsKey('envelope_sha256_hex')) {
    expect(envelopeSha256Hex(envelope), expected['envelope_sha256_hex']);
  }
  if (expected.containsKey('payload_jcs')) {
    expect(utf8.decode(jcsEncode(payload)), expected['payload_jcs']);
  }
}

void _open(Vector vector) {
  final envelope = vector.hex('envelope_hex');
  final cck = vector.hex('cck_hex');
  // `metadata-open-as-event` is the metadata envelope opened with the *event*
  // AAD: its inputs carry the whole event skeleton.
  final asEvent = vector.inputs.containsKey('uid');
  Uint8List open() => asEvent
      ? openEvent(
          cck: cck,
          envelope: envelope,
          skeleton: EventSkeleton(
            calendarId: vector.text('calendar_id'),
            uid: vector.text('uid'),
            dtstart: vector.text('dtstart'),
            end: vector.text('end'),
            rrule: vector.text('rrule'),
            recurrenceId: recurrenceInput(vector),
          ),
        )
      : openCalendarMetadata(
          cck: cck,
          envelope: envelope,
          skeleton: CalendarSkeleton(calendarId: vector.text('calendar_id')),
        );

  if (vector.isNegative) {
    expectRefusal(vector.pinnedError, open, '${vector.id} open_metadata');
    return;
  }
  final payload = open();
  final jcs = vector.expected['payload_jcs'];
  if (jcs is String) {
    expect(utf8.decode(payload), jcs);
  }
  final object = vector.expected['payload_object'];
  if (object != null) {
    expect(jsonDecode(utf8.decode(payload)), object);
  }
}

String _hex(Uint8List bytes) {
  final out = StringBuffer();
  for (final byte in bytes) {
    out.write(byte.toRadixString(16).padLeft(2, '0'));
  }
  return out.toString();
}
