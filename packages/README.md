# `packages/` — shared libraries

Libraries the clients share. Nothing here is imported by `server/**` (INV-07):
the server never decrypts.

| Directory | What belongs there | Owning epic |
|---|---|---|
| `crypto_dart/` | Dart crypto core: envelope seal/open, the key hierarchy, recovery code, device linking | [E12](../docs/epics/E12-crypto-core.md) |
| `crypto-ts/` | TypeScript crypto core: the operational subset the web client needs | [E12](../docs/epics/E12-crypto-core.md) |
| `api-client-ts/` | TypeScript API client generated from `spec/openapi.yaml`; never hand-edited | [E02-R07](../docs/epics/E02-repo-tooling-ci.md) |

Both crypto libraries are held to the same frozen vectors in
[`spec/crypto-vectors/`](../spec/crypto-vectors/README.md) and must produce
byte-identical output (E12).
