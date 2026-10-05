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
- Auth (pinned, D-03, amended by [ADR 0004](adr/0004-single-4gb-host.md)): self-hosted **Zitadel** (OIDC + PKCE, TOTP and WebAuthn), with JWT access tokens the API validates against JWKS. The API reaches CalDAV as the user through an HMAC-signed delegated principal on an internal listener (D-05), so it stores no CalDAV passwords. Stock apps use per-device app passwords (D-04, Phase 4). The login password never feeds a key derivation (D-17).

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
| Auth                 | [`flutter_appauth`](https://pub.dev/packages/flutter_appauth) (OIDC + PKCE), [`flutter_secure_storage`](https://pub.dev/packages/flutter_secure_storage) for tokens | Against our Zitadel (D-03). |
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
- Consequence: the adapter has its own CalDAV + iCalendar stack. Use [`iCal4j`](https://github.com/ical4j/ical4j) for parsing and recurrence, and [`dav4jvm`](https://github.com/bitfireAT/dav4jvm) (MPL-2.0, from the DAVx⁵ authors) for WebDAV/CalDAV. DAVx⁵'s own sync code is GPLv3 — read it for reference, but check licence compatibility before copying anything into this Apache-2.0 project.
- The adapter talks **CalDAV directly** (it is effectively our own DAVx⁵), while the Flutter UI talks to the REST API. Both end up on the same CalDAV collections, so they cannot diverge.
- The Flutter side only needs a Pigeon channel to register/remove the system account on sign-in/sign-out and to trigger a manual sync.

The adapter is scoped to **Shared** calendars ([ADR 0001](adr/0001-calendar-privacy-modes.md)), which are unencrypted, so it needs no crypto for its Phase 6 scope. If the optional Phase 8 mirroring of Private calendars ships, the adapter also has to decrypt: `lazysodium-android` alongside the Dart `sodium_libs` implementation, producing byte-identical results from shared test vectors. Only the *unwrap content key, open envelope* path is duplicated — the key hierarchy itself stays in Dart.

## Alternatives Considered

- **Native Swift/SwiftUI + Kotlin/Compose** — the previous plan. Best platform fidelity, but two UI codebases, two offline caches, and two API clients for what is mostly identical logic. Rejected; see ADR 0002.
- **React Native** — would share TypeScript types and possibly `ical.js` with the backend and web client, which is a real advantage. Rejected in favour of Flutter for more consistent rendering of a custom, gesture-heavy calendar grid, and a more mature ecosystem for the pieces we need (Pigeon, Firebase, Drift).
- **Flutter Web instead of React** — not chosen. Flutter Web renders to a canvas, which hurts accessibility, text selection, and load time, and FullCalendar is far more mature than any Flutter grid. The web client stays React (see above).
- **Kotlin Multiplatform** — would let the sync adapter and the app share one CalDAV/iCalendar core, which is attractive. Rejected for now because Compose Multiplatform on iOS is less mature than Flutter; revisit if the sync adapter grows into the dominant codebase.

## Hosting

- Pinned (D-10, amended by [ADR 0004](adr/0004-single-4gb-host.md)): one 4 GB Hetzner VPS in the EU for the CalDAV service, API, Zitadel and Postgres, plus a staging environment created on demand. From Phase 7, an HSM-backed **AWS KMS** key in `eu-central-1` for Tier 1 escrow.
- TLS: Caddy, automatic certificates from **Let's Encrypt only**. iOS in particular is fussy about TLS — no self-signed certs without a profile.
  - Domain `flexcalendar.de`, DNS at IONOS. Its CAA records allow only Let's Encrypt (`issue "letsencrypt.org"`) and forbid wildcard certificates (`issuewild ";"`).
  - Caddy's default issuers are Let's Encrypt *and* ZeroSSL, and it falls back to ZeroSSL when Let's Encrypt fails. CAA would reject that fallback, so every non-local Caddyfile pins the global option `acme_ca https://acme-v02.api.letsencrypt.org/directory`. The local stack (E02-R03) uses Caddy's local CA instead.
  - Certificates are per hostname (HTTP-01 or TLS-ALPN-01), never wildcards, so ports 80 and 443 must be reachable from the internet.
  - Hostnames: `api.flexcalendar.de` (API), `auth.flexcalendar.de` (Zitadel), `caldav.flexcalendar.de` (CalDAV; routed by Caddy only from Phase 4, since M1 doesn't expose CalDAV). Staging uses the same names under `staging.flexcalendar.de`, for example `api.staging.flexcalendar.de`.
- Platform choices pinned as D-19 (2026-10-05):
  - **PostgreSQL 18** for the one cluster;
  - **GHCR** for container images, pinned by digest;
  - **OpenTofu** with the Zitadel provider for IdP configuration as code;
  - **a password manager with a CLI** as the secret store, with deploys reading secrets through its CLI;
  - **ntfy** for ops alerts until SMTP exists, with uptime probes from a hosted service outside our host;
  - no error reporter before Phase 8 (`04`).
- The CalDAV server **must be reachable on the public internet on port 443** for stock apps to talk to it. This is a real constraint: no internal-only deployments unless you also ship a VPN profile.

### Sizing and cost

Re-checked on 2026-10-04. On 15 June 2026 Hetzner repriced its cloud for new orders. The shared-vCPU CPX line rose about 2.4–2.75× (CPX22 from €7.99 to €19.49, CPX32 from €13.99 to €35.49). The cost-optimised CX and CAX lines are listed as "currently not available". OVH and Netcup raised VPS prices in 2026 as well, so this is a market-wide move driven by memory prices, not a reason to change provider.

The whole stack fits on one 4 GB host (ADR 0004): Postgres about 1 GB, Zitadel's core and login UI together under 1 GB, and the API and CalDAV service a few hundred MB each, plus Caddy and the monitoring agents. That headroom is real but not large, so tune Postgres for the box (for example `shared_buffers` around 512 MB) and give every container a memory limit. Keycloak alone needed 1–1.5 GB and forced an 8 GB host; that is why ADR 0004 replaced it. Every component has arm64 and amd64 images, so order whichever 4 GB line is cheapest and available when E08-R01 is done. If the host runs short, resize it to 8 GB; that takes minutes.

| Item | €/month (list price, excl. VAT, 2026-10-04) |
|---|---|
| Production, 4 GB (CPX22) | ~19.50 |
| Primary IPv4 | ~0.50 |
| Backup repositories, two pay-per-GB providers, a few GB each | ~0.50–1 |
| Staging, on demand (a few days of use a month) | ~1–3 |
| Weekly throwaway restore-check instance, about an hour each | < 0.50 |
| **Total until M1** | **~22–25** |

- If a cheaper 4 GB line (for example CAX11) becomes orderable again, the total drops further.
- **No Hetzner server backups.** They are disk images, never the data backup; recovery is a fresh VPS, a deploy and a pgBackRest restore, which is what the restore drill tests.
- **Staging exists only while it's used.** Hetzner bills a powered-off server, so staging is created from code (`make staging-up`) for device tests, upgrade rehearsals and pre-deploy checks, and deleted afterwards (`make staging-down`). It never holds production data, so deleting it loses nothing.
- Later additions are small. Phase 4 adds SES mail at cents per thousand messages. Use SES in `eu-central-1` rather than Postmark, since the AWS account exists for KMS anyway. Phase 7 adds the KMS key at about $1/month plus requests. FCM is free.
- **People's time is the larger cost.** Budget 4–8 hours a month of routine operations: the quarterly Zitadel upgrade, Renovate PRs, OS patches, and reviewing restore checks. This does not include incidents.

Not chosen for now:
- **Dedicated servers** (Hetzner auction, about €40–55 for 64 GB). They have no snapshots, a hardware fault means a manual rebuild, and the capacity is far beyond what we need.
- **Managed Postgres.** It costs more, and it adds another vendor that holds plaintext Shared calendars from Phase 4 on.
- **Kubernetes.**
- **A standby replica before M5.** The 1-hour RTO is reachable from backups plus deploy-as-code. Revisit when open signup opens.
- **Free tiers or a home server.** See ADR 0004 § Alternatives.

### Runtime layout

- **Podman, rootless**, on the server and on development machines; there is no Docker daemon anywhere. The stack is described in Compose files, the same shape as the local stack (E02-R03), and run with `podman compose`, which hands the file to the `docker-compose` binary through the user's Podman socket. Images are OCI images built in CI and pinned by digest.
  - The server runs the stack as the unprivileged `deploy` user. A systemd **user** unit runs `podman compose up -d` and `down`, and `loginctl enable-linger deploy` keeps it running without a login session and starts it at boot. Don't rely on Compose `restart:` policies alone: Podman has no daemon to restart containers after a reboot.
  - Rootless containers can't bind ports below 1024 by default, so host setup sets `net.ipv4.ip_unprivileged_port_start=80` in `/etc/sysctl.d/` for Caddy. The local stack doesn't change sysctls and serves HTTPS on 8443 instead.
  - Per-container memory limits (ADR 0004) need the cgroup v2 memory controller delegated to the `deploy` user, which current systemd does by default. Host setup verifies it, since a limit Podman can't apply is silently ignored.
  - Rootless networking is `pasta`, which keeps the client's source IP on published ports. Caddy's access log and the per-IP rate limit (E03-R03) depend on that, so host setup verifies it too.
- For the CalDAV service, consider [FrankenPHP](https://frankenphp.dev/) instead of nginx + php-fpm. It is a PHP app server built on Caddy, which we already run, and it now sits under the PHP Foundation. Use classic mode, not worker mode: SabreDAV was written for one request per process lifetime, and worker mode would first need an audit for state that leaks between requests.
- **Zitadel is the component with the most upkeep.** It ships a major version about every quarter, each supported for roughly six months, and majors have broken things before: v4 split the login UI into its own container, and deploying only the core leaves login silently broken. Keep upgrades routine: no custom actions holding logic, branding by settings only, configuration as code (Terraform provider), and staging before production (E08-R08).
- **Zitadel issues JWT access tokens** only if each app registration says so; some app types default to opaque tokens. Set the JWT type and request the project audience scope, so the API validates tokens locally against JWKS (E05-R01).

### Backups and recovery (D-11)

All durable state is in **one Postgres cluster**: CalDAV objects, sidecar envelopes, metadata, the audit log and Zitadel's database. One consistent backup therefore captures everything. Keep it that way, with no durable state on local disk outside Postgres.

- **Tool**: [pgBackRest](https://pgbackrest.org/), with WAL-G as an acceptable alternative.
  - Continuous WAL archiving with `archive_timeout = 60s` gives an RPO of about 1 minute against the 5-minute target.
  - Nightly backups, kept for 30 days.
  - Client-side encryption (repository cipher). The cipher key lives in the secret store, with an offline copy.
- **Two repositories, at two providers:**
  1. A pay-per-GB EU object store, for example Scaleway Object Storage in Paris.
  2. A second pay-per-GB EU object store at another provider, for example Backblaze B2 in Amsterdam.
  - Both: Object Lock on, with a lock period shorter than pgBackRest's retention so expiry still works, and credentials on the host that can write but not delete. Neither is at Hetzner, so a Hetzner account suspension can't take the backups with the server, and an attacker on the host can't delete them. At our size (a few GB) both cost cents a month; Hetzner Object Storage's €6.49 minimum buys 1 TB we don't need (ADR 0004).
- **No Hetzner server backups** (ADR 0004). They are crash-consistent disk images, never the data backup.
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
