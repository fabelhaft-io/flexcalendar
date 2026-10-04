# ADR 0003 — Android-first, Private-first delivery order

- **Status**: Accepted
- **Date**: 2026-10-04
- **Amends**: [ADR 0001](0001-calendar-privacy-modes.md) (when Private mode ships, the Phase 1 reservations, recovery posture before open signup, key derivation)
- **Relates to**: [`04-implementation-phases.md`](../04-implementation-phases.md) (the phase order is rewritten), [`06-implementation-backlog.md`](../06-implementation-backlog.md) (milestones, D-17), [ADR 0002](0002-flutter-for-mobile-clients.md), [`05-risks-and-open-questions.md`](../05-risks-and-open-questions.md) (risk 4)

## Context

The previous plan in `04` retired the stock-app integration risk first: spike, server, web client, mobile app, Android sync adapter, and only then encryption (old Phase 5). It deferred encryption on one premise: *the friends-and-family test group accepts plaintext shared history.*

Two things have changed:

1. **The first goal is an Android app backed by our server, as fast as possible.**
2. **End-to-end encryption matters to the first users as well.** The premise for deferring Private mode does not hold. ADR 0001 already says the deadline for encryption is "the first user who did not knowingly choose plaintext", and retrofitting leaves a plaintext history behind.

Under the old order the Android app arrived after roughly 8–10 weeks and Private mode after roughly four months, and everything created in between was stored as plaintext.

**Private mode and stock-app support use disjoint parts of the system.** A Private calendar never reaches a stock app (INV-08). An Android app limited to Private calendars therefore needs none of the stock-app surface: device app passwords, Apple calendar-sharing extensions, iMIP and SMTP, `.mobileconfig` signing, `.ics` feeds and the sync adapter. Taking that surface off the critical path frees roughly the time the crypto work needs, and the crypto work has to be done in any case.

