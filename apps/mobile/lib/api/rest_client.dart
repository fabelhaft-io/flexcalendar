// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';

import 'health/health_client.dart';

/// calendar-flex API `v0.0.0`.
///
/// API contract for the readiness probe. E05 adds the product API.
class RestClient {
  RestClient(Dio dio, {String? baseUrl}) : _dio = dio, _baseUrl = baseUrl;

  final Dio _dio;
  final String? _baseUrl;

  static String get version => '0.0.0';

  HealthClient? _health;

  HealthClient get health => _health ??= HealthClient(_dio, baseUrl: _baseUrl);
}
