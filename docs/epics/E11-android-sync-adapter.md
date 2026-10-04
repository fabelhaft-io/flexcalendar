# E11 — Android sync adapter (native Kotlin)

| | |
|---|---|
| Phase | 6 (ADR 0003) |
| Status | Blocked on M2 (E03-R03, E06-R04) and E10 |
| Executor | `agent` for code; `human` for device verification |
| Depends on | E03, E06-R04, E10-R01 |
| Spec | `03` § Samsung / Pixel, `02` § Android specifics, ADR 0002, ADR 0001 (Shared only) |

## Goal

Shared calendars show up in Samsung and Google Calendar without DAVx⁵. This is the largest single piece of work in the plan (`05` risk 1), so budget for it.

## Constraints

- Plain Kotlin in the Flutter project's `android/`, with **no Dart in the sync path**, and no headless Flutter engine in `onPerformSync`.
- `dav4jvm` (MPL-2.0) for WebDAV/CalDAV and `iCal4j` for parsing and recurrence. DAVx⁵ code is GPLv3: read it, but **don't copy it** into this Apache-2.0 project.
- **Shared calendars only.** The adapter uses a device app password (D-04), so INV-08 already hides Private calendars from it.

## Requirements

### E11-R01 · Account authenticator   `agent`
An `AbstractAccountAuthenticator` and account type `app.calflex.account`. Credentials are a device app password created through the API when the account is added, and stored with `AccountManager`.
- Accept: the account appears in Android Settings → Accounts; removing it there revokes the device credential through the API.

### E11-R02 · Sync adapter skeleton   `agent`
An `AbstractThreadedSyncAdapter` bound to `CalendarContract.AUTHORITY`, with `supportsUploading=true` and a periodic sync interval (default 15 min, user-configurable).
- Accept: `ContentResolver.requestSync` triggers a sync; the adapter survives process death; WorkManager isn't used for the sync itself.

### E11-R03 · Server → device sync   `agent`
Discover calendars, then use `sync-collection` with the stored token (falling back to `calendar-query` for a full resync when the token has expired) to write `Calendars`, `Events`, `Reminders` and `Attendees` rows. Master and exception events map to `ORIGINAL_SYNC_ID`/`ORIGINAL_INSTANCE_TIME`, and `_SYNC_ID` = href, `SYNC_DATA1` = ETag.
- Accept: the E15 corpus appears in `CalendarContract` identically to what DAVx⁵ produces for the same fixtures (compared by an instrumented test that dumps rows).

### E11-R04 · Device → server sync   `agent`
Upload rows with `DIRTY=1`/`DELETED=1` as iCalendar through `iCal4j`, using `If-Match`. Unknown properties are preserved from the stored raw object (INV-02), kept in `SYNC_DATA2` or a local sidecar database.
- Accept: an edit in Google Calendar reaches the server with every original `X-` property intact; a 412 triggers a re-fetch and then a server-wins merge, with a local notification when the user's change was dropped (full conflict UX is E16-R02).

### E11-R05 · Recurrence and timezones   `agent`
Recurring events are written as `RRULE`/`EXDATE`/`RDATE` rows, and Android expands them. Exceptions are written as separate rows. `EVENT_TIMEZONE` uses the IANA ID, and all-day events use UTC midnight as `CalendarContract` requires.
- Accept: passes the E15-R02 DST matrix on an emulator with the device zone set to each test zone.

### E11-R06 · Pigeon bridge   `agent`
A Pigeon API: `registerAccount(handle, appPassword)`, `removeAccount()`, `requestSync()`, `syncStatus()`. The Flutter app calls it on sign-in, sign-out and the user toggle (E10-R09).
- Accept: sign-out from Flutter removes the system account and its calendars.

### E11-R07 · Device verification   `human`
Run the E15-R05 protocol on a Samsung device and a Pixel, without DAVx⁵ installed.
- Accept: M4 exit criteria met; results committed to `docs/verification/`.
