# Native Calendar App Integration

This is the part that makes or breaks the project. Each platform behaves differently. Validate all three end-to-end before writing your own apps.

## iPhone (Apple Calendar)

**Native CalDAV support: yes, first-class.**

User flow: Settings → Calendar → Accounts → Add Account → Other → Add CalDAV Account → enter server URL, username, password.

What works out of the box once added:
- Two-way sync (create, edit, delete events).
- Recurring events, alarms, attendees with iTIP invites by email.
- Multiple calendars per account, color-coded.
- Apple's "Add Person…" shared-calendar UI if your server implements Apple's calendar-sharing extensions (SabreDAV and Baïkal do; Radicale's support is partial).

To smooth onboarding, generate and distribute an **Apple Configuration Profile** (`.mobileconfig`) with the server pre-filled. The user taps a link, iOS prompts to install, account is added in two taps. This is the right UX.

Gotchas:
- iOS will not connect to servers with invalid TLS certs without a profile that trusts the CA. Use a real cert.
- iOS uses `.well-known/caldav` discovery — make sure your server responds correctly or set `principal-URL` explicitly.

## Samsung phones (Samsung Calendar)

**Native CalDAV support: yes, via the Android system account framework.**

Samsung Calendar app reads from whichever accounts are registered on the device that expose a calendar sync adapter. Out of the box, that means Google accounts and Samsung accounts. To add a CalDAV account on Samsung, the user installs a CalDAV sync adapter — historically Samsung shipped its own; for current devices the canonical option is **DAVx⁵** (open source, paid on Play Store / free on F-Droid).

Two paths for your product:

1. **Ask users to install DAVx⁵.** Lowest engineering cost. Users go: install DAVx⁵ → add account with your CalDAV URL → events appear in Samsung Calendar automatically. Many corporate calendar deployments do exactly this.
2. **Ship your own Android sync adapter inside your Android app.** Your app declares an `AbstractThreadedSyncAdapter` and a `CalendarContract` authority. Once a user signs in to your app, your app silently registers an account with the system and starts syncing events into `CalendarContract`, where Samsung Calendar picks them up. This is the better UX — no third-party app required — but it's significantly more code and ongoing maintenance (you reimplement what DAVx⁵ already does, including conflict resolution and recurrence expansion).

Recommend path 1 for v1, path 2 if/when you have users complaining.

## Google Pixel (Google Calendar)

**Native CalDAV support: no.**

Google Calendar on Android — same as on Samsung — only displays events from accounts registered with the Android system that expose a calendar sync adapter. So the answer is the same: **DAVx⁵ or your own sync adapter.** Once events land in `CalendarContract`, Google Calendar displays them and supports editing.

Google does run its own CalDAV server (calendar.google.com), but the Google Calendar app is not a general-purpose CalDAV client. Don't expect to point it at your server directly.

Web Google Calendar can subscribe to **read-only iCalendar feeds** by URL, which is useful as a fallback for users who really only want to view.

## Summary Table

| Stock App         | Speaks CalDAV?         | Onboarding step                                                  |
|-------------------|------------------------|------------------------------------------------------------------|
| Apple Calendar    | Yes, natively          | Install a .mobileconfig profile, or manual add in Settings.      |
| Samsung Calendar  | Via Android sync adapter | Install DAVx⁵, or ship your own sync adapter in your app.      |
| Google Calendar   | Via Android sync adapter | Install DAVx⁵, or ship your own sync adapter in your app.      |

## Why Not Just Use Google Calendar's API?

Tempting, but it locks Apple users out unless they also accept a Google account, which defeats the "easily shared" goal. CalDAV is the lowest common denominator that all three honor.

## Validate Early

Before writing a line of your own client code, do this in a day:

1. Spin up Radicale on a public VPS with a real TLS cert.
2. Create a user and a calendar; add a few events via a CalDAV client like Thunderbird.
3. On a real iPhone, add the account in Settings. Edit an event. Confirm it round-trips.
4. On an Android phone (Samsung if available; Pixel otherwise), install DAVx⁵, add the account. Open Google/Samsung Calendar. Confirm the event shows up. Edit it. Confirm round-trip.

If step 4 isn't smooth, no amount of polish on your own apps will save the product. Get this working first.
