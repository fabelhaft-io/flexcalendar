// One event time, as the domain layer wants it (E10-R04, INV-04).

import 'package:timezone/timezone.dart' as tz;

import 'zones.dart';

/// An API event time, resolved.
///
/// The API writes one of three shapes and answers the shape stored
/// (from-E05-R09): `{date}` for an all-day `VALUE=DATE`, `{utc}` for a `Z` time,
/// and `{local, tzid}` for a `TZID` time — the last one with `utc` beside it
/// when the zone resolved on the server.
sealed class EventTime {
  const EventTime();

  /// The instant of a timed value; `null` for an all-day date, which has none
  /// (INV-04: a day is never a midnight-to-midnight date-time).
  tz.TZDateTime? get instantOrNull;
}

/// An all-day value: one calendar date, its exclusive end the next date
/// (RFC 5545 § 3.8.2.2).
final class AllDayDate extends EventTime {
  const AllDayDate({
    required this.year,
    required this.month,
    required this.day,
  });

  /// Parses the API's `YYYY-MM-DD`, refusing what `DateTime` would normalise.
  factory AllDayDate.parse(String value) {
    final match = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(value);
    if (match == null) {
      throw FormatException('not an RFC 5545 DATE', value);
    }
    final date = AllDayDate(
      year: int.parse(match.group(1)!),
      month: int.parse(match.group(2)!),
      day: int.parse(match.group(3)!),
    );
    if (date.format() != value || !_isRealDate(date)) {
      throw FormatException('not an RFC 5545 DATE', value);
    }
    return date;
  }

  final int year;
  final int month;
  final int day;

  /// The exclusive end: the next calendar day, in whatever zone the day is
  /// viewed from.
  AllDayDate get nextDay {
    final shifted = DateTime.utc(year, month, day).add(const Duration(days: 1));
    return AllDayDate(
      year: shifted.year,
      month: shifted.month,
      day: shifted.day,
    );
  }

  String format() =>
      '${year.toString().padLeft(4, '0')}-'
      '${month.toString().padLeft(2, '0')}-'
      '${day.toString().padLeft(2, '0')}';

  @override
  tz.TZDateTime? get instantOrNull => null;

  @override
  String toString() => format();
}

/// A timed value: the instant, and the zone it was written in.
final class ZonedTime extends EventTime {
  const ZonedTime({required this.instant, this.tzid, this.zoneKnown = true});

  /// The instant of the value.
  final tz.TZDateTime instant;

  /// The `TZID` exactly as the API spelled it, or `null` for a `{utc}` value.
  final String? tzid;

  /// `false` when the bundled database does not know [tzid] — a zone the
  /// server's tzdata has and this build's has not, or a name that is not IANA
  /// at all. The wall clock and [tzid] are kept either way; the UI says so.
  final bool zoneKnown;

  @override
  tz.TZDateTime? get instantOrNull => instant;

  @override
  String toString() =>
      'ZonedTime(${formatUtcInstant(instant.toUtc())}'
      '${tzid == null ? '' : ' $tzid'}${zoneKnown ? '' : ', zone unknown'})';
}

/// Resolves one of the API's three time shapes (from-E05-R09).
///
/// - `{date}` → [AllDayDate].
/// - `{utc}` → a [ZonedTime] with no `tzid`.
/// - `{local, tzid}` → a zoned instant. When the API sent `utc` (it resolved the
///   zone), that instant is used rather than recomputed: the API's zone data is
///   Node's ICU (tz 2026b) and the app's is the `timezone` package's (tz 2026e),
///   so recomputing could differ from what the server stored. Otherwise the
///   instant is computed per RFC 5545 § 3.3.5 ([instantOf]); a `TZID` the
///   bundled database does not know falls back to reading the wall clock as
///   UTC, flagged `zoneKnown: false`.
///
/// A shape that carries no instant at all — a floating local time, which INV-04
/// forbids, or an empty one — is a [FormatException].
EventTime eventTimeFromApi({
  String? date,
  String? utc,
  String? tzid,
  String? local,
}) {
  if (date != null) {
    if (utc != null || tzid != null || local != null) {
      throw const FormatException('an event time carries one shape, not two');
    }
    return AllDayDate.parse(date);
  }
  if (tzid == null) {
    if (local != null) {
      throw const FormatException('a local time needs its TZID (INV-04)');
    }
    if (utc == null) {
      throw const FormatException('an event time with no value');
    }
    return ZonedTime(instant: _utcInstant(utc));
  }
  if (local == null) {
    throw const FormatException('a TZID needs the wall clock it reads');
  }
  final zone = zoneFor(tzid);
  final wall = WallClock.parse(local);
  if (utc != null) {
    final instant = _utcInstant(utc);
    return ZonedTime(
      instant: zone == null
          ? tz.TZDateTime.from(instant, tz.UTC)
          : tz.TZDateTime.from(instant, zone),
      tzid: tzid,
      zoneKnown: zone != null,
    );
  }
  final resolved = instantOfApi(local: local, tzid: tzid);
  if (resolved == null) {
    return ZonedTime(
      instant: tz.TZDateTime.from(wall.asUtcFields, tz.UTC),
      tzid: tzid,
      zoneKnown: false,
    );
  }
  return ZonedTime(instant: resolved, tzid: tzid);
}

/// The API's write shape for [time] (E05-R09): `{date}`, `{utc}` or
/// `{local, tzid}`.
///
/// A zoned time whose zone this build cannot resolve is sent as `{utc}`: the
/// instant is what we know, and the server can resolve the zone itself.
Map<String, Object?> apiJsonOf(EventTime time) {
  if (time is AllDayDate) {
    return {'date': time.format()};
  }
  final zoned = time as ZonedTime;
  final tzid = zoned.tzid;
  final zone = tzid == null ? null : zoneFor(tzid);
  if (tzid == null || zone == null) {
    return {'utc': formatUtcInstant(zoned.instant.toUtc())};
  }
  final wall = WallClock.of(tz.TZDateTime.from(zoned.instant, zone));
  return {'local': wall.format(), 'tzid': tzid};
}

/// Whether the date fields name a day that exists: `DateTime.utc` normalises
/// 30 February into March, and the comparison catches it.
bool _isRealDate(AllDayDate date) {
  final utc = DateTime.utc(date.year, date.month, date.day);
  return utc.year == date.year &&
      utc.month == date.month &&
      utc.day == date.day;
}

tz.TZDateTime _utcInstant(String value) =>
    tz.TZDateTime.from(parseUtcInstant(value), tz.UTC);
