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
}
