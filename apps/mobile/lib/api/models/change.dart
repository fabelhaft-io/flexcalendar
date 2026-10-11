// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'change.g.dart';

/// One changed object. It carries no event content: fetch the object itself for that.
@JsonSerializable()
class Change {
  const Change({required this.uid, required this.deleted, this.etag});

  factory Change.fromJson(Map<String, Object?> json) => _$ChangeFromJson(json);

  /// The `VEVENT` `UID`, read from the object the collection holds. A tombstone names the `uid` of the object that was removed.
  final String uid;

  /// `true` for a tombstone — the object is gone, and the entry carries no `etag` — and `false` for an object the collection holds now.
  final bool deleted;

  /// The CalDAV `ETag` of a present object. Absent on a tombstone.
  final String? etag;

  Map<String, Object?> toJson() => _$ChangeToJson(this);
}
