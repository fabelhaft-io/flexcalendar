import 'package:calendar_flex/src/db/database.dart';
import 'package:drift/native.dart';
import 'package:test/test.dart';

void main() {
  test('opens an in-memory database, writes a row and reads it back', () async {
    final database = AppDatabase(NativeDatabase.memory());
    addTearDown(database.close);

    final id = newCachedCalendarId();
    await database
        .into(database.cachedCalendars)
        .insert(
          CachedCalendarsCompanion.insert(
            id: id,
            displayName: 'Private calendar',
            syncedAt: DateTime.utc(2026, 10, 12, 9, 30),
          ),
        );

    final rows = await database.select(database.cachedCalendars).get();
    expect(rows, hasLength(1));
    expect(rows.single.id, id);
    expect(rows.single.displayName, 'Private calendar');
    // Drift keeps a `DateTime` as a Unix timestamp and hands it back in the
    // current zone, so the instant is what round-trips, not the zone.
    expect(rows.single.syncedAt.toUtc(), DateTime.utc(2026, 10, 12, 9, 30));
  });

  test('ids the app generates are random version-4 UUIDs (INV-03)', () {
    final ids = List.generate(64, (_) => newCachedCalendarId());

    // Random, not derived from anything: 64 draws collide with probability
    // ~2^-119.
    expect(ids.toSet(), hasLength(64));
    final version4 = RegExp(
      r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    );
    for (final id in ids) {
      expect(id, matches(version4), reason: 'not a UUIDv4: $id');
    }
  });
}
