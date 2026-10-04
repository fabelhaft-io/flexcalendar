# calendar-flex — Working Notes for Claude

A cross-platform shared-calendar product. This file captures the non-obvious facts an AI assistant needs to do useful work in this repo. The full design lives in `docs/00-overview.md` through `docs/05-risks-and-open-questions.md` — read those before making non-trivial changes.

## What the product is

A calendar service whose events are editable from three places at once:

1. The project's own iOS, Android, and web apps.
2. The stock calendar apps on iPhone (Apple Calendar), Samsung (Samsung Calendar), and Google Pixel (Google Calendar).
3. Shared between multiple users with near-real-time sync.

## The one architectural rule everything follows

**CalDAV (RFC 4791) is the source of truth.** This is non-negotiable and drives every other technology choice. The reason: requirement #2 above. Stock calendar apps don't accept plugins, so the only way to be editable in all three is to speak a protocol they already speak, and CalDAV is the only one that fits.

Consequences:

- Events are stored as iCalendar (`VEVENT`, `VTODO`, `VTIMEZONE`) on a CalDAV server.
- The project's own clients are **also CalDAV clients** — usually through a thin REST/GraphQL API layer that fronts CalDAV for better UX.
- Stock apps bypass the REST layer entirely and hit CalDAV directly. Anything built in the API layer is for the custom clients only.
- The CalDAV server must be reachable on the public internet on port 443 with a real TLS cert. iOS will not connect otherwise without a configuration profile that trusts the CA.

**Scoped by privacy mode** (`docs/adr/0001-calendar-privacy-modes.md`). Calendars come in three modes, chosen explicitly at creation and switchable afterwards, and the rule's *justification* only applies to two of them:

- **Shared** (unencrypted) and **Published** (read-only `.ics` feed) — stock apps read these, so CalDAV is genuinely non-negotiable and everything above applies verbatim.
- **Private** (end-to-end encrypted, our apps only) — no third party ever reads it, so the protocol argument does not force CalDAV. We keep it anyway, for one storage engine and to make mode switching a metadata change rather than a migration. Event content is encrypted client-side (XChaCha20-Poly1305, per-calendar key sealed to each member) into a sidecar table keyed `(calendar_id, uid, recurrence_id, envelope_sha256)`, with the hash mirrored in the skeleton as `X-CALFLEX-ENVELOPE-SHA256` (D-06); only the skeleton (`UID`, `DTSTART`/`DTEND`, `RRULE`, `SEQUENCE`, `VALARM`) stays cleartext in the `VEVENT`.
- **Never** put a Private calendar in front of a stock app or an `.ics` feed expecting content to be readable — by construction it cannot be. That is what the Shared mode is for.

## Repo status

As of writing, this repo contains **docs only** — no code has been committed yet. `README.md` is a one-line stub. The docs describe the intended architecture and a phased implementation plan; treat them as the spec.

## Planned stack (from `docs/02-technology-choices.md`)

- **CalDAV server**: SabreDAV 4.7+ embedded in a PHP 8.4 service, Postgres PDO backend (D-02). Radicale only for the Phase 0 spike.
- **Backend API**: Node 24 LTS + TypeScript + Fastify, moving to Node 26 LTS when it's promoted (D-01). Thin layer; auth, push fan-out, sharing, REST facade over CalDAV. Reaches CalDAV via an HMAC-signed delegated principal on an internal listener (D-05).
- **iCalendar parsing**: `ical.js` (Node) — the single authority for recurrence; the mobile app delegates recurrence expansion and recurring-event edits to the API. Do not roll your own — recurrence rules are the #2 risk in the project.
- **CalDAV client lib (server-side)**: `tsdav` on Node; hand-rolled on Go.
- **Web**: React + TypeScript + Vite, FullCalendar for the grid, TanStack Query for server state.
- **Mobile (iOS + Android)**: one Flutter app (Dart 3), iOS 16+ / minSdk 26. Riverpod, `dio` + OpenAPI-generated client, Drift (SQLite) for offline, `timezone` for all `TZID` math (Dart `DateTime` is UTC/local only), `calendar_view` or `kalender` for the grid, `firebase_messaging` for push on both platforms. See `docs/adr/0002-flutter-for-mobile-clients.md`.
- **Android sync adapter**: native Kotlin module in the Flutter app's `android/` project, no Dart in the sync path. `dav4jvm` + `iCal4j`, talks CalDAV directly. Pigeon for the Dart ↔ Kotlin bridge.
- **Push**: Firebase Admin SDK (FCM, which relays to APNs on iOS); data-only change pings, no event content. CalDAV has **no native push** — the API layer polls and fans out.
- **Auth**: self-hosted Zitadel, OIDC + PKCE, JWT access tokens (D-03, amended by `docs/adr/0004`). Stock apps use per-device app passwords (D-04, Phase 4). The login password never feeds a key derivation (D-17, INV-12).
- **Hosting**: one 4 GB Hetzner VPS in the EU, staging created on demand, Caddy for TLS (D-10, amended by `docs/adr/0004`). Public 443 required. Domain `flexcalendar.de`; CAA allows only Let's Encrypt and no wildcards, so every deployed Caddyfile pins `acme_ca` to Let's Encrypt's production directory. Containers run under **rootless Podman** on the server and on dev machines (`podman compose`, no Docker daemon); the local stack serves HTTPS on 8443. Tier 1 escrow (Phase 7) uses an HSM-backed AWS KMS key in `eu-central-1`. Every container has a memory limit; no Kubernetes, no Hetzner server backups. Budget about €22–25/month until M1 (`02` § Sizing and cost).
- **Backups**: all durable state, Zitadel included, lives in one Postgres cluster. pgBackRest archives continuously to **two pay-per-GB object stores at two providers, neither of them Hetzner**, with Object Lock and credentials that can't delete. Restores are verified weekly into a throwaway instance, never into staging (`02` § Backups and recovery, E08-R04).

