# Risks and Open Questions

Things to resolve early. Each is ranked by how much it could derail the plan.

## High risk

### 1. Android sync adapter complexity
Writing your own `SyncAdapter` that bridges your server's events into `CalendarContract` is the single largest piece of work in the plan, and the area with the least good documentation. DAVx⁵ is open source — read it before deciding to ship your own.
**Mitigation:** for v1, just tell users to install DAVx⁵. Build your own adapter only if onboarding friction is hurting growth.

### 2. Recurrence handling
RFC 5545 recurrence rules are deceptively hard. "Every second Tuesday except in months with a fifth Wednesday" is a real `RRULE`. Bugs here cause events to appear on the wrong day in one app and not another, and users will not file a clean bug report.
**Mitigation:** use a well-tested library (`ical.js` on Node, `iCal4j` on JVM, `python-icalendar` + `dateutil.rrule`). Never roll your own. Dart's iCalendar libraries are comparatively immature, so the Flutter app delegates recurrence expansion and recurring-event edits to the API (`ical.js`) rather than owning them. Add automated tests that round-trip events through Apple Calendar, Samsung Calendar, and Google Calendar.

### 3. Timezones
DST transitions, floating times, all-day events vs. midnight-to-midnight events — these are eternal sources of bugs.
**Mitigation:** always store `DTSTART` with an explicit `TZID` (or UTC for all-day). Use IANA zone names. Test the day of every DST switch. In the Flutter app, Dart's `DateTime` only supports UTC and device-local time — all zoned arithmetic must go through the `timezone` package's `TZDateTime`.

### 4. Key loss on Private calendars
A Private calendar is end-to-end encrypted (`adr/0001-calendar-privacy-modes.md`), so losing the key can lose the calendar. This collides head-on with the project's "events lost = product dead" rule, because at strict E2EE no backup we hold can save the user — we cannot decrypt our own backups.
**Mitigation:** two recovery tiers, decided in `adr/0001`. **Tier 1 (default)** escrows a second wrapped copy of the user's key in a cloud HSM, so recovery is always possible; the protection is procedural — user-initiated request, second factor, notification to every device, a cancellable 72-hour delay, and a readable audit log. **Tier 2 (opt-in)** removes the escrow and requires a recovery method to exist first: a 128-bit recovery code, and trusted-contact threshold recovery (2-of-3 Shamir sealed to family members' keys), which suits this product because the family social graph already exists in the sharing model. **Security questions are rejected outright** — entropy must come from the recovery code or from a hardware-enforced attempt limit, and there is no third source.
The residual risk is a Tier 2 user who loses both password and every recovery method. That outcome is accepted, and it is why Tier 1 is the default.

## Medium risk

### 5. Push notifications without native CalDAV push
CalDAV has no standard push protocol (Apple's calendar push is proprietary). Your API layer has to poll the CalDAV server and fan out changes itself, which is doable but adds moving parts.
**Mitigation:** WebDAV-Sync's sync-token makes polling cheap; poll every 30s server-side, push to clients via WebSocket/APNs/FCM. Native stock apps will rely on their own polling cadence (iOS uses Apple Push for some servers but defaults to Fetch — that's out of your control).

### 6. Sharing semantics differ between apps
Apple Calendar's sharing UI expects Apple's proprietary extensions. DAVx⁵ exposes shared calendars differently. Your web/mobile clients will need their own consistent sharing UI on top.
**Mitigation:** treat your API's sharing model as the source of truth for permissions; let CalDAV ACLs reflect it. Expect to do per-client UX polish.

### 7. Mode switching is not retroactive
Switching a calendar from Shared to Private encrypts its events going forward but **does not retroactively protect history** — that plaintext was already on our server and in our backups. Switching the other way exposes every member's contributions to us.
**Mitigation:** state the non-retroactivity at the point of switching rather than in a help page; require explicit owner confirmation; notify every member; log the change. A silent mode change would break the "without you knowing" half of the privacy claim, which is the whole product positioning.

### 8. Hosting / on-call
A calendar server going down means people miss meetings. This is a higher-stakes service than most B2C apps. Budget for monitoring, backups, on-call.

## Low risk but worth flagging

### 9. Apple configuration profile signing
Distributing an unsigned `.mobileconfig` works but shows scary warnings. Signing it requires an Apple Developer cert.
**Mitigation:** sign it. You'll need a Developer account for the iOS build of the Flutter app anyway.

### 10. Stock-app feature drift
Apple/Samsung/Google change their calendar apps over OS releases. A field that round-trips today might not next year. Lock in a regression test suite on real devices, or accept some breakage.

### 11. Email-based invitations (iTIP/iMIP)
If you want "invite alice@example.com to this event" to actually email Alice an .ics attachment she can accept in her own calendar app, your server has to send mail. SabreDAV supports this; you'll need outbound SMTP (SES, Postmark) and SPF/DKIM set up correctly.
**Not available on Private calendars** — the mail path needs a plaintext `ATTENDEE`, which a Private calendar does not expose. Scope this feature to Shared calendars.

## Open questions to answer before Phase 1

1. **Self-hosted vs. multi-tenant SaaS?** Are users running their own server, or are you running a hosted service for everyone? This changes the auth model fundamentally.
2. **Free or paid?** Affects how heavyweight the hosting can be.
3. **Target user — individuals, families, small teams, enterprises?** **Partly answered.** A family sharing weekends and school appointments across three different calendar apps — one member on Apple Calendar, one on our Android app, one on the Google Calendar app — is a named driving use case, and it is what forced the privacy-mode split in `adr/0001`. Quotas, team features and enterprise needs are still open.
4. ~~**End-to-end encryption?**~~ **Answered — see [`adr/0001-calendar-privacy-modes.md`](adr/0001-calendar-privacy-modes.md).** Yes, but as a per-calendar mode rather than a global property, which is what avoids giving up native-app compatibility. Encrypted (Private) calendars are readable only in our apps; calendars that need stock-app editing run unencrypted (Shared). Three sub-questions remain open in that ADR: whether a Private calendar keeps a cleartext skeleton, whether `ATTENDEE` is encrypted, and the account-recovery decision below.
5. **Are tasks (`VTODO`) in scope, or only events?** Affects data model and which stock apps to test against (Apple Reminders, Samsung Reminder, etc.).
6. ~~**Account recovery for Private calendars.**~~ **Answered** — escrowed by default, strict E2EE on opt-in, per `adr/0001`. Remaining sub-question: which Tier 2 recovery methods ship first beyond the recovery code.

Both the E2EE and account-recovery questions are now answered in `adr/0001`. Note that encryption is deliberately **not** in Phase 1 — the initial friends-and-family group accepts plaintext shared history, and most such groups contain an Apple or Google Calendar user anyway. Private mode is Phase 5 and gates **open signup**, not the next phase boundary.
