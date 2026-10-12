plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "de.flexcalendar.app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "de.flexcalendar.app"
        // Android 8 (ADR 0002: iOS 16+, Android minSdk 26). The Flutter
        // template's default is 24; E10-R01 raises it deliberately.
        minSdk = 26
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-apk-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // E10-R01 flavors. All three keep the **one** application ID
    // `de.flexcalendar.app` with no `applicationIdSuffix`, because the OIDC
    // redirect scheme is registered once (PR #16, owner-approved). The API base
    // URL differs per flavor and lives in Dart, not here: the default target
    // `lib/main.dart` is `dev`, `lib/main_staging.dart` is `staging` and
    // `lib/main_prod.dart` is `prod` (apps/mobile/README.md § Flavors). A build
    // therefore names both: `flutter build apk --flavor staging -t
    // lib/main_staging.dart`.
    flavorDimensions += "environment"
    productFlavors {
        create("dev") { dimension = "environment" }
        create("staging") { dimension = "environment" }
        create("prod") { dimension = "environment" }
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
