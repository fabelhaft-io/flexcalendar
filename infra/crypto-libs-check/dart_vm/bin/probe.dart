// E12-R02 crypto-libs probe — the Dart VM.
//
// Run from `infra/crypto-libs-check/dart_vm`:
//   dart run bin/probe.dart
//
// `dart run` (not `dart bin/probe.dart`) is required: `sodium` 4.x builds
// libsodium 1.0.22 from the source archive it vendors through a **build hook**,
// and only `dart run` honours build hooks. See ../README.md.

import 'dart:io';

import 'package:crypto_libs_check_dart_vm/checks.dart';
import 'package:sodium/sodium.dart';

Future<void> main() async {
  final sodium = await SodiumInit.init();
  final report = runAllChecks(
    sodium,
    libraryName: 'sodium',
    packageVersion: '4.1.1+2',
    implementation:
        'native assets: libsodium built from the package\'s vendored source by '
        'the sodium build hook; loaded ${loadedLibsodium()}',
  );
  final mismatches = frozenValueMismatches(report);

  stdout.writeln(
    '# E12-R02 crypto-libs probe — sodium 4.1.1+2 on the Dart VM '
    '(Dart ${Platform.version.split(' ').first})',
  );
  for (final line in report.lines) {
    stdout.writeln(line);
  }
  for (final gap in report.gaps) {
    stdout.writeln('gap: $gap');
  }
  stdout.writeln('frozen_values=${mismatches.isEmpty ? 'match' : 'MISMATCH'}');
  for (final mismatch in mismatches) {
    stderr.writeln('FAIL frozen value $mismatch');
  }
  for (final failure in report.failures) {
    stderr.writeln('FAIL $failure');
  }
  exitCode = report.failures.isEmpty && mismatches.isEmpty ? 0 : 1;
}

/// Which libsodium file the VM actually mapped, straight from the process.
String loadedLibsodium() {
  try {
    final paths = File('/proc/self/maps')
        .readAsLinesSync()
        .where((line) => line.contains('libsodium'))
        .map((line) => line.split(' ').last.trim())
        .toSet();
    return paths.isEmpty ? 'no libsodium mapping found' : paths.join(', ');
  } on FileSystemException catch (error) {
    return '/proc/self/maps unavailable: $error';
  }
}
