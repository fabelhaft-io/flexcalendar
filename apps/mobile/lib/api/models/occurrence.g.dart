// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'occurrence.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Occurrence _$OccurrenceFromJson(Map<String, dynamic> json) => Occurrence(
  uid: json['uid'] as String,
  recurrenceId: RecurrenceId.fromJson(
    json['recurrenceId'] as Map<String, dynamic>,
  ),
  override: json['override'] as bool,
  start: OccurrenceTime.fromJson(json['start'] as Map<String, dynamic>),
  end: OccurrenceTime.fromJson(json['end'] as Map<String, dynamic>),
  allDay: json['allDay'] as bool,
  envelopeSha256: json['envelopeSha256'] as String?,
);

Map<String, dynamic> _$OccurrenceToJson(Occurrence instance) =>
    <String, dynamic>{
      'uid': instance.uid,
      'recurrenceId': instance.recurrenceId,
      'override': instance.override,
      'start': instance.start,
      'end': instance.end,
      'allDay': instance.allDay,
      'envelopeSha256': instance.envelopeSha256,
    };
