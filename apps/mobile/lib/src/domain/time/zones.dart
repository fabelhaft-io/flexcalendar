// The `TZID` layer of the app (E10-R04, INV-04).
//
// Dart's `DateTime` knows only UTC and the device's local zone
// (`docs/02-technology-choices.md` § Mobile clients), so nothing here builds a
// zoned instant with `DateTime`: this file is the only place in the domain layer
// that turns a wall clock plus an IANA zone name into an instant, and it gives
// RFC 5545 § 3.3.5's answers, not the `timezone` package's constructor's.

import 'dart:math' show min;

import 'package:timezone/timezone.dart' as tz;

/// A day either side of a reading: a zone never makes two transitions within a
/// day of it, so these two offsets bracket every transition that can matter.
const int _dayInMilliseconds = 24 * 60 * 60 * 1000;

final RegExp _wallClockPattern = RegExp(
  r'^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$',
);
final RegExp _utcInstantPattern = RegExp(
  r'^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$',
);

/// The zone [name] names, or `null` when the bundled database does not know it.
///
/// Exact spelling only (from-E05-R09): `Europe/Berlin` and `Asia/Kolkata`
/// resolve, and so do the tzdata link names such as `Asia/Calcutta` and
/// `US/Eastern` (the app loads `data/latest_all.dart`, E10-R04). `europe/berlin`,
/// a Windows name such as `W. Europe Standard Time` and a fixed-offset label
/// such as `GMT+05:30` do not.
tz.Location? zoneFor(String name) => tz.timeZoneDatabase.locations[name];

/// Whether the bundled database knows [name] in its exact spelling.
bool isKnownZoneName(String name) => zoneFor(name) != null;

/// A local wall-clock reading, `YYYYMMDDTHHMMSS` (RFC 5545 § 3.3.5 form 3).
///
/// It is not an instant: it names a reading whose meaning depends on a zone, and
/// two of them in a year name no instant at all or name two. Nothing in the app
/// treats one as an instant — [instantOf] does that, with the RFC's answers.
class WallClock {
  const WallClock({
    required this.year,
    required this.month,
    required this.day,
    this.hour = 0,
    this.minute = 0,
    this.second = 0,
  });

  /// Parses `YYYYMMDDTHHMMSS`. A reading is refused rather than normalised:
  /// 30 February, hour 24 and the leap second `60` are `FormatException`s, so a
  /// malformed wire value can never quietly become a valid one.
  factory WallClock.parse(String value) {
    final match = _wallClockPattern.firstMatch(value);
    if (match == null) {
      throw FormatException('not an RFC 5545 wall clock', value);
    }
    final clock = WallClock(
      year: int.parse(match.group(1)!),
      month: int.parse(match.group(2)!),
      day: int.parse(match.group(3)!),
      hour: int.parse(match.group(4)!),
      minute: int.parse(match.group(5)!),
      second: int.parse(match.group(6)!),
    );
    if (clock.format() != value || !_isValidReading(clock)) {
      throw FormatException('not an RFC 5545 wall clock', value);
    }
    return clock;
  }

  /// The reading [at] shows, in the zone [at] is already in.
  factory WallClock.of(tz.TZDateTime at) => WallClock(
    year: at.year,
    month: at.month,
    day: at.day,
    hour: at.hour,
    minute: at.minute,
    second: at.second,
  );

  final int year;
  final int month;
  final int day;
  final int hour;
  final int minute;
  final int second;

  /// This reading as a UTC `DateTime` — the reading's fields, **not** an instant.
  DateTime get asUtcFields =>
      DateTime.utc(year, month, day, hour, minute, second);

  /// The same reading [days] calendar days later (RFC 5545 § 3.8.5.3 keeps the
  /// wall clock of `DTSTART`, so a recurrence adds calendar days, never 24-hour
  /// durations).
  WallClock plusDays(int days) {
    final shifted = DateTime.utc(year, month, day).add(Duration(days: days));
    return WallClock(
      year: shifted.year,
      month: shifted.month,
      day: shifted.day,
      hour: hour,
      minute: minute,
      second: second,
    );
  }

  String format() =>
      '${_pad(year, 4)}${_pad(month, 2)}${_pad(day, 2)}'
      'T${_pad(hour, 2)}${_pad(minute, 2)}${_pad(second, 2)}';

  @override
  String toString() => format();

  @override
  bool operator ==(Object other) =>
      other is WallClock &&
      other.year == year &&
      other.month == month &&
      other.day == day &&
      other.hour == hour &&
      other.minute == minute &&
      other.second == second;

  @override
  int get hashCode => Object.hash(year, month, day, hour, minute, second);
}

