package com.relayium.android.ingress

import com.relayium.protocol.stored.encodeStoreKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * What a printed QR code is allowed to do.
 *
 * A sticker on a wall is unauthenticated input from anybody who can print, with
 * none of the domain verification an OS-delivered link at least has — so the
 * only interesting question is what the app does with a payload chosen entirely
 * by somebody else.
 */
class ScanPolicyTest {

    private val origin = "https://relayium.com"
    private val key = encodeStoreKey(ByteArray(32) { 0x11 })

    private fun scan(payload: String) = ScanPolicy.result(payload, origin)

    @Test
    fun `a join link with a code prefills that code`() {
        val result = assertNotNull(scan("$origin/cross-network#c=042913"))
        assertEquals("042913", scan("$origin/cross-network#c=042913")!!.code.digits)
        assertNull(scan("$origin/cross-network#c=042913")!!.modeHint)
        assertNotNull(result)
    }

    @Test
    fun `an Apple-generated code carries its lane hint through the scanner`() {
        assertEquals(IngressTransferMode.TEXT, scan("$origin/cross-network?mode=text#c=042913")!!.modeHint)
        assertEquals(IngressTransferMode.FILE, scan("$origin/cross-network?mode=file#c=042913")!!.modeHint)
    }

    @Test
    fun `a code-less join link is nothing to a scanner`() {
        // It means "open the pairing screen" — which is where the user already
        // is while scanning.
        assertNull(scan("$origin/cross-network"))
        assertNull(scan("$origin/cross-network#"))
    }

    @Test
    fun `a stored download link is not a pairing code`() {
        // A different feature reached from a different screen. Silently
        // redirecting a scanner into it is exactly the surprise a printed code
        // must not be able to cause.
        assertNull(scan("$origin/d/abc123#k=$key"))
    }

    @Test
    fun `everything the link policy refuses is nothing here either`() {
        for (payload in listOf(
            "https://evil.example/cross-network#c=042913",
            "https://user:pass@relayium.com/cross-network#c=042913",
            "$origin/cross-networkX#c=042913",
            "$origin/cross-network#c=12345",
            "relayium://cross-network#c=042913",
            "042913",
            "just some text",
            "",
        )) {
            assertNull(payload, scan(payload))
        }
    }

    @Test
    fun `a bare six-digit code is not accepted from a camera`() {
        // The join FIELD takes a bare code, because that is a person typing.
        // A scanner accepting one would let a sticker reading "042913" reach
        // the same place as a verified-domain link.
        assertNull(scan("042913"))
    }

    @Test
    fun `an oversized payload is refused before it is parsed`() {
        val padded = "$origin/cross-network?mode=file&pad=" +
            "0".repeat(ScanPolicy.MAX_PAYLOAD_BYTES) + "#c=042913"
        assertNull(padded, scan(padded))
    }

    @Test
    fun `the bound is on bytes, not characters`() {
        // A QR code carries bytes. Counting characters would let a payload of
        // multi-byte code points be several times the size the number suggests.
        val multiByte = "文".repeat(ScanPolicy.MAX_PAYLOAD_BYTES / 3 + 1)
        assertNull(scan(multiByte))
        assertEquals(3, "文".toByteArray(Charsets.UTF_8).size)
    }
}
