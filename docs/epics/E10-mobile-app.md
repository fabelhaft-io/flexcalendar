# E10 — Flutter mobile app

| | |
|---|---|
| Phase | 3 (Android: R01–R06, R07 periodic sync, R10, R11 Play track); 4 (R07 push, R09); 5 (iOS: R08, R11 App Store, iOS CI build), per ADR 0003 |
| Status | Blocked on E05, E12, E13 |
| Executor | `agent`; `human` for store submission and device checks |
| Depends on | E05, E06-R02/R09, E12, E13, E02-R07 (generated Dart client); E07 for push (Phase 4) |
| Spec | ADR 0002, ADR 0003, `02` § Mobile clients, `04` Phases 3 and 5 |

## Goal

One Flutter app for iOS 16+ and Android minSdk 26. Android ships first, at M1, with Private calendars only; iOS follows in Phase 5 (ADR 0003). It works offline and, from Phase 4, receives push. It is a REST client and never talks to CalDAV itself (the Android adapter in E11 is the exception, and it lives outside Dart).

## Requirements

### E10-R01 · Scaffold   `agent`
`apps/mobile` with Dart 3, Riverpod, `dio` and the generated OpenAPI client, Drift, `timezone`, and flavors `dev|staging|prod`.
- Accept: `make verify-mobile` runs `flutter analyze`, unit and widget tests; `flutter build apk` runs in CI from the start; `flutter build ios --no-codesign` joins in Phase 5.

### E10-R02 · Auth   `agent`
OIDC PKCE through `flutter_appauth`, with tokens in `flutter_secure_storage` and refresh handled in a `dio` interceptor. The app's ID and redirect URIs are the ones E02-R09 registers: `de.flexcalendar.app`, `de.flexcalendar.app:/oauth2redirect` and `de.flexcalendar.app:/logout`.
- Accept: token expiry mid-session refreshes transparently; sign-out clears tokens, the cache, the keys (E12-R06) and, from Phase 4, the push token (E07-R03).

### E10-R03 · Offline cache   `agent`
Drift tables store per event the raw iCalendar (for Private calendars the skeleton, with the decrypted payload alongside per E13-R04), ETag, calendar, `uid`, `recurrence_id`, and indexed `start_utc`/`end_utc`. Expanded occurrences are cached per window. The sync token is kept per calendar.
- Accept: the app opens and renders the last 3 months and next 12 months in airplane mode; a schema migration test runs from version N-1.
- Accept: a `window-too-large` answer from the occurrences endpoint (E05-R05) is retried as smaller windows until each is answered, and an object in `unsupported` is shown to the user by its reason, never silently dropped.

### E10-R04 · Timezone discipline   `agent`
All zoned maths uses `TZDateTime` (INV-04). The tz database is initialised at startup, and the device zone is read through a native call (for example `flutter_timezone`).
- Accept: a custom lint or test rejects `DateTime` arithmetic in the domain layer; DST widget tests cover the E15-R02 dates for Europe/Berlin, America/New_York, Australia/Sydney and Asia/Kolkata.

### E10-R05 · Calendar grid   `agent`
Day, week, month and agenda views with `calendar_view` or `kalender` (pick one in the PR, with reasons), rendering cached occurrences.
- Accept: golden tests for each view with the E15 fixtures.

### E10-R06 · Editing and offline outbox   `agent`
Create, edit and delete events. Offline edits go into an outbox as intents (recurring) or full objects (non-recurring) with the base ETag, and are replayed in order on reconnect. A 412 raises the same conflict choice as E09-R05.
- Accept: an integration test goes offline, makes 3 edits, comes back online and ends in the expected server state; the client never writes `EXDATE`/`RECURRENCE-ID` (INV-05).

### E10-R07 · Background sync and push   `agent`
Phase 3: `workmanager` runs a periodic delta sync (E05-R08) every 15 min, and a delta sync also runs on every foreground and on pull-to-refresh. Phase 4: `firebase_messaging` data-only pings (E07-R04) trigger a delta fetch.
- Accept (Phase 3): on a real device, an edit from a second phone shows up on foreground, or within about 15 min in the background. Accept (Phase 4): it shows up after the ping, or on foreground if the OS dropped the ping.
- `human`: upload the APNs key to Firebase (Phase 5).

### E10-R08 · iOS system-calendar onboarding (Phase 5)   `agent`
A screen fetches a fresh signed `.mobileconfig` (E06-R05), opens it in Safari (`url_launcher`, external mode), and walks through the Settings → Profile Downloaded confirmation (`02` § iOS specifics).
- Accept: `human` completes the flow on a real iPhone as part of E15-R05.

### E10-R09 · Android onboarding (Phase 4, pre-E11)   `agent`
Until E11 ships: the DAVx⁵ instructions and deep link (E06-R08). After E11: a switch "Show in Google/Samsung Calendar" that registers the sync account through Pigeon (E11-R06).

### E10-R10 · Mode badge and sharing   `agent`
Every calendar shows its mode badge (ADR 0001). The sharing UI covers invites by link or QR (E06-R09), the member list with each member's key-verification state (D-15), and role changes and removal (E06-R02). Email invites (E06-R01) join it in Phase 4.
- Accept: widget tests for a pending invite, an unverified member and a verified member.

### E10-R11 · Store release   `human`
Phase 3: Play Console internal testing track, with a Data safety form and listing text consistent with INV-11 (no audit claim before M5). Phase 5: App Store listing, privacy labels and TestFlight.
