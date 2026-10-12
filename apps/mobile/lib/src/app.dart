import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api/api_providers.dart';
import 'auth/auth_providers.dart';
import 'auth/auth_state.dart';
import 'flavor.dart';

/// The app behind the API client (E10-R01) and the session (E10-R02).
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

/// The minimal home screen: flavor, API base URL, the session and the readiness
/// probe, all through Riverpod providers so a test can run it without a network.
///
/// The calendar grid and the offline cache arrive with the later E10
/// requirements; this screen exists to show that sign-in works and that
/// sign-out cleared the session.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final flavor = ref.watch(flavorProvider);
    final health = ref.watch(healthProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('flexcalendar')),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text('Flavor: ${flavor.name}', key: const Key('flavor')),
              Text('API: ${flavor.apiBaseUrl}', key: const Key('api')),
              const SizedBox(height: 16),
              const _AuthSection(),
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
      ),
    );
  }
}

/// Signed out, signing in, or signed in with a sign-out button.
class _AuthSection extends ConsumerWidget {
  const _AuthSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final controller = ref.read(authControllerProvider.notifier);

    switch (ref.watch(authControllerProvider)) {
      case SigningIn():
        return const CircularProgressIndicator(key: Key('auth-signing-in'));
      case SignedIn(:final user):
        return Column(
          key: const Key('auth-signed-in'),
          children: [
            Text('Signed in as ${user.handle}', key: const Key('auth-user')),
            const SizedBox(height: 8),
            FilledButton(
              key: const Key('auth-sign-out'),
              onPressed: controller.signOut,
              child: const Text('Sign out'),
            ),
          ],
        );
      case SignedOut(:final problem):
        return Column(
          key: const Key('auth-signed-out'),
          children: [
            if (problem != null) ...[
              const Text('Sign-in failed.', key: Key('auth-error')),
              // The correlation id (`urn:uuid:<id>`) that ties this failure to
              // a request in the server's logs (from-E05-R10).
              Text(
                'Support reference: ${problem.instance}',
                key: const Key('auth-problem-instance'),
              ),
              const SizedBox(height: 8),
            ],
            FilledButton(
              key: const Key('auth-sign-in'),
              onPressed: controller.signIn,
              child: const Text('Sign in'),
            ),
          ],
        );
    }
  }
}
