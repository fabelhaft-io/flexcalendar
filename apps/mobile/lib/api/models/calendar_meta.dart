// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'calendar_meta.g.dart';

/// A rename or recolour: it replaces the sealed envelope and the epoch it names, and it carries no plaintext `name` or `color` — those are a 422 on a Private calendar (D-18), and so is any other member, `mode` included.
@JsonSerializable()
class CalendarMeta {
  const CalendarMeta({this.metaEnvelope, this.metaEpoch});

  factory CalendarMeta.fromJson(Map<String, Object?> json) =>
      _$CalendarMetaFromJson(json);

  /// The replacing metadata envelope, in the same layout and encoding as on create.
  final String? metaEnvelope;

  /// The CCK epoch the replacing envelope's header carries, in the same range as on create.
  final int? metaEpoch;

  Map<String, Object?> toJson() => _$CalendarMetaToJson(this);
}
