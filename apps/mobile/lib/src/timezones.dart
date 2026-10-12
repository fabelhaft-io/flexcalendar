import 'package:timezone/data/latest.dart' as tz;

/// Loads the IANA timezone database into the `timezone` package. Call it once,
/// at startup, before the first `TZDateTime` (review-only edit).
///
/// Dart's `DateTime` knows only UTC and device-local time, so every `TZID`
/// calculation goes through `TZDateTime` (INV-04,
/// `docs/02-technology-choices.md` § Mobile clients). This is the only place
/// that calls the package's loader.
void initializeAppTimeZones() {
  tz.initializeTimeZones();
}
