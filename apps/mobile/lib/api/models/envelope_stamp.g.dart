// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'envelope_stamp.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

EnvelopeStamp _$EnvelopeStampFromJson(Map<String, dynamic> json) =>
    EnvelopeStamp(
      uid: json['uid'] as String,
      recurrenceId: json['recurrenceId'] as String?,
      epoch: (json['epoch'] as num).toInt(),
      envelopeSha256: json['envelopeSha256'] as String,
      etag: json['etag'] as String?,
    );

Map<String, dynamic> _$EnvelopeStampToJson(EnvelopeStamp instance) =>
    <String, dynamic>{
      'uid': instance.uid,
      'recurrenceId': instance.recurrenceId,
      'epoch': instance.epoch,
      'envelopeSha256': instance.envelopeSha256,
      'etag': instance.etag,
    };
