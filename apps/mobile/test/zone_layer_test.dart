// The zone layer's own tests: RFC 5545 § 3.3.5's answers, the zone names, and
// the two refusals it makes (E10-R04).

import 'package:calendar_flex/src/domain/time/zones.dart';
import 'package:calendar_flex/src/timezones.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:timezone/timezone.dart' as tz;

void main() {
  setUpAll(initializeAppTimeZones);

  group('zone names', () {
    test('an exact IANA spelling and the tzdata link names resolve', () {
      for (final name in [
        'Europe/Berlin',
        'America/New_York',
        'Australia/Sydney',
        'Asia/Kolkata',
        // A link, which only the `latest_all` data file carries, and which the
        // API accepts (from-E05-R09).
        'Asia/Calcutta',
        'US/Eastern',
      ]) {
        expect(isKnownZoneName(name), isTrue, reason: name);
        expect(zoneFor(name)!.name, name);
      }
    });

    test('a wrong case, a Windows name and a fixed offset do not', () {
      for (final name in [
        'europe/berlin',
        'Europe/berlin',
        'W. Europe Standard Time',
        'GMT+05:30',
        'Not/AZone',
        '',
      ]) {
        expect(isKnownZoneName(name), isFalse, reason: name);
        expect(zoneFor(name), isNull);
      }
    });
  });

  group('instantOf gives RFC 5545 § 3.3.5 form 3\'s instant', () {
    test('a reading in the gap uses the offset before it', () {
      // Berlin 2026-03-29 02:30 does not exist (02:00 becomes 03:00, +01:00 to
      // +02:00); RFC 5545's own example is `America/New_York:20070311T023000`.
      expect(_utc('Europe/Berlin', '20260329T023000'), '20260329T013000Z');
      expect(_utc('America/New_York', '20260308T023000'), '20260308T073000Z');
      expect(_utc('Australia/Sydney', '20261004T023000'), '20261003T163000Z');
      // Pacific/Chatham's gap is 02:45–03:45 and its offsets are quarter-hours.
      expect(_utc('Pacific/Chatham', '20260927T031500'), '20260926T143000Z');
    });

    test('a repeated reading is the first occurrence', () {
      expect(_utc('Europe/Berlin', '20261025T023000'), '20261025T003000Z');
      expect(_utc('America/New_York', '20261101T013000'), '20261101T053000Z');
      expect(_utc('Pacific/Chatham', '20260405T031500'), '20260404T133000Z');
    });

    test('a zone that never transitions has one offset all year', () {
      expect(_utc('Asia/Kolkata', '20260329T023000'), '20260328T210000Z');
      expect(_utc('Asia/Kolkata', '20261025T023000'), '20261024T210000Z');
      expect(_utc('Etc/UTC', '20260329T023000'), '20260329T023000Z');
    });

    test('the timezone package\'s own constructor answers differently', () {
      // The correction this layer exists for: `TZDateTime(location, …)` follows
      // Java/Joda, so the fall-back hour resolves to the *second* occurrence.
      // The table wants the first (`spec/ical-fixtures/dst/README.md`).
      final berlin = zoneFor('Europe/Berlin')!;
      final wall = WallClock.parse('20261025T023000');

      expect(
        formatUtcInstant(tz.TZDateTime(berlin, 2026, 10, 25, 2, 30).toUtc()),
        '20261025T013000Z',
        reason: 'the package: Java/Joda, the second occurrence',
      );
      expect(
        formatUtcInstant(instantOf(wall: wall, zone: berlin).toUtc()),
        '20261025T003000Z',
        reason: 'RFC 5545 § 3.3.5 form 3: the first occurrence',
      );
      // On a gap the package happens to land on the RFC's instant, because it
      // pushes the reading to after the transition. The app does not rely on
      // that: `instantOf` computes it from the pre-gap offset itself.
      expect(
        formatUtcInstant(tz.TZDateTime(berlin, 2026, 3, 29, 2, 30).toUtc()),
        '20260329T013000Z',
      );
      expect(
        formatUtcInstant(
          instantOf(
            wall: WallClock.parse('20260329T023000'),
            zone: berlin,
          ).toUtc(),
        ),
        '20260329T013000Z',
      );
    });
  });

  group('instantOfApi', () {
    test('resolves the API pair, or answers null for a zone it lacks', () {
      expect(
        formatUtcInstant(
          instantOfApi(
            local: '20260329T090000',
            tzid: 'Europe/Berlin',
          )!.toUtc(),
        ),
        '20260329T070000Z',
      );
      expect(
        formatUtcInstant(
          instantOfApi(
            local: '20260329T090000',
            tzid: 'Asia/Calcutta',
          )!.toUtc(),
        ),
        '20260329T033000Z',
      );
      expect(instantOfApi(local: '20260329T090000', tzid: 'Foo/Bar'), isNull);
    });
  });

  group('the wire spellings', () {
    test('a wall clock round-trips, and refuses what would normalise', () {
      final wall = WallClock.parse('20260329T023000');
      expect(wall.format(), '20260329T023000');
      expect(wall.asUtcFields, DateTime.utc(2026, 3, 29, 2, 30));

      for (final bad in [
        '20260230T023000', // 30 February
        '20260329T0230000', // too long
        '2026-03-29T02:30:00', // an ISO spelling, not the wire one
        '20260329T023000Z', // an instant is not a wall clock
        '20260329T026000', // minute 60
        '20260329T023060', // the leap second, which RFC 5545 allows and we do not
        '', // nothing
      ]) {
        expect(() => WallClock.parse(bad), throwsFormatException, reason: bad);
      }
    });

    test('plusDays adds calendar days, so the wall clock does not move', () {
      final start = WallClock.parse('20260327T023000');
      expect(start.plusDays(0).format(), '20260327T023000');
      expect(start.plusDays(2).format(), '20260329T023000');
      // Across a month end, and across a leap day.
      expect(
        WallClock.parse('20260228T090000').plusDays(1).format(),
        '20260301T090000',
      );
      expect(
        WallClock.parse('20240228T090000').plusDays(1).format(),
        '20240229T090000',
      );
    });

    test('a UTC instant round-trips, and refuses what would normalise', () {
      final instant = parseUtcInstant('20260329T013000Z');
      expect(instant, DateTime.utc(2026, 3, 29, 1, 30));
      expect(formatUtcInstant(instant), '20260329T013000Z');
      // `formatUtcInstant` takes any instant, including a local `DateTime`.
      expect(
        formatUtcInstant(DateTime.utc(2026, 1, 2, 3, 4, 5)),
        '20260102T030405Z',
      );

      for (final bad in [
        '20260230T013000Z',
        '20260329T013000', // no `Z`: a floating time (INV-04)
        '20261231T235960Z', // a leap second
        '2026-03-29T01:30:00Z',
        '20260329T013000z', // lowercase is not RFC 5545
        '',
      ]) {
        expect(() => parseUtcInstant(bad), throwsFormatException, reason: bad);
      }
    });
  });
}

/// The instant [local] names in `tzid`, as the table spells instants.
String _utc(String tzid, String local) {
  final zone = zoneFor(tzid)!;
  return formatUtcInstant(
    instantOf(wall: WallClock.parse(local), zone: zone).toUtc(),
  );
}
