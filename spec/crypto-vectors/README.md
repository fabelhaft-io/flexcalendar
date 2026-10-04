# `spec/crypto-vectors/` — cross-language crypto test vectors

**Owning epic:** [E12 — Crypto core and shared test vectors](../../docs/epics/E12-crypto-core.md).

- **What belongs here:** the positive and negative test vectors (JSON) for the
  envelope, the canonical AAD and the key hierarchy defined in `spec/crypto.md`.
  They are written once in Phase 2 and then **frozen**, and the TypeScript
  library in Phase 5 is held to them
  ([`docs/04-implementation-phases.md`](../../docs/04-implementation-phases.md)).
- Run by [`packages/crypto_dart`](../../packages/crypto_dart/README.md) from
  Phase 2, and by both libraries from Phase 5. Both must produce byte-identical
  output.
- Vectors carry invented keys and invented event content only — never real ones.
