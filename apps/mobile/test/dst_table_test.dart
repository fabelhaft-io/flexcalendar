// The app's runner for the E15-R02 DST table (E10-R04).
//
// The table's expected values are UTC instants computed from RFC 5545's rules,
// not from any engine's output, so the app has to agree with `expected` rather
// than with `ical.js` or with the `timezone` package's own constructor
// (from-E15-R02). This test runs every case in
// `spec/ical-fixtures/dst/cases.json`, the table itself.

import 'package:calendar_flex/src/domain/time/zones.dart';
import 'package:calendar_flex/src/timezones.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/dst_table.dart';

void main() {
  setUpAll(initializeAppTimeZones);

  final cases = loadDstCases();

  test('every zone the table uses is in the bundled database', () {
    final zones = cases.map((testCase) => testCase.zone).toSet();
    for (final zone in zones) {
      expect(
        isKnownZoneName(zone),
        isTrue,
        reason: 'the app cannot run the table for $zone',
      );
    }
  });

  test('each required zone contributed cases', () {
    final counts = <String, int>{};
    for (final testCase in cases) {
      counts.update(testCase.zone, (count) => count + 1, ifAbsent: () => 1);
    }
    final summary =
        (counts.entries.toList()..sort((a, b) => a.key.compareTo(b.key)))
            .map((entry) => '${entry.key}: ${entry.value}')
            .join(', ');
    // The counts are the report the review asks for, so they go to the test
    // output, not only into an assertion that passes silently.
    debugPrint('E15-R02 cases per zone — $summary');
    for (final zone in requiredDstZones) {
      expect(
        counts[zone] ?? 0,
        greaterThan(0),
        reason: 'E10-R04 covers $zone; the table contributed no case for it',
      );
    }
    expect(counts.length, greaterThan(requiredDstZones.length));
  });

  group('the app\'s zone layer reproduces the table', () {
    for (final testCase in cases) {
      test('${testCase.id} (${testCase.zone}, ${testCase.kind})', () {
        expect([
          for (final instant in testCase.instants)
            formatUtcInstant(instant.toUtc()),
        ], testCase.expected);
        final local = testCase.viewZoneLocal;
        if (testCase.expectedLocal != null) {
          // A `view-zone` case also pins the wall clock its viewer must show: a
          // UTC instant alone cannot fail a renderer in the wrong zone.
          expect(local, testCase.expectedLocal);
        }
      });
    }
  });
}
