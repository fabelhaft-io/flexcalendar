# E12 — Crypto core and shared test vectors

| | |
|---|---|
| Phase | 2 (Dart: R01–R06); 5 (TS library, web part of R06); 7 (R07). Starts right after E02 and is on the critical path to M1 (ADR 0003) |
| Status | Ready: R01 (wire spec) and R02 (library check). R03 onwards blocked on E02 |
| Executor | `agent+review`: every PR is approved by a human; an external review happens before M5 |
| Depends on | E02 |
| Spec | ADR 0001 § Private calendars — cryptography, ADR 0002 § Consequences |

## Goal

Two small libraries, `packages/crypto_dart` (Phase 2) and `packages/crypto-ts` (Phase 5), that produce byte-identical results from one written spec and one set of test vectors. The vectors are frozen in Phase 2, so the TS library has a fixed target. Nothing on the server links either of them (INV-07).

## Requirements

### E12-R01 · Written wire spec   `agent+review`
`spec/crypto.md` MUST define every byte:
- the envelope layout from ADR 0001 (version, epoch, nonce, ciphertext, tag);
- the **canonical AAD encoding**: `"calflex-v1"`, then length-prefixed (u32 BE) UTF-8 fields in a fixed order, including the fields D-14 adds;
- the payload: JSCalendar (RFC 8984) field names, serialised with JCS (RFC 8785);
- the formats of wrapped private keys, sealed CCK records (per D-15) and recovery-code encoding;
- the device-link message (E14-R08): ephemeral public key, short verification code, sealed key bundle.
- Per D-17 there are no Argon2id parameters. They return only if a separate passphrase option is ever added.
- Accept: a reviewer can implement from the spec alone; every field has a test vector.

### E12-R02 · Library capability check   `agent`
Before writing any implementation, a spike MUST confirm that `sodium_libs` (Flutter, Android and iOS; Phase 2) and `libsodium-wrappers` (web; Phase 5) provide XChaCha20-Poly1305-IETF, `crypto_box_seal`, Ed25519 and HKDF/`crypto_kdf` (ADR 0002 says to verify, not assume).
- Accept: `docs/verification/crypto-libs-<date>.md` records versions and any gaps.
- Notes: the non-sumo `libsodium-wrappers` build lacks `crypto_pwhash` and some other primitives. Without Argon2id (D-17) it may be enough; check every primitive above before choosing it over the larger sumo build.

### E12-R03 · Envelope seal/open   `agent+review`
Both libraries (Dart in Phase 2, TS in Phase 5) MUST implement `seal(cck, epoch, skeleton, payload) → bytes` and `open(cck, bytes, skeleton) → payload` per R01, with a random 24-byte nonce for every seal.
- Accept: all positive and negative vectors pass (tampered AAD field, wrong epoch, truncated, wrong version, flipped tag bit); open never returns partial plaintext.

### E12-R04 · Key hierarchy   `agent+review`
Implement:
- user keypair generation (X25519 for sealing, plus Ed25519 for signing per D-15);
- a recovery-code KEK via HKDF, and wrap and unwrap of the private keys under it;
- device-link sealing of the private keys to a new device's ephemeral X25519 key;
- CCK generation, and sealing a CCK to a member, signed with the sender's identity key.

Per D-17, no KEK is derived from the login password.
- Accept: the vectors pass in Dart (Phase 2) and TS (Phase 5); from Phase 5 a key wrapped in Dart unwraps in TS and the reverse; no library function accepts a password (INV-12).
- Notes: per D-16, the Dart library owns recovery-code, Shamir and escrow wrapping; the TS library implements the operational subset only.

### E12-R05 · Cross-language vectors in CI   `agent`
`spec/crypto-vectors/*.json` (generated once and then frozen) MUST be run in `make verify` by the Dart library from Phase 2, and by both libraries from Phase 5.
- Accept: changing a single byte in either library's output fails CI; adding a field to the spec without a vector fails a completeness check.

### E12-R06 · Key storage on device   `agent+review`
Mobile keeps the unwrapped private keys in `flutter_secure_storage` (Keychain / Keystore). Web (Phase 5) keeps them in memory, and optionally persists them wrapped by a non-extractable WebCrypto AES-GCM key in IndexedDB, so a page reload doesn't ask for the password again.
- Accept: sign-out wipes both; a test checks that keys never reach `localStorage` or logs.

### E12-R07 · Shamir 2-of-3 (Dart, Phase 7)   `agent+review`
A k-of-n Shamir split over GF(256) for the recovery secret, used by E14-R05. Use an audited package if one exists; otherwise a minimal implementation with published test vectors.
- Accept: any 2 of 3 shares reconstruct; a single share reveals nothing (statistical test over the vectors); shares carry an index and a checksum.
