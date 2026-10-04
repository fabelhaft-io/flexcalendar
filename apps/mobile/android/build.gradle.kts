// Root build of the Android module of the Flutter app (`apps/mobile`).
//
// E02-R02 pins the JDK the Android modules compile with. Nothing else lives
// here: the Flutter-generated project (E10-R01) adds the `:app` module, its
// build script and the task wiring. Keep the toolchain block when it does.

import org.jetbrains.kotlin.gradle.dsl.KotlinAndroidProjectExtension

// The JDK version the whole Android build compiles and runs against. The
// wrapper's Gradle (gradle/wrapper/gradle-wrapper.properties) is chosen to
// support it; AGP and Kotlin are pinned in settings.gradle.kts.
val pinnedJdkVersion = JavaLanguageVersion.of(21)

allprojects {
    repositories {
        google()
        mavenCentral()
    }

    // Java modules (the sync adapter may contain one).
    plugins.withId("java") {
        extensions.configure<JavaPluginExtension> {
            toolchain {
                languageVersion.set(pinnedJdkVersion)
            }
        }
    }

    // Kotlin/Android modules: same JDK, so `kotlinc` and `javac` cannot drift.
    plugins.withId("org.jetbrains.kotlin.android") {
        extensions.configure<KotlinAndroidProjectExtension> {
            jvmToolchain(pinnedJdkVersion.asInt())
        }
    }
}
