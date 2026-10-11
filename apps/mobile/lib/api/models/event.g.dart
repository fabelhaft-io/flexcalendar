// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'event.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Event _$EventFromJson(Map<String, dynamic> json) => Event(
  uid: json['uid'] as String,
  etag: json['etag'] as String?,
  ical: json['ical'] as String,
  parsed: EventParsed.fromJson(json['parsed'] as Map<String, dynamic>),
);

Map<String, dynamic> _$EventToJson(Event instance) => <String, dynamic>{
  'uid': instance.uid,
  'etag': instance.etag,
  'ical': instance.ical,
  'parsed': instance.parsed,
};
