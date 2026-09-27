# ADR 0002 — Flutter for the mobile clients

- **Status**: Accepted
- **Date**: 2026-09-27
- **Relates to**: [`02-technology-choices.md`](../02-technology-choices.md) (mobile stack), [`04-implementation-phases.md`](../04-implementation-phases.md) (Phases 3–5), [`03-native-calendar-integration.md`](../03-native-calendar-integration.md) (Android sync adapter), [`0001-calendar-privacy-modes.md`](0001-calendar-privacy-modes.md)

## Context

The original plan was two native apps, Swift/SwiftUI and Kotlin/Compose, with Flutter as a fallback. The apps' job is narrow: authenticate, talk to the REST API, keep an offline cache, render a calendar grid, receive push. That is nearly identical on both platforms.

The platform-specific work is small and well-bounded: on iOS, the `.mobileconfig` hand-off to Safari and APNs setup; on Android, the `CalendarContract` sync adapter, which runs in the background under the system's control.

## Decision

Build the iOS and Android apps as **one Flutter codebase**. Keep the **Android sync adapter in native Kotlin**, with no Dart in its sync path, inside the Flutter project's `android/` module. The **web client stays React + FullCalendar**.

To reduce the risk from Dart's thinner iCalendar ecosystem, the app does not own recurrence semantics. The API expands occurrences and applies recurring-event edits with `ical.js`; the app sends edit intents.

## Consequences

- One UI codebase, one offline cache, one API client for both phones. The old Phases 3 and 4 (3–4 weeks each) become one mobile phase (4–5 weeks) plus a separate sync-adapter phase (2–3 weeks).
- **Two iCalendar stacks remain**: `ical.js` on the server, `iCal4j` in the Kotlin sync adapter. That was already true under the native plan.
- Dart `DateTime` has no zone support, so all `TZID` handling goes through the `timezone` package. A new source of bugs to test for.
- Push is unified on FCM (`firebase_messaging`), which relays to APNs. Payloads must be data-only change pings — mandatory for Private calendars, which cannot carry content in a push at all.
- **Dart owns the key hierarchy, and that is an advantage.** Argon2id derivation, the double-wrapped private key, the recovery code and the Shamir split for trusted contacts live in Dart only. Native would mean implementing all of it twice in security-critical code: two audit surfaces, every bug duplicated. The Kotlin side needs only *unwrap content key, open envelope*, and only if Phase 6 Android mirroring ships — a bounded subset that must stay wire-compatible with the Dart implementation.
- Verify during Phase 5 that `sodium_libs` covers XChaCha20-Poly1305, `crypto_box_seal` and Argon2id rather than assuming it.
- Calendar-grid polish is limited by Flutter packages (`calendar_view`, `kalender`) or a custom grid. There is no FullCalendar equivalent.
- **Still needs native code**: home-screen widgets (WidgetKit, Glance), and passkey-based recovery — the WebAuthn `prf` extension has no mature Flutter package and lives in AuthenticationServices on iOS and Credential Manager on Android. Support is recent on both; verify before committing to that recovery method. It is a Pigeon channel around one platform API, not a sync engine.

## Revisit trigger

Re-open this decision if the `EKSource` spike in Phase 6 passes **and** iOS mirroring of Private calendars is committed to. At that point the app would contain a native Kotlin sync engine, a native Swift EventKit sync engine and Pigeon bridges to both, so the hardest code would be native anyway and "one codebase" becomes a thin claim.

Until then the trade is clear: going native now would pay a double-codebase cost through Phases 3–5 for a Phase 6 item that is optional and may prove impossible on iOS.

## Alternatives considered

- **Native Swift + Kotlin.** Best platform fidelity. **Rejected**: duplicates mostly identical logic, including the key hierarchy.
- **React Native.** Could share TypeScript and `ical.js` with the backend and web client. **Rejected** in favour of Flutter's consistent rendering for a custom, gesture-heavy grid.
- **Kotlin Multiplatform.** Could share one CalDAV/iCalendar core between the app and the sync adapter. **Rejected for now**: Compose Multiplatform on iOS is less mature than Flutter. Revisit if the sync adapter becomes the dominant codebase.
- **Flutter for web as well.** **Rejected**: canvas rendering hurts accessibility and load time, and FullCalendar is more mature than any Flutter grid.
