package com.relayium.android.ingress

import com.relayium.protocol.stored.encodeStoreKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Text another app shared, and the link that is usually inside it. */
class SharedTextPolicyTest {

    private val origin = "https://relayium.com"
    private val key = encodeStoreKey(ByteArray(32) { 0x7 })

    private fun read(text: String) = SharedTextPolicy.read(text, origin)

    private fun request(text: String): IngressRequest {
        val outcome = read(text)
        assertTrue("expected accepted, got $outcome", outcome is IngressOutcome.Accepted)
        return (outcome as IngressOutcome.Accepted).request
    }

    private fun refusal(text: String): IngressRefusal {
        val outcome = read(text)
        assertTrue("expected refused, got $outcome", outcome is IngressOutcome.Refused)
        return (outcome as IngressOutcome.Refused).reason
    }

    @Test
    fun `sharing a join link from a browser joins the link path, not the text path`() {
        // This is how a person moves a pairing link between devices: the
        // browser shares it as TEXT.
        val request = request("$origin/cross-network#c=042913")
        assertTrue(request is IngressRequest.PrefillCode)
        assertEquals("042913", (request as IngressRequest.PrefillCode).code.digits)
    }

    @Test
    fun `sharing a stored link opens the stored surface`() {
        val request = request("$origin/d/abc123#k=$key")
        assertTrue(request is IngressRequest.OpenStoredLink)
    }

    @Test
    fun `a link crosses exactly the same fences as a tapped one`() {
        // No relaxation for arriving as text: a foreign origin is not a link
        // this app acts on, whichever door it came through. It is staged as
        // TEXT, which is an ordinary thing to want to send.
        for (text in listOf(
            "https://evil.example/cross-network#c=042913",
            "https://user:pass@relayium.com/cross-network#c=042913",
            "$origin/cross-networkX#c=042913",
        )) {
            assertTrue(text, request(text) is IngressRequest.StageText)
        }
    }

    @Test
    fun `an ordinary URL is text a person wants to send`() {
        val request = request("https://en.wikipedia.org/wiki/QR_code")
        assertTrue(request is IngressRequest.StageText)
        assertEquals("https://en.wikipedia.org/wiki/QR_code", (request as IngressRequest.StageText).text)
    }

    @Test
    fun `prose is kept exactly as it was written`() {
        // Not trimmed, not normalised: it is the user's message.
        val text = "  meet at 6\n\nbring the drive  "
        assertEquals(text, (request(text) as IngressRequest.StageText).text)
    }

    @Test
    fun `nothing at all is refused`() {
        assertEquals(IngressRefusal.EMPTY, refusal(""))
        assertEquals(IngressRefusal.EMPTY, refusal("   \n\t "))
    }

    @Test
    fun `text longer than one message is refused`() {
        val tooLong = "x".repeat(SharedTextPolicy.MAX_TEXT_BYTES + 1)
        assertEquals(IngressRefusal.TEXT_TOO_LONG, refusal(tooLong))
    }

    @Test
    fun `the ceiling is bytes, so it is the same one the composer enforces`() {
        // A character count would accept here and be refused on the wire, after
        // the user had been told it fit.
        val justUnderInChars = "文".repeat(SharedTextPolicy.MAX_TEXT_BYTES / 3)
        assertTrue(justUnderInChars.length < SharedTextPolicy.MAX_TEXT_BYTES)
        assertEquals(IngressRefusal.TEXT_TOO_LONG, refusal(justUnderInChars + "文".repeat(1000)))
        // And a message that really does fit in bytes is accepted.
        assertTrue(request("文".repeat(100)) is IngressRequest.StageText)
    }

    @Test
    fun `a message at exactly the ceiling is accepted`() {
        val exact = "x".repeat(SharedTextPolicy.MAX_TEXT_BYTES)
        assertTrue(request(exact) is IngressRequest.StageText)
    }

    @Test
    fun `staged text does not print itself`() {
        val request = request("the passphrase is hunter2") as IngressRequest.StageText
        assertTrue(request.toString(), !request.toString().contains("hunter2"))
    }
}
