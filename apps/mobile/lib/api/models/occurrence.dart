// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'occurrence_time.dart';
import 'recurrence_id.dart';

part 'occurrence.g.dart';

/// One expanded occurrence. It carries no content: fetch the event itself for that. An override VEVENT is a second occurrence with `override` true and the `recurrenceId` it replaces.
@JsonSerializable()
class Occurrence {
  const Occurrence({
    required this.uid,
    required this.recurrenceId,
    required this.override,
    required this.start,
    required this.end,
    required this.allDay,
    required this.envelopeSha256,
  });

  factory Occurrence.fromJson(Map<String, Object?> json) =>
      _$OccurrenceFromJson(json);

  /// The `UID` of the master VEVENT.
  final String uid;
  final RecurrenceId recurrenceId;

  /// `true` when an override VEVENT defines this occurrence, `false` for one the rule of the master VEVENT derives.
  final bool override;
  final OccurrenceTime start;
  final OccurrenceTime end;

  /// `true` for an all-day occurrence, whose `start` and `end` are dates rather than instants.
  final bool allDay;

  /// The `X-CALFLEX-ENVELOPE-SHA256` of the VEVENT that defines this occurrence, or null when it carries none.
  final String? envelopeSha256;

  Map<String, Object?> toJson() => _$OccurrenceToJson(this);
}
