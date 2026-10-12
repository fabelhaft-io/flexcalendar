import 'package:dio/dio.dart';

import 'auth_tokens.dart';
import 'token_store.dart';

/// Exchanges a refresh token for a new token set (the OIDC client's `refresh`).
typedef RefreshTokens = Future<AuthTokens> Function(String refreshToken);

/// Puts the session's token on every request and keeps it fresh (E10-R02).
///
/// Three behaviours, in the order a request hits them:
/// - a stored token that has expired or is about to is refreshed **before** the
///   request goes out, so an expiry mid-session is invisible to the caller;
/// - a `401` from the API is answered by one refresh and one retry;
/// - N requests that need a refresh at the same time share **one** refresh.
///
/// A refresh that fails (the IdP refused it, or there is no refresh token left)
/// calls [onSignOut] — the session cannot be renewed, so it ends — and the
/// request is sent without a token, or its `401` propagated.
class AuthInterceptor extends Interceptor {
  AuthInterceptor({
    required Dio client,
    required TokenStore tokens,
    required RefreshTokens refresh,
    required Future<void> Function() onSessionEnded,
    DateTime Function()? now,
    this.leeway = const Duration(seconds: 60),
  }) : _dio = client,
       _store = tokens,
       _refreshTokens = refresh,
       _onSignOut = onSessionEnded,
       _clock = now ?? _utcNow;

  /// Marks a request that already spent its one retry.
  static const retriedKey = 'calflex.auth.retried';

  /// Marks a request whose pre-flight refresh failed, so its `401` does not
  /// start a second refresh for the same request.
  static const signedOutKey = 'calflex.auth.signed_out';

  /// How long before the expiry a token is treated as due for a refresh.
  final Duration leeway;

  final Dio _dio;
  final TokenStore _store;
  final RefreshTokens _refreshTokens;
  final Future<void> Function() _onSignOut;
  final DateTime Function() _clock;

  /// The refresh in flight, if any. Requests that arrive while it is running
  /// await it instead of starting another.
  Future<AuthTokens?>? _refreshing;

  static DateTime _utcNow() => DateTime.now().toUtc();

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    final stored = await _store.read();
    if (stored == null) {
      // No session: a public operation such as the readiness probe.
      _continue(handler, options);
      return;
    }

    var tokens = stored;
    if (stored.isExpired(_clock(), leeway: leeway)) {
      final refreshed = await _refresh(stored);
      if (refreshed == null) {
        // `onSignOut` already ran; sending a dead token would only produce a
        // `401` that would try to refresh again.
        options.extra[signedOutKey] = true;
        _continue(handler, options);
        return;
      }
      tokens = refreshed;
    }

    options.headers['Authorization'] = 'Bearer ${tokens.accessToken}';
    _continue(handler, options);
  }

  @override
  Future<void> onError(
    DioException err,
    ErrorInterceptorHandler handler,
  ) async {
    final options = err.requestOptions;
    final refused = err.response?.statusCode == 401;
    if (!refused ||
        options.extra[retriedKey] == true ||
        options.extra[signedOutKey] == true) {
      _fail(handler, err);
      return;
    }

    final stored = await _store.read();
    if (stored == null) {
      _fail(handler, err);
      return;
    }

    final refreshed = await _refresh(stored);
    if (refreshed == null) {
      _fail(handler, err);
      return;
    }

    options.extra[retriedKey] = true;
    options.headers['Authorization'] = 'Bearer ${refreshed.accessToken}';
    try {
      final response = await _dio.fetch<Object?>(options);
      if (!handler.isCompleted) handler.resolve(response);
    } on DioException catch (retryError) {
      _fail(handler, retryError);
    }
  }

  /// One refresh for every caller that wants one at the same time.
  Future<AuthTokens?> _refresh(AuthTokens stale) {
    final inFlight = _refreshing;
    if (inFlight != null) return inFlight;
    // No `await` between the check and the assignment, so a second caller in
    // the same event-loop turn sees the future this line stores.
    final refresh = _performRefresh(stale);
    _refreshing = refresh;
    return refresh;
  }

  Future<AuthTokens?> _performRefresh(AuthTokens stale) async {
    try {
      final refreshToken = stale.refreshToken;
      if (refreshToken == null) {
        await _endSession();
        return null;
      }
      final tokens = await _refreshTokens(refreshToken);
      await _store.write(tokens);
      return tokens;
    } on Object {
      // A refused or unreachable refresh endpoint: the session is over.
      await _endSession();
      return null;
    } finally {
      _refreshing = null;
    }
  }

  /// Ends the session and lets the caller carry on with the request. A failing
  /// sign-out hook must not turn a request into an interceptor exception.
  Future<void> _endSession() async {
    try {
      await _onSignOut();
    } on Object {
      // The token store is cleared first by the controller, so the session is
      // already gone; nothing useful to do with the hook's error here.
    }
  }

  /// Passes the request on unless a cancellation completed the handler while
  /// this interceptor was awaiting a token.
  void _continue(RequestInterceptorHandler handler, RequestOptions options) {
    if (!handler.isCompleted) handler.next(options);
  }

  /// The error-path twin of [_continue].
  void _fail(ErrorInterceptorHandler handler, DioException error) {
    if (!handler.isCompleted) handler.next(error);
  }
}
