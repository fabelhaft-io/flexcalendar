# Implementation Phases

Phased so that the first release is an **Android app that stores family calendars end-to-end encrypted on our server**, and so that each later phase leaves a usable product. Stock-app integration comes right after the first release. The order and its reasons are recorded in [`adr/0003-android-first-private-first-delivery.md`](adr/0003-android-first-private-first-delivery.md). It replaces the earlier order, which put encryption in Phase 5; the mapping from the old numbering is at the end.

| Phase | Content | Duration | Runs in parallel with | Ends at |
|---|---|---|---|---|
| 1 | Server core | 1.5–2 weeks | Phase 2 | — |
| 2 | Crypto core (Dart) | ~2 weeks | Phase 1 | — |
| 3 | Android app with Private calendars | 6–7 weeks | — | **M1: family v1** |
| 4 | Shared mode, stock apps, push | 3–4 weeks | — | M2 |
| 5 | Web client and iOS app | 4–5 weeks | Phases 6, 7 | M3 |
| 6 | Android sync adapter | 2–3 weeks | Phases 5, 7 | M4 |
| 7 | Recovery for everyone. **Gates open signup** | ~3 weeks | Phases 5, 6 | **M5: open signup** |
| 8 | Polish and scale | ongoing | — | — |

Estimated time to M1: **about 8–10 weeks**.

## Phase 1 — Server core (1.5–2 weeks)

Goal: the production server our own app needs: CalDAV store, API, auth and backups. It contains nothing stock-app facing.

- [ ] SabreDAV in a small PHP service, backed by Postgres (D-02): the CalDAV, ACL and Sync (RFC 6578) plugins, plus discovery.
- [ ] API → CalDAV through delegated service identity on an internal listener (D-05). CalDAV ACLs are derived from the API's membership table.
- [ ] Mode-aware write guard: the CalDAV service rejects content properties (`SUMMARY`, `LOCATION`, …) in a Private calendar's skeleton. This is the server-side backstop against a client that leaks plaintext.
- [ ] Change outbox written in the same transaction as each calendar object. The push consumer reads it from Phase 4.
- [ ] Postgres 18 schema: users, calendars (with `mode` and, for Private calendars, the encrypted name and colour, D-18), members, invitations, user keys, calendar keys, the sidecar envelope table keyed `(calendar_id, uid, recurrence_id, envelope_sha256)` (D-06), the change outbox, device-link rendezvous and an append-only audit log.
- [ ] **`mode` accepts only `private` until Phase 4.** The API still requires `mode` explicitly on create; there is no default.
- [ ] **`UID`s and every other generated ID are random UUIDv4.** Content-derived IDs leak titles and can never be changed without breaking every client's sync state.
- [ ] Zitadel (OIDC + PKCE, JWT access tokens; ADR 0004), configured as code with OpenTofu from the start, so the local stack, staging and production share one configuration (E02-R09). Accounts are created by invitation or by an admin, and self-registration is off. Password reset is admin-assisted until SMTP lands in Phase 4. It restores sign-in, never keys (D-17).
- [ ] Node + TypeScript + Fastify API: calendars, event CRUD with ETag preconditions, windowed occurrence expansion with `ical.js`, delta endpoint over `sync-collection`, IANA timezone handling, problem+json errors, and no event content in logs.
- [ ] Ops: one 4 GB VPS plus a staging environment created on demand (ADR 0004), Caddy with automatic TLS, Postgres WAL archiving plus nightly base backups to two off-site object stores at two providers, uptime and backup-age alerts delivered through ntfy (D-19), and a runbook. **Backups start here** (D-11). Backups of Private calendars are ciphertext: they protect against our failures, not against a user losing their keys.

**Not in this phase:** device app passwords, Apple calendar-sharing extensions, iMIP/SMTP, `.ics` feeds, `.mobileconfig`, push. All of them are Phase 4.

Exit criteria: API integration tests pass against the local stack and staging. A restore-from-backup drill succeeds.

## Phase 2 — Crypto core (~2 weeks, in parallel with Phase 1)

Goal: the Dart crypto library v1 depends on, built from a written spec and frozen test vectors.

- [ ] Confirm that `sodium_libs` provides XChaCha20-Poly1305-IETF, `crypto_box_seal`, Ed25519 and HKDF on Android, and on iOS for later.
- [ ] `spec/crypto.md` defines every byte:
  - the envelope, ADR 0001 layout;
  - the canonical AAD, including `calendar_id` and `recurrence_id` (D-14);
  - the JSCalendar payload, serialised with JCS;
  - sealed CCK records signed with a per-user Ed25519 identity key (D-15);
  - the recovery-code encoding and the device-link message.
