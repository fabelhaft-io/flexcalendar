# `spec/` — language-neutral contracts and corpora

Everything in here is shared across runtimes: it is the contract that the
server, the clients and both crypto libraries are checked against. No product
code.

| Path | What belongs there | Owning epic |
|---|---|---|
| `openapi.yaml` | the API contract; the TS client, the Dart `dio` client and the Fastify route schemas are generated from it or validated against it | [E02-R07](../docs/epics/E02-repo-tooling-ci.md) |
| `crypto.md` | the byte-for-byte crypto wire spec | [E12](../docs/epics/E12-crypto-core.md) |
| `crypto-vectors/` | frozen cross-language test vectors, run by both crypto libraries | [E12](../docs/epics/E12-crypto-core.md) |
| `ical-fixtures/` | the round-trip corpus captured from real clients | [E15](../docs/epics/E15-interop-regression.md) |

Nothing here may drift silently: changing a contract or a vector is a
coordinated change across every runtime that reads it.

## OpenAPI generation (E02-R07)

`openapi.yaml` is the OpenAPI 3.1.0 API contract. The only initial operation is
`GET /healthz`; E05 owns product endpoints. Run `make gen` after edits, with
corepack and pinned Flutter/Dart on PATH, and commit both generated clients.
`make gen-check` regenerates and names stale, missing or untracked generated
files; `make verify` runs it in CI even for contract-only changes. API tests
validate the document with swagger-parser 13.1.0 and compare Fastify responses.
No generator requires a JVM.
