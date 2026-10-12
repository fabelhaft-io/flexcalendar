import 'package:calendar_flex/src/auth/oidc_config.dart';
import 'package:calendar_flex/src/flavor.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('OidcConfig.forFlavor', () {
    test('each flavor resolves its documented issuer (docs/02 § Hosting)', () {
      expect(Flavor.dev.defaultIssuer, 'https://auth.localhost:8443');
      expect(
        Flavor.staging.defaultIssuer,
        'https://auth.staging.flexcalendar.de',
      );
      expect(Flavor.prod.defaultIssuer, 'https://auth.flexcalendar.de');
      // No `CALFLEX_OIDC_ISSUER` is set in a test process, so the flavor's own
      // issuer is the one the provider hands to `forFlavor`.
      expect(Flavor.dev.issuer, Flavor.dev.defaultIssuer);
      expect(Flavor.staging.issuer, Flavor.staging.defaultIssuer);
      expect(Flavor.prod.issuer, Flavor.prod.defaultIssuer);
    });

    test('dev may talk to a plaintext issuer', () {
      final config = OidcConfig.forFlavor(
        Flavor.dev,
        issuer: 'http://10.0.2.2:8443',
        clientId: 'de.flexcalendar.app',
        projectId: '123456789012345678',
      );

      expect(config.issuer, 'http://10.0.2.2:8443');
      expect(config.allowInsecureConnections, isTrue);
    });

    test('dev keeps TLS when its issuer is TLS', () {
      final config = OidcConfig.forFlavor(
        Flavor.dev,
        issuer: Flavor.dev.defaultIssuer,
        clientId: 'de.flexcalendar.app',
        projectId: '123456789012345678',
      );

      expect(config.allowInsecureConnections, isFalse);
    });

    for (final flavor in <Flavor>[Flavor.staging, Flavor.prod]) {
      test('${flavor.name} accepts its own https issuer', () {
        final config = OidcConfig.forFlavor(
          flavor,
          issuer: flavor.defaultIssuer,
          clientId: 'de.flexcalendar.app',
          projectId: '123456789012345678',
        );

        expect(config.issuer, flavor.defaultIssuer);
        expect(config.allowInsecureConnections, isFalse);
      });

      test('${flavor.name} refuses a plaintext issuer, loudly', () {
        expect(
          () => OidcConfig.forFlavor(
            flavor,
            issuer: 'http://auth.example.test',
            clientId: 'de.flexcalendar.app',
            projectId: '123456789012345678',
          ),
          throwsA(
            isA<StateError>().having(
              (error) => error.message,
              'message',
              contains('http://auth.example.test'),
            ),
          ),
        );
      });
    }

    test('the scopes ask for a refresh token and the project audience', () {
      final config = OidcConfig.forFlavor(
        Flavor.prod,
        issuer: Flavor.prod.defaultIssuer,
        clientId: 'de.flexcalendar.app',
        projectId: '123456789012345678',
      );

      expect(config.scopes, [
        'openid',
        'profile',
        'email',
        'offline_access',
        'urn:zitadel:iam:org:project:id:123456789012345678:aud',
      ]);
      expect(OidcConfig.redirectUrl, 'de.flexcalendar.app:/oauth2redirect');
      expect(OidcConfig.postLogoutRedirectUrl, 'de.flexcalendar.app:/logout');
    });
  });
}