/// The instant [wall] names in [zone] (RFC 5545 § 3.3.5 form 3).
///
/// A reading that does not exist — the spring-forward gap — is read with the UTC
/// offset **in force before the gap**; one that occurs twice — the fall-back
/// hour — is the **first** occurrence. Both are the table's answers, not the
/// `timezone` package's: its `TZDateTime(location, …)` constructor follows
/// Java/Joda and resolves the fall-back hour to the second occurrence
/// (`spec/ical-fixtures/dst/README.md`, from-E15-R02). The instant is the same
/// on a gap, but the app does not rely on that either — every zoned instant the
/// app computes goes through this function (INV-04).
tz.TZDateTime instantOf({required WallClock wall, required tz.Location zone}) {
  final wallMilliseconds = wall.asUtcFields.millisecondsSinceEpoch;
  // The offsets in force a day either side of the reading. A reading that
  // exists is off one of them; a reading in a gap is off neither, and a reading
  // in the repeated hour is off both.
  final offsets = <int>{
    _offsetAt(zone, wallMilliseconds - _dayInMilliseconds),
    _offsetAt(zone, wallMilliseconds + _dayInMilliseconds),
  };
  final candidates = <int>[
    for (final offset in offsets) wallMilliseconds - offset,
  ]..sort();
  final existing = <int>[
    for (final candidate in candidates)
      if (_offsetAt(zone, candidate) == wallMilliseconds - candidate) candidate,
  ];
  final chosen = existing.isNotEmpty
      // One candidate: the reading exists once. Two: the repeated hour, whose
      // first occurrence is the earlier (pre-transition) instant.
      ? existing.first
      // A gap: clocks skipped forward, so the pre-gap offset is the smaller of
      // the two and the instant is the later one.
      : wallMilliseconds - offsets.reduce(min);
  return tz.TZDateTime.from(
    DateTime.fromMillisecondsSinceEpoch(chosen, isUtc: true),
    zone,
  );
}

/// [instantOf] for the API's `{local, tzid}` pair (from-E05-R09), or `null` when
/// the bundled database does not know `tzid`.
tz.TZDateTime? instantOfApi({required String local, required String tzid}) {
  final zone = zoneFor(tzid);
  if (zone == null) return null;
  return instantOf(wall: WallClock.parse(local), zone: zone);
}

/// Parses `YYYYMMDDTHHMMSSZ` (RFC 5545 § 3.3.5 form 1) into a UTC instant. The
/// same normalisation refusal [WallClock.parse] makes.
DateTime parseUtcInstant(String value) {
  final match = _utcInstantPattern.firstMatch(value);
  if (match == null) {
    throw FormatException('not an RFC 5545 UTC instant', value);
  }
  final instant = DateTime.utc(
    int.parse(match.group(1)!),
    int.parse(match.group(2)!),
    int.parse(match.group(3)!),
    int.parse(match.group(4)!),
    int.parse(match.group(5)!),
    int.parse(match.group(6)!),
  );
  if (formatUtcInstant(instant) != value) {
    throw FormatException('not an RFC 5545 UTC instant', value);
  }
  return instant;
}

/// Formats a UTC instant as `YYYYMMDDTHHMMSSZ`.
String formatUtcInstant(DateTime instant) {
  final at = instant.toUtc();
  return '${_pad(at.year, 4)}${_pad(at.month, 2)}${_pad(at.day, 2)}'
      'T${_pad(at.hour, 2)}${_pad(at.minute, 2)}${_pad(at.second, 2)}Z';
}

/// `GMT+2`, `GMT-4`, `GMT+5:30`, `GMT+13:45`.
String formatOffset(Duration offset) {
  final minutes = offset.inMinutes;
  final sign = minutes < 0 ? '-' : '+';
  final absolute = minutes.abs();
  final hours = absolute ~/ 60;
  final rest = absolute % 60;
  return 'GMT$sign$hours${rest == 0 ? '' : ':${_pad(rest, 2)}'}';
}

/// Whether every field of the reading is in range. `DateTime.utc` normalises
/// what is not — 30 February into March, hour 24 into the next day, the leap
/// second `60` into the next minute — so the comparison rejects exactly the
/// spellings RFC 5545 does not allow us to read.
bool _isValidReading(WallClock clock) {
  final normalized = DateTime.utc(
    clock.year,
    clock.month,
    clock.day,
    clock.hour,
    clock.minute,
    clock.second,
  );
  return normalized.year == clock.year &&
      normalized.month == clock.month &&
      normalized.day == clock.day &&
      normalized.hour == clock.hour &&
      normalized.minute == clock.minute &&
      normalized.second == clock.second;
}

int _offsetAt(tz.Location zone, int millisecondsSinceEpoch) =>
    zone.lookupTimeZone(millisecondsSinceEpoch).timeZone.offset.inMilliseconds;

String _pad(int value, int width) => value.toString().padLeft(width, '0');
