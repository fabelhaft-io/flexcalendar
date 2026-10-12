import 'package:calendar_flex/src/auth/oidc_client.dart';
import 'package:calendar_flex/src/auth/oidc_config.dart';
import 'package:calendar_flex/src/flavor.dart';
import 'package:flutter_appauth/flutter_appauth.dart';
import 'package:flutter_test/flutter_test.dart';

/// A `flutter_appauth` with no platform channel behind it: it records the
/// request it was handed and answers with a canned token set, so the test can
/// see exactly what AppAuth would have sent to Zitadel.
class _FakeAppAuth extends FlutterAppAuth {
  AuthorizationTokenRequest? authorizationTokenRequest;
  TokenRequest? tokenRequest;
  EndSessionRequest? endSessionRequest;

  /// Set to make the next call throw, the way a refused or unreachable IdP does.
  Object? failure;

  @override
  Future<AuthorizationTokenResponse> authorizeAndExchangeCode(
    AuthorizationTokenRequest request,
  ) async {
    if (failure != null) throw failure!;
    authorizationTokenRequest = request;
    return AuthorizationTokenResponse(
      'access-1',
      'refresh-1',
      _expiry,
      'id-1',
      'Bearer',
      request.scopes,
      null,
      null,
    );
  }

  @override
  Future<TokenResponse> token(TokenRequest request) async {
    if (failure != null) throw failure!;
    tokenRequest = request;
    return TokenResponse(
      'access-2',
      'refresh-2',
      _expiry,
      'id-2',
      'Bearer',
      request.scopes,
      null,
    );
  }

  @override
  Future<EndSessionResponse> endSession(EndSessionRequest request) async {
    if (failure != null) throw failure!;
    endSessionRequest = request;
    return EndSessionResponse(null);
  }

  /// AppAuth hands back a local `DateTime`; the model stores the instant.
  DateTime get _expiry => DateTime.now().add(const Duration(hours: 1));
}

const _projectId = '123456789012345678';

/// A `prod` configuration: TLS, the way staging and production always are.
final _prodConfig = OidcConfig.forFlavor(
  Flavor.prod,
  issuer: Flavor.prod.defaultIssuer,
  clientId: 'de.flexcalendar.app',
  projectId: _projectId,
);

void main() {
  test(
    'sign-in sends the registered client, redirect, issuer and scopes',
    () async {
      final appAuth = _FakeAppAuth();
      final config = _prodConfig;

      final tokens = await AppAuthOidcClient(config, appAuth: appAuth).signIn();

      final request = appAuth.authorizationTokenRequest!;
      expect(request.clientId, 'de.flexcalendar.app');
      expect(request.redirectUrl, 'de.flexcalendar.app:/oauth2redirect');
      expect(request.issuer, 'https://auth.flexcalendar.de');
      expect(request.scopes, [
        'openid',
        'profile',
        'email',
        'offline_access',
        'urn:zitadel:iam:org:project:id:$_projectId:aud',
      ]);
      expect(tokens.accessToken, 'access-1');
      expect(tokens.refreshToken, 'refresh-1');
      expect(tokens.idToken, 'id-1');
      expect(tokens.expiresAt.isUtc, isTrue);
    },
  );

  test(
    'every request of a TLS flavor refuses an insecure connection',
    () async {
      final appAuth = _FakeAppAuth();
      final client = AppAuthOidcClient(_prodConfig, appAuth: appAuth);

      await client.signIn();
      expect(
        appAuth.authorizationTokenRequest!.allowInsecureConnections,
        isFalse,
      );

      final refreshed = await client.refresh('refresh-1');
      expect(appAuth.tokenRequest!.allowInsecureConnections, isFalse);
      expect(appAuth.tokenRequest!.refreshToken, 'refresh-1');
      expect(refreshed.accessToken, 'access-2');

      await client.signOut(idToken: 'id-1');
      final endSession = appAuth.endSessionRequest!;
      expect(endSession.allowInsecureConnections, isFalse);
      expect(endSession.idTokenHint, 'id-1');
      expect(endSession.postLogoutRedirectUrl, 'de.flexcalendar.app:/logout');
    },
  );

  test(
    'only a dev flavor built on http:// turns insecure connections on',
    () async {
      final appAuth = _FakeAppAuth();
      final client = AppAuthOidcClient(
        OidcConfig.forFlavor(
          Flavor.dev,
          issuer: 'http://10.0.2.2:8443',
          clientId: 'de.flexcalendar.app',
          projectId: _projectId,
        ),
        appAuth: appAuth,
      );

      await client.signIn();
      expect(
        appAuth.authorizationTokenRequest!.allowInsecureConnections,
        isTrue,
      );
    },
  );

  test('the flag is the configuration\'s, not re-derived from the issuer', () async {
    final appAuth = _FakeAppAuth();
    // A configuration that says TLS-only although its issuer is plaintext: the
    // client must send what it was configured with. This is what keeps the
    // `staging`/`prod` refusal in `OidcConfig.forFlavor` the single authority
    // over plaintext instead of a check made where the request is built.
    const config = OidcConfig(
      issuer: 'http://auth.example.test',
      clientId: 'de.flexcalendar.app',
      projectId: _projectId,
    );

    await AppAuthOidcClient(config, appAuth: appAuth).signIn();

    expect(
      appAuth.authorizationTokenRequest!.issuer,
      'http://auth.example.test',
    );
    expect(
      appAuth.authorizationTokenRequest!.allowInsecureConnections,
      isFalse,
    );
  });

  test('a token response without an access token is an OidcFailure', () async {
    final appAuth = _FakeAppAuth()..failure = StateError('invalid_grant');

    await expectLater(
      AppAuthOidcClient(_prodConfig, appAuth: appAuth).refresh('refresh-1'),
      throwsA(isA<StateError>()),
    );
  });

  test('an access token without an expiry is refused', () async {
    final appAuth = _NoExpiryAppAuth();

    await expectLater(
      AppAuthOidcClient(_prodConfig, appAuth: appAuth).signIn(),
      throwsA(isA<OidcFailure>()),
    );
  });
}

/// AppAuth always sends an expiry; a response without one is a broken IdP, and
/// the interceptor cannot keep a token it cannot date.
class _NoExpiryAppAuth extends FlutterAppAuth {
  @override
  Future<AuthorizationTokenResponse> authorizeAndExchangeCode(
    AuthorizationTokenRequest request,
  ) async => AuthorizationTokenResponse(
    'access-1',
    'refresh-1',
    null,
    'id-1',
    'Bearer',
    request.scopes,
    null,
    null,
  );
}
