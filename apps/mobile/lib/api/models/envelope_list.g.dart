// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'envelope_list.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

EnvelopeList _$EnvelopeListFromJson(Map<String, dynamic> json) => EnvelopeList(
  token: json['token'] as String,
  envelopes: (json['envelopes'] as List<dynamic>)
      .map((e) => Envelope.fromJson(e as Map<String, dynamic>))
      .toList(),
);

Map<String, dynamic> _$EnvelopeListToJson(EnvelopeList instance) =>
    <String, dynamic>{'token': instance.token, 'envelopes': instance.envelopes};