| Requirement | Status |
|---|---|
| Android app plus our server as the first release | **Hard**, for this ordering |
| E2EE for the first users' calendars | **Hard** |
| Stock-app editing (`00-overview.md` #2) | **Hard for the product, negotiable for the first release**: it moves to Phase 4 |
| CalDAV as the store for every mode (ADR 0001) | Unchanged |
| Open signup gated on full recovery tiers (M5) | Unchanged |

## Decision

**The first release (M1) is the Flutter app on Android with Private calendars only, backed by the full CalDAV + API server. Shared mode and stock apps follow in Phase 4. The web client and iOS app follow in Phase 5. The Android sync adapter is Phase 6. Escrow and trusted contacts are Phase 7, which still gates open signup.**

### 1. Phase order

| New phase | Content | Came from (old plan) |
|---|---|---|
| 0 | Integration spike. Runs in parallel and gates Phase 4 only | Phase 0 |
| 1 | Server core: CalDAV, API, auth, schema, backups | Phase 1 without the stock-app parts |
| 2 | Crypto core in Dart, in parallel with Phase 1 | Part of Phase 5 |
| 3 | Android app with Private calendars, ending at **M1, family v1** | Android half of Phase 3 plus the core of Phase 5 |
| 4 | Shared mode, stock apps, push | Stock-app half of Phase 1 and part of Phase 2 |
| 5 | Web client and iOS app | Phase 2 and the iOS half of Phase 3 |
| 6 | Android sync adapter | Phase 4 |
| 7 | Trusted contacts and Tier 1 escrow. **Gates open signup** | The rest of Phase 5 |
| 8 | Polish and scale | Phase 6 |

### 2. v1 accepts only `private` calendars

The `mode` column and the explicit-mode API (no default) exist from day one, as ADR 0001 requires. The Phase 1 check constraint is the **inverse** of ADR 0001's reservation: it allows `private` only until Phase 4 adds `shared` and `published`. The mode choice appears in the UI once there is a second mode to choose from. Until then every calendar shows its Private badge.

### 3. CalDAV stays the store

Private calendars are skeleton `VEVENT`s in SabreDAV plus sidecar envelopes, exactly as ADR 0001 describes. We are not swapping in a plain REST store for v1: doing so would turn Phase 4 into a storage migration, and mode switching would stop being a metadata change.

### 4. Recovery before open signup: recovery code and device linking only

v1 has no escrow. Every v1 account is therefore **strict (ADR 0001 Tier 2) by construction**, and the recovery code is its mandatory recovery method. It is shown once at key creation, and acknowledging it cannot be skipped. A second device can be linked from a device that already holds the keys.

Tier 1 escrow and trusted-contact recovery ship in Phase 7, before open signup, so the M5 gate is unchanged. When escrow ships:
- **New accounts** get Tier 1 by default, as ADR 0001 says.
- **Existing strict accounts are never moved to escrow automatically.** Escrow weakens their guarantee, so they are offered it as an explicit, logged choice.

### 5. Keys never derive from the login password (D-17)

ADR 0001 wraps the private key under an Argon2id KEK derived from "the user password". But the login password is typed into our IdP, which we host. A KEK derived from it could be derived by us, so the strict claim "we cannot read it" would be false.

v1 instead:
- generates keys on the device and keeps them in Keystore-backed secure storage;
- moves them to another device only by **device linking**, sealed to the new device's ephemeral key after the user confirms a short code on both screens;
- stores exactly one server-side wrapped copy, under the **recovery-code** KEK.

The login password authenticates and nothing else. INV-12 records this. ADR 0001's key diagram needs an amendment, tracked as D-17.

### 6. Invites without email

v1 has no SMTP. Members join through an **invite link or QR code** that the owner shares outside our system (E06-R09). Scanning the QR code in person doubles as the public-key verification that D-15 requires. A remote invite needs a safety-number comparison before the member counts as verified. Email invites arrive with SMTP in Phase 4.

### 7. Push waits for Phase 4

v1 fetches deltas on app start and foreground, on pull-to-refresh, and every 15 minutes through `workmanager`. FCM data-only pings arrive in Phase 4. At that point stock-app edits make server-originated changes common, and Tier 1 recovery in Phase 7 needs device notifications anyway.

## Consequences

- **No plaintext history.** Every v1 calendar is encrypted from its first event. The "Shared → Private is not retroactive" warning only concerns calendars created from Phase 4 on.
- **Requirement #2 waits until Phase 4.** In v1 every member of a calendar needs our Android app. A family member who uses only Apple Calendar or Google Calendar can't take part yet. This is the explicit price of shipping fast. The Phase 0 spike still runs in parallel, so the stock-app path is de-risked before Phase 4 starts.
- **Crypto is on the critical path, and it protects real family data from M1.** E12 and E13 stay `agent+review`. The external crypto review remains a gate on M5. Until then the users know the developer, and the copy may say "end-to-end encrypted" but must not imply an audit (INV-11).
- **Key-loss risk is higher before Phase 7 than ADR 0001's default.** Without escrow, losing every device *and* the recovery code loses the data, and our backups cannot help because they are ciphertext. Mitigations: mandatory recovery-code acknowledgement, a prompt to link a second device, and a periodic in-app check that the user still has the code. `05` risk 4 is updated.
- **Login and key recovery are separate.** An admin-assisted password reset at the IdP (there is no SMTP in v1) restores sign-in, never keys.
- **More decisions block v1.** D-06, D-07, D-08, D-14, D-15 and the new D-17 must be pinned before Phases 2–3 instead of before old Phase 5. D-06, D-07, D-14, D-15 and D-17 each need their ADR 0001 amendment by then. D-04 and D-16 stop blocking v1; they block Phases 4 and 5.
- **Recurring edits use the two-step intent (D-07) from the start.** The one-step intent for Shared calendars comes in Phase 4. Both run on the same `ical.js` plan engine in the API.
- **Only the Dart crypto library is needed for v1.** The test vectors are frozen in Phase 2, so the TypeScript library in Phase 5 has a fixed target.
- **The Phase 0 spike** no longer gates any coding before Phase 4. It must reach M0 before Phase 4 starts.
- The ASCII diagram in `01-architecture.md` shows the target system. The C4 diagrams in [`diagrams/`](../diagrams/) show both the target and the M1 slice.

## Alternatives considered

- **Keep the old order (Shared mode and stock apps first, encryption in Phase 5).** **Rejected**: the first users want E2EE, and data created before Phase 5 would remain plaintext forever.
- **Shared mode only in v1, with server-side encryption at rest.** **Rejected**: it can't support "we cannot read it". ADR 0001 rejects per-user KMS encryption for the same reason.
- **Drop CalDAV for a plain REST store in v1**, since no stock app reads Private calendars. **Rejected**: Phase 4 becomes a migration, and mode switching stops being a metadata change.
- **A native Kotlin app for an Android-only v1.** **Rejected**: iOS follows in Phase 5, and ADR 0002's reasons still hold. Above all, the key hierarchy stays in one language.
- **Tier 1 escrow in v1.** **Rejected for speed**: it needs an HSM-backed KMS, a separate release service, push and email, which is most of the Phase 4 and Phase 7 infrastructure.
- **Derive the KEK from the login password, as ADR 0001 is written.** **Rejected**: see decision 5. OPAQUE would make it safe, but it needs a custom authenticator in the IdP and an OPAQUE client in Dart. Verify that both exist before reconsidering.
- **A separate encryption passphrase next to the login password.** **Rejected for v1**: a second password for every family member, with the same loss problem as the recovery code and lower entropy. It can come back as an option later, and then needs Argon2id again.

## Open questions

1. Should v1 require a second linked device (or a printed recovery code) before a user can create their first calendar, rather than only prompting for it? This trades onboarding friction against key-loss risk.
