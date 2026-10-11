// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'event_time.g.dart';

/// One event time. A write sends exactly one member: `date` (an all-day VALUE=DATE, `YYYY-MM-DD`) or `utc` (an instant, `YYYYMMDDTHHMMSSZ`). A read also answers `local` — the wall clock the object spells — with `tzid` beside it when the property names a zone; the API never converts a TZID time (E05-R09 owns zones). `null` when the object carries no such property.
@JsonSerializable()
class EventTime {
  const EventTime({this.date, this.utc, this.tzid, this.local});

  factory EventTime.fromJson(Map<String, Object?> json) =>
      _$EventTimeFromJson(json);

  /// An all-day date, `YYYY-MM-DD`.
  final String? date;

  /// A UTC instant, `YYYYMMDDTHHMMSSZ`.
  final String? utc;

  /// The `TZID` the stored property names, unchanged.
  final String? tzid;

  /// The wall clock the stored property spells, `YYYYMMDDTHHMMSS`.
  final String? local;

  Map<String, Object?> toJson() => _$EventTimeToJson(this);
}
