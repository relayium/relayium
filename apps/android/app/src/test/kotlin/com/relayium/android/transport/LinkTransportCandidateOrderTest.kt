package com.relayium.android.transport

import android.content.ContextWrapper
import com.relayium.protocol.Crypto
import com.relayium.protocol.LinkProtocol
import com.relayium.protocol.Signal
import com.relayium.protocol.legacy.WireProfile
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.webrtc.IceCandidate

/**
 * The transport's own local-candidate ordering, driven through the PRODUCTION
 * seam the native stack enters.
 *
 * libwebrtc fires `onIceCandidate` on the signalling thread while
 * `setLocalDescription` is still unwinding, so the two callbacks arrive in
 * either order. The three functions exercised here —
 * [LinkTransport.beginLocalDescription], [LinkTransport.onLocalIceCandidate]
 * and [LinkTransport.onLocalDescriptionApplied] — are exactly what
 * `setLocalAndSend` and `PeerConnection.Observer.onIceCandidate` call; only the
 * native `setLocalDescription` sits between the first and the third, and it is
 * the one thing a JVM test cannot make. The assertion is on the real outbound
 * signal stream, not on the source.
 *
 * No `PeerConnection` and no `PeerConnectionFactory` is created: `start()` is
 * never called, so nothing here needs the native library.
 */
class LinkTransportCandidateOrderTest {

    private val executor = ScheduledThreadPoolExecutor(1)
    private val transports = ArrayList<LinkTransport>()

    @After
    fun tearDown() {
        for (transport in transports) onSession { transport.close("test-teardown") }
        executor.shutdownNow()
        executor.awaitTermination(2, TimeUnit.SECONDS)
    }

    private class Rig(
        val transport: LinkTransport,
        val sent: ConcurrentLinkedQueue<Signal>,
        val closed: ConcurrentLinkedQueue<String>,
        val profile: WireProfile,
    ) {
        /** What actually went on the wire, as `sdp:<type>` and `ice:<sdp>`. */
        fun wire(): List<String> = sent.map { signal ->
            when {
                signal.sdpType != null -> "sdp:${signal.sdpType}"
                signal.candidate != null -> "ice:${signal.candidate}"
                else -> "other"
            }
        }
    }

    /** Every call runs on the executor thread the transport owns, as the
     *  production callbacks do. */
    private fun <T> onSession(block: () -> T): T = executor.submit(block).get()

    private fun rig(role: LinkProtocol.Role = LinkProtocol.Role.INITIATOR): Rig {
        val sent = ConcurrentLinkedQueue<Signal>()
        val closed = ConcurrentLinkedQueue<String>()
        val profile = WireProfile.Link(role)
        val transport = LinkTransport(
            ContextWrapper(null),
            profile,
            emptyList(),
            executor,
            { signal -> sent.add(signal) },
            object : LinkTransport.Events {
                override fun onReady(keys: Crypto.SessionKeys, sas: String, maxFrameBytes: Int) = Unit
                override fun onFileFrame(frame: ByteArray) = Unit
                override fun onTextFrame(frame: ByteArray) = Unit
                override fun onClosed(reason: String) { closed.add(reason) }
            },
        )
        transports.add(transport)
        return Rig(transport, sent, closed, profile)
    }

    private fun candidate(host: String) =
        IceCandidate("0", 0, "candidate:1 1 udp 2130706431 $host 50000 typ host")

    /** The production send the local description's observer performs. */
    private fun Rig.applyLocal(type: String) = onSession {
        transport.onLocalDescriptionApplied {
            sent.add(
                if (type == "offer") profile.offer("v=0\r\n$type", "Y29tbWl0")
                else profile.answer("v=0\r\n$type", "Y29tbWl0"),
            )
        }
    }

    private fun Rig.gather(vararg hosts: String) = onSession {
        for (host in hosts) transport.onLocalIceCandidate(candidate(host))
    }

