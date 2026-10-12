// E12-R02 crypto-libs probe — the app the integration test drives.
//
// `flutter test integration_test -d <emulator>` is the command the verification
// doc records; `flutter run -d <emulator>` shows the same report on screen.

import 'package:flutter/material.dart';

import 'probe.dart';

void main() {
  runApp(const ProbeApp());
}

class ProbeApp extends StatelessWidget {
  const ProbeApp({super.key});

  @override
  Widget build(BuildContext context) =>
      MaterialApp(title: 'E12-R02 crypto-libs probe', home: const ProbePage());
}

class ProbePage extends StatefulWidget {
  const ProbePage({super.key});

  @override
  State<ProbePage> createState() => _ProbePageState();
}

class _ProbePageState extends State<ProbePage> {
  ProbeResult? _result;

  @override
  void initState() {
    super.initState();
    runProbe().then((result) {
      debugPrint(result.format());
      if (mounted) {
        setState(() => _result = result);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final result = _result;
    return Scaffold(
      appBar: AppBar(
        title: const Text('E12-R02 crypto-libs probe'),
        backgroundColor: result == null
            ? null
            : result.passed
            ? Colors.green
            : Colors.red,
      ),
      body: result == null
          ? const Center(child: CircularProgressIndicator())
          : SingleChildScrollView(
              padding: const EdgeInsets.all(12),
              child: SelectableText(
                result.format(),
                style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
              ),
            ),
    );
  }
}
