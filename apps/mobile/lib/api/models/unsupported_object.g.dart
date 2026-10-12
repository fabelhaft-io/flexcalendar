// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'unsupported_object.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

UnsupportedObject _$UnsupportedObjectFromJson(Map<String, dynamic> json) =>
    UnsupportedObject(
      uid: json['uid'] as String,
      reason: UnsupportedObjectReason.fromJson(json['reason'] as String),
    );

Map<String, dynamic> _$UnsupportedObjectToJson(UnsupportedObject instance) =>
    <String, dynamic>{
      'uid': instance.uid,
      'reason': _$UnsupportedObjectReasonEnumMap[instance.reason]!,
    };

const _$UnsupportedObjectReasonEnumMap = {
  UnsupportedObjectReason.tooManyInstances: 'too-many-instances',
  UnsupportedObjectReason.unknownZone: 'unknown-zone',
  UnsupportedObjectReason.rruleNotExpanded: 'rrule-not-expanded',
  UnsupportedObjectReason.$unknown: r'$unknown',
};
