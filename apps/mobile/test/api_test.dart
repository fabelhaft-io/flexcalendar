import 'dart:typed_data';

import 'package:calendar_flex/api/rest_client.dart';
import 'package:calendar_flex/api/models/health_status.dart';
import 'package:calendar_flex/api/models/health_service.dart';
import 'package:dio/dio.dart';
import 'package:test/test.dart';

class HealthAdapter implements HttpClientAdapter {
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    expect(options.method, 'GET');
    expect(options.path, '/healthz');
    return ResponseBody.fromString(
      '{"status":"ok","service":"api"}',
      200,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  test('generated dio client decodes health response', () async {
    final dio = Dio()..httpClientAdapter = HealthAdapter();
    final client = RestClient(dio, baseUrl: 'https://api.localhost:8443');
    final health = await client.fallback.getHealth();
    expect(health.status, HealthStatus.ok);
    expect(health.service, HealthService.api);
    dio.close();
  });
}
