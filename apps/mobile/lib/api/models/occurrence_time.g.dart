// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'occurrence_time.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

OccurrenceTime _$OccurrenceTimeFromJson(Map<String, dynamic> json) =>
    OccurrenceTime(
      date: json['date'] as String?,
      utc: json['utc'] as String?,
      tzid: json['tzid'] as String?,
      local: json['local'] as String?,
    );

Map<String, dynamic> _$OccurrenceTimeToJson(OccurrenceTime instance) =>
    <String, dynamic>{
      'date': instance.date,
      'utc': instance.utc,
      'tzid': instance.tzid,
      'local': instance.local,
    };
