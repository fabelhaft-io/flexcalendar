/// The structured recurrence id of `spec/crypto.md` §5.2: the value the API
/// reports for an occurrence, and the canonical `recurrence_id` the AAD binds.
///
/// The frozen timing vectors pin §5.2's answers for the four shapes a stored
/// object can spell. What they cannot show is the mapping the library performs on
/// the way in — the API's `date`/`utc`/`local`+`tzid` object (E05) — so the two
/// DST answers of §3.4 and the refuse-don't-guess cases are pinned here.
library;

import 'package:crypto_dart/crypto_dart.dart';
import 'package:test/test.dart';

void main() {
  group('the master', () {
    test('no recurrence id at all is the empty §5.2 value', () {
      expect(canonicalRecurrenceId(null), '');
    });
  });

  group('an all-day occurrence', () {
    test('the API spells a date YYYY-MM-DD; §5.2 wants eight digits', () {
      expect(
        canonicalRecurrenceId(const RecurrenceId.date('2026-04-01')),
        '20260401',
      );
      expect(
        canonicalRecurrenceId(const RecurrenceId.date('2026-12-31')),
        '20261231',
      );
    });

    test(
      'a date in the compact form is refused rather than passed through',
      () {
        // The API never spells it this way, and accepting both spellings would put
        // two values into the sidecar key for one occurrence.
        expect(
          _refusal(
            () => canonicalRecurrenceId(const RecurrenceId.date('20260401')),
          ),
          CryptoError.skeleton,
        );
      },
    );

    test('a date that is not a date is refused', () {
      for (final value in ['2026-02-30', '2026-13-01', '2026-04-00', '']) {
        expect(
          _refusal(() => canonicalRecurrenceId(RecurrenceId.date(value))),
          CryptoError.skeleton,
          reason: value,
        );
      }
    });
  });

  group('a timed occurrence', () {
    test('an instant is kept exactly as reported', () {
      expect(
        canonicalRecurrenceId(const RecurrenceId.utc('20260401T090000Z')),
        '20260401T090000Z',
      );
    });

    test('a wall clock beside its zone converts to UTC', () {
      expect(
        canonicalRecurrenceId(
          const RecurrenceId.local('20260401T110000', tzid: 'Europe/Berlin'),
        ),
        '20260401T090000Z',
      );
      expect(
        canonicalRecurrenceId(
          const RecurrenceId.local('20260401T153000', tzid: 'Asia/Calcutta'),
        ),
        '20260401T100000Z',
        reason: 'a link name resolves as itself',
      );
    });

    test('a spring-forward gap is read with the offset before the gap', () {
      // §3.4: RFC 5545 §3.3.5 form 3. The frozen timing vector
      // `timing-dst-europe-berlin-spring-skipped` pins the same answer, and its
      // `ical_js_note` records that another library reads it as `…T003000Z`.
      expect(
        canonicalRecurrenceId(
          const RecurrenceId.local('20260329T023000', tzid: 'Europe/Berlin'),
        ),
        '20260329T013000Z',
      );
    });

    test('an autumn overlap refers to the first occurrence', () {
      expect(
        canonicalRecurrenceId(
          const RecurrenceId.local('20261025T023000', tzid: 'Europe/Berlin'),
        ),
        '20261025T003000Z',
      );
    });

    test('a wall clock with no zone is refused, never read as UTC', () {
      expect(
        _refusal(
          () => canonicalRecurrenceId(
            const RecurrenceId.local('20260401T110000'),
          ),
        ),
        CryptoError.skeleton,
      );
    });

    test('a zone the database does not know is refused', () {
      expect(
        _refusal(
          () => canonicalRecurrenceId(
            const RecurrenceId.local('20260401T110000', tzid: 'Mars/Olympus'),
          ),
        ),
        CryptoError.skeleton,
      );
    });

    test('an instant that does not end in Z is refused', () {
      expect(
        _refusal(
          () =>
              canonicalRecurrenceId(const RecurrenceId.utc('20260401T090000')),
        ),
        CryptoError.skeleton,
      );
    });
  });

  group('the API\u2019s object', () {
    test('reads the three shapes an occurrence is reported in', () {
      expect(
        canonicalRecurrenceId(
          RecurrenceId.fromJson(const {'date': '2026-04-01'}),
        ),
        '20260401',
      );
      expect(
        canonicalRecurrenceId(
          RecurrenceId.fromJson(const {'utc': '20260401T090000Z'}),
        ),
        '20260401T090000Z',
      );
      expect(
        canonicalRecurrenceId(
          RecurrenceId.fromJson(const {
            'local': '20260401T110000',
            'tzid': 'Europe/Berlin',
          }),
        ),
        '20260401T090000Z',
      );
      expect(RecurrenceId.fromJson(const {'date': '2026-04-01'}).tzid, isNull);
    });

    test('a zoned occurrence is read from its wall clock, not its instant', () {
      // The API reports all three fields. §3.4's answer for a gap is NOT the
      // instant such an object also carries (see the frozen vector's
      // `ical_js_note`), so the wall clock and the zone have to decide — and the
      // AAD has to be a function of the stored object's own fields.
      final gap = RecurrenceId.fromJson(const {
        'local': '20260329T023000',
        'tzid': 'Europe/Berlin',
        'utc': '20260329T003000Z',
      });
      expect(canonicalRecurrenceId(gap), '20260329T013000Z');
    });

    test('a local reading with no zone is the floating shape', () {
      expect(
        _refusal(
          () => canonicalRecurrenceId(
            RecurrenceId.fromJson(const {'local': '20260401T110000'}),
          ),
        ),
        CryptoError.skeleton,
      );
    });

    test('an object with none of the three fields is refused', () {
      expect(
        _refusal(() => RecurrenceId.fromJson(const {})),
        CryptoError.skeleton,
      );
      expect(
        _refusal(() => RecurrenceId.fromJson(const {'utc': 20260401})),
        CryptoError.skeleton,
      );
    });
  });

  group('the AAD', () {
    EventSkeleton skeletonWith(RecurrenceId id) => EventSkeleton(
      calendarId: '11111111-1111-4111-8111-111111111111',
      uid: '55555555-5555-4555-8555-555555555555',
      dtstart: 'zoned:Europe/Berlin@20260401T110000',
      end: 'zoned:Europe/Berlin@20260401T120000',
      rrule: 'none',
      recurrenceId: id,
    );

    final master = EventSkeleton(
      calendarId: '11111111-1111-4111-8111-111111111111',
      uid: '55555555-5555-4555-8555-555555555555',
      dtstart: 'zoned:Europe/Berlin@20260401T110000',
      end: 'zoned:Europe/Berlin@20260401T120000',
      rrule: 'none',
    ).aad(1);

    test('two spellings of one occurrence give one AAD', () {
      // D-14's whole point: an override's envelope cannot be opened as the
      // master's or as another override's, so one occurrence has to have one
      // canonical value whichever way its stored object spells it.
      final zoned = skeletonWith(
        const RecurrenceId.local('20260401T110000', tzid: 'Europe/Berlin'),
      ).aad(1);
      final instant = skeletonWith(const RecurrenceId.utc('20260401T090000Z'))
          .aad(1);
      expect(zoned, instant, reason: 'field 3 is the same canonical value');
      expect(zoned, isNot(master), reason: 'a master binds an empty field 3');
    });

    test('another override is a different AAD', () {
      expect(
        master,
        isNot(skeletonWith(const RecurrenceId.utc('20260901T090000Z')).aad(1)),
      );
      expect(
        skeletonWith(const RecurrenceId.utc('20260401T090000Z')).aad(1),
        isNot(skeletonWith(const RecurrenceId.utc('20260901T090000Z')).aad(1)),
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
