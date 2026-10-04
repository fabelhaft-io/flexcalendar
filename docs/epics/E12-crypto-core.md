# E12 — Crypto core and shared test vectors

| | |
|---|---|
| Phase | 5 (can start right after E02; it has no product dependencies) |
| Status | Blocked on D-08, D-14, D-15, D-16 |
| Executor | `agent+review`: every PR is approved by a human; an external review happens before M5 |
| Depends on | E02 |
| Spec | ADR 0001 § Private calendars — cryptography, ADR 0002 § Consequences |

## Goal

Two small libraries, `packages/crypto_dart` and `packages/crypto-ts`, that produce byte-identical results from one written spec and one set of test vectors. Nothing on the server links either of them (INV-07).

## Requirements

### E12-R01 · Written wire spec   `agent+review`
`spec/crypto.md` MUST define every byte:
- the envelope layout from ADR 0001 (version, epoch, nonce, ciphertext, tag);
- the **canonical AAD encoding**: `"calflex-v1"`, then length-prefixed (u32 BE) UTF-8 fields in a fixed order, including the fields D-14 adds;
- the payload: JSCalendar (RFC 8984) field names, serialised with JCS (RFC 8785);
- the formats of wrapped private keys, sealed CCK records (per D-15) and recovery-code encoding;
- Argon2id parameters, stored per user so they can be upgraded.
- Accept: a reviewer can implement from the spec alone; every field has a test vector.

### E12-R02 · Library capability check   `agent`
Before writing any implementation, a spike MUST confirm that `sodium_libs` (Flutter, iOS and Android) and `libsodium-wrappers-sumo` (web) provide XChaCha20-Poly1305-IETF, `crypto_box_seal`, `crypto_pwhash` Argon2id, Ed25519 and HKDF/`crypto_kdf` (ADR 0002 says to verify, not assume).
- Accept: `docs/verification/crypto-libs-<date>.md` records versions and any gaps.
- Notes: the non-sumo `libsodium-wrappers` build **lacks `crypto_pwhash`**, so web needs the sumo build (larger WASM). Take that into account for the web bundle budget.

### E12-R03 · Envelope seal/open   `agent+review`
Both libraries MUST implement `seal(cck, epoch, skeleton, payload) → bytes` and `open(cck, bytes, skeleton) → payload` per R01, with a random 24-byte nonce for every seal.
- Accept: all positive and negative vectors pass (tampered AAD field, wrong epoch, truncated, wrong version, flipped tag bit); open never returns partial plaintext.

### E12-R04 · Key hierarchy   `agent+review`
Implement: user keypair generation (X25519 for sealing, plus Ed25519 for signing per D-15); a password KEK via Argon2id with a per-user salt; a recovery-code KEK via HKDF; wrap and unwrap of the private keys; CCK generation; sealing a CCK to a member.
- Accept: the vectors pass in both languages; a key wrapped in Dart unwraps in TS and the reverse; the Argon2id cost is ≤ 1.5 s on a reference mid-range Android phone and a 2020 laptop browser (the parameters are recorded in R01).
- Notes: per D-16, the Dart library owns recovery-code, Shamir and escrow wrapping; the TS library implements the operational subset only.

### E12-R05 · Cross-language vectors in CI   `agent`
`spec/crypto-vectors/*.json` (generated once and then frozen) MUST be run by both libraries in `make verify`.
- Accept: changing a single byte in the TS output fails CI; adding a field to the spec without a vector fails a completeness check.

### E12-R06 · Key storage on device   `agent+review`
Mobile keeps the unwrapped private keys in `flutter_secure_storage` (Keychain / Keystore). Web keeps them in memory, and optionally persists them wrapped by a non-extractable WebCrypto AES-GCM key in IndexedDB, so a page reload doesn't ask for the password again.
- Accept: sign-out wipes both; a test checks that keys never reach `localStorage` or logs.

### E12-R07 · Shamir 2-of-3 (Dart)   `agent+review`
A k-of-n Shamir split over GF(256) for the recovery secret, used by E14-R05. Use an audited package if one exists; otherwise a minimal implementation with published test vectors.
- Accept: any 2 of 3 shares reconstruct; a single share reveals nothing (statistical test over the vectors); shares carry an index and a checksum.
