// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'calendar_list.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

CalendarList _$CalendarListFromJson(Map<String, dynamic> json) => CalendarList(
  calendars: (json['calendars'] as List<dynamic>)
      .map((e) => Calendar.fromJson(e as Map<String, dynamic>))
      .toList(),
);

Map<String, dynamic> _$CalendarListToJson(CalendarList instance) =>
    <String, dynamic>{'calendars': instance.calendars};
