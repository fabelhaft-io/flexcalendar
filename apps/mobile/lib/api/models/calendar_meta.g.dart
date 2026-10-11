// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'calendar_meta.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

CalendarMeta _$CalendarMetaFromJson(Map<String, dynamic> json) => CalendarMeta(
  metaEnvelope: json['metaEnvelope'] as String?,
  metaEpoch: (json['metaEpoch'] as num?)?.toInt(),
);

Map<String, dynamic> _$CalendarMetaToJson(CalendarMeta instance) =>
    <String, dynamic>{
      'metaEnvelope': instance.metaEnvelope,
      'metaEpoch': instance.metaEpoch,
    };
