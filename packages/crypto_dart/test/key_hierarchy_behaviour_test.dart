/// Behaviour the vectors cannot show: the entry points that draw their own
/// randomness, the round trips a device performs, and the two properties that are
/// stated as prohibitions rather than as bytes — no key derives from a login
/// secret (D-17, INV-12) and none of it needs a server (INV-07).
///
/// A vector pins one blob; here the same calls run end to end, with the CSPRNG
/// branch that no vector can exercise, and each test says what production bug it
/// would fail on.
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto_dart/crypto_dart.dart';
import 'package:test/test.dart';

import 'vectors.dart';

const String aliceId = '22222222-2222-4222-8222-222222222222';
const String bobId = '33333333-3333-4333-8333-333333333333';
const String calendarId = '11111111-1111-4111-8111-111111111111';
const String linkId = '44444444-4444-4444-8444-444444444444';

/// A user whose seeds are pinned, so a failure is reproducible.
UserKeys keysOf(String x25519Seed, String ed25519Seed) => userKeysFromSeeds(
  x25519SecretKey: hexToBytes(x25519Seed * 32),
  ed25519Seed: hexToBytes(ed25519Seed * 32),
);

final alice = keysOf('11', '22');
final bob = keysOf('33', '44');

final cck = hexToBytes(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
);

