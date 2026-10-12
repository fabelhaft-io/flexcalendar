import 'dart:async';

import 'package:calendar_flex/src/api/api_providers.dart';
import 'package:calendar_flex/src/auth/auth_providers.dart';
import 'package:calendar_flex/src/auth/auth_state.dart';
import 'package:calendar_flex/src/auth/auth_tokens.dart';
import 'package:calendar_flex/src/flavor.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/auth_test_support.dart';

void main() {
  test('sign-in stores the tokens and calls /me with them', () async {
    final app = _buildApp();
    app.oidc.onSignIn = () => testTokens();

    await app.container.read(authControllerProvider.notifier).signIn();

    expect(app.container.read(authControllerProvider), isA<SignedIn>());
    expect(
      (app.container.read(authControllerProvider) as SignedIn).user.handle,
      'ada',
    );
    expect(app.store.tokens?.accessToken, 'access-1');
    expect(app.oidc.signIns, 1);
    // The first API request after sign-in goes out with the token the
    // interceptor read back out of the store (from-E05-R01).
    expect(app.adapter.requests, hasLength(1));
    expect(app.adapter.requests.single.path, '/me');
    expect(
      app.adapter.requests.single.headers['Authorization'],
      'Bearer access-1',
    );
  });

  test('a sign-in the user abandons leaves no session behind', () async {
    final app = _buildApp();
    app.oidc.signInError = StateError('cancelled');

    await app.container.read(authControllerProvider.notifier).signIn();

    expect(app.container.read(authControllerProvider), isA<SignedOut>());
    expect(app.store.tokens, isNull);
  });

  test('a /me refusal keeps the problem, and its correlation id', () async {
    final app = _buildApp(
      handler: (options) async => jsonResponse(problemBody(), 401),
    );
    app.oidc.onSignIn = () => testTokens();
    // The 401 is answered by the interceptor's one refresh and one retry; both
    // are refused, so the problem reaches the controller.
    app.oidc.onRefresh = (refreshToken) async => testTokens();

    await app.container.read(authControllerProvider.notifier).signIn();

    final state = app.container.read(authControllerProvider);
    expect(state, isA<SignedOut>());
    final problem = (state as SignedOut).problem;
    expect(problem, isNotNull);
    expect(problem!.type, 'https://flexcalendar.de/problems/unauthorized');
    expect(problem.instance, startsWith('urn:uuid:'));
    // Nothing half-signed-in survives.
    expect(app.store.tokens, isNull);
  });

  test(
    'sign-out ends the session, clears the tokens and runs every hook',
    () async {
      final app = _buildApp();
      app.store.tokens = testTokens();
      final ran = <String>[];
      app.container.read(signOutHooksProvider)
        ..register(() async => ran.add('cache'))
        ..register(() async => ran.add('keys'));

      await app.container.read(authControllerProvider.notifier).signOut();

      expect(app.oidc.signOuts, 1);
      // The ID token travels as the logout's `id_token_hint`.
      expect(app.oidc.signedOutIdTokens.single, 'id-1');
      expect(app.store.tokens, isNull);
      expect(ran, <String>['cache', 'keys']);
      expect(app.container.read(authControllerProvider), isA<SignedOut>());
    },
  );

  test('sign-out still clears when the IdP end-session call fails', () async {
    final app = _buildApp();
    app.store.tokens = testTokens();
    app.oidc.signOutError = StateError('offline');

    await app.container.read(authControllerProvider.notifier).signOut();

    expect(app.store.tokens, isNull);
    expect(app.container.read(authControllerProvider), isA<SignedOut>());
  });

  test('a hook that throws does not stop the hooks after it', () async {
    final app = _buildApp();
    app.store.tokens = testTokens();
    final ran = <String>[];
    app.container.read(signOutHooksProvider)
      ..register(() async => throw StateError('cache unavailable'))
      ..register(() async => ran.add('keys'));

    await expectLater(
      app.container.read(authControllerProvider.notifier).signOut(),
      throwsStateError,
    );

    // The tokens are gone and the UI is signed out even though a hook failed.
    expect(app.store.tokens, isNull);
    expect(app.container.read(authControllerProvider), isA<SignedOut>());
    expect(ran, <String>['keys']);
  });

  test('a session the interceptor could not refresh ends locally', () async {
    final app = _buildApp();
    app.store.tokens = testTokens();
    var hooks = 0;
    app.container.read(signOutHooksProvider).register(() async => hooks++);

    await app.container
        .read(authControllerProvider.notifier)
        .handleSessionExpired();

    expect(app.store.tokens, isNull);
    expect(hooks, 1);
    // No IdP round trip: there is nothing left to end there.
    expect(app.oidc.signOuts, 0);
    expect(app.container.read(authControllerProvider), isA<SignedOut>());
  });

  group('relaunch', () {
    test('starts on the restore, not on the sign-in screen', () async {
      final app = _buildApp(stored: testTokens());
      final controller = app.container.read(authControllerProvider.notifier);

      // The previous run's tokens are still in secure storage, so the first
      // state is the check — not `SignedOut`, which would flash a sign-in
      // button over a session that is about to come back.
      expect(
        app.container.read(authControllerProvider),
        isA<RestoringSession>(),
      );

      // Let the check finish so no work outlives the test.
      await controller.restoreSession();

      expect(app.container.read(authControllerProvider), isA<SignedIn>());
    });

    test(
      'a stored, still-good session comes back without the browser',
      () async {
        final app = _buildApp(stored: testTokens());

        await app.container
            .read(authControllerProvider.notifier)
            .restoreSession();

        expect(app.container.read(authControllerProvider), isA<SignedIn>());
        expect(
          (app.container.read(authControllerProvider) as SignedIn).user.handle,
          'ada',
        );
        // No browser, no refresh: the stored token went straight out.
        expect(app.oidc.signIns, 0);
        expect(app.oidc.refreshes, 0);
        expect(app.adapter.requests, hasLength(1));
        expect(app.adapter.requests.single.path, '/me');
        expect(
          app.adapter.requests.single.headers['Authorization'],
          'Bearer access-1',
        );
      },
    );

    test('an expired stored token refreshes once and signs back in', () async {
      final app = _buildApp(stored: testTokens(expiresIn: Duration.zero));
      app.oidc.onRefresh = (refreshToken) async {
        expect(refreshToken, 'refresh-1');
        return testTokens(access: 'rotated');
      };

      await app.container
          .read(authControllerProvider.notifier)
          .restoreSession();

      expect(app.container.read(authControllerProvider), isA<SignedIn>());
      // One refresh, and the request that follows carries the new token.
      expect(app.oidc.refreshes, 1);
      expect(app.oidc.signIns, 0);
      expect(app.adapter.requests.single.path, '/me');
      expect(
        app.adapter.requests.single.headers['Authorization'],
        'Bearer rotated',
      );
      expect(app.store.tokens?.accessToken, 'rotated');
    });

    test('a refresh the IdP refuses signs out and runs the hooks', () async {
      final app = _buildApp(
        stored: testTokens(expiresIn: Duration.zero),
        // A live API: a request without a token is a `401`.
        handler: (options) async => jsonResponse(problemBody(), 401),
      );
      app.oidc.refreshError = StateError('invalid_grant');
      final ran = <String>[];
      app.container.read(signOutHooksProvider)
        ..register(() async => ran.add('cache'))
        ..register(() async => ran.add('keys'));

      await app.container
          .read(authControllerProvider.notifier)
          .restoreSession();

      expect(app.container.read(authControllerProvider), isA<SignedOut>());
      expect(app.store.tokens, isNull);
      // The hooks run once, on the interceptor's exit, not twice.
      expect(ran, <String>['cache', 'keys']);
      expect(app.oidc.refreshes, 1);
    });

    test(
      'a stored session the API refuses signs out and runs the hooks',
      () async {
        final app = _buildApp(
          stored: testTokens(),
          handler: (options) async => jsonResponse(problemBody(), 401),
        );
        // The `401` is answered by the interceptor's one refresh and one retry;
        // the retry is refused too, so the restore's `GET /me` fails.
        app.oidc.onRefresh = (refreshToken) async =>
            testTokens(access: 'rotated');
        var hooks = 0;
        app.container.read(signOutHooksProvider).register(() async => hooks++);

        await app.container
            .read(authControllerProvider.notifier)
            .restoreSession();

        expect(app.container.read(authControllerProvider), isA<SignedOut>());
        expect(app.store.tokens, isNull);
        expect(hooks, 1);
        expect(app.adapter.requests, hasLength(2));
      },
    );

    test('a sign-in taken while the restore is running wins', () async {
      // A store whose read waits for the test, so the user can act while the
      // start-up check is still reading the previous run's tokens.
      final store = _SlowTokenStore(testTokens(access: 'from-the-last-run'));
      final app = _buildApp(tokenStore: store);
      app.oidc.onSignIn = () => testTokens(access: 'from-the-browser');

      final controller = app.container.read(authControllerProvider.notifier);
      final restore = controller.restoreSession();
      await controller.signIn();
      store.release();
      await restore;

      expect(app.container.read(authControllerProvider), isA<SignedIn>());
      // The session is the one the browser produced, and the restore did not
      // send the stale token to `/me` afterwards: exactly one request, the
      // sign-in's own.
      expect(app.store.tokens?.accessToken, 'from-the-browser');
      expect(app.oidc.signIns, 1);
      expect(app.adapter.requests, hasLength(1));
      expect(
        app.adapter.requests.single.headers['Authorization'],
        'Bearer from-the-browser',
      );
    });

    test('nothing stored settles on the sign-in screen', () async {
      final app = _buildApp();

      await app.container
          .read(authControllerProvider.notifier)
          .restoreSession();

      expect(app.container.read(authControllerProvider), isA<SignedOut>());
      // No request at all: there was no token to send and nothing to confirm.
      expect(app.adapter.requests, isEmpty);
      expect(app.oidc.signIns, 0);
      expect(app.oidc.refreshes, 0);
    });
  });
}

