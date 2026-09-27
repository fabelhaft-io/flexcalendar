# Architecture

## High-Level Diagram

```
                  ┌──────────────────────────────────────────────┐
                  │            Stock Calendar Apps               │
                  │  Apple Calendar │ Samsung Calendar │ Google  │
                  │     (CalDAV)    │  (CalDAV via     │  Cal.   │
                  │                 │   sys. account)  │ (via    │
                  │                 │                  │  DAVx⁵) │
                  └────────┬────────┴────────┬─────────┴────┬────┘
                           │ CalDAV/HTTPS    │              │
                           ▼                 ▼              ▼
                  ┌──────────────────────────────────────────────┐
                  │            CalDAV Server                     │
                  │   (Radicale / Baïkal / Xandikos / SabreDAV)  │
                  │   - Calendar collections                     │
                  │   - WebDAV ACLs for sharing                  │
                  │   - Storage of VEVENT/VTODO as iCalendar     │
                  └────────┬─────────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              │ (same store, fronted)    │
              ▼                          ▼
  ┌─────────────────────┐     ┌────────────────────────┐
  │  Your REST/GraphQL  │     │  Optional: webhooks /  │
  │  API (Node/Go/etc)  │◄────┤  change notifications  │
  │  - Auth, push, biz  │     │  (CalDAV scheduling,   │
  │    logic, sharing   │     │   or DB triggers)      │
  │    UI, invitations  │     └────────────────────────┘
  └──────────┬──────────┘
             │
   ┌─────────┼──────────┐
   ▼         ▼          ▼
 ┌─────┐  ┌─────┐  ┌──────────┐
 │ iOS │  │ And.│  │   Web    │
 │ app │  │ app │  │   app    │
 └─────┘  └─────┘  └──────────┘
   (Your own apps — speak your REST API,
    not CalDAV directly, for better UX)
```

## Layers

### 1. Storage / Source of Truth
A CalDAV server. Events stored as iCalendar objects (`VEVENT`, `VTODO`, `VTIMEZONE`). User accounts and calendar collections are first-class. This layer also handles:
- **Sharing**: WebDAV ACLs or the CalDAV sharing extension (RFC 6638-adjacent, plus Apple's calendar-sharing extensions).
- **Scheduling**: Inviting attendees via iTIP/iMIP (email-based) is built into CalDAV.
- **ETags / sync tokens**: Efficient incremental sync (RFC 6578 WebDAV-Sync).

### 2. Your API Layer (optional but recommended)
A thin HTTP/JSON service in front of the CalDAV server that:
- Provides a friendlier API for your own clients (REST or GraphQL).
- Handles **push notifications** (APNs/FCM) — CalDAV has no native push, so you poll or watch the store and notify clients yourself.
- Handles **auth** for your apps (OAuth/OIDC) and translates to CalDAV credentials internally.
- Owns user/sharing concepts that are easier to express outside CalDAV (e.g., "family calendar with 5 members and role-based permissions").

The native stock apps bypass this layer entirely and talk straight to the CalDAV server, so anything you build here is for your custom clients only.

### 3. Client Apps
- **Web** — React or Svelte SPA hitting your REST API.
- **iOS + Android** — one Flutter app hitting your REST API. On iOS it offers to add the CalDAV account to the system Calendar app via a configuration profile.
- **Android sync adapter** — native Kotlin module inside the Flutter app's Android project. Uses Android's sync adapter framework so events appear in the system CalendarProvider (and therefore in Google/Samsung Calendar) without requiring DAVx⁵. It speaks CalDAV directly rather than going through the REST API, because it runs in the background without a Flutter engine.

## Data Model

Stick close to iCalendar/CalDAV native fields so round-tripping with stock apps is lossless:

| Concept     | iCalendar field           | Notes                                            |
|-------------|---------------------------|--------------------------------------------------|
| Event       | `VEVENT`                  | One object per event (or per recurrence master). |
| Title       | `SUMMARY`                 |                                                  |
| Start/End   | `DTSTART` / `DTEND`       | With `TZID` or `Z` for UTC.                      |
| Recurrence  | `RRULE` / `RDATE` / `EXDATE` | RFC 5545; matches what stock apps emit.       |
| Attendees   | `ATTENDEE`                | Email-addressable; drives iTIP invites.          |
| Location    | `LOCATION`                |                                                  |
| Alarms      | `VALARM`                  | Honored by all three stock apps.                 |
| Identity    | `UID`                     | Globally unique; preserve across edits.          |
| Versioning  | ETag + `SEQUENCE`         | Use ETag for sync, `SEQUENCE` for iTIP.          |

Any "extra" fields your app needs (tags, custom colors per user, etc.) go in `X-` properties — stock apps will preserve them on round-trip but won't display them.

## Sync Model for Your Own Clients

1. Initial load: `REPORT` query to CalDAV (`calendar-query`) for events in a date window.
2. Incremental: WebDAV-Sync (`sync-collection` REPORT) with a sync-token. Cheap, supported by all major CalDAV servers.
3. Push: your API layer watches the server (poll or DB hook) and pushes deltas to your apps over WebSocket / APNs / FCM.

## Sharing Model

Two viable approaches:

- **Shared account** — One CalDAV account; multiple humans log in. Simplest, but no per-user identity on events.
- **Per-user accounts with shared calendar collection** — Each user has their own account; the calendar is shared via WebDAV ACL or Apple-style sharing invites. This is what you want for any serious product. Apple Calendar's built-in "Add Person…" UI for shared calendars uses this.
