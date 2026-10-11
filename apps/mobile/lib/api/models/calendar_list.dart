// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'calendar.dart';

part 'calendar_list.g.dart';

/// The calendars the caller is a member of.
@JsonSerializable()
class CalendarList {
  const CalendarList({required this.calendars});

  factory CalendarList.fromJson(Map<String, Object?> json) =>
      _$CalendarListFromJson(json);

  /// Oldest first. A Private calendar the caller cannot see is not listed.
  final List<Calendar> calendars;

  Map<String, Object?> toJson() => _$CalendarListToJson(this);
}
