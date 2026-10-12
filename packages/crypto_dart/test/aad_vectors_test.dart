/// `spec/crypto-vectors/aad-v1.json` — the canonical AAD of `spec/crypto.md` §2.
///
/// The AAD is the only thing that binds an envelope to its calendar, its event,
/// its override and its epoch, so every vector in the file matters: field order,
/// the `lp32` framing, one field changed at a time, and `RDATE`/`EXDATE` sitting
/// outside the AAD.
library;

import 'dart:typed_data';

import 'package:crypto_dart/crypto_dart.dart';
import 'package:test/test.dart';

import 'vectors.dart';

/// The one vector this package cannot satisfy as written.
///
/// `gen/generate.py` builds it as `dict(BASIC_AAD_INPUTS, calendar_id=
/// CALENDAR_ID.upper())`, and `CALENDAR_ID` is `11111111-1111-4111-8111-
/// 111111111111` — all digits, so `.upper()` is a no-op. Its `inputs` are
/// therefore byte-identical to the positive `aad-event-master` while its
/// `expected` demands `E_ENCODING`: no implementation can satisfy both. The
/// generator misses it because `build_aad` is not one of its `REFERENCE_RUNS`.
///
/// The library accepts those inputs (they *are* a canonical lowercase UUIDv4),
/// and `uppercase-calendar-id-refused` below is the check the vector meant to
/// pin.
const Set<String> _vectorsThatCannotAllHold = {
  'aad-calendar-id-uppercase-refused',
};

void main() {
  final vectors = loadVectors('aad-v1.json');
  reportVectors('aad-v1.json', vectors);

  group('aad-v1.json', () {
    test('the file is non-empty and every op is handled', () {
      expect(vectors, isNotEmpty);
      expect(vectors.map((vector) => vector.op).toSet(), {
        'build_aad',
        'constants',
      });
    });

    for (final vector in vectors) {
      if (_vectorsThatCannotAllHold.contains(vector.id)) {
        test('${vector.id} — accepted, see the note in this file', () {
          final reference = vectors.firstWhere(
            (other) => other.id == 'aad-event-master',
          );
          expect(
            vector.inputs,
            reference.inputs,
            reason: 'this vector duplicates a positive one',
          );
          expect(_hex(_aadOf(vector)), reference.expected['aad_hex']);
        });
        continue;
      }
      test('${vector.id} — ${vector.purpose}', () {
        switch (vector.op) {
          case 'build_aad':
            _buildAad(vector);
          case 'constants':
            _constants(vector);
          default:
            fail('${vector.id}: no test is wired for op ${vector.op}');
        }
      });
    }

    test('uppercase-calendar-id-refused — what that vector meant to pin', () {
      // §0.2: the canonical text form is lowercase, and a decoder MUST refuse
      // anything else.
      final skeleton = EventSkeleton(
        calendarId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        uid: '55555555-5555-4555-8555-555555555555',
        dtstart: 'zoned:Europe/Berlin@20260401T110000',
        end: 'zoned:Europe/Berlin@20260401T120000',
        rrule: 'none',
      );
      expectRefusal(
        CryptoError.encoding,
        () => skeleton.aad(1),
        'an uppercase calendar id',
      );
    });
  });
}

/// The AAD a `build_aad` vector's inputs describe.
Uint8List _aadOf(Vector vector) {
  final epoch = vector.integer('epoch');
  if (vector.inputs.containsKey('uid')) {
    return EventSkeleton(
      calendarId: vector.text('calendar_id'),
      uid: vector.text('uid'),
      dtstart: vector.text('dtstart'),
      end: vector.text('end'),
      rrule: vector.text('rrule'),
      recurrenceId: vector.text('recurrence_id'),
    ).aad(epoch);
  }
  return CalendarSkeleton(calendarId: vector.text('calendar_id')).aad(epoch);
}

