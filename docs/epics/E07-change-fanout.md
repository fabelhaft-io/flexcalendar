# E07 — Change detection and push fan-out

| | |
|---|---|
| Phase | 2 (web), 3 (mobile push) |
| Status | Blocked on E05 |
| Executor | `agent` |
| Depends on | E03-R10, E05-R08 |
| Spec | `01` § Sync model, `05` risk 5, ADR 0002 § Push |

## Goal

CalDAV has no push, so the API detects changes and pings our clients. Stock apps keep their own polling and are out of scope.

## Requirements

### E07-R01 · Change detector   `agent`
A worker MUST consume the `caldav_changes` outbox (E03-R10). A 30 s `sync-collection` poll is the fallback, covering writes the outbox missed. The worker emits `CalendarChanged{calendarId, syncToken}` events.
- Accept: a write through a device credential (stock-app path) produces an event within 2 s by outbox and within 35 s by fallback; duplicate events are coalesced per calendar per second.

### E07-R02 · Realtime channel for web   `agent`
The API MUST expose an authenticated SSE (or WebSocket) stream that delivers `CalendarChanged` for calendars the user is a member of.
- Accept: membership is checked when the stream opens and on every membership change; the p95 from write to event on a connected web client is ≤ 5 s in the local stack (M2); reconnect sends `Last-Event-ID`.

### E07-R03 · Push device registry   `agent`
Clients MUST be able to register and unregister FCM tokens. Tokens that FCM reports as unregistered are pruned.
- Accept: sign-out removes the token; stale tokens are removed after an `UNREGISTERED` response.

### E07-R04 · Data-only FCM pings   `agent`
The worker MUST send FCM data-only messages `{t:"cal", c:<calendarId>}` to members' devices, excluding the device that made the change when it's known. The iOS APNs relay uses `content-available: 1`.
- Accept: the payload schema test (INV-06) rejects any other field; no `notification` block is ever sent; rate-limited to one ping per calendar per device per 10 s.
- Notes: iOS throttles background pushes, so clients must also delta-sync on foreground (E10-R07).

### E07-R05 · Poller scaling guard   `agent`
The fallback poller MUST scale with active calendars (calendars with a member seen in the last 30 days), not all calendars, and expose its lag as a metric.
- Accept: a load test with 10 k active calendars keeps poll lag < 60 s on the reference VPS size.
