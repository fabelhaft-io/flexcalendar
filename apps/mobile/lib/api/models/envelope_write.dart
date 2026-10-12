// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'envelope_write.g.dart';

/// One envelope to store. The API checks its header, its size and that `envelopeSha256` is the SHA-256 of the bytes sent, and nothing else.
@JsonSerializable()
class EnvelopeWrite {
  const EnvelopeWrite({
    required this.envelope,
    required this.epoch,
    required this.envelopeSha256,
    this.recurrenceId,
  });

  factory EnvelopeWrite.fromJson(Map<String, Object?> json) =>
      _$EnvelopeWriteFromJson(json);

  /// The sealed envelope bytes in standard base64: version `0x01`, the big-endian uint32 epoch, the 24-byte nonce, ciphertext and tag. At least 45 bytes, at most 65,536.
  final String envelope;

  /// The CCK epoch, which must equal the epoch the envelope header carries and be 0 through 2147483647.
  final int epoch;

  /// The SHA-256 of the complete envelope bytes, 64 lowercase hex digits. The API refuses bytes that do not hash to it.
  final String envelopeSha256;

  /// The canonical recurrence identity of the `VEVENT` this envelope belongs to, `spec/crypto.md` §5.2, or null or absent for the master.
  final String? recurrenceId;

  Map<String, Object?> toJson() => _$EnvelopeWriteToJson(this);
}
