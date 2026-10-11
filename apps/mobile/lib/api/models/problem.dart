// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'event.dart';

part 'problem.g.dart';

/// An RFC 9457 problem document. `type` is stable per kind; `title` is fixed copy; `instance` is `urn:uuid:<the request correlation ID>`.
@JsonSerializable()
class Problem {
  const Problem({
    required this.type,
    required this.title,
    required this.status,
    required this.instance,
    this.property,
    this.current,
  });

  factory Problem.fromJson(Map<String, Object?> json) =>
      _$ProblemFromJson(json);

  final String type;
  final String title;
  final int status;
  final String instance;
  final String? property;
  final Event? current;

  Map<String, Object?> toJson() => _$ProblemToJson(this);
}
