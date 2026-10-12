/// `spec/crypto-vectors/keys-v1.json` — the key hierarchy of `spec/crypto.md`
/// §6.1–§6.4: key material, the key bundle, the recovery code and its KEK, and the
/// wrapped private key.
///
/// Every vector in the file is read here, positive and negative, and asserted to
/// its pinned bytes or its exact error code. The file's `wordlist_sha256` and the
/// vendored `lib/src/bip39-english.txt` are checked against each other, so a word
/// list that drifted from BIP-0039 cannot make the twelve words pass by luck.
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:crypto_dart/crypto_dart.dart';
import 'package:crypto_dart/src/bip39_english.dart' show bip39EnglishWords;
import 'package:crypto_dart/src/key_wrap.dart' show sealWrappedKeyWithNonce;
import 'package:test/test.dart';

import 'vectors.dart';

/// The `kind` input's column value as the library's enum.
KeyWrapKind kindOf(String name) => KeyWrapKind.values.firstWhere(
  (kind) => kind.name == name,
  orElse: () => throw StateError('no wrap kind named $name'),
);

void main() {
  final vectors = loadVectors('keys-v1.json');
  reportVectors('keys-v1.json', vectors);

  for (final vector in vectors) {
    test('${vector.id} — ${vector.purpose}', () {
      switch (vector.op) {
        case 'recovery_phrase':
          final phrase = recoveryPhrase(vector.hex('entropy_hex'));
          expect(phrase, vector.expected['phrase']);
          expect(
            phrase.split(' ').length,
            vector.expected['words'],
            reason: 'twelve words',
          );
          final pinned = vector.expected['wordlist_sha256'];
          if (pinned != null) {
            expect(
              encodeHex(sha256.convert(wordListBytes()).bytes),
              pinned,
              reason: 'the pinned word list',
            );
          }
        case 'parse_recovery_phrase':
          if (vector.isPositive) {
            expect(
              encodeHex(parseRecoveryPhrase(vector.text('phrase'))),
              vector.expected['entropy_hex'],
            );
          } else {
            expectRefusal(
              vector.pinnedError,
              () => parseRecoveryPhrase(vector.text('phrase')),
              vector.id,
            );
          }
        case 'recovery_kek':
          expect(vector.expected['salt'], recoveryKekSalt);
          expect(vector.expected['info'], recoveryKekInfo);
          expect(vector.expected['hash'], 'SHA-256');
          expect(
            vector.expected['length_bytes'],
            recoveryKek(hexToBytes(vector.text('entropy_hex'))).length,
          );
          expect(
            encodeHex(recoveryKek(vector.hex('entropy_hex'))),
            vector.expected['kek_hex'],
          );
          expect(recoveryKekBytes, 32);
        case 'key_bundle':
          if (vector.inputs.containsKey('bundle_hex')) {
            // The parse direction: a bundle whose key length is wrong.
            expectRefusal(
              vector.pinnedError,
              () => KeyBundle.decode(vector.hex('bundle_hex')),
              vector.id,
            );
          } else {
            // The build direction, from §6.1's seeds.
            final keys = userKeysFromSeeds(
              x25519SecretKey: vector.hex('x25519_sk_hex'),
              ed25519Seed: vector.hex('ed25519_seed_hex'),
            );
            expect(
              encodeHex(keys.x25519PublicKey),
              vector.expected['x25519_pk_hex'],
            );
            expect(
              encodeHex(keys.ed25519PublicKey),
              vector.expected['ed25519_pk_hex'],
            );
            final bundle = KeyBundle.fromUserKeys(keys);
            expect(encodeHex(bundle.toBytes()), vector.expected['bundle_hex']);
            expect(bundle.toBytes().length, keyBundleBytes);
            // Parse it back: one parser for both directions.
            final parsed = KeyBundle.decode(bundle.toBytes());
            expect(
              encodeHex(parsed.x25519SecretKey),
              encodeHex(keys.x25519SecretKey),
            );
            expect(
              encodeHex(parsed.ed25519SecretKey),
              encodeHex(keys.ed25519SecretKey),
            );
          }
        case 'check_key_bundle':
          final bundle = KeyBundle.decode(vector.hex('bundle_hex'));
          final x25519PublicKey = vector.hex('x25519_pk_hex');
          final ed25519PublicKey = vector.hex('ed25519_pk_hex');
          if (vector.isPositive) {
            expect(
              bundle.matches(
                x25519PublicKey: x25519PublicKey,
                ed25519PublicKey: ed25519PublicKey,
              ),
              vector.expected['matches'],
            );
            bundle.checkMatches(
              x25519PublicKey: x25519PublicKey,
              ed25519PublicKey: ed25519PublicKey,
            );
          } else {
            expectRefusal(
              vector.pinnedError,
              () => bundle.checkMatches(
                x25519PublicKey: x25519PublicKey,
                ed25519PublicKey: ed25519PublicKey,
              ),
              vector.id,
            );
          }
        case 'identity_keys':
          final keys = userKeysFromSeeds(
            x25519SecretKey: vector.hex('x25519_sk_hex'),
            ed25519Seed: vector.hex('ed25519_seed_hex'),
          );
          expect(
            encodeHex(keys.x25519PublicKey),
            vector.expected['x25519_pk_hex'],
          );
          expect(
            encodeHex(keys.ed25519PublicKey),
            vector.expected['ed25519_pk_hex'],
          );
          expect(
            encodeHex(keys.ed25519SecretKey),
            vector.expected['ed25519_sk_hex'],
          );
        case 'seal_wrapped_key':
          final userId = vector.text('user_id');
          final kindName = vector.text('kind');
          final nonce = vector.hex('nonce_hex');
          final wrapped = sealWrappedKeyWithNonce(
            kek: vector.hex('kek_hex'),
            userId: userId,
            kind: kindOf(kindName),
            bundle: KeyBundle.decode(vector.hex('bundle_hex')),
            nonce: nonce,
          );
          expect(encodeHex(wrapped), vector.expected['wrapped_key_hex']);
          expect(wrapped.length, vector.expected['wrapped_key_bytes']);
          expect(wrapped.length, recoveryCodeWrapBytes);
          // §6.3's AAD, composed from the spec's own framing primitive.
          expect(
            encodeHex(
              frame(keyWrapLabel, [
                utf8.encode(userId),
                utf8.encode(kindName),
                utf8.encode(keySuite),
              ]),
            ),
            vector.expected['aad_hex'],
          );
          // The pinned phrase is the recovery code the KEK was derived from: the
          // whole §6.4 path (words → entropy → HKDF) has to reproduce the KEK the
          // wrap was sealed under.
          final phrase = vector.expected['phrase'] as String;
          expect(
            encodeHex(recoveryKekFromPhrase(phrase)),
            encodeHex(vector.hex('kek_hex')),
          );
          expect(
            encodeHex(recoveryKek(parseRecoveryPhrase(phrase))),
            encodeHex(vector.hex('kek_hex')),
          );
        case 'open_wrapped_key':
          final kek = vector.hex('kek_hex');
          final userId = vector.text('user_id');
          final kind = kindOf(vector.text('kind'));
          final wrapped = vector.hex('wrapped_key_hex');
          if (vector.isPositive) {
            final bundle = openWrappedKey(
              kek: kek,
              userId: userId,
              kind: kind,
              wrapped: wrapped,
            );
            expect(encodeHex(bundle.toBytes()), vector.expected['bundle_hex']);
            expect(
              encodeHex(bundle.x25519SecretKey),
              vector.expected['x25519_sk_hex'],
            );
            expect(
              encodeHex(bundle.ed25519SecretKey),
              vector.expected['ed25519_sk_hex'],
            );
          } else {
            expectRefusal(
              vector.pinnedError,
              () => openWrappedKey(
                kek: kek,
                userId: userId,
                kind: kind,
                wrapped: wrapped,
              ),
              vector.id,
            );
          }
        default:
          throw StateError('${vector.id}: no handler for op ${vector.op}');
      }
    });
  }

  test('the vendored word list is BIP-0039 english.txt, exactly', () {
    final bytes = wordListBytes();
    expect(
      encodeHex(sha256.convert(bytes).bytes),
      '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda',
    );
    expect(bytes.length, 13116);
    final lines = utf8.decode(bytes).split('\n');
    expect(lines.length, 2049, reason: '2048 lines, LF terminated');
    expect(lines.last, '');
    expect(lines.sublist(0, 2048), bip39EnglishWords);
    expect(bip39EnglishWords.length, 2048);
    expect(bip39EnglishIndex.length, 2048);
    expect(bip39EnglishWords.first, 'abandon');
    expect(bip39EnglishWords.last, 'zoo');
    expect(
      lines
          .sublist(0, 2048)
          .where((word) => !RegExp(r'^[a-z]+$').hasMatch(word)),
      isEmpty,
      reason: 'lowercase ASCII only',
    );
  });

  test('no word list line has a duplicate, so an index is a word', () {
    expect(bip39EnglishWords.toSet().length, 2048);
  });
}

/// The verbatim word list, read from the package — never from a copy.
Uint8List wordListBytes() =>
    File('lib/src/bip39-english.txt').readAsBytesSync();
