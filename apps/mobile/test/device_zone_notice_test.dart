// The device-zone state the UI shows (E10-R04).
//
// `initializeDeviceTimeZone` falls back to UTC when the native call fails or
// names a zone the bundled database does not know. That fallback must be
// visible, so the app has a widget for it and the home screen carries it.

import 'package:calendar_flex/api/models/health.dart';
import 'package:calendar_flex/api/models/health_service.dart';
import 'package:calendar_flex/api/models/health_status.dart';
import 'package:calendar_flex/src/api/api_providers.dart';
import 'package:calendar_flex/src/app.dart';
import 'package:calendar_flex/src/auth/auth_providers.dart';
import 'package:calendar_flex/src/flavor.dart';
import 'package:calendar_flex/src/timezones.dart';
import 'package:calendar_flex/src/ui/device_zone_notice.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:timezone/timezone.dart' as tz;

import 'support/auth_test_support.dart';

void main() {
  setUpAll(initializeAppTimeZones);
  tearDown(() => tz.setLocalLocation(tz.UTC));

  Future<void> pumpNotice(WidgetTester tester, AppLocalZone zone) =>
      tester.pumpWidget(
        ProviderScope(
          overrides: [localZoneProvider.overrideWithValue(zone)],
          child: const MaterialApp(home: DeviceZoneNotice()),
        ),
      );

  testWidgets('a device zone that resolved shows nothing', (tester) async {
    await pumpNotice(
      tester,
      AppLocalZone(
        reportedName: 'Europe/Berlin',
        source: LocalZoneSource.device,
        location: tz.getLocation('Europe/Berlin'),
      ),
    );

    expect(find.byKey(const Key('time-zone-fallback')), findsNothing);
  });

  testWidgets('an unknown device zone is named, and UTC is said', (
    tester,
  ) async {
    await pumpNotice(
      tester,
      AppLocalZone.utcFallback('W. Europe Standard Time'),
    );

    expect(
      find.text(
        'Unknown device time zone "W. Europe Standard Time"; times are shown '
        'in UTC',
      ),
      findsOneWidget,
    );
  });

  testWidgets('a native call that failed says so, without naming a zone', (
    tester,
  ) async {
    await pumpNotice(tester, AppLocalZone.utcFallback(null));

    expect(
      find.text('Device time zone unavailable; times are shown in UTC'),
      findsOneWidget,
    );
  });

  testWidgets('the home screen carries the notice', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          flavorProvider.overrideWithValue(Flavor.staging),
          localZoneProvider.overrideWithValue(
            AppLocalZone.utcFallback('GMT+05:30'),
          ),
          tokenStoreProvider.overrideWithValue(FakeTokenStore()),
          healthProvider.overrideWith(
            (ref) async => const Health(
              status: HealthStatus.ok,
              service: HealthService.api,
            ),
          ),
        ],
        child: const FlexCalendarApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('time-zone-fallback')), findsOneWidget);
    expect(
      find.text('Unknown device time zone "GMT+05:30"; times are shown in UTC'),
      findsOneWidget,
    );
  });
}
