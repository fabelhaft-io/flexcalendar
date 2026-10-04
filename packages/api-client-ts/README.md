# `packages/api-client-ts/` — generated TypeScript API client

**Owning epic:** [E02-R07 — OpenAPI-first contract](../../docs/epics/E02-repo-tooling-ci.md);
its consumer is [E09](../../docs/epics/E09-web-client.md).

- **What belongs here:** the TypeScript client **generated from
  [`spec/openapi.yaml`](../../spec/openapi.yaml)**. It is generated, never
  hand-edited — E02-R07 makes CI fail when the generated client is stale
  (`make gen && git diff --exit-code`).
- The Dart client for [`apps/mobile`](../../apps/mobile/README.md) is generated
  from the same contract and is needed from Phase 3; the TS client can wait
  until Phase 5 (E02-R07 notes).
- The API contract itself lives in `spec/openapi.yaml`, not here.
