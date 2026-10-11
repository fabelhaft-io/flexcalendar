// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'occurrence_time.g.dart';

/// One occurrence time, in the zone the request asked for: the instant, the wall clock that zone reads for it, and the zone. An all-day occurrence is its `date` instead, because a day has no instant of its own and which instants it covers depends on the zone it is viewed from.
@JsonSerializable()
class OccurrenceTime {
  const OccurrenceTime({this.date, this.utc, this.tzid, this.local});

  factory OccurrenceTime.fromJson(Map<String, Object?> json) =>
      _$OccurrenceTimeFromJson(json);

  /// An all-day date, `YYYY-MM-DD`; the end is the exclusive next date.
  final String? date;

  /// The instant, `YYYYMMDDTHHMMSSZ`.
  final String? utc;

  /// The zone the request asked for, so the wall clock can be read back.
  final String? tzid;

  /// The wall clock that zone reads for `utc`, `YYYYMMDDTHHMMSS`.
  final String? local;

  Map<String, Object?> toJson() => _$OccurrenceTimeToJson(this);
}
