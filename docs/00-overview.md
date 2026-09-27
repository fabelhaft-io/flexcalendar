# Cross-Platform Shared Calendar — Project Overview

## Goal

Build a calendar service whose events can be:

1. Viewed and edited in **your own apps** on iOS, Android, and the web.
2. Viewed and edited in the **stock calendar apps** on iPhone (Apple Calendar), Samsung (Samsung Calendar), and Google Pixel (Google Calendar).
3. **Shared** between multiple users with real-time or near-real-time sync.

## The Central Constraint

Requirement #2 is the architectural pivot point. To be editable in stock calendar apps without custom plugins (which don't exist for iOS/Samsung anyway), you must use a protocol they already speak. Two exist; only one is practical:

- **CalDAV** (RFC 4791) — supported natively by Apple Calendar (iOS + macOS), Samsung Calendar (via the Android account framework), and most third-party Android calendar apps. Google Calendar does **not** speak CalDAV as a client, but its own CalDAV API can be subscribed to from other clients. Importantly, the Pixel/Google Calendar app on Android *can* sync any account registered with the Android system, and there are well-supported sync adapters (DAVx⁵ being the canonical one) that bridge CalDAV → Android's CalendarContract, which Google Calendar then displays.
- **Exchange ActiveSync** — also natively supported by Apple Calendar and Samsung Calendar, two-way, and it has real push. **Rejected**: Microsoft-licensed protocol IP, substantially more complex, and Microsoft is narrowing its client surface (EAS 16.1 required for Exchange Online from March 2026). See [`adr/0001`](adr/0001-calendar-privacy-modes.md).

Read-only sharing is much easier: every major calendar app supports subscribing to an **iCalendar (.ics) feed over HTTPS** (RFC 5545). But the requirement says *editable*, so CalDAV is the answer.

## Privacy modes qualify requirement #2

Requirement #2 does **not** apply to every calendar. [`adr/0001-calendar-privacy-modes.md`](adr/0001-calendar-privacy-modes.md) establishes three per-calendar modes, chosen explicitly when the calendar is created and switchable afterwards:

| Mode | Encryption | Clients | Editing |
|---|---|---|---|
| **Private** | End-to-end; the server cannot read event content | Our apps only | Yes, in our apps |
| **Shared** | None; the server reads everything | Any CalDAV client, including stock apps | Yes, everywhere |
| **Published** | None (or busy-only from a Private calendar) | Anything that subscribes to `.ics` | No, read-only |

The reason: a participant who installs nothing can never hold a key, so they can never read encrypted content — serving readable iCalendar to a keyless CalDAV client would require the server to hold plaintext. The privacy need and the interop need therefore peak on *different* calendars. A personal health calendar wants encryption and has no interop problem (it's only you, and you have the app). A family calendar shared across Apple Calendar, our Android app and the Google Calendar app wants interop and is only mildly sensitive.

## What This Means

- The **source of truth** for events is a CalDAV server (either one you run, or one you build a thin wrapper around). For **Shared** and **Published** calendars this is non-negotiable — it is what makes stock-app editing possible at all.
- **Private** calendars live in the same CalDAV store, but for practical reasons rather than protocol ones: one storage engine, one sync mechanism (WebDAV-Sync `sync-token`), one data model, and mode switching as a metadata change rather than a migration. No third party ever reads them. Event *content* is encrypted client-side into a sidecar store; only the skeleton (`UID`, `DTSTART`/`DTEND`, `RRULE`, `SEQUENCE`, `VALARM`) stays cleartext.
- Your custom mobile and web apps are then *also* CalDAV clients (or thin clients of your own API that fronts CalDAV). For Private calendars they are the *only* clients, and they hold the keys.
- "Sharing between users" maps to CalDAV's shared/delegated calendar mechanisms or to multiple accounts subscribing to the same calendar collection. For Private calendars, sharing also means sealing the calendar key to each new member.

## Plan Documents

1. [`01-architecture.md`](01-architecture.md) — System architecture and data flow.
2. [`02-technology-choices.md`](02-technology-choices.md) — Concrete framework and library picks with rationale.
3. [`03-native-calendar-integration.md`](03-native-calendar-integration.md) — How each stock calendar app connects (the trickiest part).
4. [`04-implementation-phases.md`](04-implementation-phases.md) — Build order, milestones, and what to defer.
5. [`05-risks-and-open-questions.md`](05-risks-and-open-questions.md) — Things to validate early.

## Decision Records

Architecture decisions and their rejected alternatives live in [`adr/`](adr/), numbered separately from the docs above.

- [`adr/0001-calendar-privacy-modes.md`](adr/0001-calendar-privacy-modes.md) — Private (E2EE, our apps), Shared (unencrypted, stock apps), Published (read-only feed). *Accepted.*
- [`adr/0002-flutter-for-mobile-clients.md`](adr/0002-flutter-for-mobile-clients.md) — One Flutter codebase for iOS and Android; the Android sync adapter stays native Kotlin. *Accepted.*
