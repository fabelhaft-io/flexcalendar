// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'health_service.dart';
import 'health_status.dart';

part 'health.g.dart';

@JsonSerializable()
class Health {
  const Health({required this.status, required this.service});

  factory Health.fromJson(Map<String, Object?> json) => _$HealthFromJson(json);

  final HealthStatus status;
  final HealthService service;

  Map<String, Object?> toJson() => _$HealthToJson(this);
}
// hand edit (review only)
