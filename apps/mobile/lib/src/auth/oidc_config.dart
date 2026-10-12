import 'package:flutter/foundation.dart';

/// The OIDC configuration of one flavor (E10-R02), against the Zitadel the
/// E02-R09 configuration registers as application `de.flexcalendar.app`.
///
/// The client id and the project id are **not** in this file: Zitadel generates
/// the client id, and both reach the build as `--dart-define` values so a build
/// against a different environment cannot silently reuse production's.
@immutable
class OidcConfig {
  const OidcConfig({
    required this.issuer,
    required this.clientId,
    required this.projectId,
  });

  /// The Zitadel issuer, e.g. `https://auth.flexcalendar.de`. AppAuth reads the
  /// discovery document (`/.well-known/openid-configuration`) under it.
  final String issuer;

  /// The public native client Zitadel generated (E02-R09, `outputs.tf`).
  final String clientId;

  /// The Zitadel project id, needed to ask for the audience scope the API
  /// validates (from-E05-R01).
  final String projectId;

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
