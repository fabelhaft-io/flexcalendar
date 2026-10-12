import 'package:calendar_flex/src/timezones.dart';
import 'package:test/test.dart';
import 'package:timezone/timezone.dart' as tz;

void main() {
  late tz.Location berlin;

  setUpAll(() {
    // The app's own initialisation, once, as `bootstrap` calls it (INV-04).
    initializeAppTimeZones();
    berlin = tz.getLocation('Europe/Berlin');
  });

  test('loads the IANA database so a TZID resolves', () {
    expect(berlin.name, 'Europe/Berlin');
    // The two ends of the pinned DST rule are the same zone object, not a
    // fixed offset.
    expect(
      tz.TZDateTime(berlin, 2026, 1, 15, 12).timeZoneOffset,
      const Duration(hours: 1),
    );
    expect(
      tz.TZDateTime(berlin, 2026, 7, 15, 12).timeZoneOffset,
      const Duration(hours: 2),
    );
  });

  test('2026-10-25: summer time ends, so a local day is 25 hours long', () {
    // Europe/Berlin ends DST on the last Sunday of October: 2026-10-25, 03:00
    // CEST becomes 02:00 CET.
    final saturdayNoon = tz.TZDateTime(berlin, 2026, 10, 24, 12);
    final sundayNoon = tz.TZDateTime(berlin, 2026, 10, 25, 12);

    expect(saturdayNoon.toUtc(), DateTime.utc(2026, 10, 24, 10));
    expect(saturdayNoon.timeZoneOffset, const Duration(hours: 2));
    expect(sundayNoon.toUtc(), DateTime.utc(2026, 10, 25, 11));
    expect(sundayNoon.timeZoneOffset, const Duration(hours: 1));
    // 12:00 local on both days is 10:00Z and 11:00Z, not a fixed offset, so the
    // elapsed time is 25 hours. Only `TZDateTime` knows that; a `DateTime` in
    // the same zone would be off by an hour, which is why INV-04 bans zoned
    // maths on `DateTime`.
    expect(sundayNoon.difference(saturdayNoon), const Duration(hours: 25));
    expect(
      sundayNoon.toUtc().difference(saturdayNoon.toUtc()),
      const Duration(hours: 25),
    );
  });

  test('2026-10-25 02:30 happens twice, one local time and two instants', () {
    final first = tz.TZDateTime.from(DateTime.utc(2026, 10, 25, 0, 30), berlin);
    final second = tz.TZDateTime.from(
      DateTime.utc(2026, 10, 25, 1, 30),
      berlin,
    );

    expect([first.hour, first.minute], [2, 30]);
    expect([second.hour, second.minute], [2, 30]);
    expect(first.timeZoneOffset, const Duration(hours: 2));
    expect(second.timeZoneOffset, const Duration(hours: 1));
    expect(second.difference(first), const Duration(hours: 1));
  });

  group('the device\'s zone becomes the package\'s local location', () {
    tearDown(() => tz.setLocalLocation(tz.UTC));

    Future<AppLocalZone> withDeviceZone(String name) =>
        initializeDeviceTimeZone(readDeviceZone: () async => name);

    test('an IANA name the database knows is used as it is', () async {
      final zone = await withDeviceZone('Australia/Sydney');

      expect(zone.source, LocalZoneSource.device);
      expect(zone.isUtcFallback, isFalse);
      expect(zone.reportedName, 'Australia/Sydney');
      expect(zone.name, 'Australia/Sydney');
      expect(tz.local.name, 'Australia/Sydney');
      // The package's own defaults follow the device zone, which is the point
      // of setting it at all.
      expect(
        tz.TZDateTime.from(DateTime.utc(2026, 4, 4), tz.local).hour,
        11,
        reason: 'Sydney is +11:00 on 2026-04-04, before its DST ends',
      );
    });

    test('a tzdata link name resolves too (from-E05-R09)', () async {
      final zone = await withDeviceZone('Asia/Calcutta');

      expect(zone.source, LocalZoneSource.device);
      expect(zone.reportedName, 'Asia/Calcutta');
      expect(tz.local.name, 'Asia/Calcutta');
    });

    test('a wrong spelling falls back to UTC, visibly', () async {
      final zone = await withDeviceZone('europe/berlin');

      expect(zone.source, LocalZoneSource.utcFallback);
      expect(zone.isUtcFallback, isTrue);
      expect(zone.reportedName, 'europe/berlin');
      expect(zone.name, tz.UTC.name);
      expect(tz.local.name, tz.UTC.name);
    });

    test('a Windows name falls back to UTC, visibly', () async {
      final zone = await withDeviceZone('W. Europe Standard Time');

      expect(zone.isUtcFallback, isTrue);
      expect(zone.reportedName, 'W. Europe Standard Time');
      expect(tz.local.name, tz.UTC.name);
    });

    test('a fixed-offset label falls back to UTC, visibly', () async {
      // Android reports `GMT+05:30` for a device set to a raw offset, which is
      // not an IANA zone and must not be treated as one.
      final zone = await withDeviceZone('GMT+05:30');

      expect(zone.isUtcFallback, isTrue);
      expect(zone.reportedName, 'GMT+05:30');
      expect(tz.local.name, tz.UTC.name);
    });

    test('an empty name falls back to UTC, with nothing to report', () async {
      final zone = await withDeviceZone('  ');

      expect(zone.isUtcFallback, isTrue);
      expect(zone.reportedName, isNull);
    });

    test(
      'a native call that throws falls back to UTC, with nothing to report',
      () async {
        final zone = await initializeDeviceTimeZone(
          readDeviceZone: () => Future<String>.error(StateError('no channel')),
        );

        expect(zone.isUtcFallback, isTrue);
        expect(zone.reportedName, isNull);
        expect(tz.local.name, tz.UTC.name);
      },
    );

    test('the real native call falls back on the test host', () async {
      // `flutter_timezone` needs the platform channel, which the Dart VM test
      // host has not registered, so the app's own default reader takes the
      // fallback path here. On a device this call answers the IANA name; the
      // device check is in `apps/mobile/README.md`.
      final zone = await initializeDeviceTimeZone();

      expect(zone.isUtcFallback, isTrue);
      expect(zone.reportedName, isNull);
      expect(tz.local.name, tz.UTC.name);
    });
  });
}
