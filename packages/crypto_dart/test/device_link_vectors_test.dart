/// `spec/crypto-vectors/device-link-v1.json` — device linking, `spec/crypto.md`
/// §6.7.
///
/// The sealer vector pins a bundle whose ephemeral key was fixed
/// (`spec/crypto-vectors/gen/generate.py`: `LINK_SEAL_EPHEMERAL_SEED = 0xdd * 32`),
/// so the test-only seam seals with that key and the whole 267-byte blob is
/// compared byte for byte. The negative whose `op` says `seal_link_bundle` but
/// whose `inputs` are an opener's is run through the opener, as the generator's
/// `RUN_BY_VECTOR_ID` does for a vector whose `op` is a coarse grouping.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto_dart/crypto_dart.dart';
import 'package:crypto_dart/src/device_link.dart'
    show sealLinkBundleWithEphemeralKey;
import 'package:test/test.dart';

import 'vectors.dart';

/// The fixed ephemeral key `device-link-v1.json`'s sealed bundle was built with.
final Uint8List linkEphemeralKey = Uint8List.fromList(List.filled(32, 0xdd));

void main() {
  final vectors = loadVectors('device-link-v1.json');
  reportVectors('device-link-v1.json', vectors);

  for (final vector in vectors) {
    test('${vector.id} — ${vector.purpose}', () {
      switch (vector.op) {
        case 'link_code':
          expect(
            linkCode(
              ephemeralPublicKey: vector.hex('ephemeral_pk_hex'),
              identityPublicKey: vector.hex('identity_pk_hex'),
            ),
            vector.expected['code'],
          );
          expect(vector.expected['digits'], 6);
        case 'link_uri':
          final uri = linkUri(
            linkId: vector.text('link_id'),
            ephemeralPublicKey: vector.hex('ephemeral_pk_hex'),
            code: vector.text('code'),
          );
          expect(uri, vector.expected['uri']);
          expect(utf8.encode(uri).length, vector.expected['ascii_bytes']);
          expect(uri.codeUnits.every((unit) => unit < 128), isTrue);
        case 'parse_link_uri':
          if (vector.isPositive) {
            final parsed = parseLinkUri(vector.text('uri'));
            expect(parsed.linkId, vector.expected['link_id']);
            expect(
              encodeHex(parsed.ephemeralPublicKey),
              vector.expected['ephemeral_pk_hex'],
            );
            expect(parsed.code, vector.expected['code']);
          } else if (vector.inputs.containsKey('identity_pk_hex')) {
            // `link-qr-code-mismatch`: the URI parses, and the code a human would
            // compare is not the one these keys produce (E_VERIFY).
            final parsed = parseLinkUri(vector.text('uri'));
            expectRefusal(
              vector.pinnedError,
              () => checkLinkCode(
                code: parsed.code,
                ephemeralPublicKey: parsed.ephemeralPublicKey,
                identityPublicKey: vector.hex('identity_pk_hex'),
              ),
              vector.id,
            );
          } else {
            expectRefusal(
              vector.pinnedError,
              () => parseLinkUri(vector.text('uri')),
              vector.id,
            );
          }
        case 'seal_link_bundle':
          if (vector.inputs.containsKey('blob_hex')) {
            // A bundle signed for this link but sealed to another ephemeral key:
            // the signature passes, the seal does not. An opener's inputs.
            final blob = vector.hex('blob_hex');
            expectRefusal(
              vector.pinnedError,
              () => openLinkBundle(
                blob: blob,
                userId: vector.text('user_id'),
                linkId: vector.text('link_id'),
                ephemeralSecretKey: vector.hex('ephemeral_sk_hex'),
                signerEd25519PublicKey: vector.hex('signer_ed25519_pk_hex'),
              ),
              vector.id,
            );
            return;
          }
          final userId = vector.text('user_id');
          final linkId = vector.text('link_id');
          final recipientEphemeralPublicKey = vector.hex(
            'recipient_ephemeral_pk_hex',
          );
          final blob = sealLinkBundleWithEphemeralKey(
            userId: userId,
            linkId: linkId,
            recipientEphemeralPublicKey: recipientEphemeralPublicKey,
            bundle: KeyBundle.decode(vector.hex('bundle_hex')),
            signerEd25519SecretKey: _ed25519SecretKey(
              vector.hex('signer_ed25519_seed_hex'),
            ),
            ephemeralSecretKey: linkEphemeralKey,
          );
          expect(encodeHex(blob), vector.expected['blob_hex']);
          expect(blob.length, vector.expected['blob_bytes']);
          expect(blob.length, linkBundleBytes);
          expect(
            encodeHex(Uint8List.sublistView(blob, 18, 50)),
            encodeHex(recipientEphemeralPublicKey),
          );
          // §6.7's signed message, from the blob's own first 203 bytes.
          expect(
            encodeHex(
              linkBundleMessage(
                userId: userId,
                linkId: linkId,
                recipientEphemeralPublicKey: Uint8List.sublistView(
                  blob,
                  18,
                  50,
                ),
                head: Uint8List.sublistView(blob, 0, 203),
              ),
            ),
            vector.expected['signature_message_hex'],
          );
        case 'open_link_bundle':
          final blob = vector.hex('blob_hex');
          final ephemeralSecretKey = vector.hex('ephemeral_sk_hex');
          final signerEd25519PublicKey = vector.hex('signer_ed25519_pk_hex');
          final userId = vector.text('user_id');
          final linkId = vector.text('link_id');
          if (vector.isPositive) {
            final bundle = openLinkBundle(
              blob: blob,
              userId: userId,
              linkId: linkId,
              ephemeralSecretKey: ephemeralSecretKey,
              signerEd25519PublicKey: signerEd25519PublicKey,
            );
            expect(encodeHex(bundle.toBytes()), vector.expected['bundle_hex']);
            expect(
              encodeHex(bundle.x25519SecretKey),
              vector.expected['x25519_sk_hex'],
            );
          } else {
            expectRefusal(
              vector.pinnedError,
              () => openLinkBundle(
                blob: blob,
                userId: userId,
                linkId: linkId,
                ephemeralSecretKey: ephemeralSecretKey,
                signerEd25519PublicKey: signerEd25519PublicKey,
              ),
              vector.id,
            );
          }
        default:
          throw StateError('${vector.id}: no handler for op ${vector.op}');
      }
    });
  }

  test('a link URI round-trips and a tampered code is refused', () {
    final ephemeralSecretKey = hexToBytes('66' * 32);
    final ephemeralPublicKey = userKeysFromSeeds(
      x25519SecretKey: ephemeralSecretKey,
      ed25519Seed: Uint8List(32),
    ).x25519PublicKey;
    const linkId = '44444444-4444-4444-8444-444444444444';
    final identityKey = userKeysFromSeeds(
      x25519SecretKey: Uint8List(32),
      ed25519Seed: hexToBytes('22' * 32),
    ).ed25519PublicKey;
    final code = linkCode(
      ephemeralPublicKey: ephemeralPublicKey,
      identityPublicKey: identityKey,
    );
    final uri = linkUri(
      linkId: linkId,
      ephemeralPublicKey: ephemeralPublicKey,
      code: code,
    );
    final parsed = parseLinkUri(uri);
    expect(parsed.linkId, linkId);
    expect(encodeHex(parsed.ephemeralPublicKey), encodeHex(ephemeralPublicKey));
    expect(parsed.code, code);
    expect(
      linkCodeMatches(
        code: code,
        ephemeralPublicKey: ephemeralPublicKey,
        identityPublicKey: identityKey,
      ),
      isTrue,
    );
    expectRefusal(
      CryptoError.verify,
      () => checkLinkCode(
        code: code,
        ephemeralPublicKey: ephemeralPublicKey,
        identityPublicKey: Uint8List.fromList(identityKey.reversed.toList()),
      ),
      'a code computed for another identity key',
    );
  });
}

/// §6.1's Ed25519 secret key from a 32-byte seed — the vector inputs carry seeds.
Uint8List _ed25519SecretKey(Uint8List seed) => userKeysFromSeeds(
  x25519SecretKey: Uint8List(32),
  ed25519Seed: seed,
).ed25519SecretKey;
