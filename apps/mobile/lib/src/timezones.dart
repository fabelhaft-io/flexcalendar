import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_timezone/flutter_timezone.dart';
import 'package:timezone/data/latest_all.dart' as tz_data;
import 'package:timezone/timezone.dart' as tz;

import 'domain/time/zones.dart';

/// Loads the IANA timezone database into the `timezone` package. Call it once,
/// at startup, before the first `TZDateTime`.
///
/// Dart's `DateTime` knows only UTC and device-local time, so every `TZID`
/// calculation goes through `TZDateTime` (INV-04,
/// `docs/02-technology-choices.md` § Mobile clients). This is the only place
/// that calls the package's loader.
///
/// The `latest_all` data file is loaded rather than `latest`: only it carries
/// the tzdata link names, so `Asia/Calcutta` and `US/Eastern` — which the API
/// accepts as `TZID`s (from-E05-R09) — resolve (E10-R04). The package's version
/// is 2026e; the API's is Node's ICU, 2026b, which is why an instant the API
/// already computed is never recomputed here.
void initializeAppTimeZones() {
  tz_data.initializeTimeZones();
}

/// Why the app's local location is what it is.
enum LocalZoneSource {
  /// The device reported an IANA name the bundled database knows.
  device,

  /// It did not: the native call failed, or named a zone the database does not
  /// know. UTC is in force, and the UI shows `DeviceZoneNotice`.
  utcFallback,
}

/// The zone the app renders times in, resolved once at startup.
@immutable
class AppLocalZone {
  const AppLocalZone({
    required this.reportedName,
    required this.source,
    required this.location,
  });

  /// UTC, after a device zone that could not be used. [reportedName] is what the
  /// device said, or `null` when the native call itself failed.
  factory AppLocalZone.utcFallback(String? reportedName) => AppLocalZone(
    reportedName: reportedName,
    source: LocalZoneSource.utcFallback,
    location: tz.UTC,
  );

  /// The name the device reported, exactly as it reported it; `null` when the
  /// native call failed.
  final String? reportedName;

  /// Where the zone came from.
  final LocalZoneSource source;

  /// The location `timezone`'s `local` now is.
  final tz.Location location;

  /// The zone in force, `Etc/UTC` in the fallback.
  String get name => location.name;

  /// Whether the device's zone could not be used.
  bool get isUtcFallback => source == LocalZoneSource.utcFallback;
}

/// The device's zone for the screens, resolved before the first frame by
/// `bootstrap`.
///
/// The default — UTC, no reported name — is what a test that does not override
/// it gets, and what the app uses when the native call failed.
final localZoneProvider = Provider<AppLocalZone>(
  (ref) => AppLocalZone.utcFallback(null),
);

/// The device's IANA zone, through the native call (E10-R04).
Future<String> readDeviceTimeZoneName() async =>
    (await FlutterTimezone.getLocalTimezone()).identifier;

/// Reads the device's zone and makes it the `timezone` package's local
/// location, so `tz.local` and every defaulted `TZDateTime.from` are the
/// device's zone.
///
/// A name the database does not know — an unknown zone, a fixed-offset label
/// such as `GMT+05:30`, or a Windows name — falls back to UTC: one log line,
/// which carries no user data, and the returned state the UI shows (E10-R04).
/// [readDeviceZone] is the seam a test replaces; it defaults to the plugin.
Future<AppLocalZone> initializeDeviceTimeZone({
  Future<String> Function() readDeviceZone = readDeviceTimeZoneName,
}) async {
  if (!tz.timeZoneDatabase.isInitialized) {
    // The one loader, for a caller that did not initialise first; it is
    // idempotent.
    initializeAppTimeZones();
  }
  final String reported;
  try {
    reported = (await readDeviceZone()).trim();
  } catch (error) {
    debugPrint(
      'flexcalendar: the device time zone could not be read '
      '(${error.runtimeType}); using UTC',
    );
    return _useUtc(null);
  }
  if (reported.isEmpty) {
    debugPrint(
      'flexcalendar: the device reported no time zone name; using UTC',
    );
    return _useUtc(null);
  }
  final location = zoneFor(reported);
  if (location == null) {
    debugPrint(
      'flexcalendar: the device time zone "$reported" is not in the IANA '
      'database; using UTC',
    );
    return _useUtc(reported);
  }
  tz.setLocalLocation(location);
  return AppLocalZone(
    reportedName: reported,
    source: LocalZoneSource.device,
    location: location,
  );
}

AppLocalZone _useUtc(String? reportedName) {
  tz.setLocalLocation(tz.UTC);
  return AppLocalZone.utcFallback(reportedName);
}