void main() {
  group('key generation (§6.1)', () {
    test('generateUserKeys draws two fresh keypairs from the CSPRNG', () {
      final first = generateUserKeys();
      final second = generateUserKeys();
      expect(first.x25519SecretKey.length, x25519SecretKeyBytes);
      expect(first.x25519PublicKey.length, x25519PublicKeyBytes);
      expect(first.ed25519SecretKey.length, ed25519SecretKeyBytes);
      expect(first.ed25519PublicKey.length, ed25519PublicKeyBytes);
      expect(
        encodeHex(first.ed25519SecretKey)
            .endsWith(encodeHex(first.ed25519PublicKey)),
        isTrue,
        reason: "libsodium's secret key is the seed followed by the public key",
      );
      expect(
        encodeHex(first.x25519SecretKey),
        isNot(encodeHex(second.x25519SecretKey)),
      );
      expect(
        encodeHex(first.ed25519SecretKey),
        isNot(encodeHex(second.ed25519SecretKey)),
      );
    });

    test('the generated pair really seals and signs (a CCK record)', () {
      // Fails if the two keypairs were crossed, or if the public half came from
      // the wrong secret key.
      final device = generateUserKeys();
      final record = sealCckRecord(
        cck: cck,
        calendarId: calendarId,
        epoch: 1,
        recipientUserId: aliceId,
        recipientX25519PublicKey: device.x25519PublicKey,
        signerUserId: aliceId,
        signerEd25519SecretKey: device.ed25519SecretKey,
      );
      final opened = openCckRecord(
        record: record,
        calendarId: calendarId,
        epoch: 1,
        recipientUserId: aliceId,
        recipientX25519SecretKey: device.x25519SecretKey,
        signerEd25519PublicKey: device.ed25519PublicKey,
      );
      expect(encodeHex(opened.cck), encodeHex(cck));
      expect(opened.signerUserId, aliceId);
    });

    test('the generated pair seals to a member', () {
      // Bob's key seals to Alice, and only Alice's secret key opens it.
      final record = sealCckRecord(
        cck: cck,
        calendarId: calendarId,
        epoch: 1,
        recipientUserId: aliceId,
        recipientX25519PublicKey: alice.x25519PublicKey,
        signerUserId: bobId,
        signerEd25519SecretKey: bob.ed25519SecretKey,
      );
      final opened = openCckRecord(
        record: record,
        calendarId: calendarId,
        epoch: 1,
        recipientUserId: aliceId,
        recipientX25519SecretKey: alice.x25519SecretKey,
        signerEd25519PublicKey: bob.ed25519PublicKey,
      );
      expect(encodeHex(opened.cck), encodeHex(cck));
      expect(opened.signerUserId, bobId);
      expectRefusal(
        CryptoError.auth,
        () => openCckRecord(
          record: record,
          calendarId: calendarId,
          epoch: 1,
          recipientUserId: aliceId,
          recipientX25519SecretKey: bob.x25519SecretKey,
          signerEd25519PublicKey: bob.ed25519PublicKey,
        ),
        'a CCK record opened by another member',
      );
    });

    test('generateCck draws 32 fresh bytes (§6.5)', () {
      final first = generateCck();
      final second = generateCck();
      expect(first.length, cckBytes);
      expect(encodeHex(first), isNot(encodeHex(second)));
    });
  });

  group('the recovery code (§6.4) and its KEK (§6.3.1)', () {
    test('a generated code is twelve words that parse back to its entropy', () {
      final entropy = generateRecoveryEntropy();
      expect(entropy.length, recoveryEntropyBytes);
      final phrase = recoveryPhrase(entropy);
      expect(phrase.split(' ').length, recoveryWordCount);
      expect(encodeHex(parseRecoveryPhrase(phrase)), encodeHex(entropy));
      expect(
        encodeHex(recoveryKekFromPhrase(phrase)),
        encodeHex(recoveryKek(entropy)),
      );
    });

    test('generateRecoveryPhrase draws a fresh code every time', () {
      final first = generateRecoveryPhrase();
      final second = generateRecoveryPhrase();
      expect(first, isNot(second));
      expect(parseRecoveryPhrase(first).length, recoveryEntropyBytes);
    });

    test('case and the two separators do not change the KEK', () {
      // §6.4/§6.3.1: the KEK comes from the 16 bytes, so a differently spaced or
      // differently cased spelling of one phrase derives the same KEK. A library
      // that hashed the words' text would fail this.
      final entropy = hexToBytes('5a' * 16);
      final phrase = recoveryPhrase(entropy);
      final shouted = phrase.toUpperCase().replaceAll(' ', '\u3000');
      expect(encodeHex(parseRecoveryPhrase(shouted)), encodeHex(entropy));
      expect(
        encodeHex(recoveryKekFromPhrase(shouted)),
        encodeHex(recoveryKekFromPhrase(phrase)),
      );
      expect(
        encodeHex(recoveryKekFromPhrase('  $phrase  ')),
        encodeHex(recoveryKekFromPhrase(phrase)),
      );
    });

    test('a phrase that is not twelve known words never derives anything', () {
      final phrase =
          'fog spot notable regret pizza coffee harvest ensure fog spot notable reflect';
      expect(parseRecoveryPhrase(phrase).length, recoveryEntropyBytes);
      for (final broken in [
        phrase.replaceAll(' ', ''),
        '$phrase $phrase',
        phrase.replaceFirst('fog', 'zzzz'),
        '${phrase.substring(0, phrase.length - 1)}\u3000',
      ]) {
        expectRefusal(
          CryptoError.recovery,
          () => recoveryKekFromPhrase(broken),
          'a broken recovery code',
        );
      }
    });
  });

  group('the wrapped private key (§6.3)', () {
    test('wrap then unwrap returns the same key material', () {
      // The production path: the nonce comes from the CSPRNG.
      final bundle = KeyBundle.fromUserKeys(alice);
      final kek = recoveryKek(generateRecoveryEntropy());
      final wrapped = sealWrappedKey(
        kek: kek,
        userId: aliceId,
        kind: KeyWrapKind.recoveryCode,
        bundle: bundle,
      );
      expect(wrapped.length, recoveryCodeWrapBytes);
      final opened = openWrappedKey(
        kek: kek,
        userId: aliceId,
        kind: KeyWrapKind.recoveryCode,
        wrapped: wrapped,
      );
      expect(encodeHex(opened.toBytes()), encodeHex(bundle.toBytes()));
      // §6.2's check: the unwrapped keys reproduce the `user_keys` row. This is the
      // check that catches a server that swapped a stored blob between users.
      opened.checkMatches(
        x25519PublicKey: alice.x25519PublicKey,
        ed25519PublicKey: alice.ed25519PublicKey,
      );
    });

    test('two wraps of one bundle are different bytes (fresh nonce)', () {
      final bundle = KeyBundle.fromUserKeys(alice);
      final kek = recoveryKek(generateRecoveryEntropy());
      final first = sealWrappedKey(
        kek: kek,
        userId: aliceId,
        kind: KeyWrapKind.recoveryCode,
        bundle: bundle,
      );
      final second = sealWrappedKey(
        kek: kek,
        userId: aliceId,
        kind: KeyWrapKind.recoveryCode,
        bundle: bundle,
      );
      expect(encodeHex(first), isNot(encodeHex(second)));
      expect(
        encodeHex(Uint8List.sublistView(first, 2, 26)),
        isNot(encodeHex(Uint8List.sublistView(second, 2, 26))),
        reason: 'the nonce is fresh on every seal (§1.2 under one KEK)',
      );
    });

    test('a swapped bundle fails the public-key check (§6.2)', () {
      // The attack the check exists for: the server answers a device-link or a
      // recovery with another user's wrap.
      final bobKeys = KeyBundle.fromUserKeys(bob);
      expectRefusal(
        CryptoError.payload,
        () => bobKeys.checkMatches(
          x25519PublicKey: alice.x25519PublicKey,
          ed25519PublicKey: alice.ed25519PublicKey,
        ),
        "another user's bundle",
      );
      expect(
        bobKeys.matches(
          x25519PublicKey: bob.x25519PublicKey,
          ed25519PublicKey: bob.ed25519PublicKey,
        ),
        isTrue,
      );
    });

    test('the wrong KEK and the wrong owner are the same refusal', () {
      final wrapped = sealWrappedKey(
        kek: recoveryKek(generateRecoveryEntropy()),
        userId: aliceId,
        kind: KeyWrapKind.recoveryCode,
        bundle: KeyBundle.fromUserKeys(alice),
      );
      expectRefusal(
        CryptoError.auth,
        () => openWrappedKey(
          kek: recoveryKek(generateRecoveryEntropy()),
          userId: aliceId,
          kind: KeyWrapKind.recoveryCode,
          wrapped: wrapped,
        ),
        'the wrong recovery code',
      );
      expectRefusal(
        CryptoError.auth,
        () => openWrappedKey(
          kek: recoveryKek(hexToBytes('5a' * 16)),
          userId: bobId,
          kind: KeyWrapKind.recoveryCode,
          wrapped: wrapped,
        ),
        "another user's row",
      );
    });

    test('the reserved escrow kind is refused, never written (§6.3.2)', () {
      expectRefusal(
        CryptoError.unsupported,
        () => sealWrappedKey(
          kek: recoveryKek(generateRecoveryEntropy()),
          userId: aliceId,
          kind: KeyWrapKind.escrow,
          bundle: KeyBundle.fromUserKeys(alice),
        ),
        'an escrow wrap',
      );
    });

    test('the whole §6.4 procedure reaches the keys', () {
      // phrase → entropy → KEK_rc → open the recovery_code wrap → KeyBundle → keys.
      final phrase = generateRecoveryPhrase();
      final wrapped = sealWrappedKey(
        kek: recoveryKekFromPhrase(phrase),
        userId: aliceId,
        kind: KeyWrapKind.recoveryCode,
        bundle: KeyBundle.fromUserKeys(alice),
      );
      final recovered = openWrappedKey(
        kek: recoveryKekFromPhrase(phrase),
        userId: aliceId,
        kind: KeyWrapKind.recoveryCode,
        wrapped: wrapped,
      );
      recovered.checkMatches(
        x25519PublicKey: alice.x25519PublicKey,
        ed25519PublicKey: alice.ed25519PublicKey,
      );
    });
  });

  group('device linking (§6.7)', () {
    test('a bundle sealed to an ephemeral key opens only there', () {
      final ephemeral = generateUserKeys();
      final other = generateUserKeys();
      final bundle = KeyBundle.fromUserKeys(alice);
      final blob = sealLinkBundle(
        userId: aliceId,
        linkId: linkId,
        recipientEphemeralPublicKey: ephemeral.x25519PublicKey,
        bundle: bundle,
        signerEd25519SecretKey: alice.ed25519SecretKey,
      );
      expect(blob.length, linkBundleBytes);
      final opened = openLinkBundle(
        blob: blob,
        userId: aliceId,
        linkId: linkId,
        ephemeralSecretKey: ephemeral.x25519SecretKey,
        signerEd25519PublicKey: alice.ed25519PublicKey,
      );
      expect(encodeHex(opened.toBytes()), encodeHex(bundle.toBytes()));
      expectRefusal(
        CryptoError.auth,
        () => openLinkBundle(
          blob: blob,
          userId: aliceId,
          linkId: linkId,
          ephemeralSecretKey: other.x25519SecretKey,
          signerEd25519PublicKey: alice.ed25519PublicKey,
        ),
        'a bundle replayed at another device',
      );
      expectRefusal(
        CryptoError.signature,
        () => openLinkBundle(
          blob: blob,
          userId: aliceId,
          linkId: '44444444-4444-4444-8444-444444444445',
          ephemeralSecretKey: ephemeral.x25519SecretKey,
          signerEd25519PublicKey: alice.ed25519PublicKey,
        ),
        'a blob replayed at another rendezvous',
      );
      expectRefusal(
        CryptoError.signature,
        () => openLinkBundle(
          blob: blob,
          userId: aliceId,
          linkId: linkId,
          ephemeralSecretKey: ephemeral.x25519SecretKey,
          signerEd25519PublicKey: bob.ed25519PublicKey,
        ),
        'a substituted identity key (D-15)',
      );
    });

    test('two links are different bytes (fresh ephemeral key)', () {
      final ephemeral = generateUserKeys();
      final bundle = KeyBundle.fromUserKeys(alice);
      final first = sealLinkBundle(
        userId: aliceId,
        linkId: linkId,
        recipientEphemeralPublicKey: ephemeral.x25519PublicKey,
        bundle: bundle,
        signerEd25519SecretKey: alice.ed25519SecretKey,
      );
      final second = sealLinkBundle(
        userId: aliceId,
        linkId: linkId,
        recipientEphemeralPublicKey: ephemeral.x25519PublicKey,
        bundle: bundle,
        signerEd25519SecretKey: alice.ed25519SecretKey,
      );
      expect(encodeHex(first), isNot(encodeHex(second)));
    });

    test('the code the two screens show covers both keys', () {
      final ephemeral = generateUserKeys();
      final code = linkCode(
        ephemeralPublicKey: ephemeral.x25519PublicKey,
        identityPublicKey: alice.ed25519PublicKey,
      );
      final uri = linkUri(
        linkId: linkId,
        ephemeralPublicKey: ephemeral.x25519PublicKey,
        code: code,
      );
      final parsed = parseLinkUri(uri);
      expect(parsed.linkId, linkId);
      expect(parsed.code, code);
      expect(
        linkCodeMatches(
          code: parsed.code,
          ephemeralPublicKey: parsed.ephemeralPublicKey,
          identityPublicKey: alice.ed25519PublicKey,
        ),
        isTrue,
      );
      expectRefusal(
        CryptoError.verify,
        () => checkLinkCode(
          code: parsed.code,
          ephemeralPublicKey: parsed.ephemeralPublicKey,
          identityPublicKey: bob.ed25519PublicKey,
        ),
        'a substituted identity key changes the code the human compares',
      );
    });

    test(
      'the version, the order and the padding of a link payload are strict',
      () {
        final code = linkCode(
          ephemeralPublicKey: alice.x25519PublicKey,
          identityPublicKey: alice.ed25519PublicKey,
        );
        final query =
            '?c=$code'
            '&e=${encodeBase64Url(alice.x25519PublicKey)}'
            '&l=$linkId';
        expectRefusal(
          CryptoError.verify,
          () => parseLinkUri('calflex://link/1$query'),
          'parameters out of order',
        );
        expectRefusal(
          CryptoError.version,
          () => parseLinkUri('calflex://link/2?l=$linkId&e=AA&c=$code'),
          'an unknown path version',
        );
        expectRefusal(
          CryptoError.version,
          () => parseLinkUri('calflex://verify/1?u=$linkId'),
          'another payload kind',
        );
        expectRefusal(
          CryptoError.encoding,
          () => parseLinkUri('calflex://link/1?l=$linkId&e=AA&c=$code'),
          'an ephemeral key that is not 32 bytes',
        );
        expectRefusal(
          CryptoError.encoding,
          () => parseLinkUri('calflex://link/1?l=$linkId&e=&c=$code'),
          'an empty ephemeral key',
        );
      },
    );
  });

  group('identity (§6.8)', () {
    test('the fingerprint covers both keys', () {
      final hex = fingerprintHex(
        x25519PublicKey: alice.x25519PublicKey,
        ed25519PublicKey: alice.ed25519PublicKey,
      );
      expect(hex.length, 64);
      expect(groupFingerprint(hex).split(' ').length, 8);
      expect(groupFingerprint(hex).split(' ').first.length, 8);
      expect(
        fingerprintHex(
          x25519PublicKey: bob.x25519PublicKey,
          ed25519PublicKey: alice.ed25519PublicKey,
        ),
        isNot(hex),
        reason: 'a substituted sealing key is visible (D-15)',
      );
      expect(
        fingerprintHex(
          x25519PublicKey: alice.x25519PublicKey,
          ed25519PublicKey: bob.ed25519PublicKey,
        ),
        isNot(hex),
        reason: 'a substituted identity key is visible (D-15)',
      );
    });

    test(
      'a verification payload round-trips and its fingerprint self-checks',
      () {
        final uri = verifyUri(
          userId: aliceId,
          x25519PublicKey: alice.x25519PublicKey,
          ed25519PublicKey: alice.ed25519PublicKey,
        );
        expect(utf8.encode(uri).length, 216);
        final parsed = parseVerifyUri(uri);
        expect(parsed.userId, aliceId);
        expect(
          encodeHex(parsed.x25519PublicKey),
          encodeHex(alice.x25519PublicKey),
        );
        expect(
          encodeHex(parsed.ed25519PublicKey),
          encodeHex(alice.ed25519PublicKey),
        );
        expect(
          parsed.fingerprintHex,
          fingerprintHex(
            x25519PublicKey: alice.x25519PublicKey,
            ed25519PublicKey: alice.ed25519PublicKey,
          ),
        );
        expectRefusal(
          CryptoError.verify,
          () => parseVerifyUri(
            uri.replaceFirst(
              '&k=${encodeBase64Url(alice.ed25519PublicKey)}',
              '&k=${encodeBase64Url(bob.ed25519PublicKey)}',
            ),
          ),
          'a fingerprint that does not cover the keys',
        );
      },
    );

    test('the safety number is the same for both users', () {
      final aliceFingerprint = fingerprint(
        x25519PublicKey: alice.x25519PublicKey,
        ed25519PublicKey: alice.ed25519PublicKey,
      );
      final bobFingerprint = fingerprint(
        x25519PublicKey: bob.x25519PublicKey,
        ed25519PublicKey: bob.ed25519PublicKey,
      );
      final first = safetyNumber(
        firstFingerprint: aliceFingerprint,
        secondFingerprint: bobFingerprint,
      );
      final second = safetyNumber(
        firstFingerprint: bobFingerprint,
        secondFingerprint: aliceFingerprint,
      );
      expect(first, second);
      expect(first.length, safetyNumberDigits);
      expect(groupSafetyNumber(first).split(' ').length, 12);
      expect(groupSafetyNumber(first).split(' ').first.length, 5);
    });
  });

  group('the prohibitions the requirement states as prose', () {
    test(
      'no code path names a password-based key derivation (D-17, INV-12)',
      () {
        // A source scan, not a vector: a password KDF leaves no trace in a vector.
        // Comments are stripped first, so the doc comments that *say* no key comes
        // from a password do not trip their own check.
        final forbidden = RegExp(
          r'(crypto_pwhash|pwhash\s*[.(]|\w*pwhash\w*\s*[.(]|argon2|bcrypt|scrypt|pbkdf)',
          caseSensitive: false,
        );
        final offenders = <String>[];
        for (final file in librarySources()) {
          for (final line in file.readAsLinesSync()) {
            if (line.trimLeft().startsWith('//')) continue;
            if (forbidden.hasMatch(line)) {
              offenders.add('${file.path}: a password-based KDF');
            }
          }
        }
        expect(offenders, isEmpty);
      },
    );

    test('no function declares a password parameter (INV-12)', () {
      final declared = RegExp(
        r'(password|passphrase|passwd|secret_phrase)\s*[,)=;]',
        caseSensitive: false,
      );
      final offenders = <String>[];
      for (final file in librarySources()) {
        for (final line in file.readAsLinesSync()) {
          if (line.trimLeft().startsWith('//')) continue;
          if (declared.hasMatch(line)) offenders.add(file.path);
        }
      }
      expect(offenders, isEmpty);
    });
  });
}

/// Every Dart file under `lib/`, the package's own code.
List<File> librarySources() =>
    Directory('lib')
        .listSync(recursive: true)
        .whereType<File>()
        .where((file) => file.path.endsWith('.dart'))
        .toList();
