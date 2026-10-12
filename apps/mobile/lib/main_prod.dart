import 'bootstrap.dart';
import 'src/flavor.dart';

/// The `prod` flavor (E10-R01): `api.flexcalendar.de`.
///
/// Build or run it as `flutter build apk --flavor prod -t lib/main_prod.dart`.
Future<void> main() => bootstrap(Flavor.prod);
