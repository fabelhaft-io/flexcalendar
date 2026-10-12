// E12-R02 crypto-libs probe — the checks, shared by the Dart VM probe
// (`bin/probe.dart`) and the Flutter/Android probe
// (`../flutter/lib/checks.dart`, the same file with the import swapped to
// `package:sodium_libs/sodium_libs.dart`).
//
// Every fixed value below is an **invented test value, never a secret**: fixed
// keys, a fixed nonce, a fixed message and a fixed Ed25519 seed exist so the
// three probes print byte-identical hex for the same primitive. Sealed boxes
// and the RNG are randomised; only their round trips are compared.
//
// No password-based key derivation is called anywhere (D-17, INV-12): the
// `crypto_pwhash` family is only *listed* for presence, never invoked, and
// nothing in here derives a key from a password.

import 'dart:convert';
import 'dart:typed_data';

import 'package:sodium/sodium.dart';

/// Fixed run of bytes: [start], start+1, ... — the same values in all probes.
Uint8List byteRun(int start, int length) => Uint8List.fromList(
  List<int>.generate(length, (index) => (start + index) & 0xff),
);

String toHex(Uint8List bytes) =>
    bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();

Uint8List ascii(String text) => Uint8List.fromList(utf8.encode(text));

/// Fixed inputs, identical in the Dart, Flutter and Node probes.
final Uint8List aeadKey = byteRun(0x00, 32);
final Uint8List aeadNonce = byteRun(0x40, 24);
final Uint8List probeMessage = ascii('flexcalendar E12-R02 probe');
final Uint8List probeAad = ascii('calflex-v1-probe-aad');
final Uint8List ed25519Seed = byteRun(0x20, 32);
final Uint8List kdfMasterKey = byteRun(0x60, 32);
const String kdfContext = 'calflex1';

/// RFC 5869 test case 1 — PRK only through the Dart API: the 10-byte `info` is
/// not ASCII, and `KdfHkdf.expand` takes a `String` context it encodes as UTF-8.
final Uint8List rfc5869Tc1Ikm = Uint8List.fromList(List<int>.filled(22, 0x0b));
final Uint8List rfc5869Tc1Salt = byteRun(0x00, 13);
final Uint8List rfc5869Tc1Info = byteRun(0xf0, 10);
const String rfc5869Tc1Prk =
    '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5';
const String rfc5869Tc1Okm =
    '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865';

/// RFC 5869 test case 3 — empty salt and empty `info`, so the whole vector is
/// reachable through the Dart API's `extract` + `expand`.
final Uint8List rfc5869Tc3Ikm = Uint8List.fromList(List<int>.filled(22, 0x0b));
const int rfc5869OkmLength = 42;
const String rfc5869Tc3Prk =
    '19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04';
const String rfc5869Tc3Okm =
    '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8';

/// A 10-byte ASCII info, used to show the API takes info longer than the
/// `crypto_kdf_hkdf_sha256_CONTEXTBYTES` of the older libsodium API.
const String asciiHkdfInfo = 'calflexhk';

class CheckReport {
  final List<String> lines = <String>[];
  final List<String> gaps = <String>[];
  final List<String> failures = <String>[];

  void value(String name, Object value) => lines.add('$name=$value');

  void ok(String name) => value('$name.result', 'ok');

  void fail(String name, String why) => failures.add('$name: $why');

  void gap(String name, String why) {
    value(name, 'absent');
    gaps.add('$name ($why)');
  }
}

/// Runs `body` and records whether it rejected a tampered input.
void rejected(CheckReport report, String name, void Function() body) {
  try {
    body();
    report.fail(name, 'succeeded, but the tampered input must not open');
  } on SodiumException {
    report.value(name, 'rejected (SodiumException)');
  }
}