- [ ] Dart library:
  - envelope seal and open;
  - user keypairs (X25519 for sealing, Ed25519 for signing);
  - recovery-code KEK via HKDF;
  - device-link sealing;
  - CCK generation and sealing to a member.
- [ ] **No KEK derived from the login password** (D-17, ADR 0003). The login password goes to our IdP, so a key derived from it would be derivable by us.
- [ ] Test vectors in `spec/crypto-vectors/`, frozen, and the target for the TypeScript library in Phase 5.

Exit criteria: all positive and negative vectors pass, and every PR has been reviewed by a human.

## Phase 3 — Android app with Private calendars (6–7 weeks) → M1

Goal: one Flutter app shipped to Android. Family members share calendars that our server cannot read.

- [ ] Flutter app (Dart 3), released for Android only (minSdk 26). The iOS target stays in the project but isn't built in CI until Phase 5. Riverpod, Drift, `dio` with a client generated from the API's OpenAPI spec, `timezone`, and a calendar grid (`calendar_view` or `kalender`).
- [ ] OIDC sign-in with `flutter_appauth`.
- [ ] **Keys are created on the first device** and kept in Keystore-backed `flutter_secure_storage`.
- [ ] **Recovery code**: 128 bits as BIP39 words, shown once. The user must save it before continuing, by printing a recovery sheet, saving it as a PDF, sharing it through the share sheet (for example to a messenger) or copying it. Then they re-enter a random subset of the words. This must be done before the first calendar can be created; a second device is not required. The save screen says plainly that anyone with the code and the account login can read the user's Private calendars. The server stores only the key wrapped under the recovery-code KEK.
- [ ] **Device linking**: the new device shows a QR code, an existing device scans it and confirms the short code, and the keys travel sealed. The app prompts users to link a second device.
- [ ] Private calendars end to end:
  - write path: a skeleton with only the allowed properties and a generic `VALARM` text (D-08), plus an envelope committed in the D-06 order;
  - calendar names and colours sealed under the calendar's key, so the server only sees `Private calendar` (D-18);
  - read path that opens envelopes into the local cache;
  - client-side search over the decrypted cache;
  - recurring edits as two-step intents (D-07): the API plans with `ical.js`, the client re-seals, and the commit is atomic.
- [ ] Sharing:
  - an invite link or QR code shared through the OS share sheet;
  - an in-person QR scan verifies keys both ways (D-15), and a remote invite needs a safety-number comparison;
  - roles, removal, and a key epoch rotation on removal.
- [ ] Offline cache in Drift, storing the skeleton iCalendar, ETag and decrypted payload. An outbox queues offline edits as intents or objects with their base ETag.
- [ ] Sync on app start and foreground, on pull-to-refresh, and every 15 minutes through `workmanager`. No push yet.
- [ ] Timezones through the `timezone` package only, never raw `DateTime` for `TZID` values. DST-day widget tests.
- [ ] Every calendar shows its **Private** badge. The copy says end-to-end encrypted and makes no claim of an audit (INV-11). It also states plainly that losing every device *and* the recovery code loses the data.
- [ ] Play Console internal testing track.

Exit criteria (M1):
- Two family members on Android phones share a Private calendar and see each other's edits after a refresh, or within 15 minutes in the background.
- `verify-private-blind.sh` on staging doesn't find a known event title anywhere in the CalDAV store, the sidecar table or the logs.
- A user who wipes their phone gets back in on a new phone with the recovery code.
- A second device links by QR.
- The restore drill has passed.

## Phase 4 — Shared mode, stock apps and push (3–4 weeks)

Goal: requirement #2. A Shared calendar works in Apple Calendar, in Samsung and Google Calendar via DAVx⁵, and in our app, and our app hears about changes quickly.

