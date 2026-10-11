// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'user.g.dart';

/// One `public.users` row; every field is a string.
@JsonSerializable()
class User {
  const User({required this.id, required this.handle, required this.email});

  factory User.fromJson(Map<String, Object?> json) => _$UserFromJson(json);

  /// The `users.id` uuid.
  final String id;
  final String handle;
  final String email;

  Map<String, Object?> toJson() => _$UserToJson(this);
}
