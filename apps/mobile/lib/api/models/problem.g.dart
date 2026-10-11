// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'problem.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Problem _$ProblemFromJson(Map<String, dynamic> json) => Problem(
  type: json['type'] as String,
  title: json['title'] as String,
  status: (json['status'] as num).toInt(),
  instance: json['instance'] as String,
  property: json['property'] as String?,
  current: json['current'] == null
      ? null
      : Event.fromJson(json['current'] as Map<String, dynamic>),
);

Map<String, dynamic> _$ProblemToJson(Problem instance) => <String, dynamic>{
  'type': instance.type,
  'title': instance.title,
  'status': instance.status,
  'instance': instance.instance,
  'property': instance.property,
  'current': instance.current,
};
