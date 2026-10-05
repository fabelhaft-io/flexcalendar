# `apps/web/` — web client

**Owning epic:** [E09 — Web client](../../docs/epics/E09-web-client.md).

- **What belongs here:** the React + TypeScript + Vite app, FullCalendar for the
  calendar grid, TanStack Query for server state, the client generated from
  [`spec/openapi.yaml`](../../spec/openapi.yaml), and OIDC PKCE login against
  the D-03 IdP (`docs/02-technology-choices.md` § Web client). From Phase 5 it
  also carries the Private-mode crypto *operational subset* through
  [`packages/crypto-ts`](../../packages/crypto-ts/README.md) (D-16).
- **README-only for now:** this directory stays README-only until Phase 5
  (E02-R01 notes, ADR 0003). Do not scaffold it as part of the layout work.
- **Not here:** the mobile app (that is `../mobile/`), and no code that emits
  `EXDATE`/`RECURRENCE-ID` (INV-05).

<!-- E02-R06 review: web-only change to exercise path selection -->
