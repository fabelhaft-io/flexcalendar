// E12-R02 crypto-libs probe — the Android run.
//
// From `infra/crypto-libs-check/flutter`, with an emulator or device attached
// and the pinned Flutter on PATH:
//
//   flutter test integration_test -d <device-id>
//
// The report it prints is what goes into
// `docs/verification/crypto-libs-2026-10-12.md` under "Android (emulator)".
// Everything asserted here is a real call into libsodium on the device: the
// round trips, the four negative cases, the RFC 5869 vectors and the frozen
// cross-probe values.

import 'package:crypto_libs_check_flutter/probe.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('every primitive E12-R02 names works on this device', (
    WidgetTester tester,
  ) async {
    final ProbeResult result = await runProbe();
    // Printed in full so the reviewer can paste it into the verification doc.
    // ignore: avoid_print — this is the probe's recorded output.
    print(result.format());

    expect(result.report.failures, isEmpty);
    expect(result.mismatches, isEmpty, reason: result.mismatches.join('\n'));

    // The three primitives the epic's note is about, asserted by name so a
    // missing one fails loudly instead of only showing up in the printed diff.
    expect(result.report.gaps, isEmpty);
    expect(result.deviceLines, isNotEmpty);
  });
}
