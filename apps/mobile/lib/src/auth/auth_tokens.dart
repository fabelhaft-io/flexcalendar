import 'package:flutter/foundation.dart';

/// One signed-in session's token set (E10-R02).
///
/// The app gets these from Zitadel over the Authorization Code + PKCE flow
/// (D-03) and keeps them only in `flutter_secure_storage` (Keystore-backed on
/// Android). They never reach a log line, an error message or shared
/// preferences.
@immutable
class AuthTokens {
  const AuthTokens({
    required this.accessToken,
    required this.expiresAt,
    this.refreshToken,
    this.idToken,
  });

  /// The JWT the API validates against Zitadel's JWKS.
  final String accessToken;

  /// The refresh token, present because the flow always asks for
  /// `offline_access`. `null` only if the IdP did not return one.
  final String? refreshToken;

  /// The ID token, kept because RP-initiated logout needs it as the
  /// `id_token_hint`.
  final String? idToken;

  /// The instant [accessToken] expires, in UTC.
  final DateTime expiresAt;

  /// Whether [now] is at or past the expiry, plus [leeway] of slack so a token
  /// that is about to lapse is refreshed before the request goes out.
  bool isExpired(DateTime now, {Duration leeway = Duration.zero}) =>
      !now.isBefore(expiresAt.subtract(leeway));

  @override
  bool operator ==(Object other) =>
      other is AuthTokens &&
      other.accessToken == accessToken &&
      other.refreshToken == refreshToken &&
      other.idToken == idToken &&
      other.expiresAt == expiresAt;

  @override
  int get hashCode =>
      Object.hash(accessToken, refreshToken, idToken, expiresAt);

  /// Deliberately does not print the tokens: an [AuthTokens] can end up inside
  /// a failure message, and a bearer token or refresh token in a log line is a
  /// leaked session.
  @override
  String toString() => 'AuthTokens(expiresAt: ${expiresAt.toIso8601String()})';
}
