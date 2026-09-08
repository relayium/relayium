package com.relayium.android.update

import com.relayium.android.BuildConfig
import java.net.URI
import java.net.URISyntaxException

/**
 * WHICH document the update check reads.
 *
 * Production is the only value a shipped build can ever have. The override
 * exists so the acceptance can point the REAL updater at a throwaway feed on
 * the host and observe the genuine available / up-to-date / error answers on a
 * device — which is otherwise unreachable, because 0.1.1 is the first build
 * with an updater and there is no newer public release to check against.
 *
 * It is fenced exactly as [com.relayium.android.Backend] is, and for the same
 * reason: this value decides where an install link comes from.
 *
 *  1. [BuildConfig.ALLOW_UPDATE_FEED_OVERRIDE] is false in release, and it is
 *     read as a MANDATORY conjunct rather than as a default parameter — so an
 *     explicit `allowOverride = true` cannot reopen it in a shipped build;
 *  2. the cleartext policy that would let a plain-HTTP loopback feed work at
 *     all is a debug-only manifest overlay; and
 *  3. nothing EXPORTED accepts one — it is read from a developer-set system
 *     property that requires a shell on the device, not from an Intent extra,
 *     so no other app and no link can move this build's update source.
 */
object UpdateEndpoint {

    /** `adb shell setprop debug.relayium.updatefeed http://10.0.2.2:8181/update.json` */
    const val OVERRIDE_PROPERTY = "debug.relayium.updatefeed"

    /** The emulator's route to the host, plus the `adb reverse` names. Matches
     *  the debug network-security overlay exactly; any other host — including a
     *  perfectly ordinary HTTPS one — resolves to production. */
    private val LOOPBACK = setOf("10.0.2.2", "localhost", "127.0.0.1")

    /** A test feed lives at a real path, so unlike the backend override this
     *  one accepts one. Bounded and traversal-free all the same. */
    private val TEST_PATH = Regex("""^/[A-Za-z0-9._/-]{0,128}$""")

    /**
     * Resolve the feed URL.
     *
     * [allowOverride] is a SECOND, NARROWING fence and never a widening one:
     * the release build returns the official URL whatever it is set to. It
     * exists so the refusal branch is directly executable — AGP generates host
     * unit tests for the test build type alone, so a release assertion guarded
     * by `assumeFalse(BuildConfig.…)` would be skipped in every run that exists
     * and would prove nothing. That the RELEASE variant really supplies `false`
     * is a build-configuration fact, asserted against `app/build.gradle.kts`
     * and against this file's shape by `scripts/test/android-policy-test.mjs`,
     * and against the COMPILED release APK by the acceptance.
     */
    @JvmOverloads
    fun resolve(rawOverride: String?, allowOverride: Boolean = true): String {
        // BOTH, and `BuildConfig` is the mandatory one. Making the variant flag
        // a mere DEFAULT for the parameter would mean an explicit
        // `allowOverride = true` bypassed it in a release build, which would
        // make this file's own first sentence false.
        if (!BuildConfig.ALLOW_UPDATE_FEED_OVERRIDE || !allowOverride) return UpdateFeed.OFFICIAL_URL
        val candidate = rawOverride?.trim().orEmpty()
        if (candidate.isEmpty()) return UpdateFeed.OFFICIAL_URL
        val uri = try {
            URI(candidate)
        } catch (_: URISyntaxException) {
            return UpdateFeed.OFFICIAL_URL
        }
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return UpdateFeed.OFFICIAL_URL
        if (uri.userInfo != null || uri.query != null || uri.fragment != null) return UpdateFeed.OFFICIAL_URL
        val host = uri.host?.lowercase() ?: return UpdateFeed.OFFICIAL_URL
        if (host !in LOOPBACK) return UpdateFeed.OFFICIAL_URL
        val path = uri.path ?: return UpdateFeed.OFFICIAL_URL
        if (path != uri.rawPath) return UpdateFeed.OFFICIAL_URL
        if (path.contains("..")) return UpdateFeed.OFFICIAL_URL
        if (path.isNotEmpty() && !TEST_PATH.matches(path)) return UpdateFeed.OFFICIAL_URL
        // URI parses any integer as a port; a socket cannot dial 99999.
        val port = uri.port
        if (port != -1 && port !in 1..65535) return UpdateFeed.OFFICIAL_URL
        return buildString {
            append(scheme).append("://").append(host)
            if (port != -1) append(':').append(port)
            append(path.ifEmpty { "/" })
        }
    }

    /**
     * Read the developer-set property. `android.os.SystemProperties` is not
     * public API, which is acceptable here precisely because this path is
     * debug-only and best-effort: any failure — the class moving, the method
     * gone — resolves to production, never to a weaker default.
     */
    @android.annotation.SuppressLint("PrivateApi")
    fun readDebugOverride(): String? {
        if (!BuildConfig.ALLOW_UPDATE_FEED_OVERRIDE) return null
        return try {
            val clazz = Class.forName("android.os.SystemProperties")
            clazz.getMethod("get", String::class.java)
                .invoke(null, OVERRIDE_PROPERTY) as? String
        } catch (_: Exception) {
            null
        }
    }
}
