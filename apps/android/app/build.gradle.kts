// The Android half. Present in the build only when `-Prelayium.android=true`
// (or an ambient SDK with no explicit flag) — see ../settings.gradle.kts.
// AGP 9 ships BUILT-IN Kotlin support: `com.android.application` compiles
// Kotlin itself. The legacy `org.jetbrains.kotlin.android` plugin is therefore
// deliberately NOT applied — doubling it puts two Kotlin plugins on one
// classpath, which is the alignment failure A2 names. The Compose compiler
// plugin is still its own Gradle plugin and rides the built-in toolchain.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.relayium.android"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "com.relayium.android"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // Only the two this build is actually tested on. Claiming armeabi-v7a or
        // x86 would be a compatibility promise nothing here has exercised, and
        // the WebRTC AAR's 16 KiB page alignment was verified for exactly these.
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            // The acceptance harness points the app at a local server. This is a
            // DEBUG-ONLY capability in three independent ways: the field is
            // false in release, the cleartext network policy that would let it
            // reach a plain-HTTP loopback is a debug-only manifest overlay, and
            // nothing exported accepts a backend override (see MainActivity).
            buildConfigField("boolean", "ALLOW_BACKEND_OVERRIDE", "true")
        }
        release {
            buildConfigField("boolean", "ALLOW_BACKEND_OVERRIDE", "false")
            isMinifyEnabled = false
            isShrinkResources = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // NO signingConfig. Release signing is Codex-owned and lives outside
            // this repository; `assembleRelease` produces an UNSIGNED apk on
            // purpose. A default debug-signed "release" would be an artifact
            // that looks distributable and is not.
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        jvmToolchain(17)
    }

    packaging {
        resources.excludes += setOf(
            "/META-INF/{AL2.0,LGPL2.1}",
            "/META-INF/versions/9/OSGI-INF/MANIFEST.MF",
        )
    }

    lint {
        warningsAsErrors = true
        abortOnError = true
        lintConfig = file("lint.xml")
        // The build is checked in CI with `lintDebug`; a baseline would let a
        // regression in and is deliberately absent.
        checkDependencies = false
        disable += setOf(
            // The app has no Play Services and no auto-update, so a stale
            // dependency warning here is not actionable in this stage and is
            // handled by the repository's own dependency policy instead.
            "GradleDependency",
            "AndroidGradlePluginVersion",
            "NewerVersionAvailable",
            // targetSdk stays 36 by explicit decision recorded in the version
            // catalog: compiling against 37 headers is done, TARGETING 37 is a
            // separate behaviour change this stage deliberately does not make.
            "OldTargetApi",
        )
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation(project(":protocol"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.annotation)
    implementation(libs.androidx.documentfile)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp)
    implementation(libs.webrtc)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.core)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)

    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.espresso.core)
    androidTestImplementation(libs.androidx.uiautomator)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
}
