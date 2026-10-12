// E12-R02 crypto-libs probe — does `dart test` honour the `sodium` build hook?
//
// Run from `infra/crypto-libs-check/dart_vm`:
//   dart test
//
// `packages/crypto_dart` (E12-R01/R03) will be a pure Dart package whose tests
// run under `dart test`, so this matters: `dart run` honours build hooks, and
// `sodium` builds libsodium through one. If this test cannot initialise
// libsodium, the answer is recorded in
// `docs/verification/crypto-libs-2026-10-12.md` and the Dart library's tests
// have to run through `flutter test` instead.

import 'package:crypto_libs_check_dart_vm/checks.dart';
import 'package:sodium/sodium.dart';
import 'package:test/test.dart';

void main() {
  test('libsodium initialises and reproduces the frozen values', () async {
    final sodium = await SodiumInit.init();
    final report = runAllChecks(
      sodium,
      libraryName: 'sodium',
      packageVersion: '4.1.1+2',
      implementation: 'native assets, under `dart test`',
    );

    expect(report.failures, isEmpty);
    expect(report.gaps, isEmpty);
    expect(
      frozenValueMismatches(report),
      isEmpty,
      reason: frozenValueMismatches(report).join('\n'),
    );
  });
}
