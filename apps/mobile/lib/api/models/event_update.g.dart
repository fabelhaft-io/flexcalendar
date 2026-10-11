// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'event_update.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

EventUpdate _$EventUpdateFromJson(Map<String, dynamic> json) => EventUpdate(
  start: json['start'] == null
      ? null
      : EventTime.fromJson(json['start'] as Map<String, dynamic>),
  end: json['end'] == null
      ? null
      : EventTime.fromJson(json['end'] as Map<String, dynamic>),
  alarm: json['alarm'] == null
      ? null
      : EventAlarm.fromJson(json['alarm'] as Map<String, dynamic>),
  envelopeSha256: json['envelopeSha256'] as String?,
  summary: json['summary'] as String?,
  description: json['description'] as String?,
  location: json['location'] as String?,
  attendees: (json['attendees'] as List<dynamic>?)
      ?.map((e) => e as String)
      .toList(),
);

Map<String, dynamic> _$EventUpdateToJson(EventUpdate instance) =>
    <String, dynamic>{
      'start': instance.start,
      'end': instance.end,
      'alarm': instance.alarm,
      'envelopeSha256': instance.envelopeSha256,
      'summary': instance.summary,
      'description': instance.description,
      'location': instance.location,
      'attendees': instance.attendees,
    };
