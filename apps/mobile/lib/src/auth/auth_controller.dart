import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/models/problem.dart';
import '../api/api_providers.dart';
import 'auth_providers.dart';
import 'auth_state.dart';
import 'auth_tokens.dart';

/// Owns the session's *state* for the UI (E10-R02); the tokens live in the
/// [TokenStore], and every request carries them through the `dio` interceptor.
class AuthController extends Notifier<AuthState> {
  /// The start-up restore, so it runs once however many callers await it.
  Future<void>? _restoring;

  /// Set by a sign-in or a sign-out — and by a session the interceptor had to
  /// end — so the restore cannot put a session back after the user has acted.
  /// The state alone is not enough: a sign-out keeps the signed-in state until
  /// its cleanup is done, which is long enough for a restore that is already in
  /// flight to finish and re-sign the user in.
  bool _sessionTakenOver = false;

  /// Starts a new process on [RestoringSession]: the tokens of the previous run
  /// are still in secure storage, so signing out is not the answer until
  /// [restoreSession] has asked the API whether they are still good.
  @override
  AuthState build() {
    // `build` has to return synchronously, and it must not reach into other
    // providers, so the check itself continues in a microtask — after this
    // build, not inside it.
    Future.microtask(restoreSession);
    return const RestoringSession();
  }

  /// Re-establishes the session a previous run stored (E10-R02).
  ///
  /// A relaunch keeps the user signed in. The stored token travels on `GET /me`
  /// through the same `dio` interceptor as every other request, so a token that
  /// is still valid is used as it is, and one that has expired (or is about to)
  /// is refreshed exactly once on the way out — the browser is never opened.
  ///
  /// The session is confirmed with `GET /me` (from-E05-R01) before the UI is
  /// told it is signed in. A refresh the IdP refuses, or a `401` the API
  /// answers even after one, ends the session through the same path as a manual
  /// sign-out: the tokens are cleared and every registered sign-out hook runs.
  /// With nothing stored it settles on [SignedOut].
  ///
  /// Called automatically by [build]; it is public so a caller (and a test) can
  /// await the same check rather than poll for it. It runs once per process.
  Future<void> restoreSession() => _restoring ??= _restoreSession();

  Future<void> _restoreSession() async {
    final stored = await _readStoredTokens();
    if (!_restoreOwnsSession) return;
    if (stored == null) {
      state = const SignedOut();
      return;
    }

    try {
      final user = await ref.read(restClientProvider).users.getMe();
      if (!_restoreOwnsSession) return;
      state = SignedIn(user);
    } on Object {
      // Either the interceptor already ended a session it could not refresh —
      // hooks included, and it takes the session over, so there is nothing left
      // to do here — or the API refused a token that had just been refreshed,
      // or it was unreachable. Both leave no session to renew, so the exit is
      // the manual one.
      if (!_restoreOwnsSession) return;
      await clearLocally();
    }
  }

  /// Whether the start-up check still owns the session: nothing has taken it
  /// over and no sign-in or sign-out has moved the state on.
  bool get _restoreOwnsSession =>
      !_sessionTakenOver && state is RestoringSession;

  /// The stored session, or `null` when secure storage holds nothing readable.
  ///
  /// A Keystore that refuses the read is not a session: the app asks the user
  /// to sign in again instead of failing to start.
  Future<AuthTokens?> _readStoredTokens() async {
    try {
      return await ref.read(tokenStoreProvider).read();
    } on Object {
      return null;
    }
  }

  /// Runs the OIDC flow, stores the tokens, and confirms the session with the
  /// API while Zitadel's login session is still alive (from-E05-R01).
  Future<void> signIn() async {
    if (state is SigningIn) return;
    _sessionTakenOver = true;
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
    _sessionTakenOver = true;
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
    _sessionTakenOver = true;
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
