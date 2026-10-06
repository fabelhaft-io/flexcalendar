# `packages/api-client-ts` — OpenAPI fetch client

The private workspace `@calendar-flex/api-client` exports a typed `createClient`
wrapper over `openapi-fetch` 0.17.0. `src/schema.d.ts` is generated, never edited,
from `spec/openapi.yaml` (OpenAPI 3.1.0), using `openapi-typescript` 7.13.0.

Generation pins a **local TypeScript 5.9.3**: openapi-typescript needs the 5.x
compiler API, which the repository's TypeScript 7.0.2 does not expose. pnpm links
that peer to the local copy. Typechecking still uses the root TypeScript 7.

Run `make gen` at the repository root after a contract change and commit both
clients. `make gen-check` runs generation and rejects stale, missing or untracked
generated files, without rejecting unrelated edits. CI invokes it in `make verify`.
The wrapper and tests are hand-written; only `src/schema.d.ts` is generated.

(review only: README touch)
