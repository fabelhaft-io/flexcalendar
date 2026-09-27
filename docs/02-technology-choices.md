# Technology Choices

For each layer, a recommended pick and the realistic alternatives.

## CalDAV Server

**Pick: [Radicale](https://radicale.org/) for prototyping, [Baïkal](https://sabre.io/baikal/) or [SabreDAV](https://sabre.io/) for production.**

| Option       | Lang   | Pros                                                                 | Cons                                                       |
|--------------|--------|----------------------------------------------------------------------|------------------------------------------------------------|
| Radicale     | Python | Tiny, file-backed, trivial to run, great for prototyping.            | Limited sharing/ACL story; not built for large scale.      |
| Baïkal       | PHP    | Production-ready, mature, web admin UI, uses SabreDAV under hood.    | PHP hosting; less hackable.                                |
| SabreDAV     | PHP    | Library you embed; powers Nextcloud, Baïkal, Fruux.                  | You build the app around it.                               |
| Xandikos     | Python | Git-backed storage (events versioned as files in a git repo).        | Smaller community; fewer production deployments.           |
| Nextcloud    | PHP    | Full groupware; calendar is one app; battle-tested sharing.          | Heavyweight if calendar is all you need.                   |

For a brand-new product, **start with Radicale** locally to validate the native-app integration story end-to-end in a weekend. Migrate to **SabreDAV** (as a library inside your own service) once you need custom auth, sharing, and push.

## Backend API Layer

**Pick: Node.js (TypeScript) with Fastify or NestJS, or Go with chi/echo.**

Either is fine; pick the language you ship faster in. The API is thin — auth, push fan-out, sharing UI, a REST/GraphQL facade over CalDAV. Notes:

- For CalDAV client work from the backend, use [`tsdav`](https://github.com/natelindev/tsdav) (TypeScript) or `go-caldav` / hand-rolled with `net/http` + an iCalendar parser like [`gocal`](https://github.com/apognu/gocal).
- iCalendar parsing/generation: [`ical.js`](https://github.com/kewisch/ical.js) (Mozilla; the de facto standard) on the Node side.
- Push: Firebase Admin SDK (FCM) for both mobile platforms — FCM relays to APNs on iOS, matching the Flutter app's single `firebase_messaging` integration. Talking to APNs directly over HTTP/2 remains an option if we ever want to drop Google from the iOS push path. Web clients get updates over WebSocket/SSE.
- Auth: Auth0, Clerk, or self-hosted Keycloak/Ory. The API translates user auth → CalDAV credentials (store CalDAV credentials encrypted, or run a CalDAV server that accepts your bearer tokens).

## Web Client

**Pick: React + TypeScript + Vite, with [FullCalendar](https://fullcalendar.io/) for the calendar grid.**

The web client is **not** part of the Flutter codebase (see Alternatives Considered below).

FullCalendar is the most mature, accessible JS calendar component and handles recurrence, drag-to-resize, multi-day events, timezones. Alternatives: Schedule-X (newer, lighter), react-big-calendar (simpler, less polished).

State/data: TanStack Query for server state, Zustand or Redux Toolkit only if you actually need shared client state beyond what Query gives you.

## Mobile Clients (iOS + Android)

**Pick: Flutter (stable channel, Dart 3), one codebase for both apps. Targets: iOS 16+, Android minSdk 26 (Android 8).**

Rationale and rejected alternatives are in [`adr/0002-flutter-for-mobile-clients.md`](adr/0002-flutter-for-mobile-clients.md). The short version: the apps are REST clients with an offline cache, and nearly all of that is identical across platforms. The genuinely platform-specific parts (the Android sync adapter, `.mobileconfig` install, push setup) are small, well-bounded, and handled natively where needed.

| Concern              | Pick                                                                 | Notes |
|----------------------|----------------------------------------------------------------------|-------|
| Calendar grid        | [`calendar_view`](https://pub.dev/packages/calendar_view) (MIT) or [`kalender`](https://pub.dev/packages/kalender) (MIT) | Day/week/month views. Budget for a custom grid later — calendar UX is where polish matters. [`syncfusion_flutter_calendar`](https://pub.dev/packages/syncfusion_flutter_calendar) is the most complete, but commercially licensed (free community licence only below a revenue threshold). `table_calendar` is a month picker, not a scheduler. |
| State management     | [Riverpod](https://riverpod.dev/)                                     | Async providers map cleanly onto "server state + offline cache". |
| Networking           | [`dio`](https://pub.dev/packages/dio) + a client generated from the API's OpenAPI spec | The apps talk to the REST API, **not** CalDAV directly — same as before. |
| Offline cache        | [Drift](https://drift.simonbinder.eu/) (SQLite)                      | Store the raw iCalendar object (plus ETag) as the canonical record, with indexed columns (start, end, calendar, UID) for queries. Avoid Isar/Hive — maintenance has stalled. |
| Timezones            | [`timezone`](https://pub.dev/packages/timezone) (IANA tz database)    | **Dart's `DateTime` only knows UTC and device-local.** All `TZID` arithmetic must go through `timezone`'s `TZDateTime`. See risk #3. |
| Recurrence           | Expanded **server-side** by the API (`ical.js`); [`rrule`](https://pub.dev/packages/rrule) on the client only for previews and offline display | Keeps one recurrence engine as the authority (see below). |
| iCalendar parsing    | [`enough_icalendar`](https://pub.dev/packages/enough_icalendar)       | Only needed for the offline cache and edits made offline. Treat as untrusted — round-trip tests required. |
| Auth                 | [`flutter_appauth`](https://pub.dev/packages/flutter_appauth) (OIDC + PKCE), [`flutter_secure_storage`](https://pub.dev/packages/flutter_secure_storage) for tokens | Works with Auth0 / Clerk / Keycloak / Ory. |
| Push                 | [`firebase_messaging`](https://pub.dev/packages/firebase_messaging)   | One API for FCM on Android and APNs on iOS (FCM relays to APNs). Send data-only "calendar X changed" pings; the client fetches the delta. Never put event content in the payload. |
| Background refresh   | [`workmanager`](https://pub.dev/packages/workmanager)                 | Periodic delta sync when push is missed. |
| Native interop       | [Pigeon](https://pub.dev/packages/pigeon)                             | Typed Dart ↔ Swift/Kotlin channels (e.g. "account signed in → register Android sync account"). |

### Recurrence: one engine, on the server

The Dart iCalendar ecosystem is much thinner than `ical.js` / `iCal4j`, and recurrence is our #2 risk. So the mobile app does **not** own recurrence semantics:

- The API returns expanded occurrences for a requested window (computed with `ical.js`), alongside the master `VEVENT`.
- Edits to recurring events are sent as intents ("this occurrence", "this and following", "all"), and the API applies them to the iCalendar object. The client never hand-writes `EXDATE` / `RECURRENCE-ID` overrides.
- The client-side `rrule` package is used only to preview a rule while the user is building it, and to render cached events while offline. Offline edits to recurring events are queued as intents and applied by the server on reconnect.

### iOS specifics

- **System calendar integration** is still via a signed `.mobileconfig` profile. Profiles can't be installed silently from an app: open the profile URL in Safari (`url_launcher` with external mode), then the user confirms in Settings → Profile Downloaded. Design the onboarding screen around that two-step flow.
- **APNs** is configured in the Firebase project (upload the APNs auth key); no separate APNs code in the app.
- Home-screen widgets, if we ever want them, require WidgetKit in Swift (bridge data with [`home_widget`](https://pub.dev/packages/home_widget)). Deferred.

### Android specifics: the sync adapter stays native Kotlin

The `CalendarContract` sync adapter (see [`03-native-calendar-integration.md`](03-native-calendar-integration.md)) lives in the Flutter project's `android/` module and is written in **plain Kotlin, with no Dart in its sync path**:

- The system runs sync adapters in the background, often with no Flutter engine alive. Spinning up a headless engine inside `onPerformSync` is fragile and slow; don't.
- Consequence: the adapter has its own CalDAV + iCalendar stack. Use [`iCal4j`](https://github.com/ical4j/ical4j) for parsing and recurrence, and [`dav4jvm`](https://github.com/bitfireAT/dav4jvm) (MPL-2.0, from the DAVx⁵ authors) for WebDAV/CalDAV. DAVx⁵'s own sync code is GPLv3 — read it for reference, but check licence compatibility before copying anything into this MIT project.
- The adapter talks **CalDAV directly** (it is effectively our own DAVx⁵), while the Flutter UI talks to the REST API. Both end up on the same CalDAV collections, so they cannot diverge.
- The Flutter side only needs a Pigeon channel to register/remove the system account on sign-in/sign-out and to trigger a manual sync.

The adapter is scoped to **Shared** calendars ([ADR 0001](adr/0001-calendar-privacy-modes.md)), which are unencrypted, so it needs no crypto for its Phase 4 scope. If the optional Phase 6 mirroring of Private calendars ships, the adapter also has to decrypt: `lazysodium-android` alongside the Dart `sodium_libs` implementation, producing byte-identical results from shared test vectors. Only the *unwrap content key, open envelope* path is duplicated — the key hierarchy itself stays in Dart.

## Alternatives Considered

- **Native Swift/SwiftUI + Kotlin/Compose** — the previous plan. Best platform fidelity, but two UI codebases, two offline caches, and two API clients for what is mostly identical logic. Rejected; see ADR 0002.
- **React Native** — would share TypeScript types and possibly `ical.js` with the backend and web client, which is a real advantage. Rejected in favour of Flutter for more consistent rendering of a custom, gesture-heavy calendar grid, and a more mature ecosystem for the pieces we need (Pigeon, Firebase, Drift).
- **Flutter Web instead of React** — not chosen. Flutter Web renders to a canvas, which hurts accessibility, text selection, and load time, and FullCalendar is far more mature than any Flutter grid. The web client stays React (see above).
- **Kotlin Multiplatform** — would let the sync adapter and the app share one CalDAV/iCalendar core, which is attractive. Rejected for now because Compose Multiplatform on iOS is less mature than Flutter; revisit if the sync adapter grows into the dominant codebase.

## Hosting

- CalDAV server + API: a single small VPS (Hetzner, Fly.io, Railway) for the prototype. Behind a managed Postgres if you choose SabreDAV with its DB backend.
- TLS: Caddy or Traefik, automatic Let's Encrypt. iOS in particular is fussy about TLS — no self-signed certs without a profile.
- The CalDAV server **must be reachable on the public internet on port 443** for stock apps to talk to it. This is a real constraint: no internal-only deployments unless you also ship a VPN profile.
