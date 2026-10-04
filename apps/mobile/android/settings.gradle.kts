// Settings for the Android module of the Flutter app (`apps/mobile`).
//
// E02-R02 pins the Android toolchain here and in the two sibling files:
//
//   Gradle         gradle/wrapper/gradle-wrapper.properties (version + sha256)
//   JDK            build.gradle.kts (Java toolchain, provisioned by the foojay
//                  resolver below)
//   AGP / Kotlin   this file
//
// The Flutter-generated project lands with E10-R01 and adds the `:app` module
// (and the adapter module for E11). Keep these pins when it does: they are a
// requirement, not template defaults.

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("com.android.application") version "9.4.1" apply false
    id("org.jetbrains.kotlin.android") version "2.4.20" apply false

    // Lets Gradle fetch the JDK pinned in build.gradle.kts when the machine does
    // not have it installed, so a clean checkout builds with the pinned tools
    // and nothing else.
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

rootProject.name = "flexcalendar-android"
