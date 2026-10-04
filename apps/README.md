# `apps/` — user-facing clients

| Directory | What belongs there | Owning epic |
|---|---|---|
| `web/` | React + Vite + TypeScript web client | [E09](../docs/epics/E09-web-client.md) |
| `mobile/` | Flutter (Dart 3) iOS/Android app; the Kotlin sync adapter lives in `mobile/android/` | [E10](../docs/epics/E10-mobile-app.md); adapter: [E11](../docs/epics/E11-android-sync-adapter.md) |

The clients are REST clients: they talk to `server/api`, not to CalDAV — the
one exception is the Android sync adapter, which speaks CalDAV natively in
Kotlin (E11). Clients send recurring-event edits as intents and never emit
`EXDATE`/`RECURRENCE-ID` themselves (INV-05).
