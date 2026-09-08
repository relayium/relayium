package com.relayium.android.ingress

import com.relayium.protocol.stored.encodeStoreKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A link that arrives from another app, another site, or a printed sticker.
 *
 * Every case here is something an attacker can actually produce: they choose
 * the whole string, and the only thing they cannot choose is which of these
 * branches it lands in.
 */
class IngressLinkPolicyTest {

    private val origin = "https://relayium.com"
    private val key = encodeStoreKey(ByteArray(32) { 0x2a })

    private fun read(raw: String) = IngressLinkPolicy.read(raw, origin)

    private fun accepted(raw: String): IngressRequest {
        val outcome = read(raw)
        assertTrue("expected accepted for $raw, got $outcome", outcome is IngressOutcome.Accepted)
        return (outcome as IngressOutcome.Accepted).request
    }

    private fun refused(raw: String): IngressRefusal {
        val outcome = read(raw)
        assertTrue("expected refused for $raw, got $outcome", outcome is IngressOutcome.Refused)
        return (outcome as IngressOutcome.Refused).reason
    }

    @Test
    fun `a first-party join link prefills its code`() {
        val request = accepted("$origin/cross-network#c=042913")
        assertTrue(request is IngressRequest.PrefillCode)
        assertEquals("042913", (request as IngressRequest.PrefillCode).code.digits)
        assertNull(request.modeHint)
        assertEquals(IngressSurface.JOIN, request.surface)
    }

    @Test
    fun `a leading zero survives, because it is a tenth of the code space`() {
        assertEquals("000000", (accepted("$origin/cross-network#c=000000") as IngressRequest.PrefillCode).code.digits)
    }

    @Test
    fun `the manifest's path PREFIX filter does not widen what is honoured`() {
        // `android:pathPrefix="/cross-network"` delivers all of these, and
        // JoinInput does not look at the path at all — so this is the only
        // place the two facts meet. Without it, an attacker-chosen route on
        // the right host is an ordinary join link.
        for (path in listOf(
            "/cross-networkX",
            "/cross-network-evil",
            "/cross-network/extra",
            "/cross-network/",
            "/zh/cross-network",
        )) {
            assertEquals(path, IngressRefusal.UNSUPPORTED_PATH, refused("$origin$path#c=042913"))
        }
    }

    @Test
    fun `a link on any other origin is refused before anything acts on it`() {
        for (raw in listOf(
            "https://evil.example/cross-network#c=042913",
            "http://relayium.com/cross-network#c=042913",
            "https://relayium.com.evil.example/cross-network#c=042913",
            "https://relayium.com:8443/cross-network#c=042913",
            "https://sub.relayium.com/cross-network#c=042913",
        )) {
            assertEquals(raw, IngressRefusal.FOREIGN_ORIGIN, refused(raw))
        }
    }

    @Test
    fun `a credential-bearing link on the right host is its own refusal`() {
        // It passes every host comparison and is still a URL this app will not
        // act on, so it must not be reported as a foreign origin.
        assertEquals(
            IngressRefusal.CREDENTIALS_IN_LINK,
            refused("https://user:pass@relayium.com/cross-network#c=042913"),
        )
        assertEquals(
            IngressRefusal.CREDENTIALS_IN_LINK,
            refused("https://relayium.com@evil.example/cross-network#c=042913".replace("evil.example", "relayium.com")),
        )
    }

    @Test
    fun `userinfo that names the trusted host does not make a foreign host trusted`() {
        // The classic misread: everything before the `@` is userinfo, and the
        // HOST here is evil.example.
        assertEquals(
            IngressRefusal.CREDENTIALS_IN_LINK,
            refused("https://relayium.com@evil.example/cross-network#c=042913"),
        )
    }

    @Test
    fun `a scheme that is not http is not a link this app claims`() {
        for (raw in listOf(
            "relayium://cross-network#c=042913",
            "javascript:alert(1)",
            "intent://relayium.com/cross-network#c=042913#Intent;scheme=https;end",
            "//relayium.com/cross-network#c=042913",
            "not a url at all",
        )) {
            assertEquals(raw, IngressRefusal.MALFORMED_LINK, refused(raw))
        }
    }

    @Test
    fun `a malformed code is refused as a code, not as a route`() {
        assertEquals(IngressRefusal.NO_CODE_IN_LINK, refused("$origin/cross-network#c=12345"))
        assertEquals(IngressRefusal.NO_CODE_IN_LINK, refused("$origin/cross-network#c=abcdef"))
        assertEquals(IngressRefusal.NO_CODE_IN_LINK, refused("$origin/cross-network#c=0429134"))
        // Arabic-Indic digits are digits to `Char.isDigit` and are not in the
        // server's alphabet.
        assertEquals(IngressRefusal.NO_CODE_IN_LINK, refused("$origin/cross-network#c=٠٤٢٩١٣"))
        assertEquals(IngressRefusal.NO_CODE_IN_LINK, refused("$origin/cross-network#nonsense"))
    }

    @Test
    fun `a key on the join route is a malformed join link, not a stored link`() {
        // `#k=` at `/cross-network` is not a stored link this app could open —
        // a stored link lives at `/d/<id>` — so the honest refusal is that the
        // join link has no code in it.
        assertEquals(IngressRefusal.NO_CODE_IN_LINK, refused("$origin/cross-network#k=$key"))
    }

