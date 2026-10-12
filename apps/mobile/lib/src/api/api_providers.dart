import 'package:calendar_flex/api/models/health.dart';
import 'package:calendar_flex/api/rest_client.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/auth_interceptor.dart';
import '../auth/auth_providers.dart';
import '../flavor.dart';

/// The API to talk to, from the selected flavor (or `--dart-define`).
final apiBaseUrlProvider = Provider<String>(
  (ref) => ref.watch(flavorProvider).apiBaseUrl,
);

/// The one `dio` instance of the app: the generated client is built on top of
/// it, and it is closed when the provider is disposed.
///
/// It carries the `dio` interceptor of E10-R02, which puts the session's bearer
/// token on every request and refreshes it from the store when it has expired
/// or is about to. The interceptor is created directly here (not as its own
/// provider) because it needs the very `Dio` it is added to, for the retry
/// after a `401`.
final dioProvider = Provider<Dio>((ref) {
  final dio = Dio(
    BaseOptions(
      baseUrl: ref.watch(apiBaseUrlProvider),
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 30),
    ),
  );
  dio.interceptors.add(
    AuthInterceptor(
      client: dio,
      tokens: ref.watch(tokenStoreProvider),
      refresh: ref.watch(oidcClientProvider).refresh,
      // A refresh the IdP refuses ends the session. Read lazily so this
      // provider (which the controller reaches through `restClientProvider`)
      // does not depend on the controller.
      onSessionEnded: () =>
          ref.read(authControllerProvider.notifier).handleSessionExpired(),
      now: () => DateTime.now().toUtc(),
    ),
  );
  ref.onDispose(dio.close);
  return dio;
});

/// The generated OpenAPI client (E02-R07), pointed at the flavor's API.
///
/// The app talks to the REST API and never to CalDAV itself (ADR 0002).
final restClientProvider = Provider<RestClient>(
  (ref) => RestClient(
    ref.watch(dioProvider),
    baseUrl: ref.watch(apiBaseUrlProvider),
  ),
);

/// The API's readiness probe, the only operation that needs no token.
final healthProvider = FutureProvider<Health>(
  (ref) => ref.watch(restClientProvider).health.getHealth(),
);
