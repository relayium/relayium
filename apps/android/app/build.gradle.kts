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
        // 0.2.1 (4), the UI and motion polish release over the 0.2.0 public
        // preview. `versionCode` is the only ordering the update
        // check ever uses — `versionName` is a display string and "0.1.10" sorts
        // before "0.1.9" as text — so it must increase monotonically for every
        // published APK, forever. `scripts/test/android-policy-test.mjs` asserts
        // the two move together.
        versionCode = 4
        versionName = "0.2.1"

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
            // The update-feed twin of the flag above, and fenced identically:
            // false in release, a debug-only cleartext policy, and read from a
            // developer-set system property rather than from anything exported.
            // It exists so the acceptance can point the REAL updater at a
            // throwaway local feed and see the genuine available/error/stale
            // answers on a device — which is otherwise unreachable, because
            // 0.1.1 is the first build with an updater at all and no newer
            // public release exists to check against.
            buildConfigField("boolean", "ALLOW_UPDATE_FEED_OVERRIDE", "true")
        }
        release {
            buildConfigField("boolean", "ALLOW_BACKEND_OVERRIDE", "false")
            buildConfigField("boolean", "ALLOW_UPDATE_FEED_OVERRIDE", "false")
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

    // Scanning a pairing code. `camera-core` and `camera-camera2` are the
    // pipeline and its Camera2 implementation, `camera-lifecycle` is what binds
    // the capture to a LifecycleOwner so an off-screen scanner cannot keep the
    // camera open, and `camera-view` provides the preview surface. `zxing:core`
    // is pure Java, so the decode is also a host unit test.
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.zxing.core)

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
