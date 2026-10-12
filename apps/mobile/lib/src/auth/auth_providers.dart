import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../flavor.dart';
import 'auth_controller.dart';
import 'auth_state.dart';
import 'oidc_client.dart';
import 'oidc_config.dart';
import 'sign_out_hooks.dart';
import 'token_store.dart';

/// The client id Zitadel generated for `de.flexcalendar.app` (E02-R09,
/// `infra/zitadel/outputs.tf`). It is not in the source: a build passes it as
/// `--dart-define=CALFLEX_OIDC_CLIENT_ID=…`.
const String _clientId = String.fromEnvironment('CALFLEX_OIDC_CLIENT_ID');

/// The Zitadel project id, for the audience scope. Passed as
/// `--dart-define=CALFLEX_OIDC_PROJECT_ID=…` (`infra/zitadel/outputs.tf`).
const String _projectId = String.fromEnvironment('CALFLEX_OIDC_PROJECT_ID');

/// Where the tokens live: Keystore-backed secure storage, nothing else.
final tokenStoreProvider = Provider<TokenStore>((ref) => SecureTokenStore());

/// The OIDC configuration for the flavor this process runs as.
///
/// It throws when the client id or the project id is missing, the way
/// `flavorProvider` throws when no entry point set a flavor: a build that
/// forgot its `--dart-define`s fails loudly at start instead of silently
/// signing in against the wrong client.
final oidcConfigProvider = Provider<OidcConfig>((ref) {
  if (_clientId.isEmpty || _projectId.isEmpty) {
    throw StateError(
      'CALFLEX_OIDC_CLIENT_ID and CALFLEX_OIDC_PROJECT_ID must be passed as '
      '--dart-define values (apps/mobile/README.md § Sign-in).',
    );
  }
  return OidcConfig(
    issuer: ref.watch(flavorProvider).issuer,
    clientId: _clientId,
    projectId: _projectId,
  );
});

/// The `flutter_appauth` client for the flavor's issuer.
final oidcClientProvider = Provider<OidcClient>(
  (ref) => AppAuthOidcClient(ref.watch(oidcConfigProvider)),
);

/// The list of local state that must go on sign-out. E10-R02 runs it; later
/// requirements register into it (the cache E10-R03, the keys E12-R06, the push
/// token E07-R03).
final signOutHooksProvider = Provider<SignOutHooks>((ref) => SignOutHooks());

/// The session state the UI watches.
final authControllerProvider = NotifierProvider<AuthController, AuthState>(
  AuthController.new,
);
