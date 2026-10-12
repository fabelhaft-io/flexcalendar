# E12-R02 · Library capability check — crypto libraries

- **Requirement:** [E12-R02](../epics/E12-crypto-core.md) (`agent`), epic [E12 — Crypto core and shared test vectors](../epics/E12-crypto-core.md)
- **Spec:** ADR 0001 § Private calendars — cryptography, ADR 0002 § Consequences ("verify that `sodium_libs` covers
  XChaCha20-Poly1305, `crypto_box_seal`, Ed25519 and HKDF rather than assuming it"); D-17 (Argon2id is not needed)
- **Date:** 2026-10-12
- **Probe sources:** [`infra/crypto-libs-check/`](../../infra/crypto-libs-check/) — `dart_vm/`, `flutter/`, `node/`
- **Verdict:** **Dart VM: pass. Node (standard and sumo): pass, with gaps. Android (API 37 emulator, `x86_64`):
  pass**, run by the reviewer on 2026-10-12 (§ 2.2.2, § 7) — every check reproduced the Dart VM column, with
  `frozen_values=match`, exit 0. iOS is out of scope here by the requirement's own wording: E10's iOS build repeats
  this check in Phase 5.

Every primitive below was **called**, not just looked up: each probe encrypts and decrypts with associated data and
checks that a flipped tag byte *and* a flipped AAD byte fail, seals and opens a box and checks that the wrong
recipient fails, signs and verifies and checks that a changed message fails, derives with `crypto_kdf` and with
HKDF-SHA-256 (against RFC 5869), draws random bytes and prints the library's own version string.

All three probes also **assert the same frozen expectations** — the fixed-input byte values listed below
(`frozenValues` in `dart_vm/lib/checks.dart` and its copy under `flutter/lib/`, `FROZEN_VALUES` in
`node/lib/checks.mjs`) — and each prints `frozen_values=match`, or `frozen_values=MISMATCH` plus the mismatching
names on stderr, and exits 1. The Node probe's negative control is in § 2.3.

**No password-based key derivation is called anywhere** (D-17, INV-12): `crypto_pwhash` is only *listed* for presence,
and no key in any probe derives from a password. All keys, nonces, messages and the Ed25519 seed are fixed, invented
test values so the three probes print byte-identical hex; sealed boxes and the RNG are randomised, so only their round
trips and lengths are compared. Nothing under `server/**` was touched (INV-07).

## 1. Versions actually used

| What | Version | Where it comes from |
|---|---|---|
| Flutter / Dart | 3.47.6 stable, revision `5fc346839b5d0eef006ed8404392afb4dfae428d` / Dart 3.13.5 | the pin in [`apps/mobile/.fvmrc`](../../apps/mobile/.fvmrc) |
| `sodium_libs` (Flutter probe) | 4.0.1 | pub.dev, `implementation` of ADR 0001 § Private calendars |
| `sodium` (what `sodium_libs` 4.0.1 re-exports) | **4.1.1+2**, resolved from `sodium_libs`'s `sodium: ^4.0.3` | pub.dev; same version in the Flutter and the Dart VM probe |
| libsodium inside `sodium` (Dart VM / Android) | **1.0.22** (`version_string=1.0.22`, major 26 minor 4) | built from the `3rdparty/libsodium-1.0.22-stable.tar.gz` the package vendors, by its build hook |
| host libsodium (not used) | `/usr/lib/libsodium.so.26`, `version_string=1.0.22`, major 26 minor 4 | measured in `dart_vm/bin/system_libsodium.dart` |
| `libsodium-wrappers` (web, standard) | 0.8.4, `version_string=1.0.22` | npm, exact pin in `node/package.json` |
| `libsodium-wrappers-sumo` (web, sumo) | 0.8.4, `version_string=1.0.22` | npm, exact pin in `node/package.json` |
| Node | v24.17.0 | sandbox toolchain |
| Android emulator (reviewer's run, § 2.2.2) | API 37, Android 17, ABI `x86_64`, model `sdk_gphone16k_x86_64` (Google), AVD `Medium-Phone-Android-17`, Dart 3.13.5 on `android_x64` | `flutter test integration_test -d emulator-5554`, reviewer, 2026-10-12 |
| Android build toolchain (reviewer's run) | first Gradle build 445.9 s; it downloaded NDK `28.2.13676358` (r28c) into the host's Android SDK, which had only 27.1 before | Gradle's own download — the first Android build of this probe installs that NDK |

Two findings about the versions themselves, both worth a decision in E12-R01:

1. **`sodium_libs` is deprecated and contains no code.** `sodium_libs` 4.0.1's `lib/sodium_libs.dart` is a single
   re-export of `package:sodium/sodium.dart` (and `sodium_libs_sumo.dart` of `sodium_sumo.dart`), with a
   `@Deprecated` marker pointing at `sodium`; its `README.md` says the package "is no longer required", because
   `sodium` 4.x builds and bundles libsodium itself through a build hook. The probe therefore depends on
   `sodium_libs: 4.0.1` (to exercise the re-export on the device) but the checks are the same ones `sodium` runs.
2. **`sodium_libs` 4.0.1 resolves `sodium` to 4.1.1+2 on the pinned Flutter 3.47.6**, not to an older 4.0.x: from a
   clean state (`rm -rf pubspec.lock .dart_tool && flutter pub get`) the lockfile holds `sodium 4.1.1+2`, which
   satisfies `sdk: ^3.13.0` on Dart 3.13.5. (One observation for completeness: the very first `pub get`, run on the
   lockfile `flutter create` had written, picked `sodium 4.0.4`; it is not reproducible from a clean state and a clean
   resolution always yields 4.1.1+2.)

## 2. Commands run, with their output

### 2.1 Dart VM probe — `dart_vm/`

```
cd infra/crypto-libs-check/dart_vm
dart pub get
dart run bin/probe.dart          # `dart run`, not `dart bin/probe.dart`: only `dart run` honours build hooks
dart test                        # dev dependency on `package:test`: does `dart test` honour the build hook too?
```

`dart test` **does** honour the `sodium` build hook (asked because `packages/crypto_dart`'s tests in E12-R01/R03 run
under `dart test`, not `flutter test`), `exit 0`:

```text
Running build hooks...[sodium] WARNING: configure: WARNING: On this platform, SIGABRT cannot be caught using signal handlers.

Running build hooks...00:00 +0: loading test/checks_test.dart
00:00 +0: test/checks_test.dart: libsodium initialises and reproduces the frozen values
00:00 +1: All tests passed!
```

Output (`exit 0`; the two `Running build hooks...` lines are stderr from the `sodium` build hook compiling libsodium
1.0.22 from the vendored source archive on the first run — later runs reuse `.dart_tool/`):

```text
# E12-R02 crypto-libs probe — sodium 4.1.1+2 on the Dart VM (Dart 3.13.5)
probe.library=sodium
probe.package_version=4.1.1+2
probe.implementation=native assets: libsodium built from the package's vendored source by the sodium build hook; loaded /home/jano/IdeaProjects/flexcalendar-agent-E12-R02/infra/crypto-libs-check/dart_vm/.dart_tool/lib/libsodium.so
sodium.version_string=1.0.22
sodium.library_version.major=26
sodium.library_version.minor=4
crypto_pwhash.present=yes (native build; reachable only through the SodiumSumo API)
crypto_pwhash.called=no (D-17: no key derives from the login password)
aead.xchacha20poly1305_ietf.key=000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
aead.xchacha20poly1305_ietf.nonce=404142434445464748494a4b4c4d4e4f5051525354555657
aead.xchacha20poly1305_ietf.message=666c657863616c656e646172204531322d5230322070726f6265
aead.xchacha20poly1305_ietf.aad=63616c666c65782d76312d70726f62652d616164
aead.xchacha20poly1305_ietf.key_bytes=32
aead.xchacha20poly1305_ietf.nonce_bytes=24
aead.xchacha20poly1305_ietf.tag_bytes=16
aead.xchacha20poly1305_ietf.ciphertext=b2556008b3811573e190e6cc8fd954a0bfe89df6332921f50854c535933ba4680105dbb564a0cacb1b6a
aead.xchacha20poly1305_ietf.ciphertext_bytes=42
aead.xchacha20poly1305_ietf.decrypted=666c657863616c656e646172204531322d5230322070726f6265
aead.xchacha20poly1305_ietf.result=ok
aead.xchacha20poly1305_ietf.flipped_tag=rejected (SodiumException)
aead.xchacha20poly1305_ietf.flipped_aad=rejected (SodiumException)
box.seal.message_bytes=26
box.seal.ciphertext_bytes=74
box.seal.overhead_bytes=48
box.seal.constant_seal_bytes=48
box.seal.roundtrip.result=ok
box.seal.wrong_recipient=rejected (SodiumException)
sign.ed25519.seed=202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f
sign.ed25519.message=666c657863616c656e646172204531322d5230322070726f6265
sign.ed25519.public_key=29acbae141bccaf0b22e1a94d34d0bc7361e526d0bfe12c89794bc9322966dd7
sign.ed25519.signature=a0060e738f9b9107b9656b9cebc3721bf9425295af8f6b11ce030a14cee9dbe77ac9f6ed23acb6bb8b423cad37e6fa8ba707780f011a0428926df206d3ab900c
sign.ed25519.verify.result=ok
sign.ed25519.flipped_message=rejected
kdf.derive_from_key.master_key=606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f
kdf.derive_from_key.context=calflex1
kdf.derive_from_key.subkey_id=1
kdf.derive_from_key.context_bytes=8
kdf.derive_from_key.key_bytes=32
kdf.derive_from_key.subkey=a377a3cab11df056b2f26740a10101b9fb451c47d5e393da2c3312dd064d9f9e
kdf.derive_from_key.result=ok
kdf.hkdf_sha256.in_library=yes
kdf.hkdf_sha256.key_bytes=32
kdf.hkdf_sha256.bytes_min=0
kdf.hkdf_sha256.bytes_max=8160
kdf.hkdf_sha256.context_bytes=not fixed (arbitrary UTF-8 info)
kdf.hkdf_sha256.rfc5869_tc1_prk=077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5
kdf.hkdf_sha256.rfc5869_tc1_info=f0f1f2f3f4f5f6f7f8f9 (10 non-ASCII bytes: not expressible through the Dart API, which takes the info as a String and encodes it as UTF-8; the RFC 5869 A.1 OKM is checked on the Node side instead)
kdf.hkdf_sha256.rfc5869_tc1_okm42=not reachable through this API
kdf.hkdf_sha256.rfc5869_tc1_okm42_rfc=3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865
kdf.hkdf_sha256.rfc5869_tc3_prk=19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04
kdf.hkdf_sha256.rfc5869_tc3_okm42=8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8
kdf.hkdf_sha256.result=ok
kdf.hkdf_sha256.ascii_info=calflexhk
kdf.hkdf_sha256.ascii_info_okm42=8f1021c886806450618d011707fd796d80c674f1258afcb6c2f7e92ab407e3234e4c8778a10ebbe432ce
randombytes.buf.length=32
randombytes.buf.two_draws_differ=yes
randombytes.buf.not_all_zero=yes
frozen_values=match
```

And the host libsodium, measured separately (`dart run bin/system_libsodium.dart`, `exit 0`). It shows the dev host has
`/usr/lib/libsodium.so.26` (1.0.22) with every primitive present — but `sodium` 4.x does **not** bind it, so this is
context, not coverage:

```text
system_libsodium.path=/usr/lib/libsodium.so.26
system_libsodium.sodium_init=0
system_libsodium.version_string=1.0.22
system_libsodium.library_version=26.4
system_libsodium.symbol.crypto_aead_xchacha20poly1305_ietf_encrypt=present
system_libsodium.symbol.crypto_aead_xchacha20poly1305_ietf_decrypt=present
system_libsodium.symbol.crypto_box_seal=present
system_libsodium.symbol.crypto_box_seal_open=present
system_libsodium.symbol.crypto_sign_detached=present
system_libsodium.symbol.crypto_sign_verify_detached=present
system_libsodium.symbol.crypto_kdf_derive_from_key=present
system_libsodium.symbol.crypto_kdf_hkdf_sha256_extract=present
system_libsodium.symbol.crypto_kdf_hkdf_sha256_expand=present
system_libsodium.symbol.crypto_auth_hmacsha256_init=present
system_libsodium.symbol.randombytes_buf=present
system_libsodium.symbol.sodium_version_string=present
system_libsodium.symbol.crypto_pwhash=present
system_libsodium.symbols_missing=0
system_libsodium.note=loaded directly with DynamicLibrary.open; the `sodium` 4.x package does not use it (see probe.dart)
```

### 2.2 Flutter probe — `flutter/`

Written completely, resolved and analysed, and its checks **run for real twice**: through the Flutter toolchain on
the host (`flutter test`, § 2.2.1) and on an Android emulator by the reviewer (§ 2.2.2, 2026-10-12). The host run is
also where the frozen cross-probe values are asserted.

#### 2.2.1 The host run — `flutter test`

```
cd infra/crypto-libs-check/flutter
flutter pub get
flutter analyze
flutter test
```

```text
Analyzing flutter...                                            
No issues found! (ran in 2.1s)
```

```text
[sodium] WARNING: configure: WARNING: On this platform, SIGABRT cannot be caught using signal handlers.

00:00 +0: loading /home/jano/IdeaProjects/flexcalendar-agent-E12-R02/infra/crypto-libs-check/flutter/test/crypto_libs_test.dart
00:00 +0: every primitive E12-R02 names works, with the frozen values
# E12-R02 crypto-libs probe — sodium_libs 4.0.1 on Flutter/Android
device.os=linux
device.os_version=Linux 7.2.9-2-cachyos #1 SMP PREEMPT_DYNAMIC Fri, 09 Oct 2026 15:36:46 +0000
device.dart_version=3.13.5 (stable) (Tue Sep 29 01:00:52 2026 -0700) on "linux_x64"
probe.library=sodium_libs
probe.package_version=4.0.1
probe.implementation=native assets: libsodium built from the source archive `sodium` vendors, by its build hook, for linux — this is the host `flutter test` run, not the Android one
sodium.version_string=1.0.22
sodium.library_version.major=26
sodium.library_version.minor=4
crypto_pwhash.present=yes (native build; reachable only through the SodiumSumo API)
crypto_pwhash.called=no (D-17: no key derives from the login password)
aead.xchacha20poly1305_ietf.key=000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
aead.xchacha20poly1305_ietf.nonce=404142434445464748494a4b4c4d4e4f5051525354555657
aead.xchacha20poly1305_ietf.message=666c657863616c656e646172204531322d5230322070726f6265
aead.xchacha20poly1305_ietf.aad=63616c666c65782d76312d70726f62652d616164
aead.xchacha20poly1305_ietf.key_bytes=32
aead.xchacha20poly1305_ietf.nonce_bytes=24
aead.xchacha20poly1305_ietf.tag_bytes=16
aead.xchacha20poly1305_ietf.ciphertext=b2556008b3811573e190e6cc8fd954a0bfe89df6332921f50854c535933ba4680105dbb564a0cacb1b6a
aead.xchacha20poly1305_ietf.ciphertext_bytes=42
aead.xchacha20poly1305_ietf.decrypted=666c657863616c656e646172204531322d5230322070726f6265
aead.xchacha20poly1305_ietf.result=ok
aead.xchacha20poly1305_ietf.flipped_tag=rejected (SodiumException)
aead.xchacha20poly1305_ietf.flipped_aad=rejected (SodiumException)
box.seal.message_bytes=26
box.seal.ciphertext_bytes=74
box.seal.overhead_bytes=48
box.seal.constant_seal_bytes=48
box.seal.roundtrip.result=ok
box.seal.wrong_recipient=rejected (SodiumException)
sign.ed25519.seed=202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f
sign.ed25519.message=666c657863616c656e646172204531322d5230322070726f6265
sign.ed25519.public_key=29acbae141bccaf0b22e1a94d34d0bc7361e526d0bfe12c89794bc9322966dd7
sign.ed25519.signature=a0060e738f9b9107b9656b9cebc3721bf9425295af8f6b11ce030a14cee9dbe77ac9f6ed23acb6bb8b423cad37e6fa8ba707780f011a0428926df206d3ab900c
sign.ed25519.verify.result=ok
sign.ed25519.flipped_message=rejected
kdf.derive_from_key.master_key=606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f
kdf.derive_from_key.context=calflex1
kdf.derive_from_key.subkey_id=1
kdf.derive_from_key.context_bytes=8
kdf.derive_from_key.key_bytes=32
kdf.derive_from_key.subkey=a377a3cab11df056b2f26740a10101b9fb451c47d5e393da2c3312dd064d9f9e
kdf.derive_from_key.result=ok
kdf.hkdf_sha256.in_library=yes
kdf.hkdf_sha256.key_bytes=32
kdf.hkdf_sha256.bytes_min=0
kdf.hkdf_sha256.bytes_max=8160
kdf.hkdf_sha256.context_bytes=not fixed (arbitrary UTF-8 info)
kdf.hkdf_sha256.rfc5869_tc1_prk=077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5
kdf.hkdf_sha256.rfc5869_tc1_info=f0f1f2f3f4f5f6f7f8f9 (10 non-ASCII bytes: not expressible through the Dart API, which takes the info as a String and encodes it as UTF-8; the RFC 5869 A.1 OKM is checked on the Node side instead)
kdf.hkdf_sha256.rfc5869_tc1_okm42=not reachable through this API
kdf.hkdf_sha256.rfc5869_tc1_okm42_rfc=3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865
kdf.hkdf_sha256.rfc5869_tc3_prk=19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04
kdf.hkdf_sha256.rfc5869_tc3_okm42=8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8
kdf.hkdf_sha256.result=ok
kdf.hkdf_sha256.ascii_info=calflexhk
kdf.hkdf_sha256.ascii_info_okm42=8f1021c886806450618d011707fd796d80c674f1258afcb6c2f7e92ab407e3234e4c8778a10ebbe432ce
randombytes.buf.length=32
randombytes.buf.two_draws_differ=yes
randombytes.buf.not_all_zero=yes
frozen_values=match

00:00 +1: All tests passed!
```

#### 2.2.2 The Android run — reviewer, 2026-10-12

Run by the reviewer on the host's emulator (AVD `Medium-Phone-Android-17`, headless), with the pinned Flutter on
`PATH`:

```sh
cd infra/crypto-libs-check/flutter
flutter test integration_test -d emulator-5554        # -> All tests passed!, exit 0
```

`exit 0`, `All tests passed!`. The first Gradle build took **445.9 s** and downloaded **NDK `28.2.13676358` (r28c)**
into the host's Android SDK (which had only 27.1 before); later runs reuse it.

The device/header lines the integration test printed:

```text
device.os=android
device.os_version=CP31.260623.012 dev-keys
device.dart_version=3.13.5 (stable) (Tue Sep 29 01:00:52 2026 -0700) on "android_x64"
device.ro.build.version.sdk=37
device.ro.build.version.release=17
device.ro.product.cpu.abi=x86_64
device.ro.product.cpu.abis=<unset>
device.ro.product.manufacturer=Google
device.ro.product.model=sdk_gphone16k_x86_64
probe.library=sodium_libs
probe.package_version=4.0.1
sodium.version_string=1.0.22
sodium.library_version.major=26
sodium.library_version.minor=4
frozen_values=match
```

**Every other line of the report is identical to the Dart VM report in § 2.1** — checked with a sorted `diff` of the
fixed-input lines (AEAD ciphertext and plaintext, Ed25519 public key and signature, `crypto_kdf` subkey, HKDF A.1 PRK,
A.3 OKM and the ASCII-info OKM, sealed-box overhead: 9 lines, `identical`); a one-character change in the compared file
makes that `diff` fail, so the comparison is not vacuous. The results lines match § 2.1 as well, e.g.
`aead.xchacha20poly1305_ietf.flipped_tag=rejected (SodiumException)`, `…flipped_aad=rejected`,
`box.seal.wrong_recipient=rejected`, `sign.ed25519.flipped_message=rejected`, `kdf.hkdf_sha256.in_library=yes`,
`crypto_pwhash.present=yes (native build; reachable only through the SodiumSumo API)`, `crypto_pwhash.called=no`,
`randombytes.buf.two_draws_differ=yes`, and no `gap:` line. So the Android build of libsodium behaves exactly like the
Dart VM one on every primitive E12-R02 names, and the § 3 Android column is the Dart VM column.

#### 2.2.3 Why the agent did not run the Android probe

The agent sandbox has no Android SDK, so `flutter test integration_test -d …` and `flutter build apk` cannot run there
at all (`flutter doctor`):

```text
Doctor summary (to see all details, run flutter doctor -v):
[✓] Flutter (Channel stable, 3.47.6, on Arch Linux 7.2.9-2-cachyos, locale C.UTF-8)
[✗] Android toolchain - develop for Android devices
    ✗ Unable to locate Android SDK.
      Install Android Studio from: https://developer.android.com/studio/index.html
      On first launch it will assist you in installing the Android SDK components.
      (or visit https://flutter.dev/to/linux-android-setup for detailed instructions).
      If the Android SDK has been installed to a custom location, please use
      `flutter config --android-sdk` to update to that location.

[✗] Chrome - develop for the web (Cannot find Chrome executable at google-chrome)
    ! Cannot find Chrome. Try setting CHROME_EXECUTABLE to a Chrome executable.
[✓] Linux toolchain - develop for Linux desktop
[✓] Connected device (1 available)
[✓] Network resources

! Doctor found issues in 2 categories.
```

### 2.3 Node probe — `node/`

```
cd infra/crypto-libs-check/node
npm install
node probe.mjs          # libsodium-wrappers 0.8.4 (standard build)
node probe-sumo.mjs     # libsodium-wrappers-sumo 0.8.4 (sumo build)
node compare-exports.mjs
```

Standard build (`exit 0`):

```text
# E12-R02 crypto-libs probe — libsodium-wrappers 0.8.4 (standard)
node.version=v24.17.0
probe.library=libsodium-wrappers
probe.package_version=0.8.4
probe.implementation=sodium.js (bundled libsodium, standard build — the sumo build is probe-sumo.mjs)
sodium.version_string=1.0.22
aead.xchacha20poly1305_ietf.export.crypto_aead_xchacha20poly1305_ietf_encrypt=present
aead.xchacha20poly1305_ietf.export.crypto_aead_xchacha20poly1305_ietf_decrypt=present
box.seal.export.crypto_box_seal=present
box.seal.export.crypto_box_seal_open=present
sign.ed25519.export.crypto_sign_detached=present
sign.ed25519.export.crypto_sign_verify_detached=present
sign.ed25519.export.crypto_sign_seed_keypair=present
kdf.derive_from_key.export.crypto_kdf_derive_from_key=present
kdf.hkdf_sha256.export.crypto_kdf_hkdf_sha256_extract=absent
kdf.hkdf_sha256.export.crypto_kdf_hkdf_sha256_expand=absent
randombytes.buf.export.randombytes_buf=present
randombytes.buf.export.sodium_version_string=present
crypto_pwhash.present=no
crypto_pwhash.argon2id_present=no
crypto_pwhash.called=no (D-17: no key derives from the login password)
aead.xchacha20poly1305_ietf.key=000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
aead.xchacha20poly1305_ietf.nonce=404142434445464748494a4b4c4d4e4f5051525354555657
aead.xchacha20poly1305_ietf.message=666c657863616c656e646172204531322d5230322070726f6265
aead.xchacha20poly1305_ietf.aad=63616c666c65782d76312d70726f62652d616164
aead.xchacha20poly1305_ietf.key_bytes=32
aead.xchacha20poly1305_ietf.nonce_bytes=24
aead.xchacha20poly1305_ietf.tag_bytes=16
aead.xchacha20poly1305_ietf.ciphertext=b2556008b3811573e190e6cc8fd954a0bfe89df6332921f50854c535933ba4680105dbb564a0cacb1b6a
aead.xchacha20poly1305_ietf.ciphertext_bytes=42
aead.xchacha20poly1305_ietf.decrypted=666c657863616c656e646172204531322d5230322070726f6265
aead.xchacha20poly1305_ietf.result=ok
aead.xchacha20poly1305_ietf.flipped_tag=rejected (Error)
aead.xchacha20poly1305_ietf.flipped_aad=rejected (Error)
box.seal.message_bytes=26
box.seal.ciphertext_bytes=74
box.seal.overhead_bytes=48
box.seal.roundtrip.result=ok
box.seal.wrong_recipient=rejected (Error)
sign.ed25519.seed=202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f
sign.ed25519.message=666c657863616c656e646172204531322d5230322070726f6265
sign.ed25519.public_key=29acbae141bccaf0b22e1a94d34d0bc7361e526d0bfe12c89794bc9322966dd7
sign.ed25519.signature=a0060e738f9b9107b9656b9cebc3721bf9425295af8f6b11ce030a14cee9dbe77ac9f6ed23acb6bb8b423cad37e6fa8ba707780f011a0428926df206d3ab900c
sign.ed25519.verify.result=ok
sign.ed25519.flipped_message=rejected
kdf.derive_from_key.master_key=606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f
kdf.derive_from_key.context=calflex1
kdf.derive_from_key.subkey_id=1
kdf.derive_from_key.subkey=a377a3cab11df056b2f26740a10101b9fb451c47d5e393da2c3312dd064d9f9e
kdf.derive_from_key.result=ok
kdf.hkdf_sha256.in_library=no
kdf.hkdf_sha256.source=node:crypto (RFC 5869; this build exports no HKDF function)
kdf.hkdf_sha256.crypto_auth_hmacsha256=absent
kdf.hkdf_sha256.crypto_auth_hmacsha256_init=absent
kdf.hkdf_sha256.crypto_auth_hmacsha256_final=absent
kdf.hkdf_sha256.crypto_auth_hmacsha256_verify=absent
kdf.hkdf_sha256.hmac_sha256_in_library=no
kdf.hkdf_sha256.usable=no
kdf.hkdf_sha256.rfc5869_tc1_prk=077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5
kdf.hkdf_sha256.rfc5869_tc1_okm42=3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865
kdf.hkdf_sha256.rfc5869_tc3_prk=19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04
kdf.hkdf_sha256.rfc5869_tc3_okm42=8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8
kdf.hkdf_sha256.ascii_info=calflexhk
kdf.hkdf_sha256.ascii_info_okm42=8f1021c886806450618d011707fd796d80c674f1258afcb6c2f7e92ab407e3234e4c8778a10ebbe432ce
randombytes.buf.length=32
randombytes.buf.two_draws_differ=yes
randombytes.buf.not_all_zero=yes
aead.xchacha20poly1305_ietf.available=yes
gap: crypto_kdf_hkdf_sha256_extract is missing from libsodium-wrappers
gap: crypto_kdf_hkdf_sha256_expand is missing from libsodium-wrappers
gap: kdf.hkdf_sha256: libsodium-wrappers 0.8.4 exports the HKDF constants but not crypto_kdf_hkdf_sha256_extract/_expand
frozen_values=match
```

Sumo build (`exit 0`) — `diff` against the standard run is exactly: the `probe.*` header, the three
`crypto_pwhash.*` lines, the four `crypto_auth_hmacsha256*` lines plus `hmac_sha256_in_library`, and the `gap:` lines'
library name. Every other line, including every hex value, is byte-identical:

```text
# E12-R02 crypto-libs probe — libsodium-wrappers-sumo 0.8.4
node.version=v24.17.0
probe.library=libsodium-wrappers-sumo
probe.package_version=0.8.4
probe.implementation=sodium.js (bundled libsodium, sumo build)
sodium.version_string=1.0.22
aead.xchacha20poly1305_ietf.export.crypto_aead_xchacha20poly1305_ietf_encrypt=present
aead.xchacha20poly1305_ietf.export.crypto_aead_xchacha20poly1305_ietf_decrypt=present
box.seal.export.crypto_box_seal=present
box.seal.export.crypto_box_seal_open=present
sign.ed25519.export.crypto_sign_detached=present
sign.ed25519.export.crypto_sign_verify_detached=present
sign.ed25519.export.crypto_sign_seed_keypair=present
kdf.derive_from_key.export.crypto_kdf_derive_from_key=present
kdf.hkdf_sha256.export.crypto_kdf_hkdf_sha256_extract=absent
kdf.hkdf_sha256.export.crypto_kdf_hkdf_sha256_expand=absent
randombytes.buf.export.randombytes_buf=present
randombytes.buf.export.sodium_version_string=present
crypto_pwhash.present=yes
crypto_pwhash.argon2id_present=yes
crypto_pwhash.called=no (D-17: no key derives from the login password)
aead.xchacha20poly1305_ietf.key=000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
aead.xchacha20poly1305_ietf.nonce=404142434445464748494a4b4c4d4e4f5051525354555657
aead.xchacha20poly1305_ietf.message=666c657863616c656e646172204531322d5230322070726f6265
aead.xchacha20poly1305_ietf.aad=63616c666c65782d76312d70726f62652d616164
aead.xchacha20poly1305_ietf.key_bytes=32
aead.xchacha20poly1305_ietf.nonce_bytes=24
aead.xchacha20poly1305_ietf.tag_bytes=16
aead.xchacha20poly1305_ietf.ciphertext=b2556008b3811573e190e6cc8fd954a0bfe89df6332921f50854c535933ba4680105dbb564a0cacb1b6a
aead.xchacha20poly1305_ietf.ciphertext_bytes=42
aead.xchacha20poly1305_ietf.decrypted=666c657863616c656e646172204531322d5230322070726f6265
aead.xchacha20poly1305_ietf.result=ok
aead.xchacha20poly1305_ietf.flipped_tag=rejected (Error)
aead.xchacha20poly1305_ietf.flipped_aad=rejected (Error)
box.seal.message_bytes=26
box.seal.ciphertext_bytes=74
box.seal.overhead_bytes=48
box.seal.roundtrip.result=ok
box.seal.wrong_recipient=rejected (Error)
sign.ed25519.seed=202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f
sign.ed25519.message=666c657863616c656e646172204531322d5230322070726f6265
sign.ed25519.public_key=29acbae141bccaf0b22e1a94d34d0bc7361e526d0bfe12c89794bc9322966dd7
sign.ed25519.signature=a0060e738f9b9107b9656b9cebc3721bf9425295af8f6b11ce030a14cee9dbe77ac9f6ed23acb6bb8b423cad37e6fa8ba707780f011a0428926df206d3ab900c
sign.ed25519.verify.result=ok
sign.ed25519.flipped_message=rejected
kdf.derive_from_key.master_key=606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f
kdf.derive_from_key.context=calflex1
kdf.derive_from_key.subkey_id=1
kdf.derive_from_key.subkey=a377a3cab11df056b2f26740a10101b9fb451c47d5e393da2c3312dd064d9f9e
kdf.derive_from_key.result=ok
kdf.hkdf_sha256.in_library=no
kdf.hkdf_sha256.source=node:crypto (RFC 5869; this build exports no HKDF function)
kdf.hkdf_sha256.crypto_auth_hmacsha256=present
kdf.hkdf_sha256.crypto_auth_hmacsha256_init=present
kdf.hkdf_sha256.crypto_auth_hmacsha256_final=present
kdf.hkdf_sha256.crypto_auth_hmacsha256_verify=present
kdf.hkdf_sha256.hmac_sha256_in_library=yes
kdf.hkdf_sha256.usable=no
kdf.hkdf_sha256.rfc5869_tc1_prk=077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5
kdf.hkdf_sha256.rfc5869_tc1_okm42=3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865
kdf.hkdf_sha256.rfc5869_tc3_prk=19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04
kdf.hkdf_sha256.rfc5869_tc3_okm42=8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8
kdf.hkdf_sha256.ascii_info=calflexhk
kdf.hkdf_sha256.ascii_info_okm42=8f1021c886806450618d011707fd796d80c674f1258afcb6c2f7e92ab407e3234e4c8778a10ebbe432ce
randombytes.buf.length=32
randombytes.buf.two_draws_differ=yes
randombytes.buf.not_all_zero=yes
aead.xchacha20poly1305_ietf.available=yes
gap: crypto_kdf_hkdf_sha256_extract is missing from libsodium-wrappers-sumo
gap: crypto_kdf_hkdf_sha256_expand is missing from libsodium-wrappers-sumo
gap: kdf.hkdf_sha256: libsodium-wrappers-sumo 0.8.4 exports the HKDF constants but not crypto_kdf_hkdf_sha256_extract/_expand
frozen_values=match
```

**The frozen values, and the negative control.** Both probes assert the same ten expectations as the Dart probes —
`FROZEN_VALUES` in [`node/lib/checks.mjs`](../../infra/crypto-libs-check/node/lib/checks.mjs), identical to
`frozenValues` in [`dart_vm/lib/checks.dart`](../../infra/crypto-libs-check/dart_vm/lib/checks.dart) (AEAD ciphertext
and plaintext, sealed-box overhead, the Ed25519 public key and signature, the `crypto_kdf` subkey, and the four HKDF
values). The four HKDF lines come from `node:crypto` — neither web build exports an HKDF *function*, only the constants
(gap 1) — so `kdf.hkdf_sha256.source` says where the value came from; the line names and the expectations are still the
Dart ones, which is how a change in the RFC 5869 vectors fails the run.

A mismatch is a failure, not a printed diff. Changing **one character** of one expectation (the last byte of the AEAD
ciphertext, `…b6a` → `…b6b`) and running the probe makes it exit 1 (`exit code 1`; last two stdout lines):

```text
$ node probe.mjs           # with the 'aead…ciphertext' expectation tampered with; exit code 1
gap: kdf.hkdf_sha256: libsodium-wrappers 0.8.4 exports the HKDF constants but not crypto_kdf_hkdf_sha256_extract/_expand
frozen_values=MISMATCH
```

and stderr names the mismatching value:

```text
FAIL frozen value aead.xchacha20poly1305_ietf.ciphertext: expected b2556008b3811573e190e6cc8fd954a0bfe89df6332921f50854c535933ba4680105dbb564a0cacb1b6b, saw b2556008b3811573e190e6cc8fd954a0bfe89df6332921f50854c535933ba4680105dbb564a0cacb1b6a
```

`probe-sumo.mjs` uses the same comparison, so the same change fails it identically; with the expectation restored both
probes are back to `frozen_values=match`, exit 0. Before this, the Node probe had no frozen expectations at all, so a
regression of the web library would have changed only the printed hex and not the exit code.

Export comparison, the part that answers the epic's note about the non-sumo build (`exit 0`):

```text
node.version=v24.17.0
sodium.version_string.standard=1.0.22
sodium.version_string.sumo=1.0.22
standard.exports=289
sumo.exports=581

# presence per family (rows for the primitives E12-R02 names; the full matrix has one row per export)
crypto_aead_xchacha20poly1305_ietf_ABYTES	standard=constant	sumo=constant
crypto_aead_xchacha20poly1305_ietf_KEYBYTES	standard=constant	sumo=constant
crypto_aead_xchacha20poly1305_ietf_MESSAGEBYTES_MAX	standard=constant	sumo=constant
crypto_aead_xchacha20poly1305_ietf_NPUBBYTES	standard=constant	sumo=constant
crypto_aead_xchacha20poly1305_ietf_NSECBYTES	standard=constant	sumo=constant
crypto_aead_xchacha20poly1305_ietf_decrypt	standard=function	sumo=function
crypto_aead_xchacha20poly1305_ietf_decrypt_detached	standard=function	sumo=function
crypto_aead_xchacha20poly1305_ietf_encrypt	standard=function	sumo=function
crypto_aead_xchacha20poly1305_ietf_encrypt_detached	standard=function	sumo=function
crypto_aead_xchacha20poly1305_ietf_keygen	standard=function	sumo=function
crypto_box_keypair	standard=function	sumo=function
crypto_box_seal	standard=function	sumo=function
crypto_box_seal_open	standard=function	sumo=function
crypto_sign	standard=function	sumo=function
crypto_sign_detached	standard=function	sumo=function
crypto_sign_seed_keypair	standard=function	sumo=function
crypto_sign_verify_detached	standard=function	sumo=function
crypto_kdf_BYTES_MAX	standard=constant	sumo=constant
crypto_kdf_BYTES_MIN	standard=constant	sumo=constant
crypto_kdf_CONTEXTBYTES	standard=constant	sumo=constant
crypto_kdf_KEYBYTES	standard=constant	sumo=constant
crypto_kdf_blake2b_BYTES_MAX	standard=absent	sumo=constant
crypto_kdf_blake2b_BYTES_MIN	standard=absent	sumo=constant
crypto_kdf_blake2b_CONTEXTBYTES	standard=absent	sumo=constant
crypto_kdf_blake2b_KEYBYTES	standard=absent	sumo=constant
crypto_kdf_derive_from_key	standard=function	sumo=function
crypto_kdf_hkdf_sha256_BYTES_MAX	standard=constant	sumo=constant
crypto_kdf_hkdf_sha256_BYTES_MIN	standard=constant	sumo=constant
crypto_kdf_hkdf_sha256_KEYBYTES	standard=constant	sumo=constant
crypto_kdf_hkdf_sha512_BYTES_MAX	standard=constant	sumo=constant
crypto_kdf_hkdf_sha512_BYTES_MIN	standard=constant	sumo=constant
crypto_kdf_hkdf_sha512_KEYBYTES	standard=constant	sumo=constant
crypto_kdf_keygen	standard=function	sumo=function
crypto_kdf_hkdf_sha256_BYTES_MAX	standard=constant	sumo=constant
crypto_kdf_hkdf_sha256_BYTES_MIN	standard=constant	sumo=constant
crypto_kdf_hkdf_sha256_KEYBYTES	standard=constant	sumo=constant
crypto_auth_hmacsha256	standard=absent	sumo=function
crypto_auth_hmacsha256_BYTES	standard=absent	sumo=constant
crypto_auth_hmacsha256_KEYBYTES	standard=absent	sumo=constant
crypto_auth_hmacsha256_final	standard=absent	sumo=function
crypto_auth_hmacsha256_init	standard=absent	sumo=function
crypto_auth_hmacsha256_keygen	standard=absent	sumo=function
crypto_auth_hmacsha256_update	standard=absent	sumo=function
crypto_auth_hmacsha256_verify	standard=absent	sumo=function
crypto_pwhash	standard=absent	sumo=function
crypto_pwhash_ALG_ARGON2I13	standard=absent	sumo=constant
crypto_pwhash_ALG_ARGON2ID13	standard=absent	sumo=constant
crypto_pwhash_ALG_DEFAULT	standard=absent	sumo=constant
crypto_pwhash_BYTES_MAX	standard=absent	sumo=constant
crypto_pwhash_BYTES_MIN	standard=absent	sumo=constant
crypto_pwhash_MEMLIMIT_INTERACTIVE	standard=absent	sumo=constant
crypto_pwhash_MEMLIMIT_MAX	standard=absent	sumo=constant
crypto_pwhash_MEMLIMIT_MIN	standard=absent	sumo=constant
crypto_pwhash_MEMLIMIT_MODERATE	standard=absent	sumo=constant
crypto_pwhash_MEMLIMIT_SENSITIVE	standard=absent	sumo=constant
crypto_pwhash_OPSLIMIT_INTERACTIVE	standard=absent	sumo=constant
crypto_pwhash_OPSLIMIT_MAX	standard=absent	sumo=constant
crypto_pwhash_OPSLIMIT_MIN	standard=absent	sumo=constant
crypto_pwhash_OPSLIMIT_MODERATE	standard=absent	sumo=constant
crypto_pwhash_OPSLIMIT_SENSITIVE	standard=absent	sumo=constant
crypto_pwhash_PASSWD_MAX	standard=absent	sumo=constant
crypto_pwhash_PASSWD_MIN	standard=absent	sumo=constant
crypto_pwhash_SALTBYTES	standard=absent	sumo=constant
crypto_pwhash_STRBYTES	standard=absent	sumo=constant
crypto_pwhash_STRPREFIX	standard=absent	sumo=constant
crypto_pwhash_argon2i_BYTES_MAX	standard=absent	sumo=constant
crypto_pwhash_argon2i_BYTES_MIN	standard=absent	sumo=constant
crypto_pwhash_argon2i_MEMLIMIT_INTERACTIVE	standard=absent	sumo=constant
crypto_pwhash_argon2i_MEMLIMIT_MAX	standard=absent	sumo=constant
crypto_pwhash_argon2i_MEMLIMIT_MIN	standard=absent	sumo=constant
crypto_pwhash_argon2i_MEMLIMIT_MODERATE	standard=absent	sumo=constant
crypto_pwhash_argon2i_MEMLIMIT_SENSITIVE	standard=absent	sumo=constant
crypto_pwhash_argon2i_OPSLIMIT_INTERACTIVE	standard=absent	sumo=constant
crypto_pwhash_argon2i_OPSLIMIT_MAX	standard=absent	sumo=constant
crypto_pwhash_argon2i_OPSLIMIT_MIN	standard=absent	sumo=constant
crypto_pwhash_argon2i_OPSLIMIT_MODERATE	standard=absent	sumo=constant
crypto_pwhash_argon2i_OPSLIMIT_SENSITIVE	standard=absent	sumo=constant
crypto_pwhash_argon2i_PASSWD_MAX	standard=absent	sumo=constant
crypto_pwhash_argon2i_PASSWD_MIN	standard=absent	sumo=constant
crypto_pwhash_argon2i_SALTBYTES	standard=absent	sumo=constant
crypto_pwhash_argon2i_STRBYTES	standard=absent	sumo=constant
crypto_pwhash_argon2i_STRPREFIX	standard=absent	sumo=constant
crypto_pwhash_argon2id_BYTES_MAX	standard=absent	sumo=constant
crypto_pwhash_argon2id_BYTES_MIN	standard=absent	sumo=constant
crypto_pwhash_argon2id_MEMLIMIT_INTERACTIVE	standard=absent	sumo=constant
crypto_pwhash_argon2id_MEMLIMIT_MAX	standard=absent	sumo=constant
crypto_pwhash_argon2id_MEMLIMIT_MIN	standard=absent	sumo=constant
crypto_pwhash_argon2id_MEMLIMIT_MODERATE	standard=absent	sumo=constant
crypto_pwhash_argon2id_MEMLIMIT_SENSITIVE	standard=absent	sumo=constant
crypto_pwhash_argon2id_OPSLIMIT_INTERACTIVE	standard=absent	sumo=constant
crypto_pwhash_argon2id_OPSLIMIT_MAX	standard=absent	sumo=constant
crypto_pwhash_argon2id_OPSLIMIT_MIN	standard=absent	sumo=constant
crypto_pwhash_argon2id_OPSLIMIT_MODERATE	standard=absent	sumo=constant
crypto_pwhash_argon2id_OPSLIMIT_SENSITIVE	standard=absent	sumo=constant
crypto_pwhash_argon2id_PASSWD_MAX	standard=absent	sumo=constant
crypto_pwhash_argon2id_PASSWD_MIN	standard=absent	sumo=constant
crypto_pwhash_argon2id_SALTBYTES	standard=absent	sumo=constant
crypto_pwhash_argon2id_STRBYTES	standard=absent	sumo=constant
crypto_pwhash_argon2id_STRPREFIX	standard=absent	sumo=constant
crypto_pwhash_scryptsalsa208sha256	standard=absent	sumo=function
crypto_pwhash_scryptsalsa208sha256_BYTES_MAX	standard=absent	sumo=constant
crypto_pwhash_scryptsalsa208sha256_BYTES_MIN	standard=absent	sumo=constant
crypto_pwhash_scryptsalsa208sha256_MEMLIMIT_INTERACTIVE	standard=absent	sumo=constant
crypto_pwhash_scryptsalsa208sha256_MEMLIMIT_MAX	standard=absent	sumo=constant
crypto_pwhash_scryptsalsa208sha256_MEMLIMIT_MIN	standard=absent	sumo=constant
crypto_pwhash_scryptsalsa208sha256_MEMLIMIT_SENSITIVE	standard=absent	sumo=constant
crypto_pwhash_scryptsalsa208sha256_OPSLIMIT_INTERACTIVE	standard=absent	sumo=constant
crypto_pwhash_scryptsalsa208sha256_OPSLIMIT_MAX	standard=absent	sumo=constant
crypto_pwhash_scryptsalsa208sha256_OPSLIMIT_MIN	standard=absent	sumo=constant
crypto_pwhash_scryptsalsa208sha256_OPSLIMIT_SENSITIVE	standard=absent	sumo=constant
crypto_pwhash_scryptsalsa208sha256_PASSWD_MAX	standard=absent	sumo=constant
crypto_pwhash_scryptsalsa208sha256_PASSWD_MIN	standard=absent	sumo=constant
crypto_pwhash_scryptsalsa208sha256_SALTBYTES	standard=absent	sumo=constant
crypto_pwhash_scryptsalsa208sha256_STRBYTES	standard=absent	sumo=constant
crypto_pwhash_scryptsalsa208sha256_STRPREFIX	standard=absent	sumo=constant
crypto_pwhash_scryptsalsa208sha256_ll	standard=absent	sumo=function
crypto_pwhash_scryptsalsa208sha256_str	standard=absent	sumo=function
crypto_pwhash_scryptsalsa208sha256_str_verify	standard=absent	sumo=function
crypto_pwhash_str	standard=absent	sumo=function
crypto_pwhash_str_needs_rehash	standard=absent	sumo=function
crypto_pwhash_str_verify	standard=absent	sumo=function
randombytes_buf	standard=function	sumo=function
randombytes_buf_deterministic	standard=function	sumo=function
sodium_version_string	standard=function	sumo=function

# set difference
only_in_standard=none
only_in_sumo.functions=102
only_in_sumo.function_family.crypto_auth=18
only_in_sumo.function_family.crypto_box=13
only_in_sumo.function_family.crypto_core=29
only_in_sumo.function_family.crypto_generichash=1
only_in_sumo.function_family.crypto_hash=8
only_in_sumo.function_family.crypto_onetimeauth=6
only_in_sumo.function_family.crypto_pwhash=8
only_in_sumo.function_family.crypto_scalarmult=6
only_in_sumo.function_family.crypto_shorthash=1
only_in_sumo.function_family.crypto_sign=2
only_in_sumo.function_family.crypto_stream=10
```

## 3. Comparison of the three targets

Values that are identical across the columns are the point of the table: the same fixed inputs must produce the same
bytes everywhere. All four columns are real runs now, not expectations: Dart VM and host-Flutter by the agent (§ 2.1,
§ 2.2.1), Android by the reviewer on 2026-10-12 (§ 2.2.2), both Node builds by the agent (§ 2.3). The Android column
holds the Dart VM values because the reviewer's run reproduced every fixed-input and result line (§ 2.2.2).

| Check | Dart VM (`sodium` 4.1.1+2) | Flutter/Android (`sodium_libs` 4.0.1, API 37 `x86_64`) | Node standard 0.8.4 | Node sumo 0.8.4 |
|---|---|---|---|---|
| `sodium_version_string` | 1.0.22 | 1.0.22 | 1.0.22 | 1.0.22 |
| XChaCha20-Poly1305-IETF present | yes | yes | yes | yes |
| … ciphertext of the fixed input | `b2556008…b6a` | `b2556008…b6a` | `b2556008…b6a` | `b2556008…b6a` |
| … decrypt round trip | ok | ok | ok | ok |
| … flipped tag byte | rejected (`SodiumException`) | rejected (`SodiumException`) | rejected (`Error`) | rejected (`Error`) |
| … flipped AAD byte | rejected (`SodiumException`) | rejected (`SodiumException`) | rejected (`Error`) | rejected (`Error`) |
| `crypto_box_seal` / `_open` | yes | yes | yes | yes |
| … round trip / overhead | ok / 48 bytes | ok / 48 bytes | ok / 48 bytes | ok / 48 bytes |
| … wrong recipient key | rejected | rejected | rejected | rejected |
| Ed25519 detached sign/verify | yes | yes | yes | yes |
| … public key (fixed seed) | `29acbae1…6dd7` | `29acbae1…6dd7` | `29acbae1…6dd7` | `29acbae1…6dd7` |
| … signature (fixed seed/message) | `a0060e73…900c` | `a0060e73…900c` | `a0060e73…900c` | `a0060e73…900c` |
| … flipped message byte | rejected | rejected | rejected | rejected |
| `crypto_kdf_derive_from_key` | yes | yes | yes | yes |
| … subkey of the fixed master key | `a377a3ca…9f9e` | `a377a3ca…9f9e` | `a377a3ca…9f9e` | `a377a3ca…9f9e` |
| HKDF-SHA-256 in the library | yes | yes | **no** | **no** |
| … RFC 5869 A.1 PRK | `07770936…b3e5` ✅ RFC | `07770936…b3e5` ✅ RFC | via `node:crypto`: `07770936…b3e5` ✅ RFC | same |
| … RFC 5869 A.1 OKM (42 bytes) | not reachable through the Dart API (see gap 4) | not reachable through the Dart API (see gap 4) | via `node:crypto`: `3cb25f25…5865` ✅ RFC | same |
| … RFC 5869 A.3 OKM (42 bytes) | `8da4e775…96c8` ✅ RFC | `8da4e775…96c8` ✅ RFC | via `node:crypto`: `8da4e775…96c8` ✅ RFC | same |
| … 10-byte ASCII info, 42 bytes | `8f1021c8…32ce` | `8f1021c8…32ce` | `8f1021c8…32ce` (via `node:crypto`) | same |
| HMAC-SHA-256 in the library | yes (native build) | yes (native build) | **no** | yes |
| `randombytes_buf` | yes, draws differ | yes, draws differ | yes, draws differ | yes, draws differ |
| `crypto_pwhash` (Argon2id) exported | yes (native; `SodiumSumo` API only) | yes (native; `SodiumSumo` API only) | **no** | yes |
| `crypto_pwhash` called | **no** (D-17, INV-12) | **no** (D-17, INV-12) | **no** | **no** |
| frozen cross-probe values asserted | `frozen_values=match` | `frozen_values=match` | `frozen_values=match` | `frozen_values=match` |
| iOS | not checked here, by scope — E10's iOS build repeats this check | | | |

Full hex values are in § 2; the frozen expectations live in `frozenValues` in
[`dart_vm/lib/checks.dart`](../../infra/crypto-libs-check/dart_vm/lib/checks.dart) (and its copy under `flutter/lib/`)
and in `FROZEN_VALUES` in [`node/lib/checks.mjs`](../../infra/crypto-libs-check/node/lib/checks.mjs), and every probe
asserts them, so a regression in a future release fails the probe instead of silently changing the wire format
(§ 2.3 shows the Node probe failing on a one-character change to an expectation).

## 4. Gaps

1. **HKDF-SHA-256 is missing from the web library — in both builds.** `libsodium-wrappers` 0.8.4 *and*
   `libsodium-wrappers-sumo` 0.8.4 export the `crypto_kdf_hkdf_sha256_*` **constants** but neither exports
   `crypto_kdf_hkdf_sha256_extract`/`_expand` (`compare-exports.mjs`). sodium.js simply does not wrap them, so this is
   not a sumo-vs-standard question. Anything HKDF-based for the web has to come from somewhere else.
2. **The standard web build has no HMAC-SHA-256 either**, so it cannot build HKDF from HMAC. The sumo build does have
   `crypto_auth_hmacsha256_init/update/final/verify`, so sumo *can* build RFC 5869 HKDF by hand. On the browser an
   alternative exists that is not in the library at all: WebCrypto `crypto.subtle` HKDF-SHA-256 (async, secure context
   only), and `node:crypto` has `hkdfSync` — which is what verified the RFC 5869 vectors on the web columns above.
3. **`crypto_pwhash` (Argon2id) is absent from the standard web build** and present in sumo — and on the Dart side
   reachable only through the `SodiumSumo` API. D-17 says no key may derive from the login password, so nothing needs
   it; it is recorded only because the epic asks for the gap.
4. **The Dart `sodium` API cannot express RFC 5869 A.1's `info`.** `KdfHkdf.expand` takes the info as a `String`
   (`context:`) and encodes it as UTF-8, while RFC 5869 A.1's info is 10 non-ASCII bytes (`f0f1f2f3f4f5f6f7f8f9`).
   The libsodium C function it calls takes `ctx, ctx_len` and would accept them — this is a Dart-binding limitation,
   not a libsodium one. The RFC's A.1 OKM is therefore verified on the Node side (`node:crypto`, which is RFC 5869),
   and the Dart side verifies A.1's PRK plus A.3 (empty salt, empty info) end to end. A wire spec that needs HKDF with
   non-ASCII `info` would need an FFI shim or a different `info` convention.
5. **What "the non-sumo build lacks" means concretely** for these primitives: Argon2id and HMAC-SHA-256 (and the
   `crypto_box_curve25519xchacha20poly1305_*` variants). Everything the epic names — XChaCha20-Poly1305-IETF,
   `crypto_box_seal`, Ed25519, `crypto_kdf_derive_from_key`, `randombytes_buf` — is in the standard build and produces
   byte-identical output. Over the whole API surface, sumo is a strict superset: 102 exported functions are sumo-only
   and **none** is standard-only (289 exports in standard, 581 in sumo).
6. **Android was unchecked in the agent sandbox** — no Android SDK/NDK, so neither the emulator run nor even an APK
   build could be executed there (`flutter doctor`, § 2.2.3). The reviewer ran it on the emulator on 2026-10-12
   (§ 2.2.2, § 7): every check reproduced the Dart VM column, `frozen_values=match`, no `gap:` line, no `FAIL` — the
   Android gap is closed.
7. **iOS is not checked**, by the requirement's own wording ("iOS is not checked before Phase 5: E10's iOS build
   repeats this check there").

## 5. Recommendation for E12-R01 (spec) and E12-R03 (TS library)

- **Dart:** `packages/crypto_dart` should depend on **`sodium` 4.1.1+2 directly**, not on `sodium_libs` (deprecated,
  a re-export). Its tests will exercise the build hook: `dart test` and `dart run` both honour it on Dart 3.13.5
  (verified, § 2.1), while `dart <file>.dart` does not. The lockfile pins 4.1.1+2 on the pinned toolchain.
- **Web:** `packages/crypto-ts` should depend on **`libsodium-wrappers-sumo` 0.8.4** if the spec ever needs HMAC or
  Argon2id, and the standard build is enough if it does not. Sumo's cost is bundle size (581 exports vs 289) and
  nothing else observable here — no primitive in this check behaves differently between the two, and neither is
  missing anything the epic names.
- **Prefer `crypto_kdf` (BLAKE2b `derive_from_key`) over HKDF-SHA-256 for key derivation on the wire.** It is present
  in **both** web builds, on native, byte-identical across all of them, with a fixed 8-byte context and a
  64-bit subkey id — everything the key hierarchy in ADR 0001 needs. HKDF-SHA-256 is *not* callable from
  `libsodium-wrappers` (gap 1), so choosing it forces sumo plus a hand-rolled RFC 5869 expand over HMAC, or WebCrypto
  in the browser plus `node:crypto` in tests. If a spec-level reason does force HKDF-SHA-256, then: sumo is required
  (gap 2), and the `info` must be ASCII if the Dart side is to reproduce it through the `sodium` API (gap 4).
- **No decision changes for Argon2id.** It is absent from the standard web build, present in sumo and on native, and
  D-17 means nothing calls it. If a separate passphrase option is ever added, sumo becomes mandatory on the web and
  the `SodiumSumo` API on mobile.
- **`sodium_libs` should not be depended on by new code.** E10-R01 should take `sodium` 4.1.1+2 directly if the pin
  process allows it; this check records the deprecation rather than changing `apps/mobile/pubspec.yaml` (out of this
  requirement's writable paths).

## 6. Invariants and rules touched

- **INV-07** — nothing under `server/**` was touched; the probes are `infra/` and `docs/` only.
- **INV-12 / D-17** — no key derives from a password in any probe: `crypto_pwhash` is listed, never called, and no
  Argon2id/HKDF-from-password code exists. `grep -rni pwhash infra/crypto-libs-check/` returns 23 lines, all of them
  either the presence check itself (`node/lib/checks.mjs`, `dart_vm/lib/checks.dart`, `flutter/lib/checks.dart`), the
  printed `crypto_pwhash.called=no` line, a symbol listed for `DynamicLibrary.lookup` in
  `dart_vm/bin/system_libsodium.dart`, or the comments saying why nothing calls it.
- **D-14/D-15/D-18 (AAD, Ed25519 authenticity, sealed calendar metadata)** — none of these is decided here; the probe
  shows the primitives they need are available (Ed25519 sign/verify, sealed boxes, XChaCha20-Poly1305 with AAD).
- **Secrets** — every key/nonce/message/seed in the probes is a fixed, invented test value, labelled as such in the
  source. No `.env`, no credential, no production value anywhere.

## 7. The Android row — the reviewer's run (2026-10-12)

The agent sandbox has no Android SDK/NDK, so this run is the reviewer's (§ 2.2.3). It was made on the host's emulator,
AVD `Medium-Phone-Android-17` (API 37, Android 17, `x86_64`, model `sdk_gphone16k_x86_64`), headless, with the pinned
Flutter on `PATH`:

```sh
cd infra/crypto-libs-check/flutter
flutter pub get                                  # resolves sodium_libs 4.0.1 -> sodium 4.1.1+2
flutter test integration_test -d emulator-5554    # -> All tests passed!, exit 0
```

**Result: pass** — § 2.2.2. The integration test prints the whole report before it asserts it; its `device.*` lines
and `frozen_values=match` are quoted in § 2.2.2, the versions in § 1, the comparison in § 3. Every fixed-input and
result line is identical to the Dart VM run (§ 2.2.2's sorted diff), with no `gap:` line and no `FAIL`.

Two things a repeat run should expect: the first Gradle build takes ~7½ minutes (445.9 s here) and downloads
**NDK `28.2.13676358` (r28c)** into the host's Android SDK, which had only 27.1 before; and `flutter build apk
--debug` is *not* a substitute for the emulator run — it would only show that the Android build compiles, which the
Dart VM and host runs of the same checks already cover.

To repeat it on another device (API 26+, any ABI — `minSdk = 26` as `apps/mobile`), the same command with the id from
`flutter devices`. If a cell differs from § 2.2.2, that is a finding for E12-R01, not a doc edit — send it back before
the spec is frozen.
