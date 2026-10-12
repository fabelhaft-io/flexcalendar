import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'src/api/api_providers.dart';
import 'src/app.dart';
import 'src/flavor.dart';
import 'src/timezones.dart';

/// Starts the app for one flavor.
///
/// Each entry point (`main.dart`, `main_staging.dart`, `main_prod.dart`) calls
/// this with its own flavor, which fixes the API base URL for the whole process
/// (`apps/mobile/README.md` § Flavors).
Future<void> bootstrap(Flavor flavor) async {
  WidgetsFlutterBinding.ensureInitialized();
  // Before the first TZDateTime: all TZID arithmetic goes through `timezone`
  // (INV-04).
  initializeAppTimeZones();
  runApp(
    ProviderScope(
      overrides: [flavorProvider.overrideWithValue(flavor)],
      child: const FlexCalendarApp(),
    ),
  );
}
