import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api/api_providers.dart';

/// The app behind the API client (E10-R01).
///
/// The scaffold shows which flavor and which API this build uses, plus the
/// result of the readiness probe. The calendar grid, sign-in and the offline
/// cache arrive with the later E10 requirements.
class FlexCalendarApp extends StatelessWidget {
  const FlexCalendarApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'flexcalendar',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.indigo),
      ),
      home: const HomeScreen(),
    );
  }
}

/// The minimal home screen: flavor, API base URL and API health, all through
/// Riverpod providers so a test can run it without a network.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final flavor = ref.watch(flavorProvider);
    final health = ref.watch(healthProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('flexcalendar')),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text('Flavor: ${flavor.name}', key: const Key('flavor')),
            Text('API: ${flavor.apiBaseUrl}', key: const Key('api')),
            const SizedBox(height: 16),
            health.when(
              data: (value) => Text(
                'Server: ${value.status.name} (${value.service.name})',
                key: const Key('health'),
              ),
              loading: () =>
                  const CircularProgressIndicator(key: Key('health-loading')),
              error: (error, stackTrace) =>
                  const Text('Server: unreachable', key: Key('health-error')),
            ),
          ],
        ),
      ),
    );
  }
}
