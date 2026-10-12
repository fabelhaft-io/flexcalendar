import 'bootstrap.dart';
import 'src/flavor.dart';

/// The `staging` flavor (E10-R01): `api.staging.flexcalendar.de`.
///
/// Build or run it as `flutter build apk --flavor staging -t lib/main_staging.dart`.
Future<void> main() => bootstrap(Flavor.staging);
