// The app's one event-time renderer (E10-R04, INV-04).

import 'package:flutter/material.dart';
import 'package:timezone/timezone.dart' as tz;

import '../domain/time/event_time.dart';
import '../domain/time/zones.dart';

/// Renders one event time in the device's zone.
///
/// [zone] defaults to `tz.local`, which `bootstrap` sets to the device's zone
/// through the native call ([initializeDeviceTimeZone] in `lib/src/timezones.dart`);
/// a test sets it with `tz.setLocalLocation`. The instant is therefore read
/// through a `TZDateTime` in that zone, never through `DateTime`
/// (INV-04): the E15-R02 DST table is what pins the wall clocks this shows
/// (`test/dst_widget_test.dart`).
///
/// An all-day value renders as its date with no time at all — a day is not a
/// midnight-to-midnight instant (INV-04). A value whose `TZID` this build cannot
/// resolve says so rather than showing a wrong zone silently (E10-R04).
class EventTimeText extends StatelessWidget {
  const EventTimeText({required this.time, this.zone, super.key});

  /// The value to render.
  final EventTime time;

  /// The zone to render in; the device's zone by default.
  final tz.Location? zone;

  @override
  Widget build(BuildContext context) =>
      Text(eventTimeLabel(time, zone ?? tz.local));
}

/// The label [EventTimeText] shows for [time] in [zone].
///
/// `2026-03-29 03:30 (GMT+2)`, or `2026-03-29 (all day)` for an all-day value.
String eventTimeLabel(EventTime time, tz.Location zone) {
  if (time is AllDayDate) {
    return '${time.format()} (all day)';
  }
  final zoned = time as ZonedTime;
  final at = tz.TZDateTime.from(zoned.instant, zone);
  final wall = WallClock.of(at);
  final date =
      '${_pad(wall.year, 4)}-${_pad(wall.month, 2)}-${_pad(wall.day, 2)}';
  final clock = '${_pad(wall.hour, 2)}:${_pad(wall.minute, 2)}';
  final unknown = zoned.zoneKnown ? '' : ' (zone unknown)';
  return '$date $clock (${formatOffset(at.timeZoneOffset)})$unknown';
}

String _pad(int value, int width) => value.toString().padLeft(width, '0');
