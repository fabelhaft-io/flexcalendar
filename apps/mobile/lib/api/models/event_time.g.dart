// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'event_time.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

EventTime _$EventTimeFromJson(Map<String, dynamic> json) => EventTime(
  date: json['date'] as String?,
  utc: json['utc'] as String?,
  tzid: json['tzid'] as String?,
  local: json['local'] as String?,
);

Map<String, dynamic> _$EventTimeToJson(EventTime instance) => <String, dynamic>{
  'date': instance.date,
  'utc': instance.utc,
  'tzid': instance.tzid,
  'local': instance.local,
};
