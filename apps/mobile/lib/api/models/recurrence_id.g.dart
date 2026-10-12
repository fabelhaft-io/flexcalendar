// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'recurrence_id.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

RecurrenceId _$RecurrenceIdFromJson(Map<String, dynamic> json) => RecurrenceId(
  date: json['date'] as String?,
  utc: json['utc'] as String?,
  tzid: json['tzid'] as String?,
  local: json['local'] as String?,
);

Map<String, dynamic> _$RecurrenceIdToJson(RecurrenceId instance) =>
    <String, dynamic>{
      'date': instance.date,
      'utc': instance.utc,
      'tzid': instance.tzid,
      'local': instance.local,
    };
