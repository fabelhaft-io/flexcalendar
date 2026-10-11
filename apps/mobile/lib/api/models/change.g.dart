// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'change.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Change _$ChangeFromJson(Map<String, dynamic> json) => Change(
  uid: json['uid'] as String,
  deleted: json['deleted'] as bool,
  etag: json['etag'] as String?,
);

Map<String, dynamic> _$ChangeToJson(Change instance) => <String, dynamic>{
  'uid': instance.uid,
  'deleted': instance.deleted,
  'etag': instance.etag,
};
