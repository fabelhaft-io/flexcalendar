/// The refusal codes of `spec/crypto.md` §0.3.
///
/// The codes are part of the wire contract because the frozen vectors in
/// `spec/crypto-vectors/` name them: a caller must not be able to tell a wrong
/// key from a flipped tag byte (both are [CryptoError.auth]).
///
/// Nothing here ever carries plaintext: a refusal message names the *step* that
/// refused, never a payload byte, a `SUMMARY`, a `DESCRIPTION` or an attendee
/// (INV-07).
enum CryptoError {
  /// A version byte or label version this implementation does not know, or a
  /// kind byte that contradicts the kind the caller asked for.
  version('E_VERSION'),

  /// Too short, too long, or a fixed field of the wrong size.
  length('E_LENGTH'),

  /// An epoch outside `0 … 2 147 483 647`.
  epoch('E_EPOCH'),

  /// Non-canonical hex/base64/base64url/UUID/decimal, or a field of the wrong
  /// type.
  encoding('E_ENCODING'),

  /// AEAD tag verification failed: wrong key, wrong AAD, flipped ciphertext or
  /// tag bit, truncation inside the ciphertext, or the wrong envelope kind.
  auth('E_AUTH'),

  /// The plaintext is not valid UTF-8 or not valid JCS JSON, or its members
  /// violate `spec/crypto.md` §4.
  payload('E_PAYLOAD'),

  /// Ed25519 verification failed, or the blob carries no signature.
  signature('E_SIGNATURE'),

  /// A skeleton property is missing, not canonical, or contradicts another
  /// property.
  skeleton('E_SKELETON'),

  /// A recovery phrase that is not 12 known words from the pinned list, or whose
  /// checksum fails.
  recovery('E_RECOVERY'),

  /// A `calflex://` payload whose contents contradict each other.
  verify('E_VERIFY'),

  /// Well-formed input that version 1 deliberately does not process.
  unsupported('E_UNSUPPORTED');

  const CryptoError(this.code);

  /// The `E_…` name the vectors use.
  final String code;

  @override
  String toString() => code;
}

/// A refusal, carrying the §0.3 code the caller must see.
///
/// [detail] is for a developer reading a stack trace. It must never contain
/// envelope bytes, plaintext or any event content.
class CryptoException implements Exception {
  const CryptoException(this.error, [this.detail]);

  /// The §0.3 code.
  final CryptoError error;

  /// A short, non-sensitive note about which step refused.
  final String? detail;

  @override
  String toString() => detail == null
      ? 'CryptoException(${error.code})'
      : 'CryptoException(${error.code}: $detail)';
}
