# `apps/mobile/android/` — Android project and native sync adapter

This is the Flutter project's Android module. Its Flutter-generated contents
arrive with [E10-R01](../../../docs/epics/E10-mobile-app.md); the part that is
ours by design is the **`CalendarContract` sync adapter**.

**Owning epic:** [E11 — Android sync adapter (native Kotlin)](../../../docs/epics/E11-android-sync-adapter.md).

- **Toolchain pins**
  ([E02-R02](../../../docs/epics/E02-repo-tooling-ci.md)): **Gradle 9.8.0** by
  version and SHA-256 (`gradle/wrapper/gradle-wrapper.properties`), **JDK 21**
  as a Java toolchain (`build.gradle.kts`, fetched by the foojay resolver when
  the machine lacks it), **AGP 9.4.1** and **Kotlin 2.4.20**
  (`settings.gradle.kts`). The Flutter scaffold (E10-R01) adds the `:app` module
  and the sync-adapter module; keep the pins when it does. Nothing a build
  generates belongs here: `build/`, `.gradle/` and `local.properties` stay
  untracked.
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
