import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The three shipping flavors (E10-R01).
///
/// The API base URL of each flavor lives here, in Dart, not in the Android
/// build: `lib/main.dart` selects `dev`, `lib/main_staging.dart` selects
/// `staging` and `lib/main_prod.dart` selects `prod`, and a build names both
/// the Android flavor and the entry point (`apps/mobile/README.md` § Flavors).
enum Flavor {
  /// The local stack (E02-R03), HTTPS on 8443 because rootless containers
  /// cannot bind 443 (`docs/02-technology-choices.md` § Runtime layout).
  dev('dev', 'https://api.localhost:8443', 'https://auth.localhost:8443'),

  /// `api.staging.flexcalendar.de` (`docs/02-technology-choices.md` § Hosting).
  staging(
    'staging',
    'https://api.staging.flexcalendar.de',
    'https://auth.staging.flexcalendar.de',
  ),

  /// `api.flexcalendar.de` and `auth.flexcalendar.de`.
  prod('prod', 'https://api.flexcalendar.de', 'https://auth.flexcalendar.de');

  const Flavor(this.name, this.defaultApiBaseUrl, this.defaultIssuer);

  /// `dev`, `staging` or `prod`, matching the Android product flavor.
  final String name;

  /// The API this flavor talks to, unless a build overrides it.
  final String defaultApiBaseUrl;

  /// The Zitadel issuer this flavor authenticates against (D-03), unless a
  /// build overrides it. The OIDC discovery document lives under it.
  final String defaultIssuer;

  /// The base URL this process uses: the flavor's default, or the value a build
  /// passes as `--dart-define=CALFLEX_API_BASE_URL=https://…` (a device pointed
  /// at another host, or a test build against a throwaway one).
  String get apiBaseUrl {
    const override = String.fromEnvironment('CALFLEX_API_BASE_URL');
    return override.isEmpty ? defaultApiBaseUrl : override;
  }

  /// The issuer this process uses: the flavor's default, or the value a build
  /// passes as `--dart-define=CALFLEX_OIDC_ISSUER=https://…` (an emulator that
  /// reaches the local stack through `adb reverse`, say).
  String get issuer {
    const override = String.fromEnvironment('CALFLEX_OIDC_ISSUER');
    return override.isEmpty ? defaultIssuer : override;
  }
}

/// The flavor this process runs as.
///
/// It has no default on purpose: every entry point (`lib/main.dart`,
/// `lib/main_staging.dart`, `lib/main_prod.dart`) overrides it, so a build that
/// forgot to name one fails loudly instead of quietly talking to production.
final flavorProvider = Provider<Flavor>(
  (ref) =>
      throw StateError('flavorProvider must be overridden by the entry point.'),
);
