// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'envelope_write.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

EnvelopeWrite _$EnvelopeWriteFromJson(Map<String, dynamic> json) =>
    EnvelopeWrite(
      envelope: json['envelope'] as String,
      epoch: (json['epoch'] as num).toInt(),
      envelopeSha256: json['envelopeSha256'] as String,
      recurrenceId: json['recurrenceId'] as String?,
    );

Map<String, dynamic> _$EnvelopeWriteToJson(EnvelopeWrite instance) =>
    <String, dynamic>{
      'envelope': instance.envelope,
      'epoch': instance.epoch,
      'envelopeSha256': instance.envelopeSha256,
      'recurrenceId': instance.recurrenceId,
    };
