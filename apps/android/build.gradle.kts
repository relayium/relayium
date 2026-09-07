// Deliberately EMPTY of plugin declarations.
//
// The usual root `plugins { alias(libs.plugins.android.application) apply false }`
// would resolve the Android Gradle Plugin for every invocation of this build,
// including the pure-JVM `:protocol:test` that `compat.yml` runs on a runner
// with no Android SDK. `apply false` does not mean "do not resolve" — it means
// "resolve, then do not apply". So each module declares the plugins it needs,
// and `settings.gradle.kts` decides whether the module that needs AGP is in the
// build at all.
//
// See docs/android-development.md for the two invocations this shape exists for.

tasks.register("relayiumProtocolGate") {
    group = "verification"
    description = "The cross-language conformance gate: pure JVM, no Android SDK required."
    dependsOn(":protocol:test")
}