- [ ] Run the device protocol (E15-R05) against staging, and fix the stock-app quirks it finds in the CalDAV service. The Phase 0 spike left no quirks log.
- [ ] Lift the mode constraint so `shared` and `published` are accepted. Creating a calendar presents the mode choice with no default, worded as a constraint on who can take part: *"Private: end-to-end encrypted, everyone you share with needs the app"* vs *"Shared: works in Apple Calendar, Google Calendar and Samsung Calendar"*.
- [ ] Mode switching:
  - the non-retroactivity warning appears at the point of switching (risk #7);
  - the owner confirms;
  - every member is notified;
  - an audit entry is written.
- [ ] Per-device app passwords for stock apps (D-04). The CalDAV auth backend checks them, and Private collections stay invisible to them (INV-08).
- [ ] Apple calendar-sharing extensions, reconciled into the API's sharing model (Shared calendars only).
- [ ] Outbound SMTP with SPF, DKIM and DMARC. Email invites. iMIP for Shared calendars.
- [ ] A signed `.mobileconfig` download and an "Add to Android" page with DAVx⁵ instructions, served as small pages by the API. The full web app is Phase 5.
- [ ] Read-only `.ics` feeds for Shared calendars at revocable capability URLs.
- [ ] One-step recurring-edit intents for Shared calendars, on the same `ical.js` plan engine as the Private two-step intents.
- [ ] Push: a change worker reads the outbox, with a 30-second `sync-collection` poll as fallback, and sends FCM data-only change pings with no event content. The Android app fetches the delta on a ping.

Exit criteria (M2):
- One Shared calendar is visible and editable in Apple Calendar (added via `.mobileconfig`), in Samsung or Google Calendar via DAVx⁵, and in our Android app.
- Our app receives a ping within seconds of a stock-app edit. Stock apps show our changes on their next refresh (D-12).
- A Shared → Private switch leaves no plaintext `SUMMARY` in CalDAV and writes the audit entry.

## Phase 5 — Web client and iOS app (4–5 weeks)

Goal: the remaining clients. Most new users will start on the web.

- [ ] React + Vite + TypeScript scaffold, FullCalendar for month, week, day and agenda views, TanStack Query.
- [ ] Create, edit and delete events with full recurrence and timezone support, through the same API intents.
- [ ] Real-time updates via SSE or WebSocket from the API.
- [ ] Private mode on the web:
  - the TypeScript crypto library, built to the frozen Phase 2 vectors;
  - only the operational subset (D-16), on `libsodium-wrappers-sumo`;
  - keys arrive by device linking from a phone or by the recovery code.
- [ ] Sharing UI, a device-credentials page, and the onboarding pages from Phase 4, moved into the web app.
- [ ] iOS build of the Flutter app (iOS 16+): APNs via FCM, the guided `.mobileconfig` install (open it in Safari, confirm in Settings), TestFlight, then the App Store.

Exit criteria (M3):
- A user runs their calendar entirely from the web app.
- Web-to-web updates arrive in ≤ 5 seconds.
- The iOS app and the web app read and write the same Private calendar as the Android app.

## Phase 6 — Android sync adapter (2–3 weeks)

Goal: users don't need DAVx⁵ on Android.

- [ ] Native Kotlin module in the Flutter app's `android/` project, with no Dart in the sync path.
- [ ] A CalendarContract sync adapter that syncs events from our CalDAV server into the system CalendarProvider, so Samsung and Google Calendar pick them up. It declares an authority and an authenticator. `dav4jvm` + `iCal4j`.
- [ ] A Pigeon channel, so the Flutter app can register and remove the system account and trigger a sync.

The sync adapter is the longest single piece of work in this whole plan. Budget for it.

Scope: **Shared calendars only.** A Private calendar cannot be fed to a stock app this way until the adapter holds keys and decrypts. That is the Phase 8 mirroring item below, and it is deliberately separate.

Exit criteria (M4): a Pixel and a Samsung phone show a Shared calendar in the stock app without DAVx⁵, with two-way edits.

## Phase 7 — Recovery for everyone (~3 weeks). Gates open signup

Goal: the full recovery design from [`adr/0001`](adr/0001-calendar-privacy-modes.md). Phases 3–6 run with the recovery code and device linking only, which is enough for users who know the developer and accept the warning. It is not enough for strangers. **Open signup stays closed until M5.** This phase can start once Phase 4 has landed, because it needs push and email, and it runs in parallel with Phases 5 and 6.

- [ ] **Tier 1 escrow**:
  - a second wrapped copy of the private key under an HSM-backed KMS key (D-10);
  - a separate release service;
  - release only after a user-initiated request, second-factor verification, a notification to every registered device and email, and a cancellable 72-hour delay;
  - a user-readable append-only audit log.
- [ ] Tier 1 becomes the default for **new** accounts. Existing accounts are strict already. They are offered escrow as an explicit, logged choice and are never moved silently (ADR 0003).
- [ ] **Trusted contacts**: 2-of-3 Shamir, with each share sealed to a family member's verified public key.
- [ ] **Tier 2 (strict) opt-in for Tier 1 accounts**: it verifiably destroys the escrow record and requires at least one recovery method first.
- [ ] **No security questions anywhere in the key hierarchy.** Entropy comes from the recovery code or from a hardware-enforced attempt limit; there is no third source.
- [ ] External review of the crypto core and the recovery design.
- [ ] Marketing copy reviewed against the claim table in `adr/0001`. Tier 1 must not be described as unreadable by us.

Exit criteria (M5):
- Two of our own clients read and write the same Private calendar while the server holds only ciphertext. This is verified by grepping the CalDAV store and the sidecar table for a known event title and finding nothing.
- A Tier 1 recovery completes end to end with all notifications delivered.
- A Tier 2 account that has lost every device and its recovery code is demonstrably unrecoverable.

## Phase 8 — Polish and scale (ongoing)

- [ ] Better recurrence editing UX (this single feature is where most calendar apps fail).
- [ ] Timezone correctness audit, with automated tests around DST transitions.
- [ ] Server-side performance. CalDAV storage is already in Postgres (D-02).
- [ ] Conflict resolution UX for the app and the sync adapter (what happens when the same event is edited offline on two devices).
- [ ] Observability beyond the Phase 1 basics: metrics dashboards and error reporting with content scrubbing.
- [ ] Passkey `prf` recovery and an HSM PIN vault (ADR 0001, Tier 2 options 3 and 4).
- [ ] **Optional: mirror Private calendars into the device calendar store**, so stock apps can display them without weakening encryption. Our app decrypts locally and writes plaintext into `EKCalendar` (iOS, EventKit) and `CalendarContract` (Android, extending the Phase 6 adapter with `lazysodium-android`). This is valuable for the personal-sensitive case, where the user owns every device. It is gated on these items, in order:
  - [ ] **The `EKSource` spike.** The calendar must live in EventKit's *local* source so plaintext never leaves the device. A writable local source has historically been unreliable when iCloud Calendar is enabled. The iCloud source would upload plaintext titles to Apple, and the subscribed source is read-only. Test with iCloud Calendar on and off, with Google and Exchange accounts added, and on a fresh device. **If this fails, iOS mirroring is dead** and the item is Android-only.
  - [ ] Event identity anchored in `EKCalendarItem.url` (`calflex://event/<uid>`), with a shadow table on `eventIdentifier` as secondary index. Expect duplicate-event bugs here.
  - [ ] Change detection by shadow table plus windowed enumeration. `EKEventStoreChanged` carries no delta, deletions are only visible by full enumeration, and predicates cap at a four-year span.
  - [ ] Accept that an edit made in Apple Calendar reaches us in minutes to hours, because no API wakes a suspended app. Android has no such problem: `CalendarContract` has a `DIRTY` column.
  - [ ] Treat the skeleton plus envelope as the authority and EventKit as a projection. `EKRecurrenceRule` is narrower than RFC 5545.
  - [ ] New disclosure: plaintext then lives in the OS calendar store and therefore in iCloud device backups, where Apple holds the keys unless Advanced Data Protection is on.

## What to Defer Aggressively

- Free/busy lookup across users (`VFREEBUSY`): nice, but not v1.
- Tasks (`VTODO`): a different UI and a different user mental model; ship as a follow-up.
- Server-side rich notifications ("Alice changed the location of dinner"): start with simple change pings.
- Native macOS / Windows apps: the web app covers desktop.

## Mapping from the previous phase numbers

Older notes, commits and ADR 0001/0002 may use the numbering from before ADR 0003.

| Old phase | Now |
|---|---|
| 0 Spike | Closed 2026-10-05 without a committed result; gates nothing (E01) |
| 1 Server foundation | 1 (core) and 4 (stock-app parts: app passwords, Apple sharing, iMIP, feeds) |
| 2 Web client | 5, plus the onboarding pages and the push fan-out in 4 |
| 3 Mobile app | 3 (Android) and 5 (iOS) |
| 4 Android sync adapter | 6 |
| 5 Encryption and recovery | 2 (crypto core), 3 (Private mode, recovery code, device linking), 7 (escrow, trusted contacts, gate on open signup) |
| 6 Polish and scale | 8 |
