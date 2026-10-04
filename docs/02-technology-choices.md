# Technology Choices

For each layer, a recommended pick and the realistic alternatives.

## CalDAV Server

**Pinned (D-02): [SabreDAV](https://sabre.io/) 4.7+ embedded in a small PHP 8.4 service with the Postgres PDO backend, from Phase 1 on. [Radicale](https://radicale.org/) only for the Phase 0 spike.**

| Option       | Lang   | Pros                                                                 | Cons                                                       |
|--------------|--------|----------------------------------------------------------------------|------------------------------------------------------------|
| Radicale     | Python | Tiny, file-backed, trivial to run, great for prototyping.            | Limited sharing/ACL story; not built for large scale.      |
| Baïkal       | PHP    | Production-ready, mature, web admin UI, uses SabreDAV under hood.    | PHP hosting; less hackable.                                |
| SabreDAV     | PHP    | Library you embed; powers Nextcloud, Baïkal, Fruux.                  | You build the app around it.                               |
| Xandikos     | Python | Git-backed storage (events versioned as files in a git repo).        | Smaller community; fewer production deployments.           |
| Nextcloud    | PHP    | Full groupware; calendar is one app; battle-tested sharing.          | Heavyweight if calendar is all you need.                   |

Radicale validates the native-app integration story in the Phase 0 spike. Production uses **SabreDAV** as a library inside our own service from the start: Phase 1 already needs custom auth (D-05), the mode-aware write guard and the change outbox, and switching servers later would mean migrating stored family data.

**Maintenance status (checked 2026-10-04).** Upstream is slow but alive: 4.7.1 shipped in July 2026. Nextcloud depends on SabreDAV, and that is the practical guarantee it keeps up with new PHP releases. So keep all our code in SabreDAV plugins and backends and never patch vendor code, which keeps an upgrade to a Composer bump. [Stalwart](https://stalw.art/) (Rust) has shipped CalDAV since v0.12 and is the only modern alternative. It is still pre-1.0, and it has no extension point for D-05, the write guard or the outbox. Revisit it after its 1.0, not before.

**SabreDAV brings a second recurrence engine.** SabreDAV answers `calendar-query` time-range filters, and stores each object's first and last occurrence, with `sabre/vobject`'s own recurrence iterator. Stock apps that query by date range therefore get `vobject`'s expansion, while our apps get `ical.js`'s. If the two disagree on an `RRULE`, a stock app can see a different set of events than our app shows. E15-R03 runs `vobject` in its differential test for this reason.

## Backend API Layer

**Pinned (D-01): Node.js 24 LTS + TypeScript with Fastify; move to Node 26 once it is promoted to LTS (late October 2026).** Go is ruled out: `ical.js`, the single recurrence authority applied by the API (ADR 0002), needs a JavaScript runtime.

The API is thin — auth, push fan-out, sharing UI, a REST/GraphQL facade over CalDAV. Notes:

- For CalDAV client work from the backend, use [`tsdav`](https://github.com/natelindev/tsdav), or raw `fetch` where it lacks a report.
- iCalendar parsing/generation: [`ical.js`](https://github.com/kewisch/ical.js) (Mozilla; the de facto standard) on the Node side.
- Push: Firebase Admin SDK (FCM) for both mobile platforms — FCM relays to APNs on iOS, matching the Flutter app's single `firebase_messaging` integration. Talking to APNs directly over HTTP/2 remains an option if we ever want to drop Google from the iOS push path. Web clients get updates over WebSocket/SSE.
- Auth (pinned, D-03): self-hosted **Keycloak** (OIDC + PKCE, TOTP and WebAuthn). The API reaches CalDAV as the user through an HMAC-signed delegated principal on an internal listener (D-05), so it stores no CalDAV passwords. Stock apps use per-device app passwords (D-04, Phase 4). The login password never feeds a key derivation (D-17).

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
| Auth                 | [`flutter_appauth`](https://pub.dev/packages/flutter_appauth) (OIDC + PKCE), [`flutter_secure_storage`](https://pub.dev/packages/flutter_secure_storage) for tokens | Against our Keycloak (D-03). |
| Push                 | [`firebase_messaging`](https://pub.dev/packages/firebase_messaging)   | One API for FCM on Android and APNs on iOS (FCM relays to APNs). Send data-only "calendar X changed" pings; the client fetches the delta. Never put event content in the payload. |
| Recovery kit         | [`pdf`](https://pub.dev/packages/pdf) + [`printing`](https://pub.dev/packages/printing), [`share_plus`](https://pub.dev/packages/share_plus) | On-device recovery sheet (print or PDF via the system file picker) and plain-text share. A sensitive clipboard copy needs a small Kotlin method (E14-R03). |
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

The adapter is scoped to **Shared** calendars ([ADR 0001](adr/0001-calendar-privacy-modes.md)), which are unencrypted, so it needs no crypto for its Phase 6 scope. If the optional Phase 8 mirroring of Private calendars ships, the adapter also has to decrypt: `lazysodium-android` alongside the Dart `sodium_libs` implementation, producing byte-identical results from shared test vectors. Only the *unwrap content key, open envelope* path is duplicated — the key hierarchy itself stays in Dart.

## Alternatives Considered

- **Native Swift/SwiftUI + Kotlin/Compose** — the previous plan. Best platform fidelity, but two UI codebases, two offline caches, and two API clients for what is mostly identical logic. Rejected; see ADR 0002.
- **React Native** — would share TypeScript types and possibly `ical.js` with the backend and web client, which is a real advantage. Rejected in favour of Flutter for more consistent rendering of a custom, gesture-heavy calendar grid, and a more mature ecosystem for the pieces we need (Pigeon, Firebase, Drift).
- **Flutter Web instead of React** — not chosen. Flutter Web renders to a canvas, which hurts accessibility, text selection, and load time, and FullCalendar is far more mature than any Flutter grid. The web client stays React (see above).
- **Kotlin Multiplatform** — would let the sync adapter and the app share one CalDAV/iCalendar core, which is attractive. Rejected for now because Compose Multiplatform on iOS is less mature than Flutter; revisit if the sync adapter grows into the dominant codebase.

## Hosting

- Pinned (D-10): a Hetzner VPS in the EU for the CalDAV service, API, Keycloak and Postgres, plus a staging twin. From Phase 7, an HSM-backed **AWS KMS** key in `eu-central-1` for Tier 1 escrow.
- TLS: Caddy or Traefik, automatic Let's Encrypt. iOS in particular is fussy about TLS — no self-signed certs without a profile.
- The CalDAV server **must be reachable on the public internet on port 443** for stock apps to talk to it. This is a real constraint: no internal-only deployments unless you also ship a VPN profile.

### Sizing and cost

Re-checked on 2026-10-04. On 15 June 2026 Hetzner repriced its cloud for new orders. The shared-vCPU CPX line rose about 2.4–2.75× (CPX22 from €7.99 to €19.49, CPX32 from €13.99 to €35.49). The cost-optimised CX and CAX lines are listed as "currently not available". OVH and Netcup raised VPS prices in 2026 as well, so this is a market-wide move driven by memory prices, not a reason to change provider. **D-10 stands; what changed is the budget.**

The whole stack fits on one 8 GB host: Keycloak needs about 1–1.5 GB, Postgres 1–2 GB, and the API and CalDAV service a few hundred MB each, plus Caddy and the monitoring agents. 4 GB is too tight with Keycloak, so use it for staging only. Every component has arm64 and amd64 images, so order whichever 8 GB line is available when E08-R01 is done.

| Item | €/month (list price, excl. VAT, 2026-10-04) |
|---|---|
| Production, 8 GB (CPX32) | ~35.50 |
| Hetzner server backups (+20 % of the server price) | ~7 |
| Staging, 4 GB (CPX22) | ~19.50 |
| 2 × primary IPv4 | 1 |
| Hetzner Object Storage, backup repository 1 (1 TB included) | 6.49 |
| Second EU object store, backup repository 2 (a few GB) | ~1–2 |
| **Total until M1** | **~70** |

- If CAX21 (€7.99) becomes orderable again, the total drops to about €25.
- Hetzner bills a powered-off server, so staging is cheaper deleted than stopped. Because deploys are code (E08-R02), it can be deleted between test runs and recreated in minutes.
- Later additions are small. Phase 4 adds SES mail at cents per thousand messages. Use SES in `eu-central-1` rather than Postmark, since the AWS account exists for KMS anyway. Phase 7 adds the KMS key at about $1/month plus requests. FCM is free.
- **People's time is the larger cost.** Budget 4–8 hours a month of routine operations: the quarterly Keycloak upgrade, Renovate PRs, OS patches, and reviewing restore checks. This does not include incidents.

Not chosen for now:
- **Dedicated servers** (Hetzner auction, about €40–55 for 64 GB). They have no snapshots, a hardware fault means a manual rebuild, and the capacity is far beyond what we need.
- **Managed Postgres.** It costs more, and it adds another vendor that holds plaintext Shared calendars from Phase 4 on.
- **Kubernetes.**
- **A standby replica before M5.** The 1-hour RTO is reachable from backups plus deploy-as-code. Revisit when open signup opens.

### Runtime layout

- Docker Compose on the host, the same shape as the local stack (E02-R03). Images are built in CI and pinned by digest, and systemd keeps the stack running.
- For the CalDAV service, consider [FrankenPHP](https://frankenphp.dev/) instead of nginx + php-fpm. It is a PHP app server built on Caddy, which we already run, and it now sits under the PHP Foundation. Use classic mode, not worker mode: SabreDAV was written for one request per process lifetime, and worker mode would first need an audit for state that leaks between requests.
- **Keycloak is the component with the most upkeep.** Since 26.0 it ships four minor releases a year and has no LTS, so only the newest release gets security fixes. That means an upgrade every quarter, without exception. Keep upgrades routine: no custom SPIs, themes by CSS only, realm configuration as code, and staging before production (E08-R08).

### Backups and recovery (D-11)

All durable state is in **one Postgres cluster**: CalDAV objects, sidecar envelopes, metadata, the audit log and Keycloak's database. One consistent backup therefore captures everything. Keep it that way, with no durable state on local disk outside Postgres.

- **Tool**: [pgBackRest](https://pgbackrest.org/), with WAL-G as an acceptable alternative.
  - Continuous WAL archiving with `archive_timeout = 60s` gives an RPO of about 1 minute against the 5-minute target.
  - Nightly backups, kept for 30 days.
  - Client-side encryption (repository cipher). The cipher key lives in the secret store, with an offline copy.
- **Two repositories, at two providers:**
  1. Hetzner Object Storage, in a different location from the server (for example, server in Falkenstein, bucket in Helsinki). Turn on Object Lock, with a lock period shorter than pgBackRest's retention so expiry still works.
  2. A second EU object store (for example Backblaze B2 EU or Scaleway), with credentials that can write but not delete. This protects against a Hetzner account suspension, and against an attacker on the host deleting backups.
- **Hetzner server backups** are crash-consistent disk images. They speed up a rebuild and are never the data backup.
- **State outside Postgres**: the secrets need their own backup in the secret store. These are the D-05 HMAC key, the Firebase service account, the APNs key, the DKIM key, the `.mobileconfig` signing certificate and the backup cipher key. Caddy's certificates can be regenerated.
- **Restore verification**:
  - Weekly, automated: restore the latest backup into a throwaway instance, check it (`pg_amcheck`, row counts, a sample CalDAV `GET`) and destroy it.
  - Quarterly: the human drill stays.
  - **Never restore production into staging.** From Phase 4, Shared calendars are plaintext, and staging is not where family data belongs.
- **Private calendars** back up as ciphertext. The backups protect against our failures, not against a user losing their keys.
- **Phase 7, the KMS key**:
  - Block key deletion by IAM policy. KMS deletion is in any case only scheduled, with a 7–30 day waiting period; use the maximum.
  - Consider a multi-Region replica key in a second EU region.
  - Losing this key loses every Tier 1 escrow copy, and no database backup can restore them.
