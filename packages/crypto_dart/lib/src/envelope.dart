/// Envelope seal and open, `spec/crypto.md` §1.
///
/// One envelope per event, and one more per Private calendar (its name and
/// colour, D-18). Both are the same byte layout, keyed with the same calendar
/// content key for the same epoch, and told apart by the **domain label in the
/// AAD** (§2.4), never by a byte in the header.
///
/// ```
/// offset  size  field
///      0     1  version (0x01)
///      1     4  epoch, u32 big-endian
///      5    24  XChaCha20 nonce, fresh for every seal
///     29     n  ciphertext
///   29+n    16  Poly1305 tag
/// ```
///
/// No function here ever logs or returns a payload byte on a refusal, and none
/// takes a password (D-17, INV-12).
library;

import 'dart:typed_data';

import 'package:sodium/sodium.dart';

import 'aad.dart';
import 'errors.dart';
import 'libsodium.dart';
import 'payload.dart';

/// A fresh 24-byte nonce from the CSPRNG.
///
/// A nonce **MUST NOT** be reused under one key (§1.2): XChaCha20-Poly1305 is
/// broken catastrophically by a repeat, so the device's CSPRNG is the only
/// source — never a counter, which a device that lost its state would restart.
Uint8List freshNonce() => libSodium.randombytes.buf(nonceBytes);

/// Seals an event envelope: `seal(cck, epoch, skeleton, payload) → bytes` (§1.2).
///
/// The nonce is drawn from the CSPRNG here; [sealEventWithNonce] is the
/// test-only entry point of §1.2 step 4.
Uint8List sealEvent({
  required Uint8List cck,
  required int epoch,
  required EventSkeleton skeleton,
  required Map<String, Object?> payload,
}) => sealEventWithNonce(
  cck: cck,
  epoch: epoch,
  skeleton: skeleton,
  payload: payload,
  nonce: freshNonce(),
);

/// Seals an event envelope under a caller-supplied nonce.
///
/// **Test-only.** Nothing in the library calls this, and it is not exported from
/// `package:crypto_dart/crypto_dart.dart`: §1.2 step 4 lets a vector test seal
/// deterministically, and a production caller that picked its own nonce would be
/// one mistake away from a catastrophic nonce reuse.
Uint8List sealEventWithNonce({
  required Uint8List cck,
  required int epoch,
  required EventSkeleton skeleton,
  required Map<String, Object?> payload,
  required Uint8List nonce,
}) => _seal(
  cck: cck,
  epoch: epoch,
  payload: payload,
  kind: PayloadKind.event,
  nonce: nonce,
  aad: skeleton.aad(epoch),
  ceiling: maxEventEnvelopeBytes,
);

/// Opens an event envelope and returns its payload bytes (§1.3).
///
/// Never returns partial plaintext: every AEAD failure — a wrong key, a flipped
/// tag or ciphertext bit, a mismatched AAD, the wrong envelope kind — is the same
/// `E_AUTH` (§0.3).
///
/// The caller **MUST** have verified the skeleton's `X-CALFLEX-ENVELOPE-SHA256`
/// against these bytes first (`verifyEnvelopeSha256` in `skeleton_hash.dart`);
/// §1.3 leaves that step to the read path because it is the only defence against
/// a server that serves the older envelope after a crash between D-06's write
/// steps.
Uint8List openEvent({
  required Uint8List cck,
  required Uint8List envelope,
  required EventSkeleton skeleton,
}) => _open(
  cck: cck,
  envelope: envelope,
  aadOf: skeleton.aad,
  kind: PayloadKind.event,
  ceiling: maxEventEnvelopeBytes,
);

/// Seals a calendar-metadata envelope: a Private calendar's name and colour
/// (D-18).
Uint8List sealCalendarMetadata({
  required Uint8List cck,
  required int epoch,
  required CalendarSkeleton skeleton,
  required Map<String, Object?> payload,
}) => sealCalendarMetadataWithNonce(
  cck: cck,
  epoch: epoch,
  skeleton: skeleton,
  payload: payload,
  nonce: freshNonce(),
);

/// Seals a calendar-metadata envelope under a caller-supplied nonce.
///
/// **Test-only**, like [sealEventWithNonce].
Uint8List sealCalendarMetadataWithNonce({
  required Uint8List cck,
  required int epoch,
  required CalendarSkeleton skeleton,
  required Map<String, Object?> payload,
  required Uint8List nonce,
}) => _seal(
  cck: cck,
  epoch: epoch,
  payload: payload,
  kind: PayloadKind.calendar,
  nonce: nonce,
  aad: skeleton.aad(epoch),
  ceiling: maxCalendarMetadataEnvelopeBytes,
);

