package com.relayium.android

import com.relayium.protocol.JoinInput

/**
 * Which Relayium the app talks to.
 *
 * Production is the only value a shipped build can ever have. The override
 * exists for the emulator acceptance harness, and it is fenced three ways:
 *
 * 1. [BuildConfig.ALLOW_BACKEND_OVERRIDE] is false in release, so [resolve]
 *    cannot return anything else there;
 * 2. the cleartext network policy that would let a plain-HTTP loopback work at
 *    all is a debug-only manifest overlay;
 * 3. nothing EXPORTED accepts one — the launcher activity reads it from a
 *    developer-set system property, not from an Intent extra, so no other app
 *    and no link can move this build's traffic.
 *
 * Self-hosted server configuration is a separate, deferred product decision. It
 * is not this switch.
 */
object Backend {

    const val PRODUCTION = JoinInput.DEFAULT_ORIGIN

    /**
     * The debug harness sets this with
     * `adb shell setprop debug.relayium.backend http://10.0.2.2:8080`, which
     * requires a shell on the device. It is read once per process.
     */
    const val OVERRIDE_PROPERTY = "debug.relayium.backend"

    /**
     * PARSED, not prefix-matched: `http://localhost:80@evil.example` starts
     * with an allowed-looking prefix but its HOST is `evil.example` (the
     * "localhost:80" is userinfo), and a prefix check would happily hand a
     * pairing code to it. The candidate must be a well-formed http/https URL
     * whose parsed host is exactly one of the emulator loopback names, with
     * no userinfo, no query, no fragment, no path beyond a bare root slash,
     * and a real port if any. Anything else — including anything
     * `java.net.URI` cannot parse — resolves to production, never to a
     * "close enough" origin.
     *
     * [allowOverride] is a SECOND, narrowing fence and never a widening one:
     * the release build returns production whatever it is set to. It exists so
     * the refusal branch is directly executable — AGP generates host unit
     * tests for the test build type alone, so a release assertion guarded by
     * `assumeFalse(BuildConfig.…)` would be skipped in every run that exists
     * and would prove nothing. That the RELEASE variant really supplies
     * `false` for the mandatory flag is a build-configuration fact, asserted
     * against `app/build.gradle.kts` by `scripts/test/android-policy-test.mjs`.
     */
    @JvmOverloads
    fun resolve(rawOverride: String?, allowOverride: Boolean = true): String {
        // BOTH fences, and `BuildConfig` is the MANDATORY one. Making the
        // variant flag a mere DEFAULT for the parameter would mean an explicit
        // `allowOverride = true` bypassed it in a release build, which would
        // make this file's own first sentence false. The parameter can only
        // ever REFUSE further; it cannot permit.
        if (!BuildConfig.ALLOW_BACKEND_OVERRIDE || !allowOverride) return PRODUCTION
        val candidate = rawOverride?.trim().orEmpty()
        if (candidate.isEmpty()) return PRODUCTION
        val uri = try {
            java.net.URI(candidate)
        } catch (_: java.net.URISyntaxException) {
            return PRODUCTION
        }
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return PRODUCTION
        if (uri.userInfo != null || uri.query != null || uri.fragment != null) return PRODUCTION
        val host = uri.host?.lowercase() ?: return PRODUCTION
        if (host !in LOOPBACK) return PRODUCTION
        if (uri.path != null && uri.path != "" && uri.path != "/") return PRODUCTION
        // URI parses any integer as a port; a socket cannot dial 99999.
        val port = uri.port
        if (port != -1 && port !in 1..65535) return PRODUCTION
        // Canonical: scheme://host[:port], the allowed trailing root slash
        // dropped, so every consumer appends paths against the same shape.
        return buildString {
            append(scheme).append("://").append(host)
            if (port != -1) append(':').append(port)
        }
    }

    private val LOOPBACK = setOf("10.0.2.2", "localhost", "127.0.0.1")

    /**
     * Read the developer-set property. `android.os.SystemProperties` is not
     * public API, which is acceptable here precisely because this path is
     * debug-only and best-effort: any failure — the class moving, the method
     * gone — resolves to production, never to a weaker default.
     */
    @android.annotation.SuppressLint("PrivateApi")
    fun readDebugOverride(): String? {
        if (!BuildConfig.ALLOW_BACKEND_OVERRIDE) return null
        return try {
            val clazz = Class.forName("android.os.SystemProperties")
            clazz.getMethod("get", String::class.java)
                .invoke(null, OVERRIDE_PROPERTY) as? String
        } catch (_: Exception) {
            null
        }
    }
}
