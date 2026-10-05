# E01 — Phase 0 integration spike

| | |
|---|---|
| Phase | 0 |
| Status | **Done** (closed 2026-10-05). The spike was run outside the repo; no infrastructure, fixtures, checklist or quirks log were committed. It gates nothing |
| Executor | `human` |
| Depends on | — |
| Spec | `03-native-calendar-integration.md` § Validate Early |

## What it was for

Before any product code depended on it, the spike checked that a plain CalDAV server (Radicale with a real TLS certificate) round-trips events through Apple Calendar and, via DAVx⁵, through Samsung and Google Calendar. The owner ran it and considers the stock-app path proven well enough to build on.

## What closing it changes

The spike left nothing in the repo, so nothing downstream may depend on it. On 2026-10-05:

- **M0 no longer gates Phase 4.** Stock-app behaviour is checked with our own server instead: by the device protocol (E15-R05), run on staging at M2 and after that.
- **Requirements create their own data.** The local stack seeds its own users (E02-R03). The round-trip corpus starts from fixtures we write by hand, and device-captured objects are added from Phase 4 (E15-R01, E15-R04). There is no `infra/spike/` and no `spec/ical-fixtures/spike/`.
- **Nothing waits for a quirks log.** Stock-app quirks are recorded as E15-R05 finds them, as notes on the affected requirement.
- **`flexcalendar.de` on the production VPS is the only domain.** There is no separate spike host.

## Requirements

R01–R06 (spike infrastructure, seed script, device checklist, iPhone and DAVx⁵ runs, quirks log) are closed without a committed result. Their content lives on in E15-R01 (fixtures we write), E15-R04 (capture from staging) and E15-R05 (device protocol). Don't reopen them; add to those requirements instead.
