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

## Phase 1 — Server foundation (1–2 weeks)

Goal: production-ready server stack with auth and multi-user.

- [ ] Replace Radicale with SabreDAV (embedded in a small PHP service) or stick with Radicale if its sharing/auth model is sufficient.
- [ ] Postgres for users, accounts, sharing relationships.
- [ ] User signup/login (your API layer; Auth0/Clerk or self-hosted).
- [ ] Sharing model: a user can create a calendar, invite another user by email, share read-only or read-write.
- [ ] iCalendar feed URLs for read-only subscribers (Google Calendar web users).
- [ ] Apple-style sharing extensions enabled so iOS's native sharing UI works.

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

## Phase 3 — iOS app (3–4 weeks)

Goal: native iOS app with offline support and push.

- [ ] SwiftUI app, iOS 16+.
- [ ] Talk to your REST API (not CalDAV directly) for faster UX.
- [ ] Offline cache with SwiftData / Core Data.
- [ ] APNs push notifications for event invites, changes, reminders.
- [ ] Login → automatically install the `.mobileconfig` so the system Calendar app is also wired up.
- [ ] App Store submission.

## Phase 4 — Android app (3–4 weeks)

Goal: native Android app, with the sync adapter so users don't need DAVx⁵.

- [ ] Jetpack Compose app, minSdk 26.
- [ ] Talks to your REST API like iOS.
- [ ] Implement a CalendarContract sync adapter: declares an authority, an authenticator, syncs events from your server into the system CalendarProvider so Samsung/Google Calendar pick them up.
- [ ] Room cache for offline.
- [ ] FCM push.
- [ ] Play Store submission.

The sync adapter is the longest single piece of work in this whole plan. Budget for it.

## Phase 5 — Polish and scale (ongoing)

- [ ] Better recurrence editing UX (this single feature is where most calendar apps fail).
- [ ] Timezone correctness audit — set up automated tests around DST transitions.
- [ ] Server-side performance: move CalDAV storage from filesystem to Postgres if you haven't.
- [ ] Conflict resolution UX for the sync adapter (what happens when the same event is edited offline on two devices).
- [ ] Observability: structured logs, metrics, error reporting (Sentry).
- [ ] Backups of the calendar store. Events lost = product dead.

## What to Defer Aggressively

- Free/busy lookup across users (`VFREEBUSY`) — nice but not v1.
- Tasks (`VTODO`) — different UI, different user mental model, ship as a follow-up.
- Server-side rich notifications ("Alice changed the location of dinner") — start with simple change pings.
- Native macOS / Windows apps — the web app covers desktop.
