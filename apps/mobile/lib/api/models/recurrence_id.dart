// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'recurrence_id.g.dart';

/// The original start of this instance, in the form the stored object spells it: `date` for an all-day occurrence, `utc` for an instant, or `local` beside the `tzid` it is written in, with `utc` the instant that reading names. `null` for an event that does not recur. It is what an edit intent sends back to address this occurrence (E05-R06/R07), never something a client writes.
@JsonSerializable()
class RecurrenceId {
  const RecurrenceId({this.date, this.utc, this.tzid, this.local});

  factory RecurrenceId.fromJson(Map<String, Object?> json) =>
      _$RecurrenceIdFromJson(json);

  /// An all-day date, `YYYY-MM-DD`.
  final String? date;

  /// A UTC instant, `YYYYMMDDTHHMMSSZ`.
  final String? utc;

  /// The `TZID` the stored property names, or the zone the reading is written in.
  final String? tzid;

  /// The wall clock the stored property spells, `YYYYMMDDTHHMMSS`.
  final String? local;

  Map<String, Object?> toJson() => _$RecurrenceIdToJson(this);
}