/// Runs every primitive check against an initialised [sodium].
CheckReport runAllChecks(
  Sodium sodium, {
  required String libraryName,
  required String packageVersion,
  required String implementation,
}) {
  final report = CheckReport();
  report.value('probe.library', libraryName);
  report.value('probe.package_version', packageVersion);
  report.value('probe.implementation', implementation);
  report.value('sodium.version_string', sodium.version);
  report.value('sodium.library_version.major', sodium.version.major);
  report.value('sodium.library_version.minor', sodium.version.minor);

  // Presence only: D-17 forbids deriving a key from the login password, so no
  // probe calls Argon2id — listing what the build exposes is as far as this goes.
  report.value(
    'crypto_pwhash.present',
    'yes (native build; reachable only through the SodiumSumo API)',
  );
  report.value(
    'crypto_pwhash.called',
    'no (D-17: no key derives from the login password)',
  );

  final crypto = sodium.crypto;

  // --- XChaCha20-Poly1305-IETF ---------------------------------------------
  const aeadPrefix = 'aead.xchacha20poly1305_ietf';
  final aead = crypto.aeadXChaCha20Poly1305IETF;
  final aeadSecureKey = SecureKey.fromList(sodium, aeadKey);
  report.value('$aeadPrefix.key', toHex(aeadKey));
  report.value('$aeadPrefix.nonce', toHex(aeadNonce));
  report.value('$aeadPrefix.message', toHex(probeMessage));
  report.value('$aeadPrefix.aad', toHex(probeAad));
  report.value('$aeadPrefix.key_bytes', aead.keyBytes);
  report.value('$aeadPrefix.nonce_bytes', aead.nonceBytes);
  report.value('$aeadPrefix.tag_bytes', aead.aBytes);

  final cipherText = aead.encrypt(
    message: probeMessage,
    nonce: aeadNonce,
    key: aeadSecureKey,
    additionalData: probeAad,
  );
  report.value('$aeadPrefix.ciphertext', toHex(cipherText));
  report.value('$aeadPrefix.ciphertext_bytes', cipherText.length);

  final decrypted = aead.decrypt(
    cipherText: cipherText,
    nonce: aeadNonce,
    key: aeadSecureKey,
    additionalData: probeAad,
  );
  report.value('$aeadPrefix.decrypted', toHex(decrypted));
  if (toHex(decrypted) != toHex(probeMessage)) {
    report.fail('$aeadPrefix.decrypt', 'round trip returned other bytes');
  } else {
    report.ok(aeadPrefix);
  }

  final flippedTag = Uint8List.fromList(cipherText);
  flippedTag[flippedTag.length - 1] ^= 0x01;
  rejected(
    report,
    '$aeadPrefix.flipped_tag',
    () => aead.decrypt(
      cipherText: flippedTag,
      nonce: aeadNonce,
      key: aeadSecureKey,
      additionalData: probeAad,
    ),
  );

  final flippedAad = Uint8List.fromList(probeAad);
  flippedAad[0] ^= 0x01;
  rejected(
    report,
    '$aeadPrefix.flipped_aad',
    () => aead.decrypt(
      cipherText: cipherText,
      nonce: aeadNonce,
      key: aeadSecureKey,
      additionalData: flippedAad,
    ),
  );
  aeadSecureKey.dispose();

  // --- crypto_box_seal ------------------------------------------------------
  const sealPrefix = 'box.seal';
  final box = crypto.box;
  final recipient = box.keyPair();
  final other = box.keyPair();
  final sealed = box.seal(
    message: probeMessage,
    publicKey: recipient.publicKey,
  );
  report.value('$sealPrefix.message_bytes', probeMessage.length);
  report.value('$sealPrefix.ciphertext_bytes', sealed.length);
  report.value(
    '$sealPrefix.overhead_bytes',
    sealed.length - probeMessage.length,
  );
  report.value('$sealPrefix.constant_seal_bytes', box.sealBytes);

  final unsealed = box.sealOpen(
    cipherText: sealed,
    publicKey: recipient.publicKey,
    secretKey: recipient.secretKey,
  );
  if (toHex(unsealed) != toHex(probeMessage)) {
    report.fail('$sealPrefix.roundtrip', 'sealed box did not open');
  } else {
    report.ok('$sealPrefix.roundtrip');
  }
  rejected(
    report,
    '$sealPrefix.wrong_recipient',
    () => box.sealOpen(
      cipherText: sealed,
      publicKey: other.publicKey,
      secretKey: other.secretKey,
    ),
  );
  recipient.dispose();
  other.dispose();

  // --- Ed25519 detached signatures -----------------------------------------
  const signPrefix = 'sign.ed25519';
  final sign = crypto.sign;
  report.value('$signPrefix.seed', toHex(ed25519Seed));
  report.value('$signPrefix.message', toHex(probeMessage));
  final signingKey = sign.seedKeyPair(SecureKey.fromList(sodium, ed25519Seed));
  report.value('$signPrefix.public_key', toHex(signingKey.publicKey));
  final signature = sign.detached(
    message: probeMessage,
    secretKey: signingKey.secretKey,
  );
  report.value('$signPrefix.signature', toHex(signature));

  final verified = sign.verifyDetached(
    message: probeMessage,
    signature: signature,
    publicKey: signingKey.publicKey,
  );
  if (!verified) {
    report.fail('$signPrefix.verify', 'detached signature did not verify');
  } else {
    report.ok('$signPrefix.verify');
  }

  final flippedMessage = Uint8List.fromList(probeMessage);
  flippedMessage[0] ^= 0x01;
  var flippedVerified = false;
  try {
    flippedVerified = sign.verifyDetached(
      message: flippedMessage,
      signature: signature,
      publicKey: signingKey.publicKey,
    );
  } on SodiumException {
    flippedVerified = false;
  }
  if (flippedVerified) {
    report.fail('$signPrefix.flipped_message', 'verified a changed message');
  } else {
    report.value('$signPrefix.flipped_message', 'rejected');
  }
  signingKey.dispose();

  // --- crypto_kdf (BLAKE2b derive_from_key) --------------------------------
  const kdfPrefix = 'kdf.derive_from_key';
  final kdf = crypto.kdf;
  report.value('$kdfPrefix.master_key', toHex(kdfMasterKey));
  report.value('$kdfPrefix.context', kdfContext);
  report.value('$kdfPrefix.subkey_id', 1);
  report.value('$kdfPrefix.context_bytes', kdf.contextBytes);
  report.value('$kdfPrefix.key_bytes', kdf.keyBytes);
  final subkey = kdf.deriveFromKey(
    masterKey: SecureKey.fromList(sodium, kdfMasterKey),
    context: kdfContext,
    subkeyId: BigInt.one,
    subkeyLen: 32,
  );
  report.value('$kdfPrefix.subkey', toHex(subkey.extractBytes()));
  if (subkey.length != 32) {
    report.fail('$kdfPrefix.subkey', 'expected 32 bytes, got ${subkey.length}');
  } else {
    report.ok(kdfPrefix);
  }
  subkey.dispose();

  // --- HKDF-SHA-256 ---------------------------------------------------------
  const hkdfPrefix = 'kdf.hkdf_sha256';
  final hkdf = crypto.kdfHkdfSha256;
  report.value('$hkdfPrefix.in_library', 'yes');
  report.value('$hkdfPrefix.key_bytes', hkdf.keyBytes);
  report.value('$hkdfPrefix.bytes_min', hkdf.bytesMin);
  report.value('$hkdfPrefix.bytes_max', hkdf.bytesMax);
  report.value('$hkdfPrefix.context_bytes', 'not fixed (arbitrary UTF-8 info)');

  final tc1Prk = hkdf.extract(salt: rfc5869Tc1Salt, ikm: rfc5869Tc1Ikm);
  report.value('$hkdfPrefix.rfc5869_tc1_prk', toHex(tc1Prk.extractBytes()));
  if (toHex(tc1Prk.extractBytes()) != rfc5869Tc1Prk) {
    report.fail('$hkdfPrefix.rfc5869_tc1_prk', 'PRK differs from RFC 5869 A.1');
  }
  report.value(
    '$hkdfPrefix.rfc5869_tc1_info',
    '${toHex(rfc5869Tc1Info)} (10 non-ASCII bytes: not expressible through the '
        'Dart API, which takes the info as a String and encodes it as UTF-8; '
        'the RFC 5869 A.1 OKM is checked on the Node side instead)',
  );
  report.value(
    '$hkdfPrefix.rfc5869_tc1_okm42',
    'not reachable through this API',
  );
  report.value('$hkdfPrefix.rfc5869_tc1_okm42_rfc', rfc5869Tc1Okm);

  // Test case 3 has an empty salt and an empty info, so both steps are
  // reachable: `expand` with a zero-length context.
  final tc3Prk = hkdf.extract(salt: Uint8List(0), ikm: rfc5869Tc3Ikm);
  report.value('$hkdfPrefix.rfc5869_tc3_prk', toHex(tc3Prk.extractBytes()));
  if (toHex(tc3Prk.extractBytes()) != rfc5869Tc3Prk) {
    report.fail('$hkdfPrefix.rfc5869_tc3_prk', 'PRK differs from RFC 5869 A.3');
  }
  final tc3Okm = hkdf.expand(
    masterKey: tc3Prk,
    context: '',
    outLen: rfc5869OkmLength,
  );
  report.value('$hkdfPrefix.rfc5869_tc3_okm42', toHex(tc3Okm.extractBytes()));
  if (toHex(tc3Okm.extractBytes()) != rfc5869Tc3Okm) {
    report.fail(
      '$hkdfPrefix.rfc5869_tc3_okm42',
      'OKM differs from RFC 5869 A.3',
    );
  } else {
    report.ok(hkdfPrefix);
  }
  tc3Okm.dispose();

  // The same expansion with a 10-byte ASCII info: the value is compared with
  // the Node probe's `node:crypto` result in the verification doc.
  final asciiOkm = hkdf.expand(
    masterKey: tc3Prk,
    context: asciiHkdfInfo,
    outLen: rfc5869OkmLength,
  );
  report.value('$hkdfPrefix.ascii_info', asciiHkdfInfo);
  report.value('$hkdfPrefix.ascii_info_okm42', toHex(asciiOkm.extractBytes()));
  asciiOkm.dispose();
  tc3Prk.dispose();

  // --- randombytes_buf ------------------------------------------------------
  const randomPrefix = 'randombytes.buf';
  final first = sodium.randombytes.buf(32);
  final second = sodium.randombytes.buf(32);
  report.value('$randomPrefix.length', first.length);
  report.value(
    '$randomPrefix.two_draws_differ',
    toHex(first) == toHex(second) ? 'no' : 'yes',
  );
  report.value(
    '$randomPrefix.not_all_zero',
    first.every((byte) => byte == 0) ? 'no' : 'yes',
  );
  if (toHex(first) == toHex(second)) {
    report.fail(randomPrefix, 'two RNG draws were identical');
  }

  return report;
}