The web client stays React — Flutter Web was rejected (canvas rendering, accessibility, FullCalendar maturity).

## Data model — stick to iCalendar native fields

Round-tripping with stock apps must be lossless, so the canonical model is iCalendar:

| Concept    | Field                          | Notes                                           |
|------------|--------------------------------|-------------------------------------------------|
| Event      | `VEVENT`                       | One object per event / recurrence master.       |
| Title      | `SUMMARY`                      |                                                 |
| Start/end  | `DTSTART` / `DTEND`            | Always with `TZID`, or `Z` for UTC.             |
| Recurrence | `RRULE` / `RDATE` / `EXDATE`   | RFC 5545.                                       |
| Attendees  | `ATTENDEE`                     | Drives iTIP/iMIP invites.                       |
| Location   | `LOCATION`                     |                                                 |
| Alarms     | `VALARM`                       | All three stock apps honor these.               |
| Identity   | `UID`                          | Globally unique. Preserve across edits.         |
| Versioning | ETag + `SEQUENCE`              | ETag for sync, `SEQUENCE` for iTIP.             |

Custom fields go in `X-` properties. Stock apps preserve them on round-trip but won't display them — do not use them for anything user-facing on stock apps.

## Sync model

- Initial load: CalDAV `REPORT` with `calendar-query` for a date window.
- Incremental: WebDAV-Sync (`sync-collection` REPORT) with a sync-token (RFC 6578). Cheap; supported by every major CalDAV server.
- Push to the project's own clients: the API layer polls CalDAV (every ~30s) and pushes deltas over WebSocket / APNs / FCM. Stock apps use their own polling cadence — out of our control.

## Sharing model

Two options; the docs recommend the second for any serious product:

1. Shared account, multiple humans log in. Simple, no per-user identity on events.
2. Per-user accounts + shared calendar collection via WebDAV ACL or Apple-style sharing invites. Apple Calendar's "Add Person…" UI requires the **Apple calendar-sharing extensions** — SabreDAV and Baïkal implement these; Radicale's support is partial.

Treat the API layer's sharing model as the source of truth and have CalDAV ACLs reflect it.

## Native-app integration cheat sheet

| Stock app         | CalDAV?                  | Onboarding step                                                  |
|-------------------|--------------------------|------------------------------------------------------------------|
| Apple Calendar    | Yes, natively            | `.mobileconfig` profile (signed) or manual add in Settings.      |
| Samsung Calendar  | Via Android sync adapter | DAVx⁵, or our own sync adapter shipped in the Android app.       |
| Google Calendar   | Via Android sync adapter | DAVx⁵, or our own sync adapter shipped in the Android app.       |

Google Calendar is **not** a general-purpose CalDAV client; pointing it at our server directly will not work. Web Google Calendar can subscribe to read-only `.ics` feeds — useful as a viewing-only fallback.

The Android sync adapter (writing into `CalendarContract` via `AbstractThreadedSyncAdapter`) is the **single largest piece of work in the plan**. Recommendation in the docs: tell users to install DAVx⁵ for Shared calendars until the Phase 6 adapter ships; build it only when onboarding friction starts to hurt.

## Implementation phases (current plan)

Ordered by `docs/adr/0003-android-first-private-first-delivery.md`: **the first release (M1) is the Flutter app on Android with Private (E2EE) calendars only**, backed by the full CalDAV + API server. Stock apps come right after. `docs/04-implementation-phases.md` has the detail and a mapping from the old phase numbers, which ADRs 0001–0002 still use.

