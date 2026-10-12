// The three API time shapes → the domain's event time (E10-R04).

import 'package:calendar_flex/api/models/event_time.dart' as api;
import 'package:calendar_flex/api/models/occurrence_time.dart' as api;
import 'package:calendar_flex/src/domain/time/api_event_time.dart';
import 'package:calendar_flex/src/domain/time/event_time.dart';
import 'package:calendar_flex/src/domain/time/zones.dart';
import 'package:calendar_flex/src/timezones.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  setUpAll(initializeAppTimeZones);

  group('the three shapes', () {
    test('{date} is a day, and has no instant', () {
      final time = eventTimeFromApi(date: '2026-03-29');
      expect(time, isA<AllDayDate>());
      final date = time as AllDayDate;
      expect([date.year, date.month, date.day], [2026, 3, 29]);
      expect(date.format(), '2026-03-29');
      expect(date.nextDay.format(), '2026-03-30');
      expect(
        time.instantOrNull,
        isNull,
        reason: 'INV-04: a day is not an instant',
      );
    });

    test('{utc} is the instant the API sent', () {
      final time = eventTimeFromApi(utc: '20260329T073000Z');
      expect(time, isA<ZonedTime>());
      final zoned = time as ZonedTime;
      expect(zoned.tzid, isNull);
      expect(formatUtcInstant(zoned.instant.toUtc()), '20260329T073000Z');
      expect(zoned.zoneKnown, isTrue);
    });

    test('{local, tzid} gets RFC 5545 § 3.3.5\'s answer', () {
      final gap = eventTimeFromApi(
        local: '20260329T023000',
        tzid: 'Europe/Berlin',
      ) as ZonedTime;
      expect(formatUtcInstant(gap.instant.toUtc()), '20260329T013000Z');
      expect(gap.tzid, 'Europe/Berlin');
      expect(gap.zoneKnown, isTrue);

      final repeated = eventTimeFromApi(
        local: '20261025T023000',
        tzid: 'Europe/Berlin',
      ) as ZonedTime;
      expect(formatUtcInstant(repeated.instant.toUtc()), '20261025T003000Z');
    });

    test('a {local, tzid, utc} read takes the API\'s instant, not a new one', () {
      // The API's zone data is Node's ICU (tz 2026b) and this build's is the
      // `timezone` package's (tz 2026e), so a value the server already resolved
      // is never recomputed (from-E05-R09).
      final time = eventTimeFromApi(
        local: '20260329T023000',
        tzid: 'Europe/Berlin',
        utc: '20260329T013000Z',
      ) as ZonedTime;
      expect(formatUtcInstant(time.instant.toUtc()), '20260329T013000Z');
      // A deliberately different instant still wins over local + tzid.
      final other = eventTimeFromApi(
        local: '20260329T023000',
        tzid: 'Europe/Berlin',
        utc: '20260329T020000Z',
      ) as ZonedTime;
      expect(formatUtcInstant(other.instant.toUtc()), '20260329T020000Z');
    });

    test('a link name is a zone; the wall clock is still read', () {
      final calcutta = eventTimeFromApi(
        local: '20260329T090000',
        tzid: 'Asia/Calcutta',
      ) as ZonedTime;
      expect(calcutta.zoneKnown, isTrue);
      expect(formatUtcInstant(calcutta.instant.toUtc()), '20260329T033000Z');
      expect(calcutta.tzid, 'Asia/Calcutta');
    });

    test('an unknown TZID keeps the wall clock, flagged', () {
      final unknown = eventTimeFromApi(
        local: '20260329T090000',
        tzid: 'Foo/Bar',
      ) as ZonedTime;
      expect(unknown.zoneKnown, isFalse);
      expect(unknown.tzid, 'Foo/Bar');
      // Read as UTC rather than dropped: the UI says the zone is unknown.
      expect(formatUtcInstant(unknown.instant.toUtc()), '20260329T090000Z');
    });

    test('a floating local time is refused (INV-04)', () {
      expect(
        () => eventTimeFromApi(local: '20260329T090000'),
        throwsFormatException,
      );
      expect(() => eventTimeFromApi(), throwsFormatException);
      expect(
        () => eventTimeFromApi(date: '2026-03-29', local: '20260329T090000'),
        throwsFormatException,
      );
      expect(
        () => eventTimeFromApi(tzid: 'Europe/Berlin'),
        throwsFormatException,
      );
      expect(() => eventTimeFromApi(date: '2026-02-30'), throwsFormatException);
    });

    test('a leap second is refused, not normalised', () {
      expect(
        () => eventTimeFromApi(utc: '20261231T235960Z'),
        throwsFormatException,
      );
    });
  });

  group('the write shape', () {
    test('a zoned value keeps its TZID and its wall clock', () {
      final time = eventTimeFromApi(
        local: '20260329T023000',
        tzid: 'Europe/Berlin',
      );
      // The instant is the ruling's; the wall clock written back is the one the
      // zone reads for it, which for a gap is the reading after it.
      expect(apiJsonOf(time), {
        'local': '20260329T033000',
        'tzid': 'Europe/Berlin',
      });
    });

    test('a UTC value stays UTC', () {
      final time = eventTimeFromApi(utc: '20260329T073000Z');
      expect(apiJsonOf(time), {'utc': '20260329T073000Z'});
    });

    test('a zone this build cannot resolve is written as its instant', () {
      final time = eventTimeFromApi(local: '20260329T090000', tzid: 'Foo/Bar');
      expect(apiJsonOf(time), {'utc': '20260329T090000Z'});
    });

    test('a day stays a day', () {
      expect(apiJsonOf(eventTimeFromApi(date: '2026-03-29')), {
        'date': '2026-03-29',
      });
    });

    test('a round trip through the wire shape is stable', () {
      for (final time in [
        eventTimeFromApi(date: '2026-10-25'),
        eventTimeFromApi(local: '20261025T023000', tzid: 'Europe/Berlin'),
        eventTimeFromApi(tzid: 'Australia/Sydney', local: '20260405T023000'),
        eventTimeFromApi(tzid: 'Asia/Kolkata', local: '20260329T090000'),
      ]) {
        final json = apiJsonOf(time);
        final again = eventTimeFromApi(
          date: json['date'] as String?,
          utc: json['utc'] as String?,
          tzid: json['tzid'] as String?,
          local: json['local'] as String?,
        );
        expect(apiJsonOf(again), json);
        expect(
          again.instantOrNull?.toUtc(),
          time.instantOrNull?.toUtc(),
          reason: 'the instant must survive the round trip',
        );
      }
    });
  });

  group('offset labels', () {
    test('the formats the screens use', () {
      expect(formatOffset(const Duration(hours: 2)), 'GMT+2');
      expect(formatOffset(const Duration(hours: -4)), 'GMT-4');
      expect(formatOffset(Duration.zero), 'GMT+0');
      expect(formatOffset(const Duration(hours: 5, minutes: 30)), 'GMT+5:30');
      expect(formatOffset(const Duration(hours: 13, minutes: 45)), 'GMT+13:45');
      expect(formatOffset(const Duration(hours: -9, minutes: -30)), 'GMT-9:30');
    });
  });

  group('the generated client\'s models', () {
    test('an event time and an occurrence time both convert', () {
      // The two generated shapes carry the same four fields (E05-R09), and the
      // adapters are the only place that reads them.
      final event = api.EventTime(
        date: null,
        utc: '20260329T013000Z',
        tzid: 'Europe/Berlin',
        local: '20260329T023000',
      );
      final occurrence = api.OccurrenceTime(
        date: null,
        utc: '20260329T013000Z',
        tzid: 'Europe/Berlin',
        local: '20260329T023000',
      );
      for (final time in [event.toDomain(), occurrence.toDomain()]) {
        expect(
          formatUtcInstant(time.instantOrNull!.toUtc()),
          '20260329T013000Z',
        );
        expect((time as ZonedTime).tzid, 'Europe/Berlin');
        expect(time.zoneKnown, isTrue);
      }
    });
  });
}
