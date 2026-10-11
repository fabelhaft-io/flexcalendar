// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'event_alarm.dart';
import 'event_time.dart';

part 'event_create.g.dart';

/// A create request. `start` is required; the API mints the `UID` and the `DTSTAMP`. On a Private calendar the content fields (`summary`, `description`, `location`, `attendees`) are a 422 and `envelopeSha256` is required — a Private object is a skeleton and the content lives in the sidecar (D-18, E03-R09). Any other member is a 422 as well.
@JsonSerializable()
class EventCreate {
  const EventCreate({
    required this.start,
    this.end,
    this.rrule,
    this.alarm,
    this.envelopeSha256,
    this.summary,
    this.description,
    this.location,
    this.attendees,
  });

  factory EventCreate.fromJson(Map<String, Object?> json) =>
      _$EventCreateFromJson(json);

  final EventTime start;
  final EventTime? end;

  /// The recurrence rule, validated by `ical.js`. Create only: a change to a recurring event is an intent (E05-R06/R07), never a rule a client writes.
  final String? rrule;
  final EventAlarm? alarm;

  /// The SHA-256 of the sealed content envelope, 64 lowercase hex digits. A Private VEVENT carries exactly one (E03-R09).
  final String? envelopeSha256;

  /// The title. Refused with 422 on a Private calendar (D-18); Shared calendars take one from Phase 4.
  final String? summary;

  /// The description. Refused with 422 on a Private calendar (D-18).
  final String? description;

  /// The location. Refused with 422 on a Private calendar (D-18).
  final String? location;

  /// The attendee addresses. Refused with 422 on a Private calendar (D-18).
  final List<String>? attendees;

  Map<String, Object?> toJson() => _$EventCreateToJson(this);
}
