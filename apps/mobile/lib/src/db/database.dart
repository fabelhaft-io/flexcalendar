import 'package:drift/drift.dart';
import 'package:drift_flutter/drift_flutter.dart';
import 'package:uuid/uuid.dart';

part 'database.g.dart';

/// A calendar whose metadata the app has cached locally.
///
/// The offline cache stores no event content of its own: the raw iCalendar
/// object is the canonical record (`docs/02-technology-choices.md` § Mobile
/// clients), and INV-01 keeps event fields out of app-only tables.
class CachedCalendars extends Table {
  /// The calendar's id, a random UUIDv4 the server assigned (INV-03).
  TextColumn get id => text()();

  /// The name to show. For a Private calendar this is the decrypted name; the
  /// server only ever sees `Private calendar` (D-18).
  TextColumn get displayName => text()();

  /// When this row was last refreshed from the API.
  DateTimeColumn get syncedAt => dateTime()();

  @override
  Set<Column<Object>> get primaryKey => {id};
}

@DriftDatabase(tables: [CachedCalendars])
class AppDatabase extends _$AppDatabase {
  /// A database over an existing executor — an in-memory one in tests.
  AppDatabase(super.executor);

  /// The app's database, in the platform's application-support directory.
  AppDatabase.open() : super(driftDatabase(name: 'flexcalendar'));

  @override
  int get schemaVersion => 1;
}

/// A fresh random UUIDv4 for a row this device creates (INV-03). The `uuid`
/// package is only ever called as `Uuid().v4()`.
String newCachedCalendarId() => const Uuid().v4();
