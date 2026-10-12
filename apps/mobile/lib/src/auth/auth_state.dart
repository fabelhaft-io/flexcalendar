import '../../api/models/problem.dart';
import '../../api/models/user.dart';

/// What the UI needs to know about the session (E10-R02).
sealed class AuthState {
  const AuthState();
}

/// No session: no tokens in the store, nothing to sign out of.
final class SignedOut extends AuthState {
  const SignedOut({this.problem});

  /// The RFC 9457 problem the last sign-in attempt failed with, when it got far
  /// enough to produce one. The UI branches on [Problem.type] and shows
  /// [Problem.instance] (the `urn:uuid:<correlation id>`) for support
  /// (from-E05-R10).
  final Problem? problem;

  @override
  bool operator ==(Object other) =>
      other is SignedOut && other.problem == problem;

  @override
  int get hashCode => problem.hashCode;
}

/// A previous run's session is being checked at start-up (E10-R02).
///
/// The tokens survive a relaunch in secure storage, so the first state of a new
/// process is neither signed in nor signed out until `AuthController` has fed
/// the stored token through the API. It is deliberately not [SignedOut]: the UI
/// must not offer a sign-in the user does not need, and must not flash the
/// sign-in screen over a session that is about to come back.
final class RestoringSession extends AuthState {
  const RestoringSession();

  @override
  bool operator ==(Object other) => other is RestoringSession;

  @override
  int get hashCode => 0;
}

/// The browser is open, or the code is being exchanged. Nothing to retry yet.
final class SigningIn extends AuthState {
  const SigningIn();

  @override
  bool operator ==(Object other) => other is SigningIn;

  @override
  int get hashCode => 0;
}

/// A live session: tokens in the store and a `users` row behind them.
final class SignedIn extends AuthState {
  const SignedIn(this.user);

  /// The user `GET /me` returned right after sign-in (from-E05-R01).
  final User user;

  @override
  bool operator ==(Object other) =>
      other is SignedIn && other.user.id == user.id;

  @override
  int get hashCode => user.id.hashCode;
}
