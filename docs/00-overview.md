# Cross-Platform Shared Calendar — Project Overview

## Goal

Build a calendar service whose events can be:

1. Viewed and edited in **your own apps** on iOS, Android, and the web.
2. Viewed and edited in the **stock calendar apps** on iPhone (Apple Calendar), Samsung (Samsung Calendar), and Google Pixel (Google Calendar).
3. **Shared** between multiple users with real-time or near-real-time sync.

## The Central Constraint

Requirement #2 is the architectural pivot point. To be editable in stock calendar apps without custom plugins (which don't exist for iOS/Samsung anyway), you must use a protocol they already speak. In practice there is exactly one such protocol:

- **CalDAV** (RFC 4791) — supported natively by Apple Calendar (iOS + macOS), Samsung Calendar (via the Android account framework), and most third-party Android calendar apps. Google Calendar does **not** speak CalDAV as a client, but its own CalDAV API can be subscribed to from other clients. Importantly, the Pixel/Google Calendar app on Android *can* sync any account registered with the Android system, and there are well-supported sync adapters (DAVx⁵ being the canonical one) that bridge CalDAV → Android's CalendarContract, which Google Calendar then displays.

Read-only sharing is much easier: every major calendar app supports subscribing to an **iCalendar (.ics) feed over HTTPS** (RFC 5545). But the requirement says *editable*, so CalDAV is the answer.

## What This Means

- The **source of truth** for events should be a CalDAV server (either one you run, or one you build a thin wrapper around). This is non-negotiable if you want native-app editing.
- Your custom mobile and web apps are then *also* CalDAV clients (or thin clients of your own API that fronts CalDAV).
- "Sharing between users" maps to CalDAV's shared/delegated calendar mechanisms or to multiple accounts subscribing to the same calendar collection.

## Plan Documents

1. [`01-architecture.md`](01-architecture.md) — System architecture and data flow.
2. [`02-technology-choices.md`](02-technology-choices.md) — Concrete framework and library picks with rationale.
3. [`03-native-calendar-integration.md`](03-native-calendar-integration.md) — How each stock calendar app connects (the trickiest part).
4. [`04-implementation-phases.md`](04-implementation-phases.md) — Build order, milestones, and what to defer.
5. [`05-risks-and-open-questions.md`](05-risks-and-open-questions.md) — Things to validate early.
