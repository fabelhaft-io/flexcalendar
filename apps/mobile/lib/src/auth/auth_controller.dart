import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/models/problem.dart';
import '../api/api_providers.dart';
import 'auth_providers.dart';
import 'auth_state.dart';

/// Owns the session's *state* for the UI (E10-R02); the tokens live in the
/// [TokenStore], and every request carries them through the `dio` interceptor.
class AuthController extends Notifier<AuthState> {
  @override
  AuthState build() => const SignedOut();

  /// Runs the OIDC flow, stores the tokens, and confirms the session with the
  /// API while Zitadel's login session is still alive (from-E05-R01).
  Future<void> signIn() async {
    if (state is SigningIn) return;
    state = const SigningIn();
    try {
      final tokens = await ref.read(oidcClientProvider).signIn();
      await ref.read(tokenStoreProvider).write(tokens);
      final user = await ref.read(restClientProvider).users.getMe();
      state = SignedIn(user);
    } catch (error) {
      // Do not keep a half-made session: a stored token the API already
      // refused would go out on the next request.
      await ref.read(tokenStoreProvider).clear();
      state = SignedOut(problem: problemFrom(error));
    }
  }

  /// User-initiated sign-out: end the session at Zitadel, then clear
  /// everything local.
  Future<void> signOut() async {
    final tokens = await ref.read(tokenStoreProvider).read();
    try {
      await ref.read(oidcClientProvider).signOut(idToken: tokens?.idToken);
    } catch (_) {
      // The IdP is unreachable: the session still ends locally, which is the
      // part that protects the user.
    }
    await clearLocally();
  }

  /// The interceptor's exit when a refresh is refused: the session cannot be
  /// renewed, so it ends without a round trip to the IdP.
  Future<void> handleSessionExpired() => clearLocally();

  /// Clears the tokens, flips the UI to signed out, then runs every registered
  /// sign-out hook. The state flips before the hooks so a failing hook cannot
  /// leave the app looking signed in with no tokens.
  Future<void> clearLocally() async {
    await ref.read(tokenStoreProvider).clear();
    state = const SignedOut();
    await ref.read(signOutHooksProvider).runAll();
  }
}

/// The RFC 9457 problem behind [error], when there is one.
///
/// The generated client throws a `DioException` whose body is the problem
/// document; callers branch on [Problem.type] and show [Problem.instance]
/// (from-E05-R10).
Problem? problemFrom(Object error) {
  if (error is! DioException) return null;
  final data = error.response?.data;
  if (data is! Map) return null;
  try {
    return Problem.fromJson(Map<String, Object?>.from(data));
  } on Object {
    return null;
  }
}
