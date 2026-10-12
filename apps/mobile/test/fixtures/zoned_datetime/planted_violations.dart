// A planted bad file (E10-R04). Nothing imports it and nothing runs it: it
// exists so `test/domain_time_guard_test.dart` can prove that INV-04's guard
// reports every construct it guards, and that its allow-list suppresses one.
// Every use in here is what the domain layer must not contain, so do not "fix"
// it and do not copy it into `lib/`.

/// The planted device-local `DateTime` use.
int plantedDeviceLocalUse(int milliseconds, DateTime parameter) {
  final DateTime midnight = DateTime(2026, 3, 29, 2, 30);
  final DateTime later = midnight.add(const Duration(hours: 2));
  final DateTime parsed = DateTime.parse('2026-03-29T02:30:00');
  final DateTime shifted = parsed.subtract(const Duration(minutes: 30));
  final DateTime fromMilliseconds = DateTime.fromMillisecondsSinceEpoch(
    milliseconds,
  );
  final DateTime now = DateTime.now();
  final DateTime local = now.toLocal();
  final Duration between = later.difference(shifted);
  return between.inMinutes +
      local.second +
      fromMilliseconds.year +
      parameter.day +
      midnight.day;
}
