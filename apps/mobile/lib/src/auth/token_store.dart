import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'auth_tokens.dart';

/// Where the session's tokens live (E10-R02).
///
/// The interface exists so the interceptor, the controller and their tests
/// never touch a platform channel; the app's only implementation is
/// [SecureTokenStore].
abstract interface class TokenStore {
  /// The stored session, or `null` when there is none (signed out, wiped).
  Future<AuthTokens?> read();

  /// Replaces the stored session.
  Future<void> write(AuthTokens tokens);

  /// Removes the session. Sign-out and a failed refresh both call this.
  Future<void> clear();
}

/// The real store: `flutter_secure_storage`, which on Android is backed by the
/// Keystore-encrypted store. No token ever goes to shared preferences.
class SecureTokenStore implements TokenStore {
  SecureTokenStore({this.storage = const FlutterSecureStorage()});

  final FlutterSecureStorage storage;

  /// Namespaced keys, so the later requirements' secure values (the wrapped
  /// key material of E12-R06) cannot collide with the session.
  static const accessTokenKey = 'calflex.oidc.access_token';
  static const refreshTokenKey = 'calflex.oidc.refresh_token';
  static const idTokenKey = 'calflex.oidc.id_token';
  static const expiresAtKey = 'calflex.oidc.expires_at';

  @override
  Future<AuthTokens?> read() async {
    final values = await Future.wait([
      storage.read(key: accessTokenKey),
      storage.read(key: refreshTokenKey),
      storage.read(key: idTokenKey),
      storage.read(key: expiresAtKey),
    ]);

    final accessToken = values[0];
    final expiresAt = values[3];
    if (accessToken == null || expiresAt == null) return null;

    final instant = DateTime.tryParse(expiresAt);
    if (instant == null) return null;

    return AuthTokens(
      accessToken: accessToken,
      refreshToken: values[1],
      idToken: values[2],
      expiresAt: instant.toUtc(),
    );
  }

  @override
  Future<void> write(AuthTokens tokens) async {
    // Delete the ones this session does not have, so a rotation can never leave
    // the previous refresh token behind.
    await _writeOrDelete(refreshTokenKey, tokens.refreshToken);
    await _writeOrDelete(idTokenKey, tokens.idToken);
    await storage.write(key: accessTokenKey, value: tokens.accessToken);
    await storage.write(
      key: expiresAtKey,
      value: tokens.expiresAt.toUtc().toIso8601String(),
    );
  }

  @override
  Future<void> clear() async {
    await Future.wait([
      for (final key in const [
        accessTokenKey,
        refreshTokenKey,
        idTokenKey,
        expiresAtKey,
      ])
        storage.delete(key: key),
    ]);
  }

  Future<void> _writeOrDelete(String key, String? value) => value == null
      ? storage.delete(key: key)
      : storage.write(key: key, value: value);
}
