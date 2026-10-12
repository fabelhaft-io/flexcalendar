import 'dart:async';
import 'dart:typed_data';

import 'package:calendar_flex/api/rest_client.dart';
import 'package:calendar_flex/src/api/api_providers.dart';
import 'package:calendar_flex/src/app.dart';
import 'package:calendar_flex/src/auth/auth_providers.dart';
import 'package:calendar_flex/src/flavor.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/auth_test_support.dart';

/// A `dio` adapter that answers the readiness probe without a socket, so the
/// widget test never depends on a running API. It stays in-flight until the
/// test releases it, which is what makes the loading assertion deterministic.
class _ControlledHealthAdapter implements HttpClientAdapter {
  final _gate = Completer<void>();

  void release() => _gate.complete();

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    expect(options.path, '/healthz');
    await _gate.future;
    return ResponseBody.fromString(
      '{"status":"ok","service":"api"}',
      200,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  testWidgets('home screen renders the flavor, the API URL and the probe', (
    tester,
  ) async {
    final adapter = _ControlledHealthAdapter();
    final dio = Dio()..httpClientAdapter = adapter;
    addTearDown(dio.close);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          flavorProvider.overrideWithValue(Flavor.staging),
          // The generated client over the stub transport: the test exercises
          // the same decode path the app uses, with no network.
          restClientProvider.overrideWithValue(
            RestClient(dio, baseUrl: 'https://api.staging.flexcalendar.de'),
          ),
          // The real controller reads the tokens at start-up (E10-R02), and the
          // Keystore-backed store never answers on the test host, so the store
          // is in-memory here — the same substitution the auth tests make.
          tokenStoreProvider.overrideWithValue(FakeTokenStore()),
        ],
        child: const FlexCalendarApp(),
      ),
    );

    expect(find.text('Flavor: staging'), findsOneWidget);
    expect(
      find.text('API: https://api.staging.flexcalendar.de'),
      findsOneWidget,
    );
    expect(find.byKey(const Key('health-loading')), findsOneWidget);

    adapter.release();
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('health')), findsOneWidget);
    expect(find.text('Server: ok (api)'), findsOneWidget);
    expect(find.byKey(const Key('health-loading')), findsNothing);
  });
}
