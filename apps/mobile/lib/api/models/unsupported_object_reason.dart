// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

/// Why the object was not expanded.
@JsonEnum()
enum UnsupportedObjectReason {
  @JsonValue('too-many-instances')
  tooManyInstances('too-many-instances'),
  @JsonValue('unknown-zone')
  unknownZone('unknown-zone'),
  @JsonValue('rrule-not-expanded')
  rruleNotExpanded('rrule-not-expanded'),

  /// Default value for all unparsed values, allows backward compatibility when adding new values on the backend.
  $unknown(null);

  const UnsupportedObjectReason(this.json);

  factory UnsupportedObjectReason.fromJson(String json) =>
      values.firstWhere((e) => e.json == json, orElse: () => $unknown);

  final String? json;

  @override
  String toString() => json?.toString() ?? super.toString();

  /// Returns all defined enum values excluding the $unknown value.
  static List<UnsupportedObjectReason> get $valuesDefined =>
      values.where((value) => value != $unknown).toList();
}