void _buildAad(Vector vector) {
  if (vector.isNegative) {
    expectRefusal(
      vector.pinnedError,
      () => _aadOf(vector),
      '${vector.id} build_aad',
    );
    return;
  }
  final epoch = vector.integer('epoch');
  final expected = vector.expected;
  expect(
    _hex(_aadOf(vector)),
    expected['aad_hex'],
    reason: 'the exact AAD bytes',
  );

  // The framing claims in `expected` are what make the AAD unambiguous: the
  // label, then one length prefix per field, in order.
  final fields = expected['fields'];
  if (fields is List) {
    final label = expected['label'] as String? ?? eventAadLabel;
    final framed = frame(
      label,
      fields.map((field) => utf8Bytes(field as String)).toList(),
    );
    expect(_hex(framed), expected['aad_hex']);
  }
  final prefixes = expected['field_length_prefixes_hex'];
  if (prefixes is List && fields is List) {
    expect(prefixes.length, fields.length);
    for (var i = 0; i < fields.length; i++) {
      final length = utf8Bytes(fields[i] as String).length;
      expect(
        length.toRadixString(16).padLeft(8, '0'),
        prefixes[i],
        reason: 'the lp32 of field ${i + 1}',
      );
    }
  }
  final epochPrefix = expected['epoch_field_length_prefix_hex'];
  if (epochPrefix is String) {
    expect(
      epoch.toString().length.toRadixString(16).padLeft(8, '0'),
      epochPrefix,
    );
  }
  final uidPrefix = expected['uid_length_prefix_hex'];
  if (uidPrefix is String) {
    expect(
      utf8Bytes(vector.text('uid')).length.toRadixString(16).padLeft(8, '0'),
      uidPrefix,
      reason: 'a length prefix counts UTF-8 bytes',
    );
  }
  if (expected.containsKey('uid_utf8_bytes')) {
    expect(utf8Bytes(vector.text('uid')).length, expected['uid_utf8_bytes']);
  }
  // The skeleton-shaped vectors build the same AAD from parsed content lines.
  final properties = vector.inputs['skeleton_properties'];
  if (properties is List) {
    final fromSkeleton = EventSkeleton.fromProperties(
      calendarId: vector.text('calendar_id'),
      properties: properties.cast<String>(),
    );
    expect(_hex(fromSkeleton.aad(epoch)), expected['aad_hex']);
    expect(fromSkeleton.uid, vector.text('uid'));
    expect(fromSkeleton.recurrenceId, vector.text('recurrence_id'));
    expect(fromSkeleton.dtstart, vector.text('dtstart'));
    expect(fromSkeleton.end, vector.text('end'));
    expect(fromSkeleton.rrule, vector.text('rrule'));
  }
}

void _constants(Vector vector) {
  expect(_hex(utf8Bytes(eventAadLabel)), vector.inputs['event_label_hex']);
  expect(
    _hex(utf8Bytes(calendarMetadataAadLabel)),
    vector.inputs['meta_label_hex'],
  );
  final index = vector.expected['first_differing_index'] as int;
  final eventBytes = utf8Bytes(eventAadLabel);
  final metaBytes = utf8Bytes(calendarMetadataAadLabel);
  expect(
    eventBytes[index],
    isNot(metaBytes[index]),
    reason: 'byte $index is the whole separation between the two kinds',
  );
  expect(
    String.fromCharCode(eventBytes[index]),
    vector.expected['event_label_byte_8'],
  );
  expect(
    String.fromCharCode(metaBytes[index]),
    vector.expected['meta_label_byte_8'],
  );
  // The metadata AAD of the file's fixed calendar, epoch 1 (§2.3).
  expect(
    _hex(
      CalendarSkeleton(calendarId: '11111111-1111-4111-8111-111111111111')
          .aad(1),
    ),
    vector.inputs['meta_aad_hex'],
  );
}

String _hex(Uint8List bytes) {
  final out = StringBuffer();
  for (final byte in bytes) {
    out.write(byte.toRadixString(16).padLeft(2, '0'));
  }
  return out.toString();
}
