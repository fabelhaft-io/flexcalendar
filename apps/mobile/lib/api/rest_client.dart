// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';

import 'health/health_client.dart';
import 'users/users_client.dart';
import 'calendars/calendars_client.dart';

/// flexcalendar API `v0.0.0`.
///
/// API contract for the flexcalendar REST facade. Every operation except the readiness probe requires an OIDC access token from the D-03 IdP, sent as `Authorization: Bearer <JWT>` and validated locally against the IdP's JWKS: issuer, audience (the Zitadel project ID), expiry and not-before, and RS256 only. An opaque or malformed token is refused, never introspected. The token's `sub` maps to a `users` row, created on first sight from the issuer's own userinfo.
/// Every error — an auth refusal, a rate-limit refusal, a validation failure or an unhandled fault — is an RFC 9457 problem document (`Content-Type: application/problem+json`, schema `Problem`). Nothing in it is derived from the request or from an exception message. Every response carries a correlation ID in `X-Request-Id`, the same ID that goes to CalDAV and appears in the server logs.
/// Until Phase 4 every calendar is Private (ADR 0003). A Private calendar's name and colour exist only inside a client-sealed metadata envelope under the CCK (D-18): the API stores `metaEnvelope` opaquely in `calendars.meta_envelope`, gives the CalDAV collection the fixed display name `Private calendar`, and refuses a plaintext `name` or `color` with 422. The API links no content-crypto library and never decrypts (INV-07).
class RestClient {
  RestClient(Dio dio, {String? baseUrl}) : _dio = dio, _baseUrl = baseUrl;

  final Dio _dio;
  final String? _baseUrl;

  static String get version => '0.0.0';

  HealthClient? _health;
  UsersClient? _users;
  CalendarsClient? _calendars;

  HealthClient get health => _health ??= HealthClient(_dio, baseUrl: _baseUrl);

  UsersClient get users => _users ??= UsersClient(_dio, baseUrl: _baseUrl);

  CalendarsClient get calendars =>
      _calendars ??= CalendarsClient(_dio, baseUrl: _baseUrl);
}
