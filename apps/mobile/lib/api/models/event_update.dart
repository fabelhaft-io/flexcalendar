// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'event_alarm.dart';
import 'event_time.dart';

part 'event_update.g.dart';

/// A patch request: the same fields as a create, minus `rrule`. Every member is optional; `null` removes the property it names and an absent member is left alone. `uid`, `rrule`, `exdate` and `recurrenceId` are a 422 — a recurring edit is an intent (E05-R06/R07), and the `UID` never changes (INV-05). `If-Match` is required (428 without it). On a Private calendar the content fields are a 422 (D-18).
@JsonSerializable()
class EventUpdate {
  const EventUpdate({
    this.start,
    this.end,
    this.alarm,
    this.envelopeSha256,
    this.summary,
    this.description,
    this.location,
    this.attendees,
  });

  factory EventUpdate.fromJson(Map<String, Object?> json) =>
      _$EventUpdateFromJson(json);

  final EventTime? start;
  final EventTime? end;
  final EventAlarm? alarm;

  /// The SHA-256 of the re-sealed content envelope, 64 lowercase hex digits. A Private VEVENT carries exactly one (E03-R09).
  final String? envelopeSha256;

  /// The title. Refused with 422 on a Private calendar (D-18).
  final String? summary;

  /// The description. Refused with 422 on a Private calendar (D-18).
  final String? description;

  /// The location. Refused with 422 on a Private calendar (D-18).
  final String? location;

  /// The attendee addresses. Refused with 422 on a Private calendar (D-18).
  final List<String>? attendees;

  Map<String, Object?> toJson() => _$EventUpdateToJson(this);
}
