// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'event_alarm.dart';
import 'event_time.dart';

part 'event_parsed.g.dart';

/// The master VEVENT, parsed. No content and no override list: the raw `ical` beside it is the whole object.
@JsonSerializable()
class EventParsed {
  const EventParsed({
    required this.uid,
    required this.start,
    required this.end,
    required this.rrule,
    required this.alarm,
    required this.sequence,
    required this.envelopeSha256,
  });

  factory EventParsed.fromJson(Map<String, Object?> json) =>
      _$EventParsedFromJson(json);

  /// The master VEVENT `UID`, exactly as stored.
  final String uid;
  final EventTime start;
  final EventTime end;

  /// The master `RRULE`, or null. Never written by a client.
  final String? rrule;
  final EventAlarm alarm;

  /// The master `SEQUENCE`; 0 when the object carries none.
  final int sequence;

  /// The `X-CALFLEX-ENVELOPE-SHA256` of the master VEVENT, 64 lowercase hex digits, or null when it carries none (a Shared calendar object).
  final String? envelopeSha256;

  Map<String, Object?> toJson() => _$EventParsedToJson(this);
}
