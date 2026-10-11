// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'calendar.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Calendar _$CalendarFromJson(Map<String, dynamic> json) => Calendar(
  id: json['id'] as String,
  mode: json['mode'] as String,
  role: json['role'] as String,
  version: (json['version'] as num).toInt(),
  metaEnvelope: json['metaEnvelope'] as String,
  metaEpoch: (json['metaEpoch'] as num).toInt(),
  createdAt: json['createdAt'] as String,
  updatedAt: json['updatedAt'] as String,
);

Map<String, dynamic> _$CalendarToJson(Calendar instance) => <String, dynamic>{
  'id': instance.id,
  'mode': instance.mode,
  'role': instance.role,
  'version': instance.version,
  'metaEnvelope': instance.metaEnvelope,
  'metaEpoch': instance.metaEpoch,
  'createdAt': instance.createdAt,
  'updatedAt': instance.updatedAt,
};
