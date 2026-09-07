package com.relayium.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * The debug backend override is an ATTACK SURFACE on a developer device: a
 * value that resolves anywhere but an exact local origin can move a pairing
 * code off the machine. Every rejection here must land on PRODUCTION, and the
 * release configuration must ignore the property entirely.
 *
 * The override-allowed flag is passed EXPLICITLY here rather than read from
 * `BuildConfig`. AGP generates host unit tests for the test build type only,
 * so a release assertion guarded by `assumeFalse(BuildConfig.…)` never
 * executes in any run that exists — it reports as a skip and proves nothing.
 * Passing the flag exercises both branches in every run; that the RELEASE
 * variant really supplies `false` is a build-configuration fact, pinned by
 * `scripts/test/android-policy-test.mjs` against `app/build.gradle.kts`.
 */
class BackendResolveTest {

    /** The debug/emulator configuration: the variant flag permits an override
     *  and the caller does not narrow it further. */
    private fun resolves(raw: String?): String = Backend.resolve(raw, allowOverride = true)

    // ── the three independently reproduced acceptances that must be RED ─────

    @Test
    fun `userinfo cannot smuggle a foreign host behind a loopback prefix`() {
        // Parses as userinfo "localhost:80" @ host "evil.example".
        assertEquals(Backend.PRODUCTION, resolves("http://localhost:80@evil.example"))
    }

    @Test
    fun `an unexpected path is rejected, not forwarded`() {
        assertEquals(Backend.PRODUCTION, resolves("http://127.0.0.1:4321/unexpected"))
    }

    @Test
    fun `a port no socket can dial is rejected`() {
        assertEquals(Backend.PRODUCTION, resolves("http://10.0.2.2:99999"))
        assertEquals(Backend.PRODUCTION, resolves("http://10.0.2.2:0"))
    }

    // ── the positive shape ──────────────────────────────────────────────────

    @Test
    fun `an exact local origin is accepted and canonicalised`() {
        assertEquals("http://10.0.2.2:4321", resolves("http://10.0.2.2:4321"))
        assertEquals("http://10.0.2.2:4321", resolves("http://10.0.2.2:4321/"))
        assertEquals("http://localhost:8080", resolves("HTTP://LOCALHOST:8080"))
        assertEquals("https://127.0.0.1", resolves("https://127.0.0.1"))
        assertEquals("http://10.0.2.2:1", resolves("http://10.0.2.2:1"))
        assertEquals("http://10.0.2.2:65535", resolves("http://10.0.2.2:65535"))
    }

    // ── everything else lands on production ─────────────────────────────────

    @Test
    fun `foreign hosts, schemes, decorations and garbage all resolve to production`() {
        val rejected = listOf(
            "http://evil.example",
            "http://10.0.2.2.evil.example",
            "http://127.0.0.2:4321",
            "ws://127.0.0.1:4321",
            "file:///etc/hosts",
            "http://127.0.0.1:4321?x=1",
            "http://127.0.0.1:4321#frag",
            "http://127.0.0.1:4321//",
            "http://user@127.0.0.1:4321",
            "http://[::1]:4321",
            "http://",
            "not a url",
            "http://127.0.0.1:4321 extra",
        )
        for (raw in rejected) {
            assertEquals("must reject: $raw", Backend.PRODUCTION, resolves(raw))
        }
        assertEquals(Backend.PRODUCTION, resolves(null))
        assertEquals(Backend.PRODUCTION, resolves(""))
        assertEquals(Backend.PRODUCTION, resolves("   "))
    }

    @Test
    fun `a caller that narrows the fence is refused every override including valid ones`() {
        // The exact inputs the debug configuration ACCEPTS above.
        for (raw in listOf("http://10.0.2.2:4321", "http://localhost", "https://127.0.0.1")) {
            assertEquals(
                "a narrowed caller must ignore: $raw",
                Backend.PRODUCTION,
                Backend.resolve(raw, allowOverride = false),
            )
        }
    }

    @Test
    fun `the variant flag is MANDATORY, not merely the parameter's default`() {
        // R18. The release fence must not be bypassable by an explicit
        // `allowOverride = true`, or this object's own first sentence —
        // "production is the only value a shipped build can ever have" —
        // becomes false. Under a variant whose flag is false, the widest
        // possible call still lands on production; under one whose flag is
        // true, it resolves. Either way the FLAG decides, and the parameter
        // can only narrow.
        val widest = Backend.resolve("http://10.0.2.2:4321", allowOverride = true)
        if (BuildConfig.ALLOW_BACKEND_OVERRIDE) {
            assertEquals("http://10.0.2.2:4321", widest)
        } else {
            assertEquals(Backend.PRODUCTION, widest)
        }
        // And the default argument is the permissive one, so the assertion
        // above is really about the flag and not about a defaulted parameter.
        assertEquals(widest, Backend.resolve("http://10.0.2.2:4321"))
    }

    @Test
    fun `a build whose flag is false never even reads the property`() {
        assertFalse(
            "a shipped build must never read the override property",
            !BuildConfig.ALLOW_BACKEND_OVERRIDE && Backend.readDebugOverride() != null,
        )
    }
}
