// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'event_parsed.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

EventParsed _$EventParsedFromJson(Map<String, dynamic> json) => EventParsed(
  uid: json['uid'] as String,
  start: EventTime.fromJson(json['start'] as Map<String, dynamic>),
  end: EventTime.fromJson(json['end'] as Map<String, dynamic>),
  rrule: json['rrule'] as String?,
  alarm: EventAlarm.fromJson(json['alarm'] as Map<String, dynamic>),
  sequence: (json['sequence'] as num).toInt(),
  envelopeSha256: json['envelopeSha256'] as String?,
);

Map<String, dynamic> _$EventParsedToJson(EventParsed instance) =>
    <String, dynamic>{
      'uid': instance.uid,
      'start': instance.start,
      'end': instance.end,
      'rrule': instance.rrule,
      'alarm': instance.alarm,
      'sequence': instance.sequence,
      'envelopeSha256': instance.envelopeSha256,
    };
