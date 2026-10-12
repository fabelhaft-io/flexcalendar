# `apps/mobile/android/` — Android project and native sync adapter

This is the Flutter project's Android module. Its Flutter-generated contents
arrived with [E10-R01](../../../docs/epics/E10-mobile-app.md); the part that is
ours by design is the **`CalendarContract` sync adapter**.

**Owning epic:** [E11 — Android sync adapter (native Kotlin)](../../../docs/epics/E11-android-sync-adapter.md).

## What E10-R01 added

- `settings.gradle.kts`, `build.gradle.kts`, `gradle.properties`,
  `app/build.gradle.kts`, `app/src/{main,debug,profile}/AndroidManifest.xml`,
  `app/src/main/kotlin/de/flexcalendar/app/MainActivity.kt` and the launcher
  resources: the Flutter app template for the pinned Flutter release, with the
  changes below.
- **Toolchain pins**
  ([E02-R02](../../../docs/epics/E02-repo-tooling-ci.md)):
  [`gradle/wrapper/gradle-wrapper.properties`](gradle/wrapper/gradle-wrapper.properties)
  pins **Gradle 9.3.1** by version and SHA-256, and
  [`gradle/gradle-daemon-jvm.properties`](gradle/gradle-daemon-jvm.properties)
  pins **JDK 21** through Gradle's daemon JVM criteria, so every build of this
  project runs on Java 21 whatever JDK happens to be on `PATH`. The template's
  own `gradle-wrapper.properties` (an unpinned `-all` distribution) was **not**
  taken: the pinned one stays. The **Android Gradle Plugin (9.1.0) and Kotlin
  Gradle Plugin (2.4.0)** are set here by the Flutter scaffold, from the release
  [`../.fvmrc`](../.fvmrc) pins — see `settings.gradle.kts`.
- **`minSdk = 26`** (Android 8) in `app/build.gradle.kts`. The Flutter template
  default is 24; ADR 0002 fixes 26.
- **Product flavors `dev`, `staging`, `prod`**, all with the **one** application
  ID `de.flexcalendar.app` and **no `applicationIdSuffix`**: the OIDC redirect
  scheme is registered once (PR #16, owner-approved). The API base URL is not in
  Gradle; it is Dart, per entry point ([`../README.md`](../README.md) § Flavors).
- **`android.permission.INTERNET` in the main manifest.** The template declares
  it only for debug and profile builds, where the Flutter tool needs it; a
  release APK that talks to the API needs it too.
- Nothing a build generates belongs here: `build/`, `.gradle/`,
  `local.properties` and `GeneratedPluginRegistrant.java` stay untracked
  ([`../.gitignore`](../.gitignore) and the repository root).

## What E10-R02 added

- **The `appAuthRedirectScheme` manifest placeholder.** `defaultConfig` in
  `app/build.gradle.kts` sets it to `de.flexcalendar.app`, which is what the
  `RedirectUriReceiverActivity` of AppAuth's Android library matches to receive
  the redirect URI E02-R09 registers (`de.flexcalendar.app:/oauth2redirect`).
  It is one value for all three flavors, because they share the one application
  ID; a build that leaves it unset fails in the manifest merger.

## Checks

This module builds with `flutter build apk --flavor dev --debug`, run from
`apps/mobile`. CI runs exactly that command — in the path that runs for
`apps/mobile` changes and in the full run
([`.github/workflows/verify.yml`](../../../.github/workflows/verify.yml)) — and
it needs the Android SDK plus a Java 21 toolchain, but no signing key and no
secret.

The Gradle daemon's JVM is pinned by `gradle/gradle-daemon-jvm.properties`, not
by the JDK on `PATH`. To see which JVM a build actually used, build once and
then read the daemon's command line:

```sh
cd apps/mobile/android
./gradlew --version          # wrapper and JVM that the wrapper selects
ps -o args= -p "$(jps -l | awk '/GradleDaemon/ {print $1; exit}')"
```

## The sync adapter (E11, Phase 6)

- Plain **Kotlin**, no Dart in the sync path, and no headless Flutter engine in
  `onPerformSync` (ADR 0002,
  `docs/02-technology-choices.md` § Android specifics).
- `dav4jvm` (MPL-2.0) for WebDAV/CalDAV and **iCal4j** for parsing and
  recurrence — the adapter's own recurrence authority (INV-05).
- Shared calendars only; it authenticates with a device app password (D-04), so
  INV-08 already hides Private collections from it.
- DAVx⁵'s own source is GPLv3: read it for reference only, and check licence
  compatibility before copying anything from it (`docs/02-technology-choices.md`
  § Android specifics).
- The Dart side reaches it through a Pigeon channel (register/remove the system
  account, trigger a manual sync) — never by putting Dart in the sync engine.
