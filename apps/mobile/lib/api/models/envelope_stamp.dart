// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'envelope_stamp.g.dart';

/// The envelope that was committed, its key, and the skeleton `ETag` the commit left.
@JsonSerializable()
class EnvelopeStamp {
  const EnvelopeStamp({
    required this.uid,
    required this.recurrenceId,
    required this.epoch,
    required this.envelopeSha256,
    required this.etag,
  });

  factory EnvelopeStamp.fromJson(Map<String, Object?> json) =>
      _$EnvelopeStampFromJson(json);

  /// The `VEVENT` `UID` the envelope belongs to.
  final String uid;

  /// The canonical recurrence identity this envelope belongs to, or null for the master.
  final String? recurrenceId;

  /// The CCK epoch the envelope header carries.
  final int epoch;

  /// The SHA-256 of the stored envelope bytes, 64 lowercase hex digits.
  final String envelopeSha256;

  /// The CalDAV `ETag` of the skeleton the commit wrote, or null when the store answered without one.
  final String? etag;

  Map<String, Object?> toJson() => _$EnvelopeStampToJson(this);
}
