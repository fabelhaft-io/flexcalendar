# E10 — Flutter mobile app

| | |
|---|---|
| Phase | 3 |
| Status | Blocked on E05, E07 |
| Executor | `agent`; `human` for store submission and device checks |
| Depends on | E05, E06, E07, E02-R07 (generated Dart client) |
| Spec | ADR 0002, `02` § Mobile clients, `04` Phase 3 |

## Goal

One Flutter app for iOS 16+ and Android minSdk 26. It works offline and receives push. It is a REST client and never talks to CalDAV itself (the Android adapter in E11 is the exception, and it lives outside Dart).

## Requirements

### E10-R01 · Scaffold   `agent`
`apps/mobile` with Dart 3, Riverpod, `dio` and the generated OpenAPI client, Drift, `timezone`, and flavors `dev|staging|prod`.
- Accept: `make verify-mobile` runs `flutter analyze`, unit and widget tests; both platforms build in CI (`flutter build apk`, `flutter build ios --no-codesign`).

### E10-R02 · Auth   `agent`
OIDC PKCE through `flutter_appauth`, with tokens in `flutter_secure_storage` and refresh handled in a `dio` interceptor.
- Accept: token expiry mid-session refreshes transparently; sign-out clears tokens, the cache and the push token (E07-R03).

### E10-R03 · Offline cache   `agent`
Drift tables store per event the raw iCalendar, ETag, calendar, `uid`, `recurrence_id`, and indexed `start_utc`/`end_utc`. Expanded occurrences are cached per window. The sync token is kept per calendar.
- Accept: the app opens and renders the last 3 months and next 12 months in airplane mode; a schema migration test runs from version N-1.

### E10-R04 · Timezone discipline   `agent`
All zoned maths uses `TZDateTime` (INV-04). The tz database is initialised at startup, and the device zone is read through a native call (for example `flutter_timezone`).
- Accept: a custom lint or test rejects `DateTime` arithmetic in the domain layer; DST widget tests cover the E15-R02 dates for Europe/Berlin, America/New_York, Australia/Sydney and Asia/Kolkata.

### E10-R05 · Calendar grid   `agent`
Day, week, month and agenda views with `calendar_view` or `kalender` (pick one in the PR, with reasons), rendering cached occurrences.
- Accept: golden tests for each view with the E15 fixtures.

### E10-R06 · Editing and offline outbox   `agent`
Create, edit and delete events. Offline edits go into an outbox as intents (recurring) or full objects (non-recurring) with the base ETag, and are replayed in order on reconnect. A 412 raises the same conflict choice as E09-R05.
- Accept: an integration test goes offline, makes 3 edits, comes back online and ends in the expected server state; the client never writes `EXDATE`/`RECURRENCE-ID` (INV-05).

### E10-R07 · Push and background refresh   `agent`
`firebase_messaging` for data-only pings (E07-R04) → a delta fetch (E05-R08). `workmanager` runs a periodic delta sync, and a delta sync also runs on every foreground.
- Accept: on a real device, a web edit shows up in the backgrounded app after the ping, or on foreground if iOS dropped the ping.
- `human`: upload the APNs key to Firebase.

### E10-R08 · iOS system-calendar onboarding   `agent`
A screen fetches a fresh signed `.mobileconfig` (E06-R05), opens it in Safari (`url_launcher`, external mode), and walks through the Settings → Profile Downloaded confirmation (`02` § iOS specifics).
- Accept: `human` completes the flow on a real iPhone as part of E15-R05.

### E10-R09 · Android onboarding (pre-E11)   `agent`
Until E11 ships: the DAVx⁵ instructions and deep link (E06-R08). After E11: a switch "Show in Google/Samsung Calendar" that registers the sync account through Pigeon (E11-R06).

### E10-R10 · Mode badge and sharing   `agent`
Same as E09-R06 and E09-R08.

### E10-R11 · Store release   `human`
App Store and Play Store listings, privacy labels (consistent with INV-11), TestFlight and internal track releases.
