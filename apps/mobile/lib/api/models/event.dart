// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'event_parsed.dart';

part 'event.g.dart';

/// One event: the raw iCalendar object the CalDAV collection stores (`ical`, byte for byte) and its `ETag`, plus a parsed convenience view. On a Private calendar the object is the skeleton, and the content lives in the sidecar (E13-R02).
@JsonSerializable()
class Event {
  const Event({
    required this.uid,
    required this.etag,
    required this.ical,
    required this.parsed,
  });

  factory Event.fromJson(Map<String, Object?> json) => _$EventFromJson(json);

  /// The `UID` of the stored object.
  final String uid;

  /// The CalDAV `ETag`, quoted, or null when the store answered without one.
  final String? etag;

  /// The stored iCalendar object, byte for byte.
  final String ical;
  final EventParsed parsed;

  Map<String, Object?> toJson() => _$EventToJson(this);
}
