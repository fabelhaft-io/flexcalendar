// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'event_time.g.dart';

/// One event time. A write sends one of three forms: `date` (an all-day VALUE=DATE, `YYYY-MM-DD`), `utc` (an instant, `YYYYMMDDTHHMMSSZ`), or `local` together with `tzid` (an IANA zone in its exact spelling and the wall clock it reads, `YYYYMMDDTHHMMSS`). A read answers the form the stored property spells — `date`, `utc`, or `local` with the `tzid` beside it — and a `TZID` time also carries `utc`, the instant that reading names, when the zone resolves (E05-R09). `null` when the object carries no such property.
@JsonSerializable()
class EventTime {
  const EventTime({this.date, this.utc, this.tzid, this.local});

  factory EventTime.fromJson(Map<String, Object?> json) =>
      _$EventTimeFromJson(json);

  /// An all-day date, `YYYY-MM-DD`.
  final String? date;

  /// A UTC instant, `YYYYMMDDTHHMMSSZ`. On a `local` time it is computed from the zone, never converted back.
  final String? utc;

  /// The `TZID` the stored property names, unchanged, or the IANA zone a write names.
  final String? tzid;

  /// The wall clock the stored property spells, `YYYYMMDDTHHMMSS`.
  final String? local;

  Map<String, Object?> toJson() => _$EventTimeToJson(this);
}