0. **Spike (1–3 days, in parallel)** — Radicale on a VPS with real TLS; round-trip an event through Apple Calendar, Samsung/Google Calendar via DAVx⁵. Do not skip. It doesn't block Phases 1–3, but M0 must be reached before Phase 4.
1. **Server core (1.5–2 weeks)** — SabreDAV + Postgres, Zitadel, API core with `ical.js`, mode-aware write guard, change outbox, backups from day one. `mode` accepts only `private` until Phase 4. Nothing stock-app facing.
2. **Crypto core (~2 weeks, parallel with 1)** — wire spec, Dart library, frozen test vectors. No KEK from the login password (D-17).
3. **Android app with Private calendars (6–7 weeks) → M1 family v1** — Flutter (Android only), Drift cache, Private write/read paths, recovery code, device linking, invites by link/QR with key verification, periodic sync (no push yet), Play internal track.
4. **Shared mode, stock apps, push (3–4 weeks) → M2** — mode choice and switching, device app passwords, Apple sharing extensions, SMTP/iMIP, `.mobileconfig`, `.ics` feeds, FCM data-only pings.
5. **Web client and iOS app (4–5 weeks) → M3** — React/Vite/FullCalendar including Private mode (TS crypto), iOS build with `.mobileconfig` onboarding.
6. **Android sync adapter (2–3 weeks) → M4** — native Kotlin CalendarContract adapter, Shared calendars only.
7. **Recovery for everyone (~3 weeks) → M5** — Tier 1 HSM escrow, trusted contacts, Tier 2 opt-in, external crypto review. **Gates open signup.**
8. **Polish & scale (ongoing)** — recurrence-editing UX, DST regression tests, conflict resolution, observability, optional device-store mirroring of Private calendars.

Explicitly deferred: `VFREEBUSY`, `VTODO`, rich change notifications ("Alice moved dinner"), native macOS/Windows.

## Risks to keep in mind whenever writing code

1. **Recurrence rules** (`RRULE`) are deceptively hard. Always use a vetted library (`ical.js` / `iCal4j` / `python-icalendar` + `dateutil.rrule`). Add round-trip tests against the three stock apps for any change in recurrence handling.
2. **Timezones**: always store `DTSTART` with an explicit `TZID` (IANA names) or `Z` for UTC. Test the day of every DST switch. All-day vs. midnight-to-midnight events are different things — don't conflate them.
3. **No CalDAV push** — the API layer is the push fan-out, not the CalDAV server.
4. **Sharing UX differs per platform** — Apple Calendar expects Apple extensions, DAVx⁵ surfaces shared calendars differently. Expect per-client polish.
5. **`.mobileconfig` should be signed** — unsigned works but shows scary warnings. An Apple Developer cert is needed for the iOS build anyway.
6. **TLS strictness** — iOS won't talk to a server with a bad cert. Caddy + Let's Encrypt is the path of least resistance.
7. **iTIP/iMIP email invites** require working outbound SMTP (SES/Postmark) with SPF/DKIM. SabreDAV supports this; the server must be configured for it.
8. **Backups** — events lost = product dead. Bake this in from Phase 1.

## Open questions still unanswered in the docs

These affect architecture; check the docs / ask before building anything that assumes a particular answer:

- ~~Self-hosted vs. multi-tenant SaaS?~~ **Answered (D-13):** we host it; no self-hosting.
- Free or paid?
- Target user: individuals, families, small teams, or enterprises? **Partly answered** — families with mixed calendar apps (one on Apple Calendar, one on our Android app, one on Google Calendar) are a named driving use case; quotas and team features are still open.
- Are tasks (`VTODO`) in scope, or only events?
**Answered:** end-to-end encryption is in scope, as a per-calendar mode rather than a global property — see the architectural rule above and `docs/adr/0001`. Account recovery is answered too: escrowed by default (we can recover, with mandatory notification and a cancellable delay), strict E2EE on opt-in. Security questions are rejected as key protection. **Until Phase 7 there is no escrow** (`docs/adr/0003`): every account is strict, recovered by recovery code or device linking. Keys must never derive from the login password, because our IdP sees it (D-17, INV-12).

## Conventions for this repo

- Documentation in `docs/` is numbered (`NN-topic.md`) and the numbering is the intended reading order. When adding a new top-level design doc, continue the sequence.
- The README is intentionally minimal right now; the docs are the spec until code lands.
- License: Apache-2.0 (see `LICENSE`).

## What Claude should usually do

- Before changing architecture or tech choices, re-read the relevant numbered doc — it almost certainly already addresses the question.
- Implementation work is driven by `docs/06-implementation-backlog.md` and `docs/epics/`. Follow its agent working agreement, and pick up only requirements whose `D-*` decisions are Pinned. Never break an `INV-*` invariant.
- Keep the iCalendar model authoritative. Don't invent shadow fields in the API layer that diverge from `VEVENT`.
- When in doubt about whether something belongs in the CalDAV layer or the API layer: stock-app-visible behavior goes in CalDAV; everything else (push, custom sharing UI, app auth) goes in the API layer.
- Treat the Phase 0 spike as a real prerequisite for Phase 4 (stock apps), not a formality.
