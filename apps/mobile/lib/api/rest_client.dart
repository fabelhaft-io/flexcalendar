// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';

import 'health/health_client.dart';
import 'users/users_client.dart';

/// calendar-flex API `v0.0.0`.
///
/// API contract for the calendar-flex REST facade. Every operation except the readiness probe requires an OIDC access token from the D-03 IdP, sent as `Authorization: Bearer <JWT>` and validated locally against the IdP's JWKS: issuer, audience (the Zitadel project ID), expiry and not-before, and RS256 only. An opaque or malformed token is refused, never introspected. The token's `sub` maps to a `users` row, created on first sight from the issuer's own userinfo.
class RestClient {
  RestClient(Dio dio, {String? baseUrl}) : _dio = dio, _baseUrl = baseUrl;

  final Dio _dio;
  final String? _baseUrl;

  static String get version => '0.0.0';

  HealthClient? _health;
  UsersClient? _users;

  HealthClient get health => _health ??= HealthClient(_dio, baseUrl: _baseUrl);

  UsersClient get users => _users ??= UsersClient(_dio, baseUrl: _baseUrl);
}