/// The values every probe must reproduce, byte for byte. They were frozen from
/// the first full run of the three probes (2026-10-12), where the Dart VM and
/// the Node runs already agreed — these are what `packages/crypto_dart`
/// (E12-R01/R03) and `packages/crypto-ts` are held to. Sealed boxes and the RNG
/// are randomised, so only their lengths are frozen.
const Map<String, String> frozenValues = <String, String>{
  'aead.xchacha20poly1305_ietf.ciphertext': 'b2556008b3811573e190e6cc8fd954a0bfe89df6332921f50854c535933ba4680105dbb564a0cacb1b6a',
  'aead.xchacha20poly1305_ietf.decrypted':
      '666c657863616c656e646172204531322d5230322070726f6265',
  'box.seal.overhead_bytes': '48',
  'sign.ed25519.public_key':
      '29acbae141bccaf0b22e1a94d34d0bc7361e526d0bfe12c89794bc9322966dd7',
  'sign.ed25519.signature': 'a0060e738f9b9107b9656b9cebc3721bf9425295af8f6b11ce030a14cee9dbe77ac9f6ed23acb6bb8b423cad37e6fa8ba707780f011a0428926df206d3ab900c',
  'kdf.derive_from_key.subkey':
      'a377a3cab11df056b2f26740a10101b9fb451c47d5e393da2c3312dd064d9f9e',
  'kdf.hkdf_sha256.rfc5869_tc1_prk':
      '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5',
  'kdf.hkdf_sha256.rfc5869_tc3_prk':
      '19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04',
  'kdf.hkdf_sha256.rfc5869_tc3_okm42': '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
  'kdf.hkdf_sha256.ascii_info_okm42': '8f1021c886806450618d011707fd796d80c674f1258afcb6c2f7e92ab407e3234e4c8778a10ebbe432ce',
};

/// The [frozenValues] a report does not reproduce, as `name: expected …, saw …`.
List<String> frozenValueMismatches(CheckReport report) {
  final seen = <String, String>{};
  for (final line in report.lines) {
    final separator = line.indexOf('=');
    if (separator > 0) {
      seen[line.substring(0, separator)] = line.substring(separator + 1);
    }
  }
  return <String>[
    for (final MapEntry<String, String> entry in frozenValues.entries)
      if (seen[entry.key] != entry.value)
        '${entry.key}: expected ${entry.value}, saw ${seen[entry.key] ?? '<missing>'}',
  ];
}
