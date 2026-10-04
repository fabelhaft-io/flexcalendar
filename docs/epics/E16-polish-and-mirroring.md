# E16 — Phase 6: polish and optional mirroring

| | |
|---|---|
| Phase | 6 (ongoing) |
| Status | Blocked on M4 and M5 |
| Executor | mixed |
| Depends on | E11, E13 |
| Spec | `04` Phase 6, ADR 0001 § Optional Phase 6, ADR 0002 § Revisit trigger |

## Goal

Placeholders so the backlog is complete. Break these into full requirements when their dependencies are Done. They are deliberately left coarse.

## Requirements

### E16-R01 · Recurrence editing UX   `agent`
Better "this / this and following / all" flows, including a preview of which occurrences change. Web and mobile.

### E16-R02 · Conflict resolution UX   `agent`
Offline edits of one event on two devices, in our apps and in the adapter (replacing E11-R04's server-wins fallback).

### E16-R03 · Performance and scale   `agent`
Load tests, query tuning and poller sharding. (The "Postgres-backed CalDAV storage" item in `04` is covered by D-02.)

### E16-R04 · `EKSource` spike   `human` + `agent`
Test whether a writable **local** EventKit source is reliable with iCloud Calendar on and off, with Google and Exchange accounts added, and on a fresh device. **If it fails, iOS mirroring is dead** (ADR 0001).

### E16-R05 · Android mirroring of Private calendars   `agent+review`
Extend the E11 adapter with `lazysodium-android`, implementing only *unwrap the content key, open the envelope*, and require byte-identical results on the E12 vectors. Also the new disclosure copy (plaintext in the OS store).

### E16-R06 · iOS mirroring of Private calendars   `agent+review`
Gated on R04. Event identity through `EKCalendarItem.url`, a shadow table, and windowed change detection (ADR 0001 § Optional Phase 6). **Committing to this triggers the ADR 0002 revisit.**

### E16-R07 · Passkey `prf` recovery; HSM PIN vault   `agent+review`
From E14 § Deferred.

## Still deferred (from `04`)
`VFREEBUSY` lookup, `VTODO`, rich server-side change notifications, and native macOS/Windows apps.
