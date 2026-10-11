// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'calendar_create.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

CalendarCreate _$CalendarCreateFromJson(Map<String, dynamic> json) =>
    CalendarCreate(
      mode: json['mode'] as String?,
      metaEnvelope: json['metaEnvelope'] as String?,
      metaEpoch: (json['metaEpoch'] as num?)?.toInt(),
      name: json['name'] as String?,
      color: json['color'] as String?,
    );

Map<String, dynamic> _$CalendarCreateToJson(CalendarCreate instance) =>
    <String, dynamic>{
      'mode': instance.mode,
      'metaEnvelope': instance.metaEnvelope,
      'metaEpoch': instance.metaEpoch,
      'name': instance.name,
      'color': instance.color,
    };
