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
}

/// The app's providers over a stub transport: the real `dioProvider` and its
/// interceptor, with no network and no platform channel.
({
  ProviderContainer container,
  FakeTokenStore store,
  FakeOidcClient oidc,
  StubAdapter adapter,
})
_buildApp({Future<ResponseBody> Function(RequestOptions options)? handler}) {
  final store = FakeTokenStore();
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

/// A valid session for the tests. The expiry is relative to the real clock,
/// because the interceptor in `dioProvider` reads the real clock.
AuthTokens testTokens() => AuthTokens(
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  idToken: 'id-1',
  expiresAt: DateTime.now().toUtc().add(const Duration(hours: 1)),
);
