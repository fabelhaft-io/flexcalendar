import 'bootstrap.dart';
import 'src/flavor.dart';

/// The `dev` flavor (E10-R01): the local stack, HTTPS on 8443.
///
/// This is also the default target, so `flutter run` and `flutter build apk
/// --flavor dev` need no `-t`.
Future<void> main() => bootstrap(Flavor.dev);
