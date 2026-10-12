# `apps/mobile/` — Flutter mobile app

**Owning epic:** [E10 — Flutter mobile app](../../docs/epics/E10-mobile-app.md).

- **What belongs here:** one Flutter (Dart 3) codebase for Android (minSdk 26)
  and iOS 16+, with Riverpod, `dio` plus the client generated from
  [`spec/openapi.yaml`](../../spec/openapi.yaml), Drift (SQLite) for the offline
  cache, `timezone` for every `TZID` calculation (never raw `DateTime` — INV-04),
  and flavors `dev|staging|prod` (ADR 0002,
  `docs/02-technology-choices.md` § Mobile clients). The app is a REST client:
  it never talks to CalDAV itself, and it sends recurring-event edits as intents
  (INV-05).
- **`android/`** holds the project's native Kotlin `CalendarContract` sync
  adapter, with **no Dart in its sync path** — see
  [`android/README.md`](android/README.md) and
  [E11](../../docs/epics/E11-android-sync-adapter.md).
- **Toolchain pins**
  ([E02-R02](../../docs/epics/E02-repo-tooling-ci.md)): [`.fvmrc`](.fvmrc) pins
  **Flutter 3.47.6** (stable, Dart 3.13.5) and [`pubspec.yaml`](pubspec.yaml)
  pins the SDK (`Dart ^3.13.5`, Flutter `>=3.47.6 <4.0.0`). The Gradle wrapper
  and JDK pins for the `android/` module live in
  [`android/README.md`](android/README.md); the Android Gradle Plugin and Kotlin
  Gradle Plugin are set by the E10-R01 scaffold from the pinned Flutter release.
  The app scaffold and its additional dependencies arrive with E10-R01.
  E02-R07 tracks `pubspec.lock` for the API client now.

## API client generation (E02-R07)

`swagger_parser.yaml` reads `../../spec/openapi.yaml` (OpenAPI 3.1.0) and writes
`lib/api/`. This directory is entirely generated and replaced whole by `make gen`,
so files removed from the spec cannot linger. No app entry point or
Flutter framework dependency is scaffolded here.
Generator and runtime dependencies are exact pins in `pubspec.yaml`; transitive
versions are locked in `pubspec.lock`. `analyzer` is pinned to 13.3.0 because
build_runner 2.16.1 uses `contextFeatures`, removed in analyzer 14.x.

With the pinned Flutter 3.47.6 / Dart 3.13.5 on PATH, run `make gen` at the root.
It runs `flutter pub get`, `dart run swagger_parser` (1.45.0),
`dart run build_runner build` (Retrofit and JSON serialization), then `dart format
lib/api`, through `infra/scripts/gen-dart.mjs`. The script moves the old
`lib/api/` aside first and puts it back, failing, when swagger_parser prints
"No schemes were generated" (1.45.0 exits 0 then) or leaves no Dart file, and it
refuses a path-level `parameters:` list in the spec before running anything,
because 1.45.0 dies on one. All generators are pure Dart; no JVM. Commit all generated files and
the lockfile. `make gen-check` detects stale, missing and untracked generated
files and runs through `make verify`. `make verify-apps-mobile` checks formatting,
analysis and the `package:test` stub-dio decoding test.
