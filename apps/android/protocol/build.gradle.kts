// The pure-JVM half. No Android, no WebRTC, no Compose, no Gradle plugin that
// would drag any of those in — see ../settings.gradle.kts for why that matters.
plugins {
    alias(libs.plugins.kotlin.jvm)
}

kotlin {
    jvmToolchain(17)
    compilerOptions {
        // Warnings here are wire bugs waiting to happen (an unchecked cast in a
        // frame decoder, a non-exhaustive `when` over a frame class).
        allWarningsAsErrors.set(true)
    }
}

dependencies {
    // Lightweight primitives only: X25519, BLAKE2b, and — for the Device Inbox
    // sealed box — the Salsa20 core, XSalsa20 and Poly1305, which compose
    // libsodium's crypto_box_seal (see inbox/InboxSealedBox.kt). The JCE
    // PROVIDER is deliberately not registered: AES-GCM comes from the platform,
    // and installing a provider would change crypto for every other consumer in
    // the process.
    implementation(libs.bouncycastle.prov)

    testImplementation(libs.junit)
    testImplementation(kotlin("test"))
}

val sharedFixtures = rootProject.layout.projectDirectory.dir("../../apps/RelayiumKit/Tests/Fixtures")

tasks.withType<Test>().configureEach {
    useJUnit()
    // The conformance suites read the SHARED fixtures, read-only, through this
    // one property. Nothing under apps/android duplicates a fixture value: a
    // second copy is a second thing to keep in sync, which is the drift
    // `web/scripts/check-wire-vectors.mjs` exists to prevent.
    systemProperty("relayium.fixtures", sharedFixtures.asFile.absolutePath)
    // The fixture CONTENTS are inputs of this task, declared file by file.
    //
    // The system property above carries only a PATH, which never changes, so
    // without this block an edit to a fixture leaves :protocol:test UP-TO-DATE
    // (and restorable from the build cache) — a green conformance gate over
    // vectors it never re-read, on exactly the fixture-only commits the
    // always-on compat lane exists to catch. RELATIVE sensitivity keeps the
    // fingerprint on (name, content), so moving the repository does not
    // invalidate while editing or swapping any of them does.
    inputs.files(
        sharedFixtures.file("crypto-vectors.json"),
        sharedFixtures.file("realtime-wire-vectors.json"),
        sharedFixtures.file("store-wire-vectors.json"),
        sharedFixtures.file("device-inbox-manifest-v3-vectors.json"),
    )
        .withPropertyName("relayiumSharedFixtures")
        .withPathSensitivity(PathSensitivity.RELATIVE)
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
