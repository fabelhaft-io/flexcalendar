// E12-R02 crypto-libs probe — the same checks on the host Dart VM.
//
// From `infra/crypto-libs-check/flutter`:
//
//   flutter test
//
// This is not the Android run (that is `integration_test/`, see the README);
// it keeps the probe honest on any machine, and it fails if a future `sodium`
// or `sodium_libs` release stops reproducing the frozen values.

import 'package:crypto_libs_check_flutter/probe.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('every primitive E12-R02 names works, with the frozen values', () async {
    final ProbeResult result = await runProbe();
    // ignore: avoid_print — this is the probe's recorded output.
    print(result.format());

    expect(result.report.failures, isEmpty);
    expect(result.mismatches, isEmpty, reason: result.mismatches.join('\n'));
    expect(result.report.gaps, isEmpty);
  });
}