/// The app's providers over a stub transport: the real `dioProvider` and its
/// interceptor, with no network and no platform channel.
({
  ProviderContainer container,
  FakeTokenStore store,
  FakeOidcClient oidc,
  StubAdapter adapter,
})
_buildApp({
  Future<ResponseBody> Function(RequestOptions options)? handler,
  AuthTokens? stored,
  FakeTokenStore? tokenStore,
}) {
  final store = tokenStore ?? FakeTokenStore(stored);
  final oidc = FakeOidcClient();
  final adapter = StubAdapter(
    handler ?? (options) async => jsonResponse(userBody()),
  );
  final container = ProviderContainer.test(
    overrides: [
      flavorProvider.overrideWithValue(Flavor.dev),
      oidcConfigProvider.overrideWithValue(testOidcConfig),
      tokenStoreProvider.overrideWithValue(store),
      oidcClientProvider.overrideWithValue(oidc),
    ],
  );
  container.read(dioProvider).httpClientAdapter = adapter;
  return (container: container, store: store, oidc: oidc, adapter: adapter);
}

/// A session for the tests, relative to the real clock because the interceptor
/// in `dioProvider` reads the real clock. `expiresIn: Duration.zero` is an
/// access token that has expired, which the interceptor refreshes.
AuthTokens testTokens({
  String access = 'access-1',
  String? refresh = 'refresh-1',
  Duration expiresIn = const Duration(hours: 1),
}) => AuthTokens(
  accessToken: access,
  refreshToken: refresh,
  idToken: 'id-1',
  expiresAt: DateTime.now().toUtc().add(expiresIn),
);

/// A store whose **first** read blocks until the test releases it, so a sign-in
/// can be started while the start-up restore is still reading. Reads after it
/// — the interceptor's, for the sign-in's own `GET /me` — go straight through.
class _SlowTokenStore extends FakeTokenStore {
  _SlowTokenStore(super.tokens);

  final _gate = Completer<void>();
  bool _waited = false;

  void release() => _gate.complete();

  @override
  Future<AuthTokens?> read() async {
    if (!_waited) {
      _waited = true;
      await _gate.future;
    }
    return super.read();
  }
}
