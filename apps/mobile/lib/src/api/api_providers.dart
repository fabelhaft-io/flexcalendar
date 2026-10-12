import 'package:calendar_flex/api/models/health.dart';
import 'package:calendar_flex/api/rest_client.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../flavor.dart';

/// The flavor this process runs as.
///
/// It has no default on purpose: every entry point (`lib/main.dart`,
/// `lib/main_staging.dart`, `lib/main_prod.dart`) overrides it, so a build that
/// forgot to name one fails loudly instead of quietly talking to production.
final flavorProvider = Provider<Flavor>(
  (ref) =>
      throw StateError('flavorProvider must be overridden by the entry point.'),
);

/// The API to talk to, from the selected flavor (or `--dart-define`).
final apiBaseUrlProvider = Provider<String>(
  (ref) => ref.watch(flavorProvider).apiBaseUrl,
);

/// The one `dio` instance of the app: the generated client is built on top of
/// it, and it is closed when the provider is disposed.
final dioProvider = Provider<Dio>((ref) {
  final dio = Dio(
    BaseOptions(
      baseUrl: ref.watch(apiBaseUrlProvider),
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 30),
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
