// INV-04's guard, and the proof that it fails on bad code (E10-R04).
//
// `make verify-mobile` runs this with the rest of `flutter test`, so the Accept
// line's "a custom lint or test rejects `DateTime` arithmetic in the domain
// layer" is a check on every run, not a review note.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'support/domain_time_guard.dart';

/// The directories the guard covers: the domain layer of `apps/mobile`
/// (E10-R04). The UI, the generated client, auth and the offline cache may read
/// the clock; this layer resolves instants, and it must do it with `TZDateTime`
/// (`lib/src/domain/time/zones.dart`).
const _domainDirectory = 'lib/src/domain';

/// Nothing is excused, and the fact that this list is empty is the point: the
/// domain layer needs no device-local reading, so every use is a bug. The
/// allow-list mechanism itself is exercised in the group below.
const _allowList = <AllowedUse>[];

const _planted = 'test/fixtures/zoned_datetime/planted_violations.dart';

void main() {
  test('the domain layer has no device-local DateTime', () {
    final files =
        Directory(_domainDirectory)
            .listSync(recursive: true)
            .whereType<File>()
            .where((file) => file.path.endsWith('.dart'))
            .toList()
          ..sort((a, b) => a.path.compareTo(b.path));
    expect(
      files,
      isNotEmpty,
      reason:
          'INV-04: the guard must scan the domain layer at '
          '$_domainDirectory, and it found no Dart file there',
    );
    final uses = [
      for (final file in files)
        ...findLocalZoneDateTimeUses(
          path: file.path,
          source: file.readAsStringSync(),
          allowList: _allowList,
        ),
    ];
    expect(
      uses,
      isEmpty,
      reason:
          'INV-04: a plain `DateTime` does not know a zone. Use `TZDateTime` '
          'through lib/src/domain/time/zones.dart (E10-R04).',
    );
  });

  group('the guard itself', () {
    final source = File(_planted).readAsStringSync();

    test('reports every guarded construct of the planted file', () {
      final symbols = findLocalZoneDateTimeUses(
        path: _planted,
        source: source,
      ).map((use) => use.symbol).toSet();
      expect(
        symbols,
        containsAll(guardedSymbols),
        reason:
            'every construct in `guardedSymbols` needs a planted case in '
            '$_planted, or the rule is untested',
      );
    });

    test('reports the line the use is on', () {
      final use = findLocalZoneDateTimeUses(
        path: _planted,
        source: source,
      ).firstWhere((use) => use.symbol == 'toLocal()');
      expect(source.split('\n')[use.line - 1], contains('toLocal()'));
    });

    test('an allow-listed use is not reported', () {
      const allowList = [
        AllowedUse(
          path: _planted,
          symbol: 'DateTime.now()',
          why: 'the fixture proves that naming an exception suppresses it',
        ),
      ];
      final all = findLocalZoneDateTimeUses(path: _planted, source: source);
      final allowed = findLocalZoneDateTimeUses(
        path: _planted,
        source: source,
        allowList: allowList,
      );
      expect(all.map((use) => use.symbol), contains('DateTime.now()'));
      expect(
        allowed.map((use) => use.symbol),
        isNot(contains('DateTime.now()')),
      );
      expect(allowed, hasLength(all.length - 1));
    });

    test('UTC readings and TZDateTime are not reported', () {
      final uses = findLocalZoneDateTimeUses(
        path: 'clean',
        source: '''
final instant = DateTime.utc(2026, 3, 29).add(const Duration(hours: 1));
final epoch = DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);
''',
      );
      expect(uses, isEmpty);
    });

    test('a comment or a string mentioning DateTime is not a use', () {
      final uses = findLocalZoneDateTimeUses(
        path: 'clean',
        source: '''
// DateTime.now() in a comment, and "DateTime.now()" in a string.
const explanation = 'DateTime(...)';
''',
      );
      expect(uses, isEmpty);
    });

    test('a file that does not parse is loud, not silently clean', () {
      expect(
        () => findLocalZoneDateTimeUses(path: 'broken', source: 'void ( {'),
        throwsArgumentError,
      );
    });
  });
}
