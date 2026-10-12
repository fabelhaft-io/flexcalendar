// The DST widget tests of E10-R04: the E15-R02 table, rendered.
//
// A UTC instant alone cannot fail a renderer that shows the event in the wrong
// zone (from-E15-R02), so every case of `spec/ical-fixtures/dst/cases.json` is
// also rendered through `EventTimeText` with the device zone set to each of the
// four zones the Accept line names. The literals in the first tests pin the
// rendering; the loop checks every case and every zone.

import 'package:calendar_flex/src/domain/time/event_time.dart';
import 'package:calendar_flex/src/domain/time/zones.dart';
import 'package:calendar_flex/src/timezones.dart';
import 'package:calendar_flex/src/ui/event_time_text.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:timezone/timezone.dart' as tz;

import 'support/dst_table.dart';

void main() {
  setUpAll(initializeAppTimeZones);
  tearDown(() => tz.setLocalLocation(tz.UTC));

  final cases = loadDstCases();
  final requiredCases = [
    for (final testCase in cases)
      if (requiredDstZones.contains(testCase.zone)) testCase,
  ];

  /// Renders [time] with the device's zone set to [deviceZone].
  Future<void> render(
    WidgetTester tester,
    EventTime time,
    String deviceZone,
  ) async {
    tz.setLocalLocation(zoneFor(deviceZone)!);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: EventTimeText(time: time)),
      ),
    );
  }

  tz.TZDateTime utc(int year, int month, int day, int hour, int minute) =>
      tz.TZDateTime.from(DateTime.utc(year, month, day, hour, minute), tz.UTC);

  testWidgets('the Berlin gap instance shows as 03:30 in Berlin', (
    tester,
  ) async {
    // `berlin-2026-spring-skipped`: RFC 5545 § 3.3.5 form 3 reads
    // `20260329T023000` in Europe/Berlin with the offset before the gap, i.e.
    // the instant 2026-03-29T01:30Z. In Berlin that reads 03:30 CEST, not the
    // 02:30 that was written and not ical.js's 00:30Z (`spec/ical-fixtures/dst`
    // README).
    final time = ZonedTime(instant: utc(2026, 3, 29, 1, 30));
    const labels = {
      'Europe/Berlin': '2026-03-29 03:30 (GMT+2)',
      'America/New_York': '2026-03-28 21:30 (GMT-4)',
      'Australia/Sydney': '2026-03-29 12:30 (GMT+11)',
      'Asia/Kolkata': '2026-03-29 07:00 (GMT+5:30)',
    };
    for (final entry in labels.entries) {
      await render(tester, time, entry.key);
      expect(
        find.text(entry.value),
        findsOneWidget,
        reason: 'the same instant in ${entry.key}',
      );
    }
  });

  testWidgets('the repeated hour is the first occurrence, at 02:30 in Berlin', (
    tester,
  ) async {
    // `berlin-2026-fall-repeated`: `20261025T023000` occurs twice; RFC 5545
    // § 3.3.5 form 3 takes the first, 2026-10-25T00:30Z, which still reads
    // 02:30 CEST. The `timezone` package's constructor would give 01:30Z, an
    // hour later.
    final time = ZonedTime(instant: utc(2026, 10, 25, 0, 30));
    const labels = {
      'Europe/Berlin': '2026-10-25 02:30 (GMT+2)',
      'America/New_York': '2026-10-24 20:30 (GMT-4)',
      'Australia/Sydney': '2026-10-25 11:30 (GMT+11)',
      'Asia/Kolkata': '2026-10-25 06:00 (GMT+5:30)',
    };
    for (final entry in labels.entries) {
      await render(tester, time, entry.key);
      expect(
        find.text(entry.value),
        findsOneWidget,
        reason: 'the same instant in ${entry.key}',
      );
    }
  });

  testWidgets('a quarter-hour offset is not rounded', (tester) async {
    // `chatham-2026-spring-skipped`: the ruling's instant for
    // `TZID=Pacific/Chatham:20260927T031500` is 2026-09-26T14:30Z. 03:15 local
    // is inside Chatham's gap (02:45 becomes 03:45), so the instant is the
    // reading with the offset before it and shows as 04:15 (+13:45) — and as
    // 20:00 the previous day in Kolkata (+05:30).
    final time = ZonedTime(instant: utc(2026, 9, 26, 14, 30));
    await render(tester, time, 'Pacific/Chatham');
    expect(find.text('2026-09-27 04:15 (GMT+13:45)'), findsOneWidget);
    await render(tester, time, 'Asia/Kolkata');
    expect(find.text('2026-09-26 20:00 (GMT+5:30)'), findsOneWidget);
  });

  testWidgets('an all-day value is a date, never a time', (tester) async {
    final date = AllDayDate.parse('2026-03-29');
    for (final zone in requiredDstZones) {
      await render(tester, date, zone);
      expect(find.text('2026-03-29 (all day)'), findsOneWidget);
      expect(find.textContaining(':'), findsNothing);
    }
  });

  testWidgets('a TZID this build cannot resolve says so', (tester) async {
    final time = eventTimeFromApi(local: '20260329T090000', tzid: 'Foo/Bar');
    expect(time, isA<ZonedTime>());
    await render(tester, time, 'Europe/Berlin');
    // The wall clock is kept and read as UTC, and the label flags it: the app
    // never silently shows a zone it does not know (E10-R04).
    expect(
      find.text('2026-03-29 11:00 (GMT+2) (zone unknown)'),
      findsOneWidget,
    );
  });

  group('every table case renders in every device zone', () {
    for (final testCase in requiredCases) {
      testWidgets('${testCase.id} (${testCase.zone}, ${testCase.kind})', (
        tester,
      ) async {
        final date = testCase.allDay;
        final instants = testCase.instants;
        for (final deviceZone in requiredDstZones) {
          tz.setLocalLocation(zoneFor(deviceZone)!);
          await tester.pumpWidget(
            MaterialApp(
              home: Scaffold(
                body: Column(
                  children: [
                    for (final (index, instant) in instants.indexed)
                      EventTimeText(
                        key: ValueKey('instant-$index'),
                        time: ZonedTime(instant: instant),
                      ),
                    if (date != null)
                      EventTimeText(key: const ValueKey('date'), time: date),
                  ],
                ),
              ),
            ),
          );
          if (date != null) {
            expect(
              find.text('${date.format()} (all day)'),
              findsOneWidget,
              reason: '${testCase.id} in $deviceZone',
            );
          }
          for (final (index, instant) in instants.indexed) {
            expect(
              find.text(
                _rendered(tz.TZDateTime.from(instant, zoneFor(deviceZone)!)),
              ),
              findsOneWidget,
              reason:
                  '${testCase.id} instance $index in $deviceZone, instant '
                  '${formatUtcInstant(instant.toUtc())}',
            );
          }
        }
      });
    }
  });
}

/// The label the rendering rules give for [at] — an implementation of the
/// documented format that is independent of the widget's own.
String _rendered(tz.TZDateTime at) {
  String two(int value) => value.toString().padLeft(2, '0');
  final offset = at.timeZoneOffset;
  final minutes = offset.inMinutes.abs();
  final rest = minutes % 60;
  final sign = offset.inMinutes < 0 ? '-' : '+';
  final gmt = 'GMT$sign${minutes ~/ 60}${rest == 0 ? '' : ':${two(rest)}'}';
  return '${at.year.toString().padLeft(4, '0')}-${two(at.month)}-${two(at.day)} '
      '${two(at.hour)}:${two(at.minute)} ($gmt)';
}
