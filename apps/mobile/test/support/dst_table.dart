// The E15-R02 DST table, read as a fixture (E10-R04).
//
// The table is the interop contract (`spec/ical-fixtures/dst/README.md`), and
// each client runs it itself (from-E15-R02): the file is read from the
// repository, never copied into the app, so it cannot drift.

import 'dart:convert';
import 'dart:io';

import 'package:calendar_flex/src/domain/time/event_time.dart';
import 'package:calendar_flex/src/domain/time/zones.dart';
import 'package:timezone/timezone.dart' as tz;

/// The table, relative to `apps/mobile` (the directory `flutter test` runs in).
const dstCasesPath = '../../spec/ical-fixtures/dst/cases.json';

/// The zones E10-R04's Accept line names. Each must contribute at least one
/// case, or the requirement's DST matrix is not being run.
const requiredDstZones = <String>[
  'Europe/Berlin',
  'America/New_York',
  'Australia/Sydney',
  'Asia/Kolkata',
];

/// One case of the table, with the object built from `zone`/`kind`/`input`.
class DstCase {
  DstCase(this.json);

  final Map<String, Object?> json;

  String get id => json['id'] as String;

  /// The IANA zone of `DTSTART`/`DTEND`.
  String get zone => json['zone'] as String;

  /// `skipped`, `repeated`, `daily-existing`, `daily-skipped`, `all-day`,
  /// `view-zone` or `control`.
  String get kind => json['kind'] as String;

  Map<String, Object?> get input => json['input'] as Map<String, Object?>;

  /// The UTC instants the table expects, `YYYYMMDDTHHMMSSZ`.
  List<String> get expected => (json['expected'] as List).cast<String>();

  /// On a `view-zone` case, the wall clock the viewer in `input.viewZone` must
  /// show for the instant.
  String? get expectedLocal => json['expectedLocal'] as String?;

  tz.Location get location => _locationOf(zone);

  /// The all-day date of an `all-day` case, if it is one.
  AllDayDate? get allDay => kind == 'all-day'
      ? AllDayDate.parse(_isoDate(input['date'] as String))
      : null;

  /// The instants this app computes for the case, `.toUtc()`.
  ///
  /// - An all-day case: the midnights of its date and of the next date in
  ///   `input.viewZone` (a day's instants exist only in a viewing zone).
  /// - A `view-zone` case: the one instant of a `TZID` time.
  /// - A daily case: `COUNT` instances, each keeping the wall clock of
  ///   `DTSTART` — the one at a nonexistent local time kept and counted, read
  ///   with the offset before the gap (the owner's ruling on RFC 5545 § 3.3.10,
  ///   `docs/02` § Recurrence).
  /// - Everything else (`skipped`, `repeated`, `control`): one `DTSTART`.
  List<tz.TZDateTime> get instants {
    switch (kind) {
      case 'all-day':
        final view = _locationOf(input['viewZone'] as String);
        final date = allDay!;
        return [_midnight(date, view), _midnight(date.nextDay, view)];
      case 'daily-existing':
      case 'daily-skipped':
        final start = WallClock.parse(input['dtstart'] as String);
        final count =
            (input['rrule']! as Map<String, Object?>)['count']! as int;
        return [
          for (var day = 0; day < count; day++)
            instantOf(wall: start.plusDays(day), zone: location),
        ];
      default:
        return [
          instantOf(
            wall: WallClock.parse(input['dtstart'] as String),
            zone: location,
          ),
        ];
    }
  }

  /// The wall clock `input.viewZone` reads for [instants], on a case that has
  /// one.
  String? get viewZoneLocal {
    if (!input.containsKey('viewZone') || kind == 'all-day') {
      return null;
    }
    final view = _locationOf(input['viewZone'] as String);
    return WallClock.of(tz.TZDateTime.from(instants.single, view)).format();
  }
}

/// Reads the table. A missing file is a failure, not a skip: the runner may not
/// quietly test nothing (from-E15-R02).
List<DstCase> loadDstCases() {
  final file = File(dstCasesPath);
  if (!file.existsSync()) {
    throw StateError(
      'the E15-R02 table is not at $dstCasesPath; `flutter test` must run in '
      'apps/mobile inside the repository checkout',
    );
  }
  final decoded = jsonDecode(file.readAsStringSync());
  if (decoded is! Map<String, Object?> || decoded['cases'] is! List) {
    throw StateError('$dstCasesPath is not the E15-R02 table');
  }
  return [
    for (final entry in decoded['cases']! as List)
      DstCase(entry as Map<String, Object?>),
  ];
}

tz.Location _locationOf(String name) {
  final zone = zoneFor(name);
  if (zone == null) {
    throw StateError('the bundled timezone database does not know $name');
  }
  return zone;
}

tz.TZDateTime _midnight(AllDayDate date, tz.Location view) => instantOf(
  wall: WallClock(year: date.year, month: date.month, day: date.day),
  zone: view,
);

/// `20260329` → `2026-03-29`.
String _isoDate(String yyyymmdd) =>
    '${yyyymmdd.substring(0, 4)}-${yyyymmdd.substring(4, 6)}-'
    '${yyyymmdd.substring(6, 8)}';
