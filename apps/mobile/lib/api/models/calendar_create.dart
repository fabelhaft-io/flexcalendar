// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'calendar_create.g.dart';

/// A create request. `mode` is required and has no default (ADR 0001); until Phase 4 only `private` is accepted (ADR 0003). A Private calendar takes `metaEnvelope` and `metaEpoch` and no plaintext `name` or `color` (D-18). The API answers 422 for every rule of this list; a member the operation does not take is a 422 too.
@JsonSerializable()
class CalendarCreate {
  const CalendarCreate({
    this.mode,
    this.metaEnvelope,
    this.metaEpoch,
    this.name,
    this.color,
  });

  factory CalendarCreate.fromJson(Map<String, Object?> json) =>
      _$CalendarCreateFromJson(json);

  /// The calendar mode. Until Phase 4, `private` is the only accepted value.
  final String? mode;

  /// The client-sealed metadata envelope (version `0x01`, the CCK epoch as a big-endian uint32, a 24-byte nonce, ciphertext and a 16-byte tag), standard base64, at most 4096 bytes.
  final String? metaEnvelope;

  /// The CCK epoch the envelope's header carries. The header field is a uint32, but the API accepts only what `calendars.meta_epoch` holds (an `integer`); anything above it is a 422, never a database error.
  final int? metaEpoch;

  /// A plaintext display name. Refused with 422 on a Private calendar (D-18); Shared calendars take one from Phase 4.
  final String? name;

  /// A plaintext colour. Refused with 422 on a Private calendar (D-18); Shared calendars take one from Phase 4.
  final String? color;

  Map<String, Object?> toJson() => _$CalendarCreateToJson(this);
}