/// Opens a calendar-metadata envelope (§1.3), with `calflex-meta-v1` as its AAD
/// label.
///
/// An event envelope opened here — or the reverse — is `E_AUTH`, because the two
/// labels differ in byte 8 (§1.4).
Uint8List openCalendarMetadata({
  required Uint8List cck,
  required Uint8List envelope,
  required CalendarSkeleton skeleton,
}) => _open(
  cck: cck,
  envelope: envelope,
  aadOf: skeleton.aad,
  kind: PayloadKind.calendar,
  ceiling: maxCalendarMetadataEnvelopeBytes,
);

Uint8List _seal({
  required Uint8List cck,
  required int epoch,
  required Map<String, Object?> payload,
  required PayloadKind kind,
  required Uint8List nonce,
  required Uint8List aad,
  required int ceiling,
}) {
  // §1.2 step 1.
  checkEpoch(epoch);
  if (cck.length != cckBytes) {
    throw const CryptoException(CryptoError.length, 'a CCK is 32 bytes');
  }
  if (nonce.length != nonceBytes) {
    throw const CryptoException(CryptoError.length, 'a nonce is 24 bytes');
  }
  // §1.2 step 2. A calendar payload's `name`/`color` *values* are checked after
  // the ceiling below, which is what `metadata-seal-over-4096-refused` pins: the
  // plaintext length is known here, encryption cannot change it, and the vector
  // wants `E_LENGTH` for a payload that is both oversized and has a 4200-byte
  // name.
  final payloadBytes = serialisePayload(
    payload,
    kind,
    checkCalendarValues: false,
  );
  if (envelopeFixedBytes + payloadBytes.length > ceiling) {
    throw CryptoException(
      CryptoError.length,
      'the envelope exceeds $ceiling bytes',
    );
  }
  if (kind == PayloadKind.calendar) {
    validatePayload(payloadBytes, PayloadKind.calendar);
  }
  // §1.2 steps 3–5. The AAD was built from the same epoch by the skeleton.
  final key = SecureKey.fromList(libSodium, cck);
  final Uint8List cipher;
  try {
    cipher = libSodium.crypto.aeadXChaCha20Poly1305IETF.encrypt(
      message: payloadBytes,
      nonce: nonce,
      key: key,
      additionalData: aad,
    );
  } finally {
    // sodium_memzero: the CCK does not stay in the heap after the call.
    key.dispose();
  }
  final out = Uint8List(envelopeFixedBytes + payloadBytes.length);
  out[0] = envelopeVersion;
  out[1] = (epoch >> 24) & 0xff;
  out[2] = (epoch >> 16) & 0xff;
  out[3] = (epoch >> 8) & 0xff;
  out[4] = epoch & 0xff;
  out.setRange(5, 29, nonce);
  out.setRange(29, out.length, cipher);
  return out;
}

Uint8List _open({
  required Uint8List cck,
  required Uint8List envelope,
  required Uint8List Function(int epoch) aadOf,
  required PayloadKind kind,
  required int ceiling,
}) {
  // §1.3 steps 1–3, in order: the length check comes first, whatever else the
  // blob holds.
  if (envelope.length < envelopeFixedBytes || envelope.length > ceiling) {
    throw CryptoException(
      CryptoError.length,
      'an envelope outside $envelopeFixedBytes … $ceiling bytes',
    );
  }
  if (envelope[0] != envelopeVersion) {
    throw const CryptoException(
      CryptoError.version,
      'an unknown envelope version',
    );
  }
  final epoch =
      (envelope[1] << 24) |
      (envelope[2] << 16) |
      (envelope[3] << 8) |
      envelope[4];
  checkEpoch(epoch);
  if (cck.length != cckBytes) {
    throw const CryptoException(CryptoError.length, 'a CCK is 32 bytes');
  }
  // §1.3 step 4: the epoch comes from the header, never from a separate
  // argument, so the two can never disagree.
  final aad = aadOf(epoch);
  final key = SecureKey.fromList(libSodium, cck);
  final Uint8List plain;
  try {
    // §1.3 step 5.
    plain = libSodium.crypto.aeadXChaCha20Poly1305IETF.decrypt(
      cipherText: Uint8List.sublistView(envelope, 29),
      nonce: Uint8List.sublistView(envelope, 5, 29),
      key: key,
      additionalData: aad,
    );
  } on SodiumException {
    throw const CryptoException(
      CryptoError.auth,
      'the envelope does not authenticate',
    );
  } finally {
    key.dispose();
  }
  // §1.3 step 6.
  validatePayload(plain, kind);
  return plain;
}
