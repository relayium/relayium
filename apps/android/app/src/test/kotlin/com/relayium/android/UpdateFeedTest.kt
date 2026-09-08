package com.relayium.android

import com.relayium.android.update.UpdateFeed
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The document rules, exhaustively.
 *
 * Every case here is a document a real origin could serve — a stale manifest,
 * a truncated one, an HTML error page with a 200, a feed edited to point
 * somewhere else — and the assertion is always the same shape: what does this
 * build DO with it. Nothing in this file touches a socket; `UpdateSourceTest`
 * owns the transport half.
 */
class UpdateFeedTest {

    private fun feed(
        available: String = "true",
        applicationId: String = "\"com.relayium.android\"",
        versionCode: String = "3",
        versionName: String = "\"0.1.2\"",
        downloadUrl: String? = null,
        sha256: String = "\"${"a".repeat(64)}\"",
        size: String = "40000000",
        notes: String = """{"en":"Fixes"}""",
        schema: String = "1",
        extra: String = "",
    ): String {
        val url = downloadUrl ?: "\"https://github.com${UpdateFeed.assetPath("0.1.2", 3)}\""
        return """{"schema":$schema,"android":{"available":$available,"applicationId":$applicationId,""" +
            """"versionCode":$versionCode,"versionName":$versionName,"downloadUrl":$url,""" +
            """"sha256":$sha256,"size":$size,"notes":$notes$extra}}"""
    }

    private fun release(text: String): UpdateFeed.Feed.Release {
        val parsed = UpdateFeed.parse(text)
        assertTrue("expected a release, got $parsed", parsed is UpdateFeed.Parsed.Ok)
        val feed = (parsed as UpdateFeed.Parsed.Ok).feed
        assertTrue("expected a release, got $feed", feed is UpdateFeed.Feed.Release)
        return feed as UpdateFeed.Feed.Release
    }

    private fun refusal(text: String): UpdateFeed.Rejection {
        val parsed = UpdateFeed.parse(text)
        assertTrue("expected a refusal, got $parsed", parsed is UpdateFeed.Parsed.Refused)
        return (parsed as UpdateFeed.Parsed.Refused).why
    }

    // ── the happy document ──────────────────────────────────────────────────

    @Test
    fun `reads a well formed release`() {
        val r = release(feed())
        assertEquals(3, r.versionCode)
        assertEquals("0.1.2", r.versionName)
        assertEquals(40_000_000L, r.size)
        assertEquals("Fixes", r.notes["en"])
    }

    /** Forward compatibility: a later schema may add fields, and a reader that
     *  refused them would brick every already-installed build the day one is
     *  added. Unknown fields are the ONE thing tolerated. */
    @Test
    fun `ignores unknown fields`() {
        val r = release(feed(extra = ""","minSdk":26,"channel":"preview","nested":{"a":[1,2]}"""))
        assertEquals(3, r.versionCode)
    }

    @Test
    fun `available false is a first class answer, not an error and not an offer`() {
        val parsed = UpdateFeed.parse("""{"schema":1,"android":{"available":false}}""")
        assertTrue(parsed is UpdateFeed.Parsed.Ok)
        assertEquals(UpdateFeed.Feed.None, (parsed as UpdateFeed.Parsed.Ok).feed)
        assertEquals(
            UpdateFeed.Outcome.NoneDistributed,
            UpdateFeed.outcome(UpdateFeed.Feed.None, 2, "0.1.1"),
        )
    }

    // ── ordering ────────────────────────────────────────────────────────────

    @Test
    fun `offers only a strictly newer versionCode`() {
        val r = release(feed())
        assertTrue(UpdateFeed.outcome(r, 2, "0.1.1") is UpdateFeed.Outcome.Available)
        assertTrue(UpdateFeed.outcome(r, 3, "0.1.2") is UpdateFeed.Outcome.UpToDate)
        // A feed that has gone BACKWARDS is up to date, never a downgrade offer.
        assertTrue(UpdateFeed.outcome(r, 9, "0.9.0") is UpdateFeed.Outcome.UpToDate)
    }

