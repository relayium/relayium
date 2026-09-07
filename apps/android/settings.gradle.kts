// The Android client's build, in two halves that are deliberately not equally
// expensive to run.
//
// `:protocol` is PURE JVM. It has no Android dependency, no WebRTC, no Compose,
// and it is where every crypto byte, every frame, and every lifecycle invariant
// lives. That is what lets the cross-language conformance suite run on
// `ubuntu-latest` in seconds, inside the always-on `compat.yml` gate, with no
// Android SDK installed and no emulator — see docs/CI-PLATFORM-BOUNDARY.md.
//
// `:app` is the Android half. Including it makes Gradle resolve the Android
// Gradle Plugin, which needs a licensed SDK on disk and pulls a large plugin
// classpath. So it is included ONLY when asked for:
//
//     gradle -p apps/android :protocol:test            # no SDK, no AGP
//     gradle -p apps/android -Prelayium.android=true :app:assembleDebug
//
// The property gate is not a convenience. `pluginManagement` and
// `dependencyResolutionManagement` are evaluated for the whole build, but a
// plugin is only RESOLVED when a project that declares it is in the build — so
// excluding `:app` here is what makes the protocol gate genuinely
// SDK-independent rather than merely SDK-tolerant. A CI lane that must never
// touch the Android toolchain gets a build that structurally cannot.
pluginManagement {
    repositories {
        // Ordered cheapest-first for the protocol-only build: it needs the
        // Kotlin JVM plugin from the portal and nothing from Google.
        gradlePluginPortal()
        google()
        mavenCentral()
    }
}

@Suppress("UnstableApiUsage")
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "relayium-android"

include(":protocol")

// **Explicit beats ambient, in both directions.**
//
// `-Prelayium.android=false` excludes `:app` even on a machine with a perfectly
// good SDK, and that precedence is the whole point rather than a nicety: hosted
// GitHub runners ship ANDROID_HOME preset, so an environment fallback that could
// not be overridden would make the pure-JVM compat lane resolve AGP on exactly
// the runner it exists to stay off. The flag is what `compat.yml` passes and
// what `docs/android-development.md` documents.
//
// With no flag at all, a real SDK on ANDROID_HOME/ANDROID_SDK_ROOT is taken as
// "this machine is set up for Android work" and `:app` is included. CI is always
// explicit in both lanes, so a workflow that forgets the flag fails loudly
// rather than quietly picking a build shape.
val androidFlag: String? = providers.gradleProperty("relayium.android").orNull
val sdkPresent = sequenceOf("ANDROID_HOME", "ANDROID_SDK_ROOT")
    .mapNotNull { providers.environmentVariable(it).orNull }
    .any { it.isNotBlank() && File(it, "platforms").isDirectory }

val includeApp = when (androidFlag) {
    "true" -> true
    "false" -> false
    null -> sdkPresent
    else -> throw GradleException(
        "relayium.android must be exactly \"true\" or \"false\"; got \"$androidFlag\". " +
            "A typo must not silently choose a build shape.",
    )
}

if (includeApp) {
    include(":app")
} else {
    logger.lifecycle(
        "relayium: :app is excluded (relayium.android=" + (androidFlag ?: "<unset>") +
            ", sdkPresent=" + sdkPresent + "). The pure-JVM :protocol module is the whole " +
            "build; AGP is never resolved.",
    )
}
