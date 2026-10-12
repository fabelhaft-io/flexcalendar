// The device time zone's state, shown when it could not be used (E10-R04).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../timezones.dart';

/// Says so when the device's zone is not the zone the app shows times in.
///
/// `initializeDeviceTimeZone` falls back to UTC when the native call fails or
/// names a zone the bundled database does not know (E10-R04); a screen that
/// shows times includes this widget so that fallback is visible, never silent.
class DeviceZoneNotice extends ConsumerWidget {
  const DeviceZoneNotice({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final zone = ref.watch(localZoneProvider);
    if (!zone.isUtcFallback) {
      return const SizedBox.shrink();
    }
    final reported = zone.reportedName;
    return Text(
      reported == null
          ? 'Device time zone unavailable; times are shown in UTC'
          : 'Unknown device time zone "$reported"; times are shown in UTC',
      key: const Key('time-zone-fallback'),
    );
  }
}
