import 'dart:convert';
import 'dart:typed_data';

import 'package:calendar_flex/src/auth/auth_tokens.dart';
import 'package:calendar_flex/src/auth/oidc_client.dart';
import 'package:calendar_flex/src/auth/oidc_config.dart';
import 'package:calendar_flex/src/auth/token_store.dart';
import 'package:dio/dio.dart';

/// A configuration for tests; the real one comes from the flavor and the
/// `--dart-define` values.
const testOidcConfig = OidcConfig(
  issuer: 'https://auth.test',
  clientId: 'de.flexcalendar.app',
  projectId: '123456789012345678',
);

/// An in-memory [TokenStore]; the real one is Keystore-backed and cannot run on
/// the test host.
class FakeTokenStore implements TokenStore {
  FakeTokenStore([this.tokens]);

  AuthTokens? tokens;
  int reads = 0;
  int writes = 0;
  int clears = 0;

  @override
  Future<AuthTokens?> read() async {
    reads++;
    return tokens;
  }

  @override
  Future<void> write(AuthTokens value) async {
    writes++;
    tokens = value;
  }

  @override
  Future<void> clear() async {
    clears++;
    tokens = null;
  }
}

/// An [OidcClient] with no platform channel behind it.
class FakeOidcClient implements OidcClient {
  FakeOidcClient({this.onSignIn, this.onRefresh});

  /// What a sign-in returns; overridden per test.
  AuthTokens Function()? onSignIn;

  /// What a refresh returns, given the presented refresh token.
  Future<AuthTokens> Function(String refreshToken)? onRefresh;

  /// Set to make the corresponding call throw.
  Object? signInError;
  Object? refreshError;
  Object? signOutError;

  int signIns = 0;
  int refreshes = 0;
  int signOuts = 0;
  final List<String?> signedOutIdTokens = <String?>[];

  @override
  Future<AuthTokens> signIn() async {
    signIns++;
    final error = signInError;
    if (error != null) throw error;
    return onSignIn!();
  }

  @override
  Future<AuthTokens> refresh(String refreshToken) async {
    refreshes++;
    final error = refreshError;
    if (error != null) throw error;
    return onRefresh!(refreshToken);
  }

  @override
  Future<void> signOut({String? idToken}) async {
    signOuts++;
    signedOutIdTokens.add(idToken);
    final error = signOutError;
    if (error != null) throw error;
  }
}

/// A `dio` transport that answers from a script and records what it received.
class StubAdapter implements HttpClientAdapter {
  StubAdapter(this.handler);

  final Future<ResponseBody> Function(RequestOptions options) handler;

  /// Every request that reached the transport, in order.
  final List<RequestOptions> requests = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) {
    requests.add(options);
    return handler(options);
  }

  @override
  void close({bool force = false}) {}
}

/// A JSON response body, the way the API's content type arrives.
ResponseBody jsonResponse(Object body, [int statusCode = 200]) =>
    ResponseBody.fromString(
      body is String ? body : jsonEncode(body),
      statusCode,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );

/// A minimal RFC 9457 problem document, as the API writes one.
Map<String, Object?> problemBody({
  String type = 'https://flexcalendar.de/problems/unauthorized',
  int status = 401,
}) => <String, Object?>{
  'type': type,
  'title': 'Unauthorized',
  'status': status,
  'instance': 'urn:uuid:6f1d0a5e-1f1e-4c8e-9a5b-2f0f1a2b3c4d',
};

/// A JSON body for `GET /me`.
Map<String, Object?> userBody({
  String id = '3ab0f2c8-3f4d-4f0a-9c1e-6a7b8c9d0e1f',
  String handle = 'ada',
  String email = 'ada@example.test',
}) => <String, Object?>{'id': id, 'handle': handle, 'email': email};