    @Test
    fun `a code-less join link is accepted and writes nothing`() {
        assertSame(IngressRequest.ShowJoinSurface, accepted("$origin/cross-network"))
        assertSame(IngressRequest.ShowJoinSurface, accepted("$origin/cross-network#"))
    }

    @Test
    fun `an Apple link's lane hint is read`() {
        // `pairingJoinURL(baseURL:code:mode:)` really emits this shape.
        assertEquals(
            IngressTransferMode.FILE,
            (accepted("$origin/cross-network?mode=file#c=042913") as IngressRequest.PrefillCode).modeHint,
        )
        assertEquals(
            IngressTransferMode.TEXT,
            (accepted("$origin/cross-network?mode=text#c=042913") as IngressRequest.PrefillCode).modeHint,
        )
    }

    @Test
    fun `an unrelated query parameter does not disturb a valid hint`() {
        // Only `mode` is read. A tracking parameter a messenger appended sits
        // beside it and changes nothing — the same thing `parseAppDeepLink`
        // does, which filters the query down to `mode` before looking at it.
        val request = accepted("$origin/cross-network?utm_source=chat&mode=file#c=042913")
        assertEquals(IngressTransferMode.FILE, (request as IngressRequest.PrefillCode).modeHint)
        assertEquals("042913", request.code.digits)
        assertEquals(
            IngressTransferMode.TEXT,
            (accepted("$origin/cross-network?mode=text&ref=abc#c=042913") as IngressRequest.PrefillCode).modeHint,
        )
    }

    @Test
    fun `an unreadable hint drops the hint and keeps the code`() {
        // Matching `parseAppDeepLink`: the code is what the link is FOR, and
        // the hint selects nothing on its own — the lane is negotiated from the
        // peer's announcement. Refusing here would break a working link over a
        // field that decides nothing.
        for (raw in listOf(
            "$origin/cross-network?mode=video#c=042913",
            "$origin/cross-network?mode=file&mode=text#c=042913",
            "$origin/cross-network?mode=#c=042913",
            // No `mode` at all: nothing to read rather than something
            // unreadable, and the same null either way.
            "$origin/cross-network?utm_source=chat#c=042913",
        )) {
            val request = accepted(raw)
            assertTrue(raw, request is IngressRequest.PrefillCode)
            assertEquals(raw, "042913", (request as IngressRequest.PrefillCode).code.digits)
            assertNull(raw, request.modeHint)
        }
    }

    @Test
    fun `a stored link is opened as a stored link`() {
        val request = accepted("$origin/d/abc123#k=$key")
        assertTrue(request is IngressRequest.OpenStoredLink)
        assertEquals("abc123", (request as IngressRequest.OpenStoredLink).link.id)
        assertEquals(IngressSurface.STORED, request.surface)
    }

    @Test
    fun `a stored link this app cannot open is refused, never half-opened`() {
        for (raw in listOf(
            "$origin/d/abc123",
            "$origin/d/abc123#k=short",
            "$origin/d/abc%2F123#k=$key",
            "$origin/d/abc123?spy=1#k=$key",
        )) {
            assertEquals(raw, IngressRefusal.STORED_LINK_INVALID, refused(raw))
        }
    }

    @Test
    fun `a dot segment is resolved first, and then judged as the route it became`() {
        // Dot segments are resolved while the URL is parsed, per RFC 3986, and
        // the route check therefore sees what a browser would navigate to
        // rather than what was typed. Pinned because it decides both
        // directions and neither is obvious from the code:
        //
        //  - a link that resolves to a route with no entry point is refused as
        //    that route, whatever it looked like before...
        assertEquals(IngressRefusal.UNSUPPORTED_PATH, refused("$origin/d/../etc#k=$key"))
        assertEquals(IngressRefusal.UNSUPPORTED_PATH, refused("$origin/d/abc123/#k=$key"))
        //  - ...and one that resolves to exactly the join route IS the join
        //    link it resolves to. Refusing it would refuse a string that every
        //    browser, and the server it points at, agree names the join page —
        //    and the origin, which is the fence that matters, is unchanged by
        //    any amount of dot-segment noise inside the path.
        val request = accepted("$origin/d/x/../../cross-network#c=042913")
        assertEquals("042913", (request as IngressRequest.PrefillCode).code.digits)
    }

    @Test
    fun `an unbounded payload is refused by length, before it is parsed`() {
        val huge = "$origin/cross-network#c=" + "0".repeat(IngressLinkPolicy.MAX_LINK_CHARS)
        assertEquals(IngressRefusal.MALFORMED_LINK, refused(huge))
    }

    @Test
    fun `nothing at all is EMPTY rather than malformed`() {
        assertEquals(IngressRefusal.EMPTY, refused(""))
        assertEquals(IngressRefusal.EMPTY, refused("   \n "))
    }

    @Test
    fun `an acceptance build's own origin is honoured, and only that one`() {
        val local = "http://10.0.2.2:8080"
        val request = IngressLinkPolicy.read("$local/cross-network#c=042913", local)
        assertTrue(request is IngressOutcome.Accepted)
        // A different port on the same host is a different server, which on a
        // shared machine belongs to somebody else's run.
        assertTrue(
            IngressLinkPolicy.read("http://10.0.2.2:8081/cross-network#c=042913", local)
                is IngressOutcome.Refused,
        )
        // And production links are not claimed by a build pointed elsewhere.
        assertTrue(
            IngressLinkPolicy.read("$origin/cross-network#c=042913", local) is IngressOutcome.Refused,
        )
    }
}
