# Risks and Open Questions

Things to resolve early. Each is ranked by how much it could derail the plan.

## High risk

### 1. Android sync adapter complexity
Writing your own `SyncAdapter` that bridges your server's events into `CalendarContract` is the single largest piece of work in the plan, and the area with the least good documentation. DAVx⁵ is open source — read it before deciding to ship your own.
**Mitigation:** for v1, just tell users to install DAVx⁵. Build your own adapter only if onboarding friction is hurting growth.

### 2. Recurrence handling
RFC 5545 recurrence rules are deceptively hard. "Every second Tuesday except in months with a fifth Wednesday" is a real `RRULE`. Bugs here cause events to appear on the wrong day in one app and not another, and users will not file a clean bug report.
**Mitigation:** use a well-tested library (`ical.js` on Node, `iCal4j` on JVM, `python-icalendar` + `dateutil.rrule`). Never roll your own. Add automated tests that round-trip events through Apple Calendar, Samsung Calendar, and Google Calendar.

### 3. Timezones
DST transitions, floating times, all-day events vs. midnight-to-midnight events — these are eternal sources of bugs.
**Mitigation:** always store `DTSTART` with an explicit `TZID` (or UTC for all-day). Use IANA zone names. Test the day of every DST switch.

## Medium risk

### 4. Push notifications without native CalDAV push
CalDAV has no standard push protocol (Apple's calendar push is proprietary). Your API layer has to poll the CalDAV server and fan out changes itself, which is doable but adds moving parts.
**Mitigation:** WebDAV-Sync's sync-token makes polling cheap; poll every 30s server-side, push to clients via WebSocket/APNs/FCM. Native stock apps will rely on their own polling cadence (iOS uses Apple Push for some servers but defaults to Fetch — that's out of your control).

### 5. Sharing semantics differ between apps
Apple Calendar's sharing UI expects Apple's proprietary extensions. DAVx⁵ exposes shared calendars differently. Your web/mobile clients will need their own consistent sharing UI on top.
**Mitigation:** treat your API's sharing model as the source of truth for permissions; let CalDAV ACLs reflect it. Expect to do per-client UX polish.

### 6. Hosting / on-call
A calendar server going down means people miss meetings. This is a higher-stakes service than most B2C apps. Budget for monitoring, backups, on-call.

## Low risk but worth flagging

### 7. Apple configuration profile signing
Distributing an unsigned `.mobileconfig` works but shows scary warnings. Signing it requires an Apple Developer cert.
**Mitigation:** sign it. You'll need a Developer account for the iOS app anyway.

### 8. Stock-app feature drift
Apple/Samsung/Google change their calendar apps over OS releases. A field that round-trips today might not next year. Lock in a regression test suite on real devices, or accept some breakage.

### 9. Email-based invitations (iTIP/iMIP)
If you want "invite alice@example.com to this event" to actually email Alice an .ics attachment she can accept in her own calendar app, your server has to send mail. SabreDAV supports this; you'll need outbound SMTP (SES, Postmark) and SPF/DKIM set up correctly.

## Open questions to answer before Phase 1

1. **Self-hosted vs. multi-tenant SaaS?** Are users running their own server, or are you running a hosted service for everyone? This changes the auth model fundamentally.
2. **Free or paid?** Affects how heavyweight the hosting can be.
3. **Target user — individuals, families, small teams, enterprises?** Sharing model and quotas depend on this.
4. **End-to-end encryption?** Hard with CalDAV (stock apps need to read plaintext). If E2EE matters, this whole plan changes and you'd give up native-app compatibility.
5. **Are tasks (`VTODO`) in scope, or only events?** Affects data model and which stock apps to test against (Apple Reminders, Samsung Reminder, etc.).

The E2EE question in particular is worth answering before writing code, because a "yes" forces a completely different architecture (custom apps only, no stock-calendar integration).
