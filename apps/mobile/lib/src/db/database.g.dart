// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'database.dart';

// ignore_for_file: type=lint
class $CachedCalendarsTable extends CachedCalendars
    with TableInfo<$CachedCalendarsTable, CachedCalendar> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $CachedCalendarsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _displayNameMeta = const VerificationMeta(
    'displayName',
  );
  @override
  late final GeneratedColumn<String> displayName = GeneratedColumn<String>(
    'display_name',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _syncedAtMeta = const VerificationMeta(
    'syncedAt',
  );
  @override
  late final GeneratedColumn<DateTime> syncedAt = GeneratedColumn<DateTime>(
    'synced_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [id, displayName, syncedAt];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'cached_calendars';
  @override
  VerificationContext validateIntegrity(
    Insertable<CachedCalendar> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('display_name')) {
      context.handle(
        _displayNameMeta,
        displayName.isAcceptableOrUnknown(
          data['display_name']!,
          _displayNameMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_displayNameMeta);
    }
    if (data.containsKey('synced_at')) {
      context.handle(
        _syncedAtMeta,
        syncedAt.isAcceptableOrUnknown(data['synced_at']!, _syncedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_syncedAtMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  CachedCalendar map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return CachedCalendar(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      displayName: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}display_name'],
      )!,
      syncedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}synced_at'],
      )!,
    );
  }

  @override
  $CachedCalendarsTable createAlias(String alias) {
    return $CachedCalendarsTable(attachedDatabase, alias);
  }
}

class CachedCalendar extends DataClass implements Insertable<CachedCalendar> {
  /// The calendar's id, a random UUIDv4 the server assigned (INV-03).
  final String id;

  /// The name to show. For a Private calendar this is the decrypted name; the
  /// server only ever sees `Private calendar` (D-18).
  final String displayName;

