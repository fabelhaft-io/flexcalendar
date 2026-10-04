# `packages/crypto-ts/` — TypeScript crypto core

**Owning epic:** [E12 — Crypto core and shared test vectors](../../docs/epics/E12-crypto-core.md).

- **What belongs here:** the web client's *operational subset* of the key
  hierarchy — receiving keys by device linking or the recovery code, opening and
  sealing envelopes, and sealing calendar content keys to members it shares with
  (ADR 0002 § Consequences, D-16). Recovery-code generation, Shamir splitting
  and escrow setup stay in
  [`packages/crypto_dart`](../crypto_dart/README.md).
- It must produce byte-identical results with the Dart library from the frozen
  vectors in [`spec/crypto-vectors/`](../../spec/crypto-vectors/README.md).
- **README-only for now:** this directory stays README-only until Phase 5
  (E02-R01 notes, ADR 0003). Do not scaffold it as part of the layout work.
- **Security:** `agent+review`; no key may be derived from the login password
  (D-17, INV-12), and no such input is accepted.
