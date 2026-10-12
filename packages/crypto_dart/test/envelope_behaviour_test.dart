/// Behaviour the vectors cannot show: the public entry points, which draw their
/// own nonce, and the properties that hold across two envelopes rather than
/// inside one.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto_dart/crypto_dart.dart';
import 'package:test/test.dart';

import 'vectors.dart';

final cck = hexToBytes(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
);
final otherCck = hexToBytes(
  '7777777777777777777777777777777777777777777777777777777777777777',
);
const calendarId = '11111111-1111-4111-8111-111111111111';
const uid = '55555555-5555-4555-8555-555555555555';

final eventSkeleton = EventSkeleton(
  calendarId: calendarId,
  uid: uid,
  dtstart: 'zoned:Europe/Berlin@20260401T110000',
  end: 'zoned:Europe/Berlin@20260401T120000',
  rrule: 'none',
);

const eventPayload = <String, Object?>{
  '@type': 'Event',
  'description':
      'Invented test content — "quoted" \\ backslash, line\nbreak, Grüße 🙂',
  'priority': 5,
  'title': 'Physio (test value)',
};

void main() {
  group('the public seal/open path', () {
    test('sealEvent → openEvent round-trips the payload', () {
      final envelope = sealEvent(
        cck: cck,
        epoch: 3,
        skeleton: eventSkeleton,
        payload: eventPayload,
      );
      expect(
        envelope.length,
        envelopeFixedBytes + utf8.encode(jcsSerialise(eventPayload)).length,
      );
      final plain = openEvent(
        cck: cck,
        envelope: envelope,
        skeleton: eventSkeleton,
      );
      expect(jsonDecode(utf8.decode(plain)), eventPayload);
    });

    test('sealCalendarMetadata → openCalendarMetadata round-trips', () {
      const payload = <String, Object?>{
        '@type': 'Calendar',
        'color': '#3b82f6',
        'name': 'Privat (test value)',
      };
      final envelope = sealCalendarMetadata(
        cck: cck,
        epoch: 1,
        skeleton: const CalendarSkeleton(calendarId: calendarId),
        payload: payload,
      );
      final plain = openCalendarMetadata(
        cck: cck,
        envelope: envelope,
        skeleton: const CalendarSkeleton(calendarId: calendarId),
      );
      expect(jsonDecode(utf8.decode(plain)), payload);
    });

    test('every seal draws a fresh 24-byte nonce', () {
      // Nonce reuse under one key is a catastrophic failure (§1.2), so a hard-
      // coded or repeated nonce has to fail here.
      final nonces = <String>{};
      final envelopes = <String>{};
      for (var i = 0; i < 8; i++) {
        final envelope = sealEvent(
          cck: cck,
          epoch: 1,
          skeleton: eventSkeleton,
          payload: eventPayload,
        );
        nonces.add(_hex(Uint8List.sublistView(envelope, 5, 29)));
        envelopes.add(_hex(envelope));
      }
      expect(nonces.length, 8);
      expect(envelopes.length, 8);
    });

    test('the header carries version, epoch and nonce in order', () {
      final envelope = sealEvent(
        cck: cck,
        epoch: 2147483647,
        skeleton: eventSkeleton,
        payload: eventPayload,
      );
      expect(envelope[0], 0x01);
      expect(_hex(Uint8List.sublistView(envelope, 1, 5)), '7fffffff');
      // Everything after the 24-byte nonce is ciphertext plus the 16-byte tag.
      expect(
        envelope.length - envelopeFixedBytes,
        utf8.encode(jcsSerialise(eventPayload)).length,
      );
    });
  });

  group('what a refusal must never do', () {
    test(
      'a flipped tag bit, a wrong key and a changed AAD are one refusal',
      () {
        final envelope = sealEvent(
          cck: cck,
          epoch: 1,
          skeleton: eventSkeleton,
          payload: eventPayload,
        );
        final flipped = Uint8List.fromList(envelope);
        flipped[flipped.length - 1] ^= 0x01;
        final codes = <CryptoError>[
          _refusal(
            () =>
                openEvent(cck: cck, envelope: flipped, skeleton: eventSkeleton),
          ),
          _refusal(
            () => openEvent(
              cck: otherCck,
              envelope: envelope,
              skeleton: eventSkeleton,
            ),
          ),
          _refusal(
            () => openEvent(
              cck: cck,
              envelope: envelope,
              skeleton: EventSkeleton(
                calendarId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                uid: uid,
                dtstart: 'zoned:Europe/Berlin@20260401T110000',
                end: 'zoned:Europe/Berlin@20260401T120000',
                rrule: 'none',
              ),
            ),
          ),
          _refusal(
            () => openCalendarMetadata(
              cck: cck,
              envelope: envelope,
              skeleton: const CalendarSkeleton(calendarId: calendarId),
            ),
          ),
        ];
        expect(codes, everyElement(CryptoError.auth));
      },
    );

    test('a payload the format refuses is refused after the tag verifies', () {
      // An *authentic* envelope whose plaintext is not a valid payload is
      // E_PAYLOAD, not E_AUTH: §1.3's step 6 runs only after the tag verified,
      // and the two codes must stay distinguishable. The bytes come from the
      // frozen vector `envelope-open-payload-duplicate-member`.
      final vectors = loadVectors('envelope-v1.json');
      final duplicate = vectors.firstWhere(
        (vector) => vector.id == 'envelope-open-payload-duplicate-member',
      );
      expect(
        _refusal(
          () => openEvent(
            cck: duplicate.hex('cck_hex'),
            envelope: duplicate.hex('envelope_hex'),
            skeleton: EventSkeleton(
              calendarId: duplicate.text('calendar_id'),
              uid: duplicate.text('uid'),
              dtstart: duplicate.text('dtstart'),
              end: duplicate.text('end'),
              rrule: duplicate.text('rrule'),
              recurrenceId: duplicate.text('recurrence_id'),
            ),
          ),
        ),
        CryptoError.payload,
      );
    });

    test('a refusal carries no payload, and open returns nothing partial', () {
      final envelope = sealEvent(
        cck: cck,
        epoch: 1,
        skeleton: eventSkeleton,
        payload: eventPayload,
      );
      final flipped = Uint8List.fromList(envelope);
      flipped[envelope.length - 1] ^= 0x01;
      var returned = Uint8List(0);
      try {
        returned = openEvent(
          cck: cck,
          envelope: flipped,
          skeleton: eventSkeleton,
        );
      } on CryptoException catch (error) {
        expect(error.toString(), isNot(contains('Physio')));
        expect(error.detail ?? '', isNot(contains('Physio')));
      }
      expect(returned, isEmpty);
    });
  });

  group('the skeleton hash gate', () {
    test('the property must match the bytes about to be opened', () {
      final envelope = sealEvent(
        cck: cck,
        epoch: 1,
        skeleton: eventSkeleton,
        payload: eventPayload,
      );
      final digest = envelopeSha256Hex(envelope);
      verifyEnvelopeSha256(propertyValue: digest, envelope: envelope);
      expect(digest, matches(RegExp(r'^[0-9a-f]{64}$')));
      expect(
        _refusal(
          () => verifyEnvelopeSha256(
            propertyValue: '${digest.substring(0, 63)}0',
            envelope: envelope,
          ),
        ),
        CryptoError.skeleton,
      );
    });
  });

  group('the payload rules that are not the vectors\u2019', () {
    test('an empty calendar name is refused', () {
      expect(
        _refusal(
          () => serialisePayload(const {
            '@type': 'Calendar',
            'color': '#3b82f6',
            'name': '',
          }, PayloadKind.calendar),
        ),
        CryptoError.payload,
      );
    });

    test(
      'a bounded but oversized metadata payload is E_LENGTH, not E_PAYLOAD',
      () {
        // The frozen vector `metadata-seal-over-4096-refused` pins this order: the
        // payload's *shape* is checked, then the envelope's size, then the §4.3
        // `name`/`color` values.
        final name = 'x' * 4200;
        expect(
          _refusal(
            () => sealCalendarMetadata(
              cck: cck,
              epoch: 1,
              skeleton: const CalendarSkeleton(calendarId: calendarId),
              payload: {'@type': 'Calendar', 'color': '#3b82f6', 'name': name},
            ),
          ),
          CryptoError.length,
        );
      },
    );

    test('a bounded metadata payload with a bad colour is E_PAYLOAD', () {
      expect(
        _refusal(
          () => sealCalendarMetadata(
            cck: cck,
            epoch: 1,
            skeleton: const CalendarSkeleton(calendarId: calendarId),
            payload: const {
              '@type': 'Calendar',
              'color': '#3B82F6',
              'name': 'Privat',
            },
          ),
        ),
        CryptoError.payload,
      );
    });

    test('the epoch range is checked before anything is sealed', () {
      expect(
        _refusal(
          () => sealEvent(
            cck: cck,
            epoch: 2147483648,
            skeleton: eventSkeleton,
            payload: eventPayload,
          ),
        ),
        CryptoError.epoch,
      );
    });
  });
}

CryptoError _refusal(void Function() body) {
  try {
    body();
    throw StateError('expected a refusal');
  } on CryptoException catch (error) {
    return error.error;
  }
}

String _hex(Uint8List bytes) {
  final out = StringBuffer();
  for (final byte in bytes) {
    out.write(byte.toRadixString(16).padLeft(2, '0'));
  }
  return out.toString();
}
