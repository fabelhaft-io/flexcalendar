/// The calendar content key and its sealed, signed records, `spec/crypto.md`
/// §6.5 and §6.6 (D-15).
///
/// - The **CCK** is 32 random bytes per `(calendar, epoch)`, never derived from a
///   user key, a password, a calendar name or a UUID (§6.5). Epoch 1 is sealed to
///   the calendar's owner when it is created (E13-R01); a rotation that removes a
///   member starts epoch N+1 (E13-R05).
/// - A **record** is one entry of `calendar_keys.record`, where the table's
///   `user_id` is the **recipient**. A sealed box proves nothing about the sender,
///   so every record is signed with the sender's Ed25519 identity key (D-15):
///
/// ```
/// offset  size  field
///      0     1  version = 0x01
///      1     1  suite: 0x01 = X25519 seal + Ed25519 signature
///      2    16  signer user id, raw UUIDv4 bytes
///     18    32  crypto_box_seal ephemeral public key
///     50    16  crypto_box_easy Poly1305 tag — first, as libsodium writes it
///     66    32  crypto_box_easy ciphertext: the sealed CCK
///     98    64  Ed25519 signature by the signer's identity key
///               total 162 bytes
/// ```
///
/// ```
/// sig_msg = "calflex-cck-record-v1" ‖ lp32(calendar_id) ‖ lp32(recipient user id)
///                                     ‖ lp32(epoch as canonical decimal)
///                                     ‖ lp32(record[0:98])
/// ```
///
/// Opening verifies the signature **first** (§6.6 step 2): a moved or re-addressed
/// record fails there, and the signature is the only thing that proves "this record
/// came from that user". A recipient **MUST** refuse to use a CCK from a sender
/// whose identity key it has not verified, and the returned [CckRecord.signerUserId]
/// is what it compares against the verified key it looked the record up with.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:sodium/sodium.dart';

import 'aad.dart' show cckBytes, checkEpoch, frame;
import 'encoding.dart';
import 'errors.dart';
import 'key_material.dart' show x25519PublicKeyBytes, x25519PublicKeyOf;
import 'libsodium.dart';
import 'sealed_box.dart';

/// The one record version this implementation writes or reads (§6.6).
const int cckRecordVersion = 0x01;

/// The one suite byte this implementation writes or reads (§6.6).
const int cckRecordSuite = 0x01;

/// §6.6's signature label.
const String cckRecordLabel = 'calflex-cck-record-v1';

/// `1 + 1 + 16 + 80 + 64`: today's record, exactly (§6.6).
const int cckRecordBytes = 162;

/// What the API should refuse: a record shorter than the fixed header through the
/// seal's ephemeral key (§6.6).
const int minCckRecordBytes = 50;

/// What the API should refuse: a record longer than this (§6.6).
const int maxCckRecordBytes = 1024;

/// The offset of the sealed 80-byte box inside a record.
const int cckRecordSealedOffset = 18;

/// The offset of the signature inside a record.
const int cckRecordSignatureOffset = 98;

/// 32 bytes from the CSPRNG, one per `(calendar, epoch)` (§6.5).
Uint8List generateCck() => randomBytes(cckBytes);

/// What a recipient gets out of a record: the CCK and who signed it.
class CckRecord {
  /// Wraps the two values a record carries.
  CckRecord({required this.cck, required this.signerUserId});

  /// The 32-byte calendar content key.
  final Uint8List cck;

  /// The canonical lowercase UUIDv4 text of the signer, from the record's header
  /// (raw bytes 2…18).
  ///
  /// The record carries it because `calendar_keys` has no `signer` column; the
  /// signature covers those bytes, so this is *who signed*, not who the server
  /// says signed. The caller **MUST** compare it with the identity key it verified
  /// (D-15, E13-R05).
  final String signerUserId;
}

/// Seals [cck] to a member and signs the record with the sender's identity key.
///
/// The sealed box draws a fresh ephemeral key on every seal, so two records for
/// the same member and epoch are different bytes; [sealCckRecordWithEphemeralKey]
/// is the test-only form §6.6's vectors pin.
Uint8List sealCckRecord({
  required Uint8List cck,
  required String calendarId,
  required int epoch,
  required String recipientUserId,
  required Uint8List recipientX25519PublicKey,
  required String signerUserId,
  required Uint8List signerEd25519SecretKey,
}) => sealCckRecordWithEphemeralKey(
  cck: cck,
  calendarId: calendarId,
  epoch: epoch,
  recipientUserId: recipientUserId,
  recipientX25519PublicKey: recipientX25519PublicKey,
  signerUserId: signerUserId,
  signerEd25519SecretKey: signerEd25519SecretKey,
  ephemeralSecretKey: randomBytes(x25519PublicKeyBytes),
);

