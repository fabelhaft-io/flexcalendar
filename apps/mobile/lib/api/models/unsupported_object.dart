// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'unsupported_object_reason.dart';

part 'unsupported_object.g.dart';

/// One stored object the expansion left out, with the reason. It is not an error: the rest of the window is answered as usual.
@JsonSerializable()
class UnsupportedObject {
  const UnsupportedObject({required this.uid, required this.reason});

  factory UnsupportedObject.fromJson(Map<String, Object?> json) =>
      _$UnsupportedObjectFromJson(json);

  /// The `UID` of the master VEVENT of the object.
  final String uid;

  /// Why the object was not expanded.
  final UnsupportedObjectReason reason;

  Map<String, Object?> toJson() => _$UnsupportedObjectToJson(this);
}