  /// When this row was last refreshed from the API.
  final DateTime syncedAt;
  const CachedCalendar({
    required this.id,
    required this.displayName,
    required this.syncedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['display_name'] = Variable<String>(displayName);
    map['synced_at'] = Variable<DateTime>(syncedAt);
    return map;
  }

  CachedCalendarsCompanion toCompanion(bool nullToAbsent) {
    return CachedCalendarsCompanion(
      id: Value(id),
      displayName: Value(displayName),
      syncedAt: Value(syncedAt),
    );
  }

  factory CachedCalendar.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return CachedCalendar(
      id: serializer.fromJson<String>(json['id']),
      displayName: serializer.fromJson<String>(json['displayName']),
      syncedAt: serializer.fromJson<DateTime>(json['syncedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'displayName': serializer.toJson<String>(displayName),
      'syncedAt': serializer.toJson<DateTime>(syncedAt),
    };
  }

  CachedCalendar copyWith({
    String? id,
    String? displayName,
    DateTime? syncedAt,
  }) => CachedCalendar(
    id: id ?? this.id,
    displayName: displayName ?? this.displayName,
    syncedAt: syncedAt ?? this.syncedAt,
  );
  CachedCalendar copyWithCompanion(CachedCalendarsCompanion data) {
    return CachedCalendar(
      id: data.id.present ? data.id.value : this.id,
      displayName: data.displayName.present
          ? data.displayName.value
          : this.displayName,
      syncedAt: data.syncedAt.present ? data.syncedAt.value : this.syncedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('CachedCalendar(')
          ..write('id: $id, ')
          ..write('displayName: $displayName, ')
          ..write('syncedAt: $syncedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(id, displayName, syncedAt);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is CachedCalendar &&
          other.id == this.id &&
          other.displayName == this.displayName &&
          other.syncedAt == this.syncedAt);
}

class CachedCalendarsCompanion extends UpdateCompanion<CachedCalendar> {
  final Value<String> id;
  final Value<String> displayName;
  final Value<DateTime> syncedAt;
  final Value<int> rowid;
  const CachedCalendarsCompanion({
    this.id = const Value.absent(),
    this.displayName = const Value.absent(),
    this.syncedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  CachedCalendarsCompanion.insert({
    required String id,
    required String displayName,
    required DateTime syncedAt,
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       displayName = Value(displayName),
       syncedAt = Value(syncedAt);
  static Insertable<CachedCalendar> custom({
    Expression<String>? id,
    Expression<String>? displayName,
    Expression<DateTime>? syncedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (displayName != null) 'display_name': displayName,
      if (syncedAt != null) 'synced_at': syncedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  CachedCalendarsCompanion copyWith({
    Value<String>? id,
    Value<String>? displayName,
    Value<DateTime>? syncedAt,
    Value<int>? rowid,
  }) {
    return CachedCalendarsCompanion(
      id: id ?? this.id,
      displayName: displayName ?? this.displayName,
      syncedAt: syncedAt ?? this.syncedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (displayName.present) {
      map['display_name'] = Variable<String>(displayName.value);
    }
    if (syncedAt.present) {
      map['synced_at'] = Variable<DateTime>(syncedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('CachedCalendarsCompanion(')
          ..write('id: $id, ')
          ..write('displayName: $displayName, ')
          ..write('syncedAt: $syncedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

abstract class _$AppDatabase extends GeneratedDatabase {
  _$AppDatabase(QueryExecutor e) : super(e);
  $AppDatabaseManager get managers => $AppDatabaseManager(this);
  late final $CachedCalendarsTable cachedCalendars = $CachedCalendarsTable(
    this,
  );
  @override
  Iterable<TableInfo<Table, Object?>> get allTables =>
      allSchemaEntities.whereType<TableInfo<Table, Object?>>();
  @override
  List<DatabaseSchemaEntity> get allSchemaEntities => [cachedCalendars];
}

typedef $$CachedCalendarsTableCreateCompanionBuilder =
    CachedCalendarsCompanion Function({
      required String id,
      required String displayName,
      required DateTime syncedAt,
      Value<int> rowid,
    });
typedef $$CachedCalendarsTableUpdateCompanionBuilder =
    CachedCalendarsCompanion Function({
      Value<String> id,
      Value<String> displayName,
      Value<DateTime> syncedAt,
      Value<int> rowid,
    });

class $$CachedCalendarsTableFilterComposer
    extends Composer<_$AppDatabase, $CachedCalendarsTable> {
  $$CachedCalendarsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get displayName => $composableBuilder(
    column: $table.displayName,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get syncedAt => $composableBuilder(
    column: $table.syncedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$CachedCalendarsTableOrderingComposer
    extends Composer<_$AppDatabase, $CachedCalendarsTable> {
  $$CachedCalendarsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get displayName => $composableBuilder(
    column: $table.displayName,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get syncedAt => $composableBuilder(
    column: $table.syncedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$CachedCalendarsTableAnnotationComposer
    extends Composer<_$AppDatabase, $CachedCalendarsTable> {
  $$CachedCalendarsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get displayName => $composableBuilder(
    column: $table.displayName,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get syncedAt =>
      $composableBuilder(column: $table.syncedAt, builder: (column) => column);
}

class $$CachedCalendarsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $CachedCalendarsTable,
          CachedCalendar,
          $$CachedCalendarsTableFilterComposer,
          $$CachedCalendarsTableOrderingComposer,
          $$CachedCalendarsTableAnnotationComposer,
          $$CachedCalendarsTableCreateCompanionBuilder,
          $$CachedCalendarsTableUpdateCompanionBuilder,
          (
            CachedCalendar,
            BaseReferences<
              _$AppDatabase,
              $CachedCalendarsTable,
              CachedCalendar
            >,
          ),
          CachedCalendar,
          PrefetchHooks Function()
        > {
  $$CachedCalendarsTableTableManager(
    _$AppDatabase db,
    $CachedCalendarsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$CachedCalendarsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$CachedCalendarsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$CachedCalendarsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> displayName = const Value.absent(),
                Value<DateTime> syncedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CachedCalendarsCompanion(
                id: id,
                displayName: displayName,
                syncedAt: syncedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                required String displayName,
                required DateTime syncedAt,
                Value<int> rowid = const Value.absent(),
              }) => CachedCalendarsCompanion.insert(
                id: id,
                displayName: displayName,
                syncedAt: syncedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map(
                (e) => (
                  e.readTable<$CachedCalendarsTable, CachedCalendar>(table),
                  BaseReferences<
                    _$AppDatabase,
                    $CachedCalendarsTable,
                    CachedCalendar
                  >(db, table, e),
                ),
              )
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$CachedCalendarsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $CachedCalendarsTable,
      CachedCalendar,
      $$CachedCalendarsTableFilterComposer,
      $$CachedCalendarsTableOrderingComposer,
      $$CachedCalendarsTableAnnotationComposer,
      $$CachedCalendarsTableCreateCompanionBuilder,
      $$CachedCalendarsTableUpdateCompanionBuilder,
      (
        CachedCalendar,
        BaseReferences<_$AppDatabase, $CachedCalendarsTable, CachedCalendar>,
      ),
      CachedCalendar,
      PrefetchHooks Function()
    >;

class $AppDatabaseManager {
  final _$AppDatabase _db;
  $AppDatabaseManager(this._db);
  $$CachedCalendarsTableTableManager get cachedCalendars =>
      $$CachedCalendarsTableTableManager(_db, _db.cachedCalendars);
}
