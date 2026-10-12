// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'envelope.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Envelope _$EnvelopeFromJson(Map<String, dynamic> json) => Envelope(
  uid: json['uid'] as String,
  deleted: json['deleted'] as bool,
  recurrenceId: json['recurrenceId'] as String?,
  epoch: (json['epoch'] as num?)?.toInt(),
  envelopeSha256: json['envelopeSha256'] as String?,
  envelope: json['envelope'] as String?,
);

Map<String, dynamic> _$EnvelopeToJson(Envelope instance) => <String, dynamic>{
  'uid': instance.uid,
  'deleted': instance.deleted,
  'recurrenceId': instance.recurrenceId,
  'epoch': instance.epoch,
  'envelopeSha256': instance.envelopeSha256,
  'envelope': instance.envelope,
};
