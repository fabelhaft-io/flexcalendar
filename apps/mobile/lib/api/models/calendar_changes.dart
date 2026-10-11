// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'change.dart';

part 'calendar_changes.g.dart';

/// The changes since a token, and the token that stands for that point in the collection. With no `since`, the whole collection is reported as present objects.
@JsonSerializable()
class CalendarChanges {
  const CalendarChanges({required this.token, required this.changes});

  factory CalendarChanges.fromJson(Map<String, Object?> json) =>
      _$CalendarChangesFromJson(json);

  /// The sync token to send back as `since` next time. Bound to this calendar; another calendar answers 410 for it.
  final String token;

  /// One entry per changed object, a tombstone for a deletion. Empty when nothing changed since `since`.
  final List<Change> changes;

  Map<String, Object?> toJson() => _$CalendarChangesToJson(this);
}
