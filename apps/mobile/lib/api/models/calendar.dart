// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'calendar.g.dart';

/// One calendar the caller is a member of. A Private calendar carries its sealed metadata envelope; the API never opens it (D-18).
@JsonSerializable()
class Calendar {
  const Calendar({
    required this.id,
    required this.mode,
    required this.role,
    required this.version,
    required this.metaEnvelope,
    required this.metaEpoch,
    required this.createdAt,
    required this.updatedAt,
  });

  factory Calendar.fromJson(Map<String, Object?> json) =>
      _$CalendarFromJson(json);

  /// The `calendars.id` uuid, which is also the CalDAV collection href.
  final String id;

  /// The calendar mode. Until Phase 4 every calendar is `private` (ADR 0003).
  final String mode;

  /// The caller's role in `calendar_members`: `owner`, `editor` or `viewer`.
  final String role;

  /// The optimistic-concurrency version; also the `ETag`.
  final int version;

  /// A Private calendar's client-sealed metadata envelope, standard base64. Opaque to the API.
  final String metaEnvelope;

  /// The CCK epoch inside the envelope's header.
  final int metaEpoch;

  /// When the calendar was created, ISO 8601.
  final String createdAt;

  /// When the calendar last changed, ISO 8601.
  final String updatedAt;

  Map<String, Object?> toJson() => _$CalendarToJson(this);
}
