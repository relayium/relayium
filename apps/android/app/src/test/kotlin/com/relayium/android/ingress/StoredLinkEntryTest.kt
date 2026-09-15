package com.relayium.android.ingress

import com.relayium.protocol.JoinInput
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The decision the Code-or-link field makes about a stored-file link.
 *
 * ## What was wrong
 *
 * `TransferViewModel.join` parsed with [JoinInput] and showed the rejection. For
 * a `/d/<id>#k=<key>` link that rejection read "That is a stored-file link. This
 * app joins live transfers between two devices that are both open" — a sentence
 * that was FALSE about the app it appeared in: the Cloud surface receives
 * exactly those links, anonymously, in the same build. Somebody who pasted one
 * was told the app could not do the thing it does, with no route to the screen
 * that does it.
 *
 * ## The rule this pins
 *
 * `join` composes two parsers, and the composition is the interesting part:
 * [JoinInput.parse] decides whether the input is a pairing code, and only what
 * it REJECTS is offered to [IngressLinkPolicy], which decides whether the input
 * is a stored link this app may open. Acceptance needs the second to say yes,
 * so a disagreement between them can only ever refuse.
 *
 * Deliberately NOT keyed on [JoinInput.Result.Reason.STORED_LINK]. That reason
 * means only "the fragment began with `k=`", which `/cross-network#k=…` also
 * produces and which a link on a host this app does not talk to never reaches
 * at all. Routing on it would have sent a `/cross-network` link to the stored
 * surface and refused a perfectly good `/d/` link from a self-hosted origin.
 */
class StoredLinkEntryTest {

    private val origin = "https://relayium.com"

    /** 32 bytes, url-safe and unpadded, as a real link carries. */
    private val key = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { 7 })

    private fun stored(id: String = "abc123") = "$origin/d/$id#k=$key"

    /** Exactly what `TransferViewModel.routeStoredLink` does with an input the
     *  join parser has already refused. */
    private fun routed(raw: String, trustedOrigin: String = origin): IngressRequest.OpenStoredLink? =
        (IngressLinkPolicy.read(raw, trustedOrigin) as? IngressOutcome.Accepted)
            ?.request as? IngressRequest.OpenStoredLink

    /** Whether the join parser refuses it, which is the precondition for the
     *  routing attempt happening at all. */
    private fun refusedByJoin(raw: String): Boolean =
        JoinInput.parse(raw) is JoinInput.Result.Rejected

    // ── what must now be routed ─────────────────────────────────────────────

    @Test
    fun `a valid stored link pasted into the join field is routed, not refused`() {
        val link = stored()
        assertTrue("the join parser must refuse it first", refusedByJoin(link))
        val request = routed(link)
        assertEquals("abc123", request?.link?.id)
        assertEquals(IngressSurface.STORED, request?.surface)
    }

    @Test
    fun `the routed request cannot express a download`() {
        // The vocabulary is the guarantee. `OpenStoredLink` resolves ENCRYPTED
        // metadata; there is no case in `IngressRequest` that names a transfer
        // action, so a pasted link inherits the same "prefill and show, never
        // act" rule a tapped one has always had.
        val request = routed(stored())!!
        assertTrue(request is IngressRequest.OpenStoredLink)
        assertEquals(IngressSurface.STORED, request.surface)
    }

    @Test
    fun `the routed request redacts the key it carries`() {
        // This value reaches coroutine failure text and test output, and the
        // fragment IS the decryption key.
        val text = routed(stored()).toString()
        assertTrue(text, !text.contains(key))
        assertTrue(text, text.contains("redacted"))
    }

    @Test
    fun `a stored link on a self-hosted origin is routed against that origin`() {
        // The join parser refuses this as a FOREIGN origin — it only ever knows
        // relayium.com — so routing on its STORED_LINK reason would have missed
        // every link the acceptance harness produces against a local server.
        val local = "http://127.0.0.1:8080"
        val link = "$local/d/abc123#k=$key"
        assertTrue(refusedByJoin(link))
        assertEquals("abc123", routed(link, trustedOrigin = local)?.link?.id)
    }

    // ── what must still fall through to the join field's own error ──────────

    @Test
    fun `a stored link on a host this app does not talk to is not routed`() {
        assertNull(routed("https://evil.example/d/abc123#k=$key"))
    }

    @Test
    fun `a relayium stored link is not routed when the app talks to another origin`() {
        // The join parser calls this STORED_LINK, because the fragment begins
        // `k=` and the host is the default one. The policy still refuses it:
        // this build does not talk to that origin, so it cannot open it.
        val link = stored()
        assertEquals(
            JoinInput.Result.Reason.STORED_LINK,
            (JoinInput.parse(link) as JoinInput.Result.Rejected).reason,
        )
        assertNull(routed(link, trustedOrigin = "http://127.0.0.1:8080"))
    }

    @Test
    fun `a k-fragment on the join route is not a stored link`() {
        // `/cross-network#k=…` also produces STORED_LINK from the join parser,
        // and it is NOT something the stored surface can open — a stored link
        // lives at `/d/<id>`. It must keep falling through.
        val link = "$origin/cross-network#k=$key"
        assertTrue(refusedByJoin(link))
        assertNull(routed(link))
    }

    @Test
    fun `a credential-bearing link is never routed, even on the right host`() {
        assertNull(routed("https://user:pass@relayium.com/d/abc123#k=$key"))
    }

    @Test
    fun `a stored link whose key is not a key is not routed`() {
        assertNull(routed("$origin/d/abc123#k=not-a-key"))
        assertNull(routed("$origin/d/abc123#k="))
        assertNull(routed("$origin/d/abc123"))
    }

    @Test
    fun `a stored link whose id is not one is not routed`() {
        assertNull(routed("$origin/d/../../etc#k=$key"))
        assertNull(routed("$origin/d/#k=$key"))
    }

    @Test
    fun `a deeper path that merely starts with d is not routed`() {
        assertNull(routed("$origin/d/abc123/extra#k=$key"))
        assertNull(routed("$origin/download/abc123#k=$key"))
    }

    @Test
    fun `a pairing code and a pairing link are untouched by this route`() {
        // The precondition fails for both: the join parser ACCEPTS them, so
        // routing is never attempted. Asserted anyway, because the change lives
        // in `join` and a regression there would show up as a code that stopped
        // connecting.
        assertTrue(JoinInput.parse("123456") is JoinInput.Result.Code)
        assertTrue(JoinInput.parse("$origin/cross-network#c=123456") is JoinInput.Result.Code)
    }

    @Test
    fun `a mistyped code is refused by the join field, not sent to the cloud`() {
        for (input in listOf("12345", "abcdef", "", "   ")) {
            assertTrue(input, refusedByJoin(input))
            assertNull(input, routed(input))
        }
    }

    @Test
    fun `a pairing link with a bad code is refused rather than routed`() {
        val link = "$origin/cross-network#c=12345"
        assertTrue(refusedByJoin(link))
        assertNull(routed(link))
    }
}
