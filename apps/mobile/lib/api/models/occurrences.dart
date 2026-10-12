// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'occurrence.dart';
import 'unsupported_object.dart';

part 'occurrences.g.dart';

/// The expanded occurrences of the window, sorted by start instant, and the objects that were left out.
@JsonSerializable()
class Occurrences {
  const Occurrences({required this.occurrences, required this.unsupported});

  factory Occurrences.fromJson(Map<String, Object?> json) =>
      _$OccurrencesFromJson(json);

  /// One entry per instance that overlaps the window, including the override VEVENTs.
  final List<Occurrence> occurrences;

  /// The stored objects that were not expanded, and why. Empty when every object was.
  final List<UnsupportedObject> unsupported;

  Map<String, Object?> toJson() => _$OccurrencesToJson(this);
}
