# `flutter/` — E12-R02 probe on an Android emulator or device

Part of [E12-R02](../../../docs/epics/E12-crypto-core.md) — see
[`../README.md`](../README.md) for what the probe checks and why, and
[`docs/verification/crypto-libs-2026-10-12.md`](../../../docs/verification/crypto-libs-2026-10-12.md)
for the recorded result.

A minimal Flutter app (Flutter 3.47.6 / Dart 3.13.5, Android only, `minSdk = 26` as
[`apps/mobile`](../../../apps/mobile/pubspec.yaml)) that depends on **`sodium_libs` 4.0.1** — the package ADR 0001
names — and calls every primitive the epic lists. `sodium_libs` 4.0.1 resolves `sodium` 4.1.1+2, which builds
libsodium 1.0.22 from its vendored source through a build hook during the Android build.

With the pinned Flutter on `PATH` and an emulator or device attached (`flutter devices` lists the ids):

```sh
flutter pub get
flutter analyze
flutter test integration_test -d <device-id>   # the run the verification doc needs: paste its output
flutter test                                   # the same checks on the host VM, no device needed
flutter run -d <device-id>                     # optional: shows the report on screen
```

`integration_test/crypto_libs_test.dart` prints the whole report and then asserts it (no gaps, no failures, the frozen
cross-probe values). The `device.*` lines it prints — `ro.build.version.sdk`, `ro.product.cpu.abi`,
`ro.product.manufacturer`/`model`, `Platform.operatingSystemVersion` — are what the verification doc's versions table
wants for the ABI and API level.

Nothing here is iOS-shaped: as the requirement says, E10's iOS build repeats the check in Phase 5. `local.properties`,
`.dart_tool/`, `build/`, the Gradle wrapper and `pubspec.lock` are generated and stay untracked.
