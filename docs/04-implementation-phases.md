# Implementation Phases

Phased so that the riskiest unknowns get answered first and you have a usable product after each phase.

## Phase 0 — Spike: Prove the integration story (1–3 days)

Goal: end-to-end CalDAV round-trip with a stock app on each platform. Build nothing of your own yet.

- [ ] Deploy Radicale on a VPS at a public hostname with a real TLS cert (Caddy + Let's Encrypt is the fastest).
- [ ] Create one user, one calendar collection, two events via Thunderbird.
- [ ] Add the account to a real iPhone via Settings. Edit an event, confirm round-trip.
- [ ] Install DAVx⁵ on an Android phone (Samsung and/or Pixel), add the account, confirm events show up in the stock calendar app and edits round-trip.
- [ ] Document any quirks (TLS, discovery URLs, weird recurrence behavior).

Exit criteria: a screenshot of the same event in Apple Calendar, Samsung/Google Calendar, and a Radicale event file, all in sync. **Do not skip this phase.**

This spike validates the **Shared** mode from [`adr/0001-calendar-privacy-modes.md`](adr/0001-calendar-privacy-modes.md), which is the mode that carries requirement #2. Private calendars need no stock-app round-trip, so nothing here blocks on them.

## Phase 1 — Server foundation (1–2 weeks)

Goal: production-ready server stack with auth and multi-user.

- [ ] Replace Radicale with SabreDAV (embedded in a small PHP service) or stick with Radicale if its sharing/auth model is sufficient.
- [ ] Postgres for users, accounts, sharing relationships.
- [ ] User signup/login (your API layer; Auth0/Clerk or self-hosted).
- [ ] Sharing model: a user can create a calendar, invite another user by email, share read-only or read-write.
- [ ] iCalendar feed URLs for read-only subscribers (Google Calendar web users).
- [ ] Apple-style sharing extensions enabled so iOS's native sharing UI works (Shared calendars only).
### Structural reservations for encryption

Encryption itself is Phase 5, but three cheap decisions must land now so nothing has to migrate later:

- [ ] `mode` column on the calendar record — `private` | `shared` | `published`. Only `shared` and `published` are accepted until Phase 5.
- [ ] The sidecar envelope table, keyed `(calendar_id, uid, recurrence_id)`, created and left empty.
- [ ] **`UID`s are random UUIDv4 from day one**, never derived from event content. A content-derived `UID` would leak titles retroactively once calendars go private, and it cannot be changed later without breaking every client's sync state.

Exit criteria: two users on iPhones can each add the account, see a shared calendar, and edit events that the other sees within a few seconds.

## Phase 2 — Web client (2–3 weeks)

Goal: full-featured web app — most users will start here.

- [ ] React + Vite + TypeScript scaffold.
- [ ] FullCalendar for grid; month/week/day/agenda views.
- [ ] REST/GraphQL endpoints in your API layer fronting CalDAV (event CRUD, list calendars, sharing).
- [ ] Create / edit / delete events with full recurrence and timezone support.
- [ ] Real-time updates via WebSocket or SSE from the API layer (poll CalDAV server-side, fan out to connected clients).
- [ ] Sharing UI: invite by email, accept invitation, role management.
- [ ] Provide the `.mobileconfig` download for iPhone users and an "Add to Android" page with DAVx⁵ instructions.

Exit criteria: a user can run their daily calendar life entirely from the web app, and any event they create appears within seconds on their iPhone and Android stock apps.

## Phase 3 — Mobile app, iOS + Android (4–5 weeks)

Goal: one Flutter app shipped to both stores, with offline support and push.

- [ ] Flutter app (Dart 3), iOS 16+ and Android minSdk 26. Riverpod, Drift, `dio` with a client generated from the API's OpenAPI spec.
- [ ] Talk to your REST API (not CalDAV directly) for faster UX. Recurring-event edits go to the API as intents; the server applies them with `ical.js`.
- [ ] Offline cache in Drift (SQLite), storing raw iCalendar + ETag as the canonical record.
- [ ] Timezone handling through the `timezone` package — never raw `DateTime` for `TZID` values. DST-day widget tests.
- [ ] Push via `firebase_messaging` (FCM on Android, APNs via FCM on iOS): data-only change pings, client fetches the delta.
- [ ] iOS onboarding: open the signed `.mobileconfig` in Safari and walk the user through confirming it in Settings.
- [ ] Android onboarding: DAVx⁵ instructions until Phase 4 lands.
- [ ] App Store and Play Store submission.

## Phase 4 — Android sync adapter (2–3 weeks)

Goal: users don't need DAVx⁵ on Android.

- [ ] Native Kotlin module in the Flutter app's `android/` project; no Dart in the sync path.
- [ ] Implement a CalendarContract sync adapter: declares an authority, an authenticator, syncs events from your CalDAV server into the system CalendarProvider so Samsung/Google Calendar pick them up. `dav4jvm` + `iCal4j`.
- [ ] Pigeon channel so the Flutter app registers/removes the system account on sign-in/sign-out and can trigger a sync.

The sync adapter is the longest single piece of work in this whole plan. Budget for it.

Scope: **Shared calendars only.** A Private calendar cannot be fed to a stock app this way until the adapter holds keys and decrypts — that is the Phase 6 item below, and it is deliberately separate.

## Phase 5 — Encryption and recovery (3–4 weeks) — gate before open signup

Goal: Private mode, per [`adr/0001-calendar-privacy-modes.md`](adr/0001-calendar-privacy-modes.md).

**Why here and not Phase 1.** The initial test group is friends and family. Plaintext shared history is acceptable to them, and most such groups contain at least one Apple Calendar or Google Calendar user, so they would run in Shared mode regardless. Building the crypto first would have delayed the part of the product that actually needs validating.

**Why it must not slip past this point.** Retrofitting encryption onto stored plaintext leaves a plaintext history. That is fine for friends and family who chose it knowingly; it is not fine for a stranger who signs up expecting privacy. **This phase is a gate on open signup, not merely the next phase in sequence.**

- [ ] Crypto core: per-user X25519 keypair; private key wrapped by an Argon2id key from the password; per-calendar content key sealed to each member with `crypto_box_seal`; XChaCha20-Poly1305 envelopes over JSCalendar payloads.
- [ ] Sidecar envelope store goes live; the API never decrypts.
- [ ] **Tier 1 escrow**: second wrapped copy of the private key in a cloud HSM, plus the release process — user-initiated request, second-factor verification, notification to every registered device and email, a cancellable 72-hour delay, and a user-readable append-only audit log.
- [ ] **Tier 2 (strict E2EE) opt-in**: verifiably destroy the escrow record, and require at least one recovery method to exist first. Ship the recovery code (128-bit, BIP39 word list, shown once) and trusted-contact threshold recovery (2-of-3 Shamir, sealed to family members' public keys). Passkey `prf` and an HSM PIN vault are later options.
- [ ] **No security questions anywhere in the key hierarchy.** Entropy comes from the recovery code or from a hardware-enforced attempt limit; there is no third source.
- [ ] Mode selection when creating a calendar, worded as a constraint on who can participate rather than a feature toggle — *"Private: end-to-end encrypted, everyone you share with needs the app"* vs *"Shared: works in Apple Calendar, Google Calendar and Samsung Calendar"*.
- [ ] Mode switching, with the non-retroactivity warning at the point of the switch (risk #7), owner confirmation, notification to every member, and an audit entry.
- [ ] Invite flow refuses, or clearly warns, when someone is added to a Private calendar without a client that can hold a key.
- [ ] Client-side crypto and client-side search: `libsodium-wrappers` (WASM) on web, `sodium_libs` in Flutter, over the decrypted local cache — the API cannot search Private calendars.
- [ ] Marketing copy reviewed against the claim table in `adr/0001`. Tier 1 must not be described as unreadable by us.

Exit criteria: two of our own clients read and write the same Private calendar while the server holds only ciphertext — verified by grepping the CalDAV store and the sidecar table for a known event title and finding nothing. A Tier 1 recovery completes end to end with all notifications delivered. A Tier 2 account with a lost password and a used recovery code is demonstrably unrecoverable.

## Phase 6 — Polish and scale (ongoing)

- [ ] Better recurrence editing UX (this single feature is where most calendar apps fail).
- [ ] Timezone correctness audit — set up automated tests around DST transitions.
- [ ] Server-side performance: move CalDAV storage from filesystem to Postgres if you haven't.
- [ ] Conflict resolution UX for the sync adapter (what happens when the same event is edited offline on two devices).
- [ ] Observability: structured logs, metrics, error reporting (Sentry).
- [ ] Backups of the calendar store. Events lost = product dead. Note that backups of a Private calendar are ciphertext — they protect against our failures, not against a user losing their keys.
- [ ] **Optional: mirror Private calendars into the device calendar store** so stock apps can display them without weakening encryption — our app decrypts locally and writes plaintext into `EKCalendar` (iOS, EventKit) and `CalendarContract` (Android, extending the Phase 4 adapter with `lazysodium-android`). Valuable for the personal-sensitive case, where the user owns every device. Gated on, in order:
  - [ ] **The `EKSource` spike.** The calendar must live in EventKit's *local* source so plaintext never leaves the device. A writable local source has historically been unreliable when iCloud Calendar is enabled; the iCloud source would upload plaintext titles to Apple and the subscribed source is read-only. Test with iCloud Calendar on, off, plus Google and Exchange accounts added, and on a fresh device. **If this fails, iOS mirroring is dead** and the item is Android-only.
  - [ ] Event identity anchored in `EKCalendarItem.url` (`calflex://event/<uid>`), with a shadow table on `eventIdentifier` as secondary index. Expect duplicate-event bugs here.
  - [ ] Change detection by shadow table plus windowed enumeration — `EKEventStoreChanged` carries no delta, deletions are only visible by full enumeration, and predicates cap at a four-year span.
  - [ ] Accept that an edit made in Apple Calendar reaches us in minutes to hours; no API wakes a suspended app. Android has no such problem (`CalendarContract` has a `DIRTY` column).
  - [ ] Treat the skeleton plus envelope as authority and EventKit as a projection — `EKRecurrenceRule` is narrower than RFC 5545.
  - [ ] New disclosure: plaintext then lives in the OS calendar store and therefore in iCloud device backups, where Apple holds the keys unless Advanced Data Protection is on.

## What to Defer Aggressively

- Free/busy lookup across users (`VFREEBUSY`) — nice but not v1.
- Tasks (`VTODO`) — different UI, different user mental model, ship as a follow-up.
- Server-side rich notifications ("Alice changed the location of dinner") — start with simple change pings.
- Native macOS / Windows apps — the web app covers desktop.
