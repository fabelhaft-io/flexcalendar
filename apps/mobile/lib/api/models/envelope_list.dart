// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'envelope.dart';

part 'envelope_list.g.dart';

/// The envelopes of one read, and the token that stands for the point in the collection they were read at.
@JsonSerializable()
class EnvelopeList {
  const EnvelopeList({required this.token, required this.envelopes});

  factory EnvelopeList.fromJson(Map<String, Object?> json) =>
      _$EnvelopeListFromJson(json);

  /// The sync token of the point this answer was read at, to send back as `since` next time. Bound to this calendar.
  final String token;

  /// One entry per envelope a skeleton names, plus a tombstone per object deleted since `since`.
  final List<Envelope> envelopes;

  Map<String, Object?> toJson() => _$EnvelopeListToJson(this);
}
