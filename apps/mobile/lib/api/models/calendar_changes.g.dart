// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'calendar_changes.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

CalendarChanges _$CalendarChangesFromJson(Map<String, dynamic> json) =>
    CalendarChanges(
      token: json['token'] as String,
      changes: (json['changes'] as List<dynamic>)
          .map((e) => Change.fromJson(e as Map<String, dynamic>))
          .toList(),
    );

Map<String, dynamic> _$CalendarChangesToJson(CalendarChanges instance) =>
    <String, dynamic>{'token': instance.token, 'changes': instance.changes};