/// Seals [cck] under a caller-supplied ephemeral key.
///
/// **Test-only.** §6.6 pins the record a fixed ephemeral key produces so the seal
/// can be reproduced byte for byte; nothing in the library calls this, and it is
/// not exported from `package:crypto_dart/crypto_dart.dart`.
Uint8List sealCckRecordWithEphemeralKey({
  required Uint8List cck,
  required String calendarId,
  required int epoch,
  required String recipientUserId,
  required Uint8List recipientX25519PublicKey,
  required String signerUserId,
  required Uint8List signerEd25519SecretKey,
  required Uint8List ephemeralSecretKey,
}) {
  checkUuidV4(calendarId);
  checkUuidV4(recipientUserId);
  checkUuidV4(signerUserId);
  checkEpoch(epoch);
  if (cck.length != cckBytes) {
    throw const CryptoException(CryptoError.length, 'a CCK is 32 bytes');
  }
  if (signerEd25519SecretKey.length != 64) {
    throw const CryptoException(
      CryptoError.length,
      'an Ed25519 secret key is 64 bytes',
    );
  }
  // §6.6 step 1.
  final sealed = sealBox(
    message: cck,
    recipientPublicKey: recipientX25519PublicKey,
    ephemeralSecretKey: ephemeralSecretKey,
  );
  final head = Uint8List(cckRecordSignatureOffset);
  head[0] = cckRecordVersion;
  head[1] = cckRecordSuite;
  head.setRange(2, 18, decodeUuidV4(signerUserId));
  head.setRange(cckRecordSealedOffset, cckRecordSignatureOffset, sealed);
  // §6.6 step 3.
  final signature = _sign(
    cckRecordMessage(
      calendarId: calendarId,
      recipientUserId: recipientUserId,
      epoch: epoch,
      head: head,
    ),
    signerEd25519SecretKey,
  );
  return Uint8List.fromList([...head, ...signature]);
}

/// Verifies a record's signature and then opens its sealed box (§6.6).
///
/// [recipientUserId] is the **caller's own** id — the record was addressed to it —
/// and [signerEd25519PublicKey] is the identity key the caller verified for the
/// sender. The CCK comes out only if the record is addressed to this recipient, in
/// this calendar, in this epoch, and signed by that key.
CckRecord openCckRecord({
  required Uint8List record,
  required String calendarId,
  required int epoch,
  required String recipientUserId,
  required Uint8List recipientX25519SecretKey,
  required Uint8List signerEd25519PublicKey,
}) {
  // §6.6 step 1: the length is exact, whatever else the blob holds.
  if (record.length != cckRecordBytes) {
    throw CryptoException(
      CryptoError.length,
      'a CCK record that is not $cckRecordBytes bytes',
    );
  }
  if (record[0] != cckRecordVersion) {
    throw const CryptoException(
      CryptoError.version,
      'an unknown CCK record version',
    );
  }
  if (record[1] != cckRecordSuite) {
    throw const CryptoException(
      CryptoError.unsupported,
      'a CCK record suite this version does not implement',
    );
  }
  checkUuidV4(calendarId);
  checkUuidV4(recipientUserId);
  checkEpoch(epoch);
  if (signerEd25519PublicKey.length != 32) {
    throw const CryptoException(
      CryptoError.length,
      'an Ed25519 public key is 32 bytes',
    );
  }
  // §6.6 step 2: verification comes first, and a moved or re-addressed record
  // fails here.
  final verified = libSodium.crypto.sign.verifyDetached(
    message: cckRecordMessage(
      calendarId: calendarId,
      recipientUserId: recipientUserId,
      epoch: epoch,
      head: Uint8List.sublistView(record, 0, cckRecordSignatureOffset),
    ),
    signature: Uint8List.sublistView(
      record,
      cckRecordSignatureOffset,
      cckRecordBytes,
    ),
    publicKey: signerEd25519PublicKey,
  );
  if (!verified) {
    throw const CryptoException(
      CryptoError.signature,
      'the CCK record is not signed by that identity key',
    );
  }
  // §6.6 step 3: the caller holds only its secret key, so it derives the public
  // one and hands libsodium both; the ephemeral key is read from the box itself.
  final recipientPublicKey = x25519PublicKeyOf(recipientX25519SecretKey);
  final cck = openSealedBox(
    sealed: Uint8List.sublistView(
      record,
      cckRecordSealedOffset,
      cckRecordSignatureOffset,
    ),
    recipientPublicKey: recipientPublicKey,
    recipientSecretKey: recipientX25519SecretKey,
  );
  if (cck.length != cckBytes) {
    throw const CryptoException(
      CryptoError.length,
      'a sealed CCK that is not 32 bytes',
    );
  }
  return CckRecord(
    cck: cck,
    signerUserId: encodeUuidV4(
      Uint8List.sublistView(record, 2, cckRecordSealedOffset),
    ),
  );
}

/// §6.6's `sig_msg`, built from the caller's calendar, recipient and epoch plus
/// the record's first 98 bytes.
Uint8List cckRecordMessage({
  required String calendarId,
  required String recipientUserId,
  required int epoch,
  required Uint8List head,
}) => frame(cckRecordLabel, [
  utf8.encode(calendarId),
  utf8.encode(recipientUserId),
  utf8.encode(epoch.toString()),
  head,
]);

Uint8List _sign(Uint8List message, Uint8List ed25519SecretKey) {
  final key = SecureKey.fromList(
    libSodium,
    Uint8List.fromList(ed25519SecretKey),
  );
  try {
    return libSodium.crypto.sign.detached(message: message, secretKey: key);
  } finally {
    key.dispose();
  }
}
