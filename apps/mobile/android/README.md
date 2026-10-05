# `apps/mobile/android/` — Android project and native sync adapter

This is the Flutter project's Android module. Its Flutter-generated contents
arrive with [E10-R01](../../../docs/epics/E10-mobile-app.md); the part that is
ours by design is the **`CalendarContract` sync adapter**.

**Owning epic:** [E11 — Android sync adapter (native Kotlin)](../../../docs/epics/E11-android-sync-adapter.md).

- **Toolchain pins**
  ([E02-R02](../../../docs/epics/E02-repo-tooling-ci.md)):
  [`gradle/wrapper/gradle-wrapper.properties`](gradle/wrapper/gradle-wrapper.properties)
  pins **Gradle 9.3.1** by version and SHA-256, and
  [`gradle/gradle-daemon-jvm.properties`](gradle/gradle-daemon-jvm.properties)
  pins **JDK 21** through Gradle's daemon JVM criteria, so every build of this
  project runs on Java 21 whatever JDK happens to be on `PATH`. The **Android
  Gradle Plugin and Kotlin Gradle Plugin are not pinned here**: the Flutter
  scaffold (E10-R01) sets them from the Flutter release that
  [`../.fvmrc`](../.fvmrc) pins. Keep the Gradle wrapper and the JDK criteria
  when that scaffold lands. Nothing a build generates belongs here: `build/`,
  `.gradle/` and `local.properties` stay untracked.
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
