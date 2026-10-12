import 'package:flutter/foundation.dart';

import '../flavor.dart';

/// The OIDC configuration of one flavor (E10-R02), against the Zitadel the
/// E02-R09 configuration registers as application `de.flexcalendar.app`.
///
/// The client id and the project id are **not** in this file: Zitadel generates
/// the client id, and both reach the build as `--dart-define` values so a build
/// against a different environment cannot silently reuse production's.
///
/// A build gets its instance from [OidcConfig.forFlavor], which refuses a
/// plaintext issuer outside `dev`; the bare constructor is the value object
/// underneath it.
@immutable
class OidcConfig {
  const OidcConfig({
    required this.issuer,
    required this.clientId,
    required this.projectId,
    this.allowInsecureConnections = false,
  });

  /// The configuration of [flavor], over the issuer that flavor resolved.
  ///
  /// **Only `dev` may talk to a plaintext issuer.** The sign-in carries the
  /// user's password into the browser, and `docs/02-technology-choices.md`
  /// § Hosting puts TLS on everything but the local stack, so a `staging` or
  /// `prod` build that was pointed at `http://` is refused loudly here — the
  /// way a missing client id is — instead of sending the login in the clear.
  /// A `dev` build may use `http://` (an emulator or a device reaching the
  /// local stack through `adb reverse`), and only then does AppAuth get
  /// [allowInsecureConnections].
  factory OidcConfig.forFlavor(
    Flavor flavor, {
    required String issuer,
    required String clientId,
    required String projectId,
  }) {
    final secure = issuer.startsWith('https://');
    if (!secure && flavor != Flavor.dev) {
      throw StateError(
        'The ${flavor.name} flavor refuses the plaintext OIDC issuer '
        '"$issuer": only the dev flavor may use an http:// issuer '
        '(docs/02-technology-choices.md § Hosting). Pass '
        '--dart-define=CALFLEX_OIDC_ISSUER=https://… instead.',
      );
    }
    return OidcConfig(
      issuer: issuer,
      clientId: clientId,
      projectId: projectId,
      allowInsecureConnections: !secure && flavor == Flavor.dev,
    );
  }

  /// The Zitadel issuer, e.g. `https://auth.flexcalendar.de`. AppAuth reads the
  /// discovery document (`/.well-known/openid-configuration`) under it.
  final String issuer;

  /// The public native client Zitadel generated (E02-R09, `outputs.tf`).
  final String clientId;

  /// The Zitadel project id, needed to ask for the audience scope the API
  /// validates (from-E05-R01).
  final String projectId;

  /// Whether AppAuth may talk to a plaintext (`http://`) issuer (E10-R02).
  ///
  /// It is not derived from [issuer] where it is read, because that would make
  /// every flavor insecure for an `http://` issuer; [OidcConfig.forFlavor] sets
  /// it for a `dev` build only.
  final bool allowInsecureConnections;

  /// The registered redirect URI (E02-R09). The scheme is the one the Android
  /// manifest placeholder `appAuthRedirectScheme` carries.
  static const String redirectUrl = 'de.flexcalendar.app:/oauth2redirect';

  /// The registered post-logout redirect URI (E02-R09).
  static const String postLogoutRedirectUrl = 'de.flexcalendar.app:/logout';

  /// The project audience scope the API's JWKS validation needs, so a token
  /// issued for another project is refused.
  String get audienceScope => 'urn:zitadel:iam:org:project:id:$projectId:aud';

  /// `openid profile email offline_access` plus the audience scope
  /// (from-E05-R01). `offline_access` is what makes Zitadel issue the refresh
  /// token the interceptor rotates.
  List<String> get scopes => <String>[
    'openid',
    'profile',
    'email',
    'offline_access',
    audienceScope,
  ];
}
