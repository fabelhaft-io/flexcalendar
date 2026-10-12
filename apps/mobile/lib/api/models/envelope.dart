// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'envelope.g.dart';

/// One sealed envelope as the sidecar holds it, with the metadata that selects it. Opaque to the API, which never opens one (INV-07). A tombstone — the uid of an object deleted since `since` — is an entry carrying only `uid` and `deleted`.
@JsonSerializable()
class Envelope {
  const Envelope({
    required this.uid,
    required this.deleted,
    this.recurrenceId,
    this.epoch,
    this.envelopeSha256,
    this.envelope,
  });

  factory Envelope.fromJson(Map<String, Object?> json) =>
      _$EnvelopeFromJson(json);

  /// The `VEVENT` `UID` the envelope belongs to.
  final String uid;

  /// `true` for the uid of an object deleted since `since`, which has no envelope any more; `false` for an envelope a skeleton names.
  final bool deleted;

  /// The canonical recurrence identity of the `VEVENT` this envelope belongs to, `spec/crypto.md` §5.2, or null for the master.
  final String? recurrenceId;

  /// The CCK epoch the envelope header carries.
  final int? epoch;

  /// The SHA-256 of the complete envelope bytes, 64 lowercase hex digits, which is the value the skeleton carries.
  final String? envelopeSha256;

  /// The sealed envelope bytes, standard base64 and opaque.
  final String? envelope;

  Map<String, Object?> toJson() => _$EnvelopeToJson(this);
}