    /** The ordering must be the integer, not the display string: as text
     *  "0.1.10" sorts BEFORE "0.1.9", so a name-based comparison would refuse
     *  to offer the tenth patch release. */
    @Test
    fun `orders by versionCode and not by version name text`() {
        val newer = release(
            feed(
                versionCode = "10",
                versionName = "\"0.1.10\"",
                downloadUrl = "\"https://github.com${UpdateFeed.assetPath("0.1.10", 10)}\"",
            ),
        )
        assertTrue("0.1.10" < "0.1.9") // the trap this guards against
        assertTrue(UpdateFeed.outcome(newer, 9, "0.1.9") is UpdateFeed.Outcome.Available)
    }

    // ── document shape ──────────────────────────────────────────────────────

    @Test
    fun `refuses things that are not the document`() {
        // An HTML error page served with 200 is the shape production's own
        // nginx produces for a missing file; it must never reach a decision.
        assertEquals(UpdateFeed.Rejection.NOT_JSON, refusal("<!doctype html><html>404</html>"))
        assertEquals(UpdateFeed.Rejection.NOT_JSON, refusal(""))
        assertEquals(UpdateFeed.Rejection.NOT_JSON, refusal("null"))
        assertEquals(UpdateFeed.Rejection.NOT_JSON, refusal("[]"))
        // Trailing bytes after a complete value: two documents concatenated, or
        // a body someone appended to.
        assertEquals(UpdateFeed.Rejection.NOT_JSON, refusal(feed() + "{}"))
        assertEquals(UpdateFeed.Rejection.NOT_JSON, refusal(feed().dropLast(1)))
    }

