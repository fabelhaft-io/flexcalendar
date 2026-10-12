import 'dart:async';

import 'package:calendar_flex/src/auth/auth_interceptor.dart';
import 'package:calendar_flex/src/auth/auth_tokens.dart';
import 'package:dio/dio.dart';
import 'package:test/test.dart';

import 'support/auth_test_support.dart';

void main() {
  late DateTime now;

  setUp(() {
    now = DateTime.utc(2026, 10, 12, 12);
  });

  AuthTokens tokens({
    String access = 'access-1',
    String? refresh = 'refresh-1',
    String? id = 'id-1',
    Duration expiresIn = const Duration(hours: 1),
  }) => AuthTokens(
    accessToken: access,
    refreshToken: refresh,
    idToken: id,
    expiresAt: now.add(expiresIn),
  );

  test(
    'a token about to expire is refreshed before the request goes out',
    () async {
      final harness = _Harness(
        stored: tokens(access: 'stale', expiresIn: const Duration(seconds: 30)),
        clock: () => now,
      );
      harness.oidc.onRefresh = (refreshToken) async {
        expect(refreshToken, 'refresh-1');
        return tokens(access: 'fresh');
      };

      final response = await harness.dio.get<Object?>('/me');

      expect(response.statusCode, 200);
      expect(
        harness.adapter.requests.single.headers['Authorization'],
        'Bearer fresh',
      );
      expect(harness.oidc.refreshes, 1);
      expect(harness.signOuts, 0);
      expect(harness.store.tokens?.accessToken, 'fresh');
    },
  );

  test('a token with time left is used as it is', () async {
    final harness = _Harness(
      stored: tokens(access: 'good', expiresIn: const Duration(minutes: 10)),
      clock: () => now,
    );

    await harness.dio.get<Object?>('/me');

    expect(
      harness.adapter.requests.single.headers['Authorization'],
      'Bearer good',
    );
    expect(harness.oidc.refreshes, 0);
  });

  test('a request with no session carries no token', () async {
    final harness = _Harness(clock: () => now);

    await harness.dio.get<Object?>('/healthz');

    expect(
      harness.adapter.requests.single.headers.containsKey('Authorization'),
      isFalse,
    );
    expect(harness.oidc.refreshes, 0);
  });

  test('N concurrent requests share one refresh', () async {
    final harness = _Harness(
      stored: tokens(access: 'stale', expiresIn: Duration.zero),
      clock: () => now,
    );
    final refreshStarted = Completer<void>();
    final gate = Completer<void>();
    harness.oidc.onRefresh = (refreshToken) async {
      if (!refreshStarted.isCompleted) refreshStarted.complete();
      await gate.future;
      return tokens(access: 'fresh');
    };

    final requests = <Future<Response<Object?>>>[
      for (var i = 0; i < 5; i++) harness.dio.get<Object?>('/events/$i'),
    ];
    await refreshStarted.future;
    // Let the other four requests reach the in-flight refresh.
    await Future<void>.delayed(Duration.zero);
    gate.complete();
    await Future.wait(requests);

    expect(harness.oidc.refreshes, 1);
    expect(harness.adapter.requests, hasLength(5));
    for (final request in harness.adapter.requests) {
      expect(request.headers['Authorization'], 'Bearer fresh');
    }
  });

  test('a 401 is answered with one refresh and one retry', () async {
    var attempts = 0;
    final harness = _Harness(
      stored: tokens(access: 'good', expiresIn: const Duration(minutes: 10)),
      clock: () => now,
      handler: (options) async {
        attempts++;
        return attempts == 1
            ? jsonResponse(problemBody(), 401)
            : jsonResponse(userBody());
      },
    );
    harness.oidc.onRefresh = (refreshToken) async => tokens(access: 'rotated');

    final response = await harness.dio.get<Object?>('/me');

    expect(response.statusCode, 200);
    expect(attempts, 2);
    expect(harness.oidc.refreshes, 1);
    expect(
      harness.adapter.requests.last.headers['Authorization'],
      'Bearer rotated',
    );
    expect(harness.signOuts, 0);
  });

  test('a second 401 is not retried a third time', () async {
    final harness = _Harness(
      stored: tokens(access: 'good', expiresIn: const Duration(minutes: 10)),
      clock: () => now,
      handler: (options) async => jsonResponse(problemBody(), 401),
    );
    harness.oidc.onRefresh = (refreshToken) async => tokens(access: 'rotated');

    await expectLater(
      harness.dio.get<Object?>('/me'),
      throwsA(isA<DioException>()),
    );

    expect(harness.adapter.requests, hasLength(2));
    expect(harness.oidc.refreshes, 1);
  });

  test('a refresh the IdP refuses ends the session', () async {
    final harness = _Harness(
      stored: tokens(access: 'stale', expiresIn: const Duration(seconds: 30)),
      clock: () => now,
    );
    harness.oidc.refreshError = StateError('invalid_grant');

    final response = await harness.dio.get<Object?>('/me');

    expect(response.statusCode, 200);
    expect(harness.signOuts, 1);
    expect(harness.oidc.refreshes, 1);
    expect(
      harness.adapter.requests.single.headers.containsKey('Authorization'),
      isFalse,
    );
  });

  test('an expired token with no refresh token ends the session', () async {
    final harness = _Harness(
      stored: tokens(
        access: 'stale',
        refresh: null,
        expiresIn: const Duration(seconds: 30),
      ),
      clock: () => now,
    );

    await harness.dio.get<Object?>('/me');

    expect(harness.signOuts, 1);
    expect(harness.oidc.refreshes, 0);
    expect(
      harness.adapter.requests.single.headers.containsKey('Authorization'),
      isFalse,
    );
  });

  test('a 401 whose refresh fails ends the session', () async {
    final harness = _Harness(
      stored: tokens(access: 'good', expiresIn: const Duration(minutes: 10)),
      clock: () => now,
      handler: (options) async => jsonResponse(problemBody(), 401),
    );
    harness.oidc.refreshError = StateError('invalid_grant');

    await expectLater(
      harness.dio.get<Object?>('/me'),
      throwsA(isA<DioException>()),
    );

    expect(harness.signOuts, 1);
    expect(harness.oidc.refreshes, 1);
  });

  test('a 401 with no session at all is left alone', () async {
    final harness = _Harness(
      clock: () => now,
      handler: (options) async => jsonResponse(problemBody(), 401),
    );

    await expectLater(
      harness.dio.get<Object?>('/me'),
      throwsA(isA<DioException>()),
    );

    expect(harness.oidc.refreshes, 0);
    expect(harness.signOuts, 0);
  });
}

/// The interceptor wired to a stub transport: no network, no platform channel.
class _Harness {
  _Harness({
    AuthTokens? stored,
    Future<ResponseBody> Function(RequestOptions options)? handler,
    required DateTime Function() clock,
    Duration leeway = const Duration(seconds: 60),
  }) {
    store = FakeTokenStore(stored);
    oidc = FakeOidcClient();
    adapter = StubAdapter(
      handler ?? (options) async => jsonResponse(<String, Object?>{'ok': true}),
    );
    dio = Dio(BaseOptions(baseUrl: 'https://api.test'))
      ..httpClientAdapter = adapter;
    dio.interceptors.add(
      AuthInterceptor(
        client: dio,
        tokens: store,
        refresh: oidc.refresh,
        onSessionEnded: () async {
          signOuts++;
        },
        now: clock,
        leeway: leeway,
      ),
    );
  }

  late final Dio dio;
  late final StubAdapter adapter;
  late final FakeTokenStore store;
  late final FakeOidcClient oidc;
  int signOuts = 0;
}
