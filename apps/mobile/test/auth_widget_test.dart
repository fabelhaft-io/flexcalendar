import 'package:calendar_flex/api/models/user.dart';
import 'package:calendar_flex/api/rest_client.dart';
import 'package:calendar_flex/src/api/api_providers.dart';
import 'package:calendar_flex/src/app.dart';
import 'package:calendar_flex/src/auth/auth_controller.dart';
import 'package:calendar_flex/src/auth/auth_providers.dart';
import 'package:calendar_flex/src/auth/auth_state.dart';
import 'package:calendar_flex/src/flavor.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/auth_test_support.dart';

const _user = User(
  id: '3ab0f2c8-3f4d-4f0a-9c1e-6a7b8c9d0e1f',
  handle: 'ada',
  email: 'ada@example.test',
);

void main() {
  testWidgets('signed out: the screen offers sign-in', (tester) async {
    await _pump(tester, const SignedOut());

    expect(find.byKey(const Key('auth-signed-out')), findsOneWidget);
    expect(find.byKey(const Key('auth-sign-in')), findsOneWidget);
    expect(find.byKey(const Key('auth-signed-in')), findsNothing);
  });

  testWidgets('restoring: a relaunch checks the stored session first', (
    tester,
  ) async {
    // A spinner never settles, so this test takes one frame rather than
    // `pumpAndSettle`.
    await _pump(tester, const RestoringSession(), settle: false);

    expect(find.byKey(const Key('auth-restoring')), findsOneWidget);
    // No sign-in button over a session that may still be good.
    expect(find.byKey(const Key('auth-sign-in')), findsNothing);
    expect(find.byKey(const Key('auth-signed-in')), findsNothing);

    // Let the readiness probe's in-flight request finish, so no timer outlives
    // the test. The spinner is still the whole auth section.
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byKey(const Key('auth-restoring')), findsOneWidget);
  });

  testWidgets('signed in: the screen names the user and offers sign-out', (
    tester,
  ) async {
    await _pump(tester, const SignedIn(_user));

    expect(find.byKey(const Key('auth-signed-in')), findsOneWidget);
    expect(find.text('Signed in as ada'), findsOneWidget);
    expect(find.byKey(const Key('auth-sign-out')), findsOneWidget);
    expect(find.byKey(const Key('auth-sign-in')), findsNothing);
  });

  testWidgets('a failed sign-in shows the correlation id for support', (
    tester,
  ) async {
    await _pump(
      tester,
      SignedOut(
        problem: problemFrom(
          DioException(
            requestOptions: RequestOptions(path: '/me'),
            response: Response<Object?>(
              requestOptions: RequestOptions(path: '/me'),
              statusCode: 401,
              data: problemBody(),
            ),
          ),
        ),
      ),
    );

    expect(find.byKey(const Key('auth-error')), findsOneWidget);
    expect(
      find.text(
        'Support reference: urn:uuid:6f1d0a5e-1f1e-4c8e-9a5b-2f0f1a2b3c4d',
      ),
      findsOneWidget,
    );
  });

  testWidgets('the sign-in button asks the controller to sign in', (
    tester,
  ) async {
    final controller = _RecordingAuthController();
    await _pumpWith(tester, () => controller);

    await tester.tap(find.byKey(const Key('auth-sign-in')));
    await tester.pump();

    expect(controller.signInCalls, 1);
  });

  testWidgets('the sign-out button asks the controller to sign out', (
    tester,
  ) async {
    final controller = _RecordingAuthController()
      ..initial = const SignedIn(_user);
    await _pumpWith(tester, () => controller);

    await tester.tap(find.byKey(const Key('auth-sign-out')));
    await tester.pump();

    expect(controller.signOutCalls, 1);
  });
}

Future<void> _pump(
  WidgetTester tester,
  AuthState state, {
  bool settle = true,
}) => _pumpWith(tester, () => _FixedAuthController(state), settle: settle);

Future<void> _pumpWith(
  WidgetTester tester,
  AuthController Function() create, {
  bool settle = true,
}) async {
  final dio = Dio()
    ..httpClientAdapter = StubAdapter(
      (options) async =>
          jsonResponse(<String, Object?>{'status': 'ok', 'service': 'api'}),
    );
  addTearDown(dio.close);

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        flavorProvider.overrideWithValue(Flavor.staging),
        // The generated client over a stub transport, so the readiness probe
        // needs no network.
        restClientProvider.overrideWithValue(
          RestClient(dio, baseUrl: 'https://api.staging.flexcalendar.de'),
        ),
        authControllerProvider.overrideWith(create),
      ],
      child: const FlexCalendarApp(),
    ),
  );
  // A screen that is showing a spinner (the restore, or a sign-in in flight)
  // never settles; a test that pumps one asks for a single frame instead.
  if (settle) await tester.pumpAndSettle();
}

/// A controller pinned to one state, for the state tests.
class _FixedAuthController extends AuthController {
  _FixedAuthController(this.initial);

  final AuthState initial;

  @override
  AuthState build() => initial;
}

/// A controller that records the button's call instead of running the flow.
class _RecordingAuthController extends AuthController {
  AuthState initial = const SignedOut();
  int signInCalls = 0;
  int signOutCalls = 0;

  @override
  AuthState build() => initial;

  @override
  Future<void> signIn() async {
    signInCalls++;
  }

  @override
  Future<void> signOut() async {
    signOutCalls++;
  }
}
