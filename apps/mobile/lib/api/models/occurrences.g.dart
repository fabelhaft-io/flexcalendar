// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'occurrences.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Occurrences _$OccurrencesFromJson(Map<String, dynamic> json) => Occurrences(
  occurrences: (json['occurrences'] as List<dynamic>)
      .map((e) => Occurrence.fromJson(e as Map<String, dynamic>))
      .toList(),
  unsupported: (json['unsupported'] as List<dynamic>)
      .map((e) => UnsupportedObject.fromJson(e as Map<String, dynamic>))
      .toList(),
);

Map<String, dynamic> _$OccurrencesToJson(Occurrences instance) =>
    <String, dynamic>{
      'occurrences': instance.occurrences,
      'unsupported': instance.unsupported,
    };
