/// `spec/crypto-vectors/cck-records-v1.json` — the sealed, signed CCK record of
/// `spec/crypto.md` §6.6.
///
/// The sealer vector pins a box whose ephemeral key was fixed
/// (`spec/crypto-vectors/gen/generate.py`: `SEAL_EPHEMERAL_SEED = 0xcc * 32`), so
/// here the test-only seam seals with that key and the whole 162-byte record is
/// compared byte for byte. The two negatives whose `op` says `seal_cck_record` but
/// whose `inputs` are an opener's are run through the opener, exactly as the
/// generator's own `RUN_BY_VECTOR_ID` re-routes a vector whose `op` is a coarse
/// grouping rather than the call.
library;

import 'dart:typed_data';

import 'package:crypto_dart/crypto_dart.dart';
import 'package:crypto_dart/src/cck.dart' show sealCckRecordWithEphemeralKey;
import 'package:test/test.dart';

import 'vectors.dart';

/// The fixed ephemeral key `cck-records-v1.json`'s sealed boxes were built with.
final Uint8List sealEphemeralKey = Uint8List.fromList(List.filled(32, 0xcc));

void main() {
  final vectors = loadVectors('cck-records-v1.json');
  reportVectors('cck-records-v1.json', vectors);

  for (final vector in vectors) {
    test('${vector.id} — ${vector.purpose}', () {
      final calendarId = vector.text('calendar_id');
      final epoch = vector.integer('epoch');
      final recipientUserId = vector.text('recipient_user_id');
      switch (vector.op) {
        case 'seal_cck_record':
          if (vector.inputs.containsKey('record_hex')) {
            // A record sealed to another key: the signature passes, the seal does
            // not. The vector's `inputs` are an opener's, so it runs there.
            final record = vector.hex('record_hex');
            expectRefusal(
              vector.pinnedError,
              () => openCckRecord(
                record: record,
                calendarId: calendarId,
                epoch: epoch,
                recipientUserId: recipientUserId,
                recipientX25519SecretKey: vector.hex('x25519_sk_hex'),
                signerEd25519PublicKey: vector.hex('signer_ed25519_pk_hex'),
              ),
              vector.id,
            );
            return;
          }
          final signerUserId = vector.text('signer_user_id');
          final record = sealCckRecordWithEphemeralKey(
            cck: vector.hex('cck_hex'),
            calendarId: calendarId,
            epoch: epoch,
            recipientUserId: recipientUserId,
            recipientX25519PublicKey: vector.hex('recipient_x25519_pk_hex'),
            signerUserId: signerUserId,
            signerEd25519SecretKey: _ed25519SecretKey(
              vector.hex('signer_ed25519_seed_hex'),
            ),
            ephemeralSecretKey: sealEphemeralKey,
          );
          expect(encodeHex(record), vector.expected['record_hex']);
          expect(record.length, vector.expected['record_bytes']);
          expect(record.length, cckRecordBytes);
          expect(vector.expected['signer_user_id'], signerUserId);
          expect(
            encodeUuidV4(Uint8List.sublistView(record, 2, 18)),
            signerUserId,
          );
          expect(
            encodeHex(Uint8List.sublistView(record, 18, 50)),
            vector.expected['seal_ephemeral_pk_hex'],
          );
          // §6.6's signed message, composed from the spec's framing primitive and
          // the record's own first 98 bytes.
          expect(
            encodeHex(
              cckRecordMessage(
                calendarId: calendarId,
                recipientUserId: recipientUserId,
                epoch: epoch,
                head: Uint8List.sublistView(record, 0, 98),
              ),
            ),
            vector.expected['signature_message_hex'],
          );
        case 'open_cck_record':
          final record = vector.hex('record_hex');
          if (vector.isPositive) {
            final opened = openCckRecord(
              record: record,
              calendarId: calendarId,
              epoch: epoch,
              recipientUserId: recipientUserId,
              recipientX25519SecretKey: vector.hex('x25519_sk_hex'),
              signerEd25519PublicKey: vector.hex('signer_ed25519_pk_hex'),
            );
            expect(encodeHex(opened.cck), vector.expected['cck_hex']);
            expect(opened.signerUserId, vector.expected['signer_user_id']);
          } else {
            expectRefusal(
              vector.pinnedError,
              () => openCckRecord(
                record: record,
                calendarId: calendarId,
                epoch: epoch,
                recipientUserId: recipientUserId,
                recipientX25519SecretKey: vector.hex('x25519_sk_hex'),
                signerEd25519PublicKey: vector.hex('signer_ed25519_pk_hex'),
              ),
              vector.id,
            );
          }
        default:
          throw StateError('${vector.id}: no handler for op ${vector.op}');
      }
    });
  }
}

/// §6.1's Ed25519 secret key from a 32-byte seed — the vector inputs carry seeds.
Uint8List _ed25519SecretKey(Uint8List seed) => userKeysFromSeeds(
  x25519SecretKey: Uint8List(32),
  ed25519Seed: seed,
).ed25519SecretKey;
