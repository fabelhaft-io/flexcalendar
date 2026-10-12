/// The recovery code and its KEK, `spec/crypto.md` §6.4 and §6.3.1 (D-17).
///
/// 128 bits from the CSPRNG, shown once, encoded as twelve BIP-0039 English
/// words. A phrase is typed back in, lowercased, split on runs of U+0020 or the
/// ideographic space U+3000, required to be exactly twelve known words and
/// checked against its checksum **before** anything is derived — anything else is
/// [CryptoError.recovery], so the user is never told *which* word is wrong.
///
/// ```
/// KEK_rc = HKDF-SHA-256(ikm = entropy(16 bytes), salt = "calflex-v1",
///                       info = "calflex-v1/recovery-kek", L = 32)
/// ```
///
/// The `ikm` is the **16-byte entropy**, not the words' text: a differently spaced
/// or differently cased spelling of one phrase derives the same KEK, and no
/// Unicode normalisation enters the derivation (§6.3.1).
///
/// **No Argon2id, in any configuration, and no `crypto_kdf`.** Every derivation
/// here is HKDF-SHA-256, and every `info` is ASCII on purpose: Dart's `sodium`
/// takes HKDF's `info` as a `String` (§6.3.1). Both libraries stay on the
/// standard build (D-16).
///
/// **The login password is not an input anywhere** (D-17, INV-12). Nothing in
/// this file takes one, and no library function in this package may.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'bip39_english.dart';
import 'errors.dart';
import 'libsodium.dart';

/// 128 bits of entropy (§6.4).
const int recoveryEntropyBytes = 16;

/// Twelve words, each an 11-bit group of the 132 bits (§6.4).
const int recoveryWordCount = 12;

/// The derived KEK's length, `L = 32` (§6.3.1).
const int recoveryKekBytes = 32;

/// §6.3.1's ASCII salt.
const String recoveryKekSalt = 'calflex-v1';

/// §6.3.1's ASCII `info`.
const String recoveryKekInfo = 'calflex-v1/recovery-kek';

/// 128 bits from the CSPRNG: the entropy a recovery code is made of.
Uint8List generateRecoveryEntropy() => randomBytes(recoveryEntropyBytes);

/// A fresh recovery code, twelve words, for the one screen that shows it.
///
/// Shown once and never sent anywhere (§6.4): the server stores only the wrap
/// under the KEK this code derives.
String generateRecoveryPhrase() => recoveryPhrase(generateRecoveryEntropy());

/// §6.4's encoding: 16 bytes and a 4-bit checksum as twelve BIP-0039 words.
///
/// The 132 bits are cut into eleven-bit groups most significant bit first, each
/// an index into [bip39EnglishWords] (the 2048-word list whose SHA-256 is
/// `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`).
String recoveryPhrase(Uint8List entropy) {
  if (entropy.length != recoveryEntropyBytes) {
    throw const CryptoException(
      CryptoError.length,
      'recovery entropy is 16 bytes',
    );
  }
  final checksum = sha256.convert(entropy).bytes[0];
  final words = <String>[];
  var bits = 0;
  var bitCount = 0;
  // The 128 entropy bits, then the 4 checksum bits, as one stream: 132 bits is
  // exactly twelve 11-bit groups.
  void feed(int byte, int from, int to) {
    for (var i = from; i >= to; i--) {
      bits = (bits << 1) | ((byte >> i) & 1);
      bitCount++;
      if (bitCount == 11) {
        words.add(bip39EnglishWords[bits]);
        bits = 0;
        bitCount = 0;
      }
    }
  }

  for (final byte in entropy) {
    feed(byte, 7, 0);
  }
  feed(checksum, 7, 4);
  return words.join(' ');
}

/// §6.4's rules for a phrase typed back in, returning the 16 bytes of entropy.
///
/// Lowercases the input, splits on runs of U+0020 or U+3000, and requires exactly
/// twelve known words whose checksum holds — all before any key derivation. A
/// surrounding separator from a paste is stripped; an empty word anywhere else is
/// [CryptoError.recovery] like any other unknown word.
Uint8List parseRecoveryPhrase(String phrase) {
  final words = _trimSeparators(phrase.toLowerCase()).split(_separator);
  if (words.length != recoveryWordCount) {
    throw const CryptoException(
      CryptoError.recovery,
      'a recovery phrase that is not twelve words',
    );
  }
  final indices = <int>[];
  for (final word in words) {
    final index = bip39EnglishIndex[word];
    if (index == null) {
      throw const CryptoException(
        CryptoError.recovery,
        'a recovery phrase with a word outside the pinned list',
      );
    }
    indices.add(index);
  }
  final entropy = _entropyOf(indices);
  final checksum = sha256.convert(entropy).bytes[0] >> 4;
  if (checksum != _checksumOf(indices)) {
    throw const CryptoException(
      CryptoError.recovery,
      'a recovery phrase whose checksum does not hold',
    );
  }
  return entropy;
}

/// §6.3.1's `KEK_rc`: HKDF-SHA-256 over the 16 bytes of entropy.
///
/// The KEK is **never stored** and never leaves the device; the server holds only
/// the wrap (§6.3.1).
Uint8List recoveryKek(Uint8List entropy) {
  if (entropy.length != recoveryEntropyBytes) {
    throw const CryptoException(
      CryptoError.length,
      'recovery entropy is 16 bytes',
    );
  }
  final hkdf = libSodium.crypto.kdfHkdfSha256;
  final salt = Uint8List.fromList(utf8.encode(recoveryKekSalt));
  final master = hkdf.extract(salt: salt, ikm: entropy);
  try {
    final kek = hkdf.expand(
      masterKey: master,
      context: recoveryKekInfo,
      outLen: recoveryKekBytes,
    );
    try {
      return kek.extractBytes();
    } finally {
      kek.dispose();
    }
  } finally {
    master.dispose();
  }
}

/// [recoveryKek] of a phrase: parse (checksum first), then derive.
///
/// The recovery procedure of §6.4 in one call, so a caller cannot skip the
/// validation step: phrase → entropy → `KEK_rc`.
Uint8List recoveryKekFromPhrase(String phrase) =>
    recoveryKek(parseRecoveryPhrase(phrase));

/// Word → index, built once from the vendored list.
final Map<String, int> bip39EnglishIndex = Map<String, int>.unmodifiable({
  for (var index = 0; index < bip39EnglishWords.length; index++)
    bip39EnglishWords[index]: index,
});

final RegExp _separator = RegExp('[\u0020\u3000]+');

String _trimSeparators(String value) {
  var start = 0;
  var end = value.length;
  while (start < end && _isSeparator(value.codeUnitAt(start))) {
    start++;
  }
  while (end > start && _isSeparator(value.codeUnitAt(end - 1))) {
    end--;
  }
  return value.substring(start, end);
}

bool _isSeparator(int codeUnit) => codeUnit == 0x20 || codeUnit == 0x3000;

/// The 128 entropy bits of twelve 11-bit indices.
Uint8List _entropyOf(List<int> indices) {
  final entropy = Uint8List(recoveryEntropyBytes);
  var bit = 0;
  for (final index in indices) {
    for (var i = 10; i >= 0; i--) {
      if (bit < 128) {
        entropy[bit >> 3] |= ((index >> i) & 1) << (7 - (bit & 7));
      }
      bit++;
    }
  }
  return entropy;
}

/// The 4 checksum bits, the last four of the twelve 11-bit groups.
int _checksumOf(List<int> indices) {
  final last = indices.last;
  return last & 0x0f;
}
