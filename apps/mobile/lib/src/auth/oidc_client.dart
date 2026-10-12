import 'package:flutter_appauth/flutter_appauth.dart';

import 'auth_tokens.dart';
import 'oidc_config.dart';

/// The OIDC operations the app needs (E10-R02), behind an interface so the
/// controller and its tests never touch a platform channel.
abstract interface class OidcClient {
  /// Opens the system browser for Authorization Code + PKCE against the
  /// flavor's issuer and returns the exchanged token set.
  Future<AuthTokens> signIn();

  /// Exchanges a refresh token for a new token set. Throws when the IdP refuses
  /// it — a revoked, rotated-away or expired refresh token.
  Future<AuthTokens> refresh(String refreshToken);

  /// Ends the session at the IdP (RP-initiated logout), so the next sign-in
  /// asks for credentials again instead of silently reusing the browser
  /// session. [idToken] is the `id_token_hint` the request needs.
  Future<void> signOut({String? idToken});
}

/// The real client, on `flutter_appauth` (AppAuth).
class AppAuthOidcClient implements OidcClient {
  AppAuthOidcClient(this.config, {this.appAuth = const FlutterAppAuth()});

  final OidcConfig config;
  final FlutterAppAuth appAuth;

  @override
  Future<AuthTokens> signIn() async {
    // AppAuth's Authorization Code flow is always PKCE S256
    // (`code_challenge_method=S256`); there is no switch to turn it off, and
    // Zitadel enforces the verifier when a challenge was sent (from-E02-R09).
    final request = AuthorizationTokenRequest(
      config.clientId,
      OidcConfig.redirectUrl,
      issuer: config.issuer,
      scopes: config.scopes,
      allowInsecureConnections: _allowInsecureConnections,
    );
    return _tokensFrom(await appAuth.authorizeAndExchangeCode(request));
  }

  @override
  Future<AuthTokens> refresh(String refreshToken) async {
    final request = TokenRequest(
      config.clientId,
      OidcConfig.redirectUrl,
      issuer: config.issuer,
      scopes: config.scopes,
      refreshToken: refreshToken,
      allowInsecureConnections: _allowInsecureConnections,
    );
    return _tokensFrom(await appAuth.token(request));
  }

  @override
  Future<void> signOut({String? idToken}) async {
    final request = EndSessionRequest(
      idTokenHint: idToken,
      postLogoutRedirectUrl: OidcConfig.postLogoutRedirectUrl,
      issuer: config.issuer,
      allowInsecureConnections: _allowInsecureConnections,
    );
    await appAuth.endSession(request);
  }

  /// AppAuth refuses a plaintext endpoint unless this is set, so it is derived
  /// from the issuer rather than hard-coded: the dev flavor may point at
  /// `http://` on a device, staging and prod are always `https://`.
  bool get _allowInsecureConnections => !config.issuer.startsWith('https://');

  AuthTokens _tokensFrom(TokenResponse response) {
    final accessToken = response.accessToken;
    if (accessToken == null || accessToken.isEmpty) {
      throw const OidcFailure('The IdP returned no access token.');
    }
    final expiresAt = response.accessTokenExpirationDateTime;
    if (expiresAt == null) {
      throw const OidcFailure('The IdP returned no access-token expiry.');
    }
    return AuthTokens(
      accessToken: accessToken,
      refreshToken: response.refreshToken,
      idToken: response.idToken,
      // AppAuth hands back a local `DateTime`; the model stores the instant.
      expiresAt: expiresAt.toUtc(),
    );
  }
}

/// A failure inside the OIDC flow itself (no access token, no expiry), as
/// opposed to a network or IdP refusal.
class OidcFailure implements Exception {
  const OidcFailure(this.message);

  final String message;

  @override
  String toString() => 'OidcFailure: $message';
}
