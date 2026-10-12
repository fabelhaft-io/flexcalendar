// E12-R02 crypto-libs probe — shared entry point for the Flutter/Android probe.
//
// `runProbe()` is what the integration test (`integration_test/`), the host
// unit test (`test/`) and the app (`main.dart`) all call, so all three report
// exactly the same lines.

import 'dart:io';

// The package the epic names is deprecated in favour of `sodium`; the probe
// keeps importing it on purpose, so that the re-export itself is exercised
// on the device. See ../README.md.
// ignore: deprecated_member_use
import 'package:sodium_libs/sodium_libs.dart';

import 'checks.dart';

/// The package under check, exactly as the epic names it.
const String packageUnderCheck = 'sodium_libs';
const String packageUnderCheckVersion = '4.0.1';

/// Everything one probe run produced.
class ProbeResult {
  ProbeResult({
    required this.report,
    required this.deviceLines,
    required this.mismatches,
  });

  final CheckReport report;

  /// Device-specific lines: absent on the Dart VM probe, and never compared —
  /// they exist so the verification doc can record which emulator answered.
  final List<String> deviceLines;

  final List<String> mismatches;

  bool get passed => report.failures.isEmpty && mismatches.isEmpty;

  String format() {
    final buffer = StringBuffer()
      ..writeln(
        '# E12-R02 crypto-libs probe — $packageUnderCheck '
        '$packageUnderCheckVersion on Flutter/Android',
      );
    for (final line in deviceLines) {
      buffer.writeln(line);
    }
    for (final line in report.lines) {
      buffer.writeln(line);
    }
    for (final gap in report.gaps) {
      buffer.writeln('gap: $gap');
    }
    buffer.writeln(
      'frozen_values=${mismatches.isEmpty ? 'match' : 'MISMATCH'}',
    );
    for (final failure in report.failures) {
      buffer.writeln('FAIL $failure');
    }
    for (final mismatch in mismatches) {
      buffer.writeln('FAIL frozen value $mismatch');
    }
    return buffer.toString();
  }
}

/// Runs every primitive check on this device.
Future<ProbeResult> runProbe() async {
  final deviceLines = await deviceInfoLines();
  final sodium = await SodiumInit.init();
  final report = runAllChecks(
    sodium,
    libraryName: packageUnderCheck,
    packageVersion: packageUnderCheckVersion,
    implementation: Platform.isAndroid
        ? 'native assets: libsodium built from the source archive `sodium` '
              'vendors, by its build hook, for the app\'s Android ABIs'
        : 'native assets: libsodium built from the source archive `sodium` '
              'vendors, by its build hook, for ${Platform.operatingSystem} — '
              'this is the host `flutter test` run, not the Android one',
  );
  return ProbeResult(
    report: report,
    deviceLines: deviceLines,
    mismatches: frozenValueMismatches(report),
  );
}

/// The device the run happened on — API level and ABI included, because the
/// verification doc has to record both.
Future<List<String>> deviceInfoLines() async {
  final lines = <String>[
    'device.os=${Platform.operatingSystem}',
    'device.os_version=${Platform.operatingSystemVersion}',
    'device.dart_version=${Platform.version}',
  ];
  // `getprop` is present on every Android build; on anything else this throws
  // and the lines are simply absent.
  for (final property in <String>[
    'ro.build.version.sdk',
    'ro.build.version.release',
    'ro.product.cpu.abi',
    'ro.product.cpu.abis',
    'ro.product.manufacturer',
    'ro.product.model',
  ]) {
    try {
      final result = await Process.run('/system/bin/getprop', <String>[
        property,
      ]);
      final value = (result.stdout as String).trim();
      lines.add('device.$property=${value.isEmpty ? '<unset>' : value}');
    } on ProcessException {
      // Not Android, or getprop unavailable: the other lines still identify
      // the run.
    }
  }
  return lines;
}
