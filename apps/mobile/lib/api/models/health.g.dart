// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'health.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Health _$HealthFromJson(Map<String, dynamic> json) => Health(
  status: HealthStatus.fromJson(json['status'] as String),
  service: HealthService.fromJson(json['service'] as String),
);

Map<String, dynamic> _$HealthToJson(Health instance) => <String, dynamic>{
  'status': _$HealthStatusEnumMap[instance.status]!,
  'service': _$HealthServiceEnumMap[instance.service]!,
};

const _$HealthStatusEnumMap = {
  HealthStatus.ok: 'ok',
  HealthStatus.$unknown: r'$unknown',
};

const _$HealthServiceEnumMap = {
  HealthService.api: 'api',
  HealthService.$unknown: r'$unknown',
};
