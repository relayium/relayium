package com.relayium.android

import com.relayium.android.transport.LinkTransport
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The remote `a=max-message-size` parse the negotiated ceiling comes from. */
class TransportParseTest {

    private val base = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"

    @Test
    fun `an advertised ceiling is read exactly`() {
        assertEquals(16_384, LinkTransport.parseMaxMessageSize(base + "a=max-message-size:16384\r\n"))
        assertEquals(262_144, LinkTransport.parseMaxMessageSize(base + "a=max-message-size:262144\r\n"))
    }

    @Test
    fun `no advertisement means null, and RFC 8841's default applies upstream`() {
        assertNull(LinkTransport.parseMaxMessageSize(base))
    }

    @Test
    fun `nonsense advertisements are treated as absent`() {
        assertNull(LinkTransport.parseMaxMessageSize(base + "a=max-message-size:zero\r\n"))
        assertNull(LinkTransport.parseMaxMessageSize(base + "a=max-message-size:0\r\n"))
        assertNull(LinkTransport.parseMaxMessageSize(base + "a=max-message-size:-5\r\n"))
    }

    @Test
    fun `a huge advertisement clamps instead of overflowing`() {
        assertEquals(
            Int.MAX_VALUE,
            LinkTransport.parseMaxMessageSize(base + "a=max-message-size:99999999999999\r\n"),
        )
    }
}