    @Test
    fun `an offer's candidates never overtake the offer`() {
        val rig = rig(LinkProtocol.Role.INITIATOR)
        // setLocalAndSend closes the gate, then the native call starts
        // gathering: both candidates below are produced BEFORE the observer
        // that sends the offer runs.
        onSession { rig.transport.beginLocalDescription() }
        rig.gather("10.0.0.7", "192.168.1.5")
        assertTrue(
            "a candidate must not reach a peer that has no description yet",
            rig.sent.isEmpty(),
        )
        rig.applyLocal("offer")
        assertEquals(
            listOf("sdp:offer", "ice:candidate:1 1 udp 2130706431 10.0.0.7 50000 typ host",
                "ice:candidate:1 1 udp 2130706431 192.168.1.5 50000 typ host"),
            rig.wire(),
        )
    }

    @Test
    fun `an answer's candidates never overtake the answer`() {
        val rig = rig(LinkProtocol.Role.RESPONDER)
        onSession { rig.transport.beginLocalDescription() }
        rig.gather("10.0.0.7")
        assertTrue(rig.sent.isEmpty())
        rig.applyLocal("answer")
        assertEquals(
            listOf("sdp:answer", "ice:candidate:1 1 udp 2130706431 10.0.0.7 50000 typ host"),
            rig.wire(),
        )
    }

    @Test
    fun `candidates gathered after the description was signalled go straight out`() {
        val rig = rig()
        onSession { rig.transport.beginLocalDescription() }
        rig.applyLocal("offer")
        rig.gather("10.0.0.7")
        assertEquals(
            listOf("sdp:offer", "ice:candidate:1 1 udp 2130706431 10.0.0.7 50000 typ host"),
            rig.wire(),
        )
    }

    @Test
    fun `a restart gates its own generation as the initial exchange did`() {
        val rig = rig(LinkProtocol.Role.RESPONDER)
        onSession { rig.transport.beginLocalDescription() }
        rig.gather("10.0.0.7")
        rig.applyLocal("answer")
        // A second local description — a renegotiation or an ICE restart. Its
        // candidates belong to a generation the peer has not been told about.
        onSession { rig.transport.beginLocalDescription() }
        rig.gather("10.0.0.8")
        assertEquals(
            "the restart's candidate must wait for the restart's answer",
            listOf("sdp:answer", "ice:candidate:1 1 udp 2130706431 10.0.0.7 50000 typ host"),
            rig.wire(),
        )
        rig.applyLocal("answer")
        assertEquals(
            listOf(
                "sdp:answer", "ice:candidate:1 1 udp 2130706431 10.0.0.7 50000 typ host",
                "sdp:answer", "ice:candidate:1 1 udp 2130706431 10.0.0.8 50000 typ host",
            ),
            rig.wire(),
        )
    }

    @Test
    fun `the local backlog is bounded and overflow fails the link closed`() {
        val rig = rig()
        onSession { rig.transport.beginLocalDescription() }
        onSession {
            repeat(LinkProtocol.HELD_SIGNAL_MAX) {
                rig.transport.onLocalIceCandidate(candidate("10.0.0.$it"))
            }
        }
        assertNull("nothing is torn down at the bound itself", rig.closed.peek())
        onSession { rig.transport.onLocalIceCandidate(candidate("10.9.9.9")) }
        assertEquals("local-candidate-overflow", rig.closed.peek())
        assertTrue(
            "a failed link sends no candidate at all — never a truncated set",
            rig.sent.isEmpty(),
        )
    }

    @Test
    fun `close drops the backlog and a late gathering callback is silent`() {
        val rig = rig()
        onSession { rig.transport.beginLocalDescription() }
        rig.gather("10.0.0.7", "10.0.0.8")
        onSession { rig.transport.close("local-close") }
        assertEquals("local-close", rig.closed.peek())
        // Continual gathering keeps producing after teardown, and applying a
        // description cannot come back either.
        rig.gather("10.0.0.9")
        onSession { rig.transport.onLocalDescriptionApplied { rig.sent.add(rig.profile.offer("v=0", "Y29tbWl0")) } }
        assertTrue(
            "a closed transport must not emit, and its backlog is gone",
            rig.sent.isEmpty(),
        )
        assertEquals("and close stays reported once", 1, rig.closed.size)
    }
}