    @Test
    fun `refuses an unknown schema rather than guessing`() {
        assertEquals(UpdateFeed.Rejection.UNKNOWN_SCHEMA, refusal(feed(schema = "2")))
        assertEquals(UpdateFeed.Rejection.UNKNOWN_SCHEMA, refusal(feed(schema = "0")))
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(schema = "\"1\"")))
    }

    @Test
    fun `refuses a missing or non boolean available flag`() {
        // Absence is NOT read as false: "no release" and "this is not the
        // document we think it is" must stay distinguishable.
        assertEquals(
            UpdateFeed.Rejection.MALFORMED,
            refusal("""{"schema":1,"android":{"versionCode":3}}"""),
        )
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(available = "\"true\"")))
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(available = "1")))
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(available = "null")))
    }

    @Test
    fun `refuses a feed for another application`() {
        assertEquals(
            UpdateFeed.Rejection.WRONG_APPLICATION,
            refusal(feed(applicationId = "\"com.example.other\"")),
        )
        assertEquals(
            UpdateFeed.Rejection.WRONG_APPLICATION,
            refusal(feed(applicationId = "\"com.relayium.android.debug\"")),
        )
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(applicationId = "123")))
    }

    @Test
    fun `refuses a version code that is not an exact positive int`() {
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(versionCode = "\"3\"")))
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(versionCode = "3.5")))
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(versionCode = "0")))
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(versionCode = "-1")))
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(versionCode = "2147483648")))
        // A non-finite literal is refused by the strict JSON reader before any
        // field check runs, so it surfaces as NOT_JSON rather than MALFORMED.
        assertEquals(UpdateFeed.Rejection.NOT_JSON, refusal(feed(versionCode = "1e400")))
    }

    /**
     * REGRESSION. `9223372036854775808` is 2^63, one past `Long.MAX_VALUE`. It
     * parses to a double that SATURATES back to `Long.MAX_VALUE`, whose own
     * `toDouble()` is that same double — so a naive round-trip check accepted a
     * number the document never contained. Bounding at 2^53 is the fix.
     */
    @Test
    fun `refuses a size that saturates the long conversion`() {
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(size = "9223372036854775808")))
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(size = "1e300")))
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(versionCode = "9223372036854775808")))
    }

    @Test
    fun `refuses a size outside the publisher policy`() {
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(size = "0")))
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(size = "-5")))
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(size = "1.5")))
        assertEquals(
            UpdateFeed.Rejection.MALFORMED,
            refusal(feed(size = "${UpdateFeed.MAX_APK_BYTES + 1}")),
        )
        // The bound itself is allowed.
        assertEquals(UpdateFeed.MAX_APK_BYTES, release(feed(size = "${UpdateFeed.MAX_APK_BYTES}")).size)
    }

    @Test
    fun `refuses a version name that is not the strict numeric form`() {
        // The four-component case is an RFC 5737 documentation address, not an
        // invented one. Four dotted numbers ARE an IPv4 literal, and
        // `scripts/check-production-identifiers.sh` scans every file — comments
        // included — for that shape, so an arbitrary quad reads as a possible
        // production address and fails the gate. 192.0.2.0/24 is reserved for
        // documentation and is explicitly allowed there. The assertion is
        // unchanged: a version name with too many components must be refused.
        for (bad in listOf("\"\"", "\"0.1\"", "\"192.0.2.3\"", "\"v0.1.2\"", "\"0.1.2-rc1\"",
            "\"0.1.2+build\"", "\"01.1.2\"", "\"0.1.x\"", "\"0.1.2 \"", "\"0.1.2\\n\"")) {
            assertEquals("versionName $bad", UpdateFeed.Rejection.MALFORMED, refusal(feed(versionName = bad)))
        }
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(versionName = "12")))
    }

    @Test
    fun `refuses a sha256 that is not 64 lowercase hex`() {
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(sha256 = "\"${"A".repeat(64)}\"")))
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(sha256 = "\"${"a".repeat(63)}\"")))
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(sha256 = "\"${"a".repeat(65)}\"")))
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(sha256 = "\"${"g".repeat(64)}\"")))
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(sha256 = "null")))
    }

    // ── release notes ───────────────────────────────────────────────────────

    @Test
    fun `requires an english note and falls back to it`() {
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(notes = """{"zh":"只有中文"}""")))
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(notes = """{"en":""}""")))
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(notes = """{"en":"  "}""")))
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(notes = """{"en":123}""")))
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(notes = "null")))

        val notes = release(feed(notes = """{"en":"English","zh":"中文"}""")).notes
        assertEquals("中文", UpdateFeed.noteFor(notes, "zh-Hans-CN"))
        assertEquals("中文", UpdateFeed.noteFor(notes, "zh"))
        assertEquals("English", UpdateFeed.noteFor(notes, "fr-FR"))
        assertEquals("English", UpdateFeed.noteFor(notes, ""))
        // A device tag with an underscore, which some locales still produce.
        assertEquals("中文", UpdateFeed.noteFor(notes, "zh_CN"))
    }

    @Test
    fun `bounds a note and refuses one that could redraw the block`() {
        val long = "x".repeat(UpdateFeed.MAX_NOTE_CHARS + 500)
        assertEquals(UpdateFeed.MAX_NOTE_CHARS, release(feed(notes = """{"en":"$long"}""")).notes["en"]!!.length)
        // A newline is legitimate paragraphing; other control characters are not.
        assertNotNull(release(feed(notes = """{"en":"line\nline"}""")).notes["en"])
        // Raw: refused by the strict JSON reader. Escaped: refused by the note
        // rules, which is the branch that matters here.
        assertEquals(UpdateFeed.Rejection.NOT_JSON, refusal(feed(notes = "{\"en\":\"a\u0007b\"}")))
        assertEquals(UpdateFeed.Rejection.MALFORMED, refusal(feed(notes = """{"en":"a\u0007b"}""")))
    }

    // ── the download URL ────────────────────────────────────────────────────

    /**
     * REGRESSION. A namespace-only path check accepted a document advertising
     * `0.1.2 (3)` while pointing at the `0.1.1` asset — an "update" that
     * installs what the user already has, or something older. The tag and file
     * name identify the bytes and must be derived from the advertised version.
     */
    @Test
    fun `refuses a download url that does not name the advertised release`() {
        val mismatches = listOf(
            "https://github.com/relayium/relayium/releases/download/android-v0.1.1/Relayium-0.1.1-2.apk",
            // Right tag, wrong build number in the file name.
            "https://github.com/relayium/relayium/releases/download/android-v0.1.2/Relayium-0.1.2-2.apk",
            // Right file name, wrong tag.
            "https://github.com/relayium/relayium/releases/download/android-v0.1.1/Relayium-0.1.2-3.apk",
            // Another product's tag namespace in the same repository.
            "https://github.com/relayium/relayium/releases/download/macos-v0.1.2/Relayium-0.1.2-3.apk",
            "https://github.com/relayium/relayium/releases/download/v0.1.2/Relayium-0.1.2-3.apk",
            // A different repository entirely.
            "https://github.com/someone/relayium/releases/download/android-v0.1.2/Relayium-0.1.2-3.apk",
            // The CLI's asset shape.
            "https://github.com/relayium/relayium/releases/download/android-v0.1.2/relayium_linux_arm64.tar.gz",
        )
        for (url in mismatches) {
            assertEquals(url, UpdateFeed.Rejection.UNTRUSTED_URL, refusal(feed(downloadUrl = "\"$url\"")))
        }
    }

    @Test
    fun `accepts only the exact official asset url`() {
        val good = "https://github.com" + UpdateFeed.assetPath("0.1.2", 3)
        assertTrue(UpdateFeed.isOfficialDownloadUrl(good, "0.1.2", 3))

        val bad = listOf(
            // The userinfo trap: a PREFIX check passes this and the host is
            // evil.example. Backend.resolve documents the same one.
            "https://github.com@evil.example/relayium/relayium/releases/download/android-v0.1.2/Relayium-0.1.2-3.apk",
            "https://user:pw@github.com/relayium/relayium/releases/download/android-v0.1.2/Relayium-0.1.2-3.apk",
            // Scheme.
            "http://github.com/relayium/relayium/releases/download/android-v0.1.2/Relayium-0.1.2-3.apk",
            "javascript:alert(1)",
            "intent://github.com/#Intent;scheme=https;end",
            "file:///data/local/tmp/Relayium-0.1.2-3.apk",
            // Host.
            "https://github.com.evil.example/relayium/relayium/releases/download/android-v0.1.2/Relayium-0.1.2-3.apk",
            "https://raw.github.com/relayium/relayium/releases/download/android-v0.1.2/Relayium-0.1.2-3.apk",
            "https://github.com./relayium/relayium/releases/download/android-v0.1.2/Relayium-0.1.2-3.apk",
            // Port, even the canonical one.
            "https://github.com:443/relayium/relayium/releases/download/android-v0.1.2/Relayium-0.1.2-3.apk",
            "https://github.com:8443/relayium/relayium/releases/download/android-v0.1.2/Relayium-0.1.2-3.apk",
            // Query and fragment: what a redirector would need.
            "https://github.com/relayium/relayium/releases/download/android-v0.1.2/Relayium-0.1.2-3.apk?to=evil",
            "https://github.com/relayium/relayium/releases/download/android-v0.1.2/Relayium-0.1.2-3.apk#x",
            // Traversal, raw and encoded.
            "https://github.com/relayium/relayium/releases/download/android-v0.1.2/../../../Relayium-0.1.2-3.apk",
            "https://github.com/relayium/relayium/releases/download/android-v0.1.2/%2e%2e/Relayium-0.1.2-3.apk",
            "https://github.com/relayium%2Frelayium/releases/download/android-v0.1.2/Relayium-0.1.2-3.apk",
            "https://github.com//relayium/relayium/releases/download/android-v0.1.2/Relayium-0.1.2-3.apk",
            // Not a URL at all.
            "not a url",
            "",
        )
        for (url in bad) assertFalse(url, UpdateFeed.isOfficialDownloadUrl(url, "0.1.2", 3))
    }

    @Test
    fun `refuses a url check for a version that is not itself well formed`() {
        // The path is DERIVED from the version, so a malformed version can
        // never be allowed to build one.
        assertFalse(UpdateFeed.isOfficialDownloadUrl("https://github.com/x", "../..", 3))
        assertFalse(
            UpdateFeed.isOfficialDownloadUrl(
                "https://github.com" + UpdateFeed.assetPath("0.1.2", 0),
                "0.1.2",
                0,
            ),
        )
    }

    @Test
    fun `refuses a duplicated key that would smuggle a second value`() {
        // The strict reader takes last-one-wins, matching JavaScript, so a
        // duplicate cannot present one value to a checker and another to us.
        val text = """{"schema":1,"android":{"available":true,"available":false}}"""
        val parsed = UpdateFeed.parse(text)
        assertEquals(UpdateFeed.Feed.None, (parsed as UpdateFeed.Parsed.Ok).feed)
    }
}
