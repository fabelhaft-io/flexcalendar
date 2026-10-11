// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'event_alarm.g.dart';

/// The reminder: an ISO 8601 duration trigger, e.g. `-PT15M` for fifteen minutes before the start. `null` in a write removes it, and `null` in a read means the object carries none. The action and description are fixed (`ACTION:DISPLAY`, `DESCRIPTION:Reminder`).
@JsonSerializable()
class EventAlarm {
  const EventAlarm({required this.trigger});

  factory EventAlarm.fromJson(Map<String, Object?> json) =>
      _$EventAlarmFromJson(json);

  /// An ISO 8601 duration, e.g. `-PT15M`.
  final String trigger;

  Map<String, Object?> toJson() => _$EventAlarmToJson(this);
}
