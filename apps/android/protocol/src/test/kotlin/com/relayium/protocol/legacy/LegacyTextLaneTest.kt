package com.relayium.protocol.legacy

import com.relayium.protocol.Crypto
import com.relayium.protocol.LinkProtocol
import com.relayium.protocol.RealtimeFrame
import com.relayium.protocol.TextLaneSession
import com.relayium.protocol.TextSessionLimits
import com.relayium.protocol.TextWire
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The shipped message connection's LIFECYCLE, which is where it differs from
 * `link/1`: no `0xfa`, no `0xfb`, no reopen, and an activation gate each role
 * reaches differently.
 *
 * The codec is asserted against the frozen frames in `LegacyVectorTest`; this
 * file is about which frames may cross and when.
 */
class LegacyTextLaneTest {

    private fun keys(): Pair<Crypto.SessionKeys, Crypto.SessionKeys> {
        val a = Crypto.generateKeyPair()
        val b = Crypto.generateKeyPair()
        return Crypto.deriveSession(Crypto.Role.INITIATOR, a, b.publicKey) to
            Crypto.deriveSession(Crypto.Role.RESPONDER, b, a.publicKey)
    }

    private fun lane(
        k: Crypto.SessionKeys,
        role: LinkProtocol.Role,
        now: () -> Long = System::currentTimeMillis,
    ) = LegacyTextLane(k, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES, role, now = now).also {
        it.attachReceiver()
    }

    private fun sent(actions: List<TextLaneSession.Action>) =
        actions.filterIsInstance<TextLaneSession.Action.Send>().map { it.frame }

    // ── the two starting states ─────────────────────────────────────────────

    @Test
    fun `the offer already asked, so neither role starts idle`() {
        val (local, _) = keys()
        assertEquals(
            TextLaneSession.State.REQUESTED,
            lane(local, LinkProtocol.Role.INITIATOR).state,
        )
        assertEquals(
            TextLaneSession.State.INCOMING_REQUEST,
            lane(local, LinkProtocol.Role.RESPONDER).state,
        )
    }

    @Test
    fun `there is nothing to reopen and nothing to wait for`() {
        val (local, _) = keys()
        val l = lane(local, LinkProtocol.Role.INITIATOR)
        assertFalse(l.canRequest)
        assertFalse(l.hasEndBarrier)
        assertEquals(emptyList<TextLaneSession.Action>(), l.request())
        assertEquals(emptyList<TextLaneSession.Action>(), l.endBarrierTimedOut())
    }

    // ── the activation gate ─────────────────────────────────────────────────

    @Test
    fun `a responder installs its handler before the byte that invites content`() {
        val (local, _) = keys()
        val bare = LegacyTextLane(local, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES, LinkProtocol.Role.RESPONDER)
        val failure = runCatching { bare.accept() }.exceptionOrNull()
        assertTrue("accept must refuse before the receiver is attached", failure is IllegalStateException)
        assertEquals(TextLaneSession.State.INCOMING_REQUEST, bare.state)
    }

    @Test
    fun `a responder accept sends exactly the shared accept byte`() {
        val (local, _) = keys()
        val l = lane(local, LinkProtocol.Role.RESPONDER)
        val actions = l.accept()
        assertEquals(listOf(RealtimeFrame.CTRL_ACCEPT), sent(actions).map { it.single().toInt() and 0xff })
        assertTrue(actions.contains(TextLaneSession.Action.Opened))
        assertEquals(TextLaneSession.State.OPEN, l.state)
    }

    @Test
    fun `an initiator may not surface content before the peer's accept`() {
        val (local, remote) = keys()
        val l = lane(local, LinkProtocol.Role.INITIATOR)
        val peer = TextWire.Sender()
        // The channel is ordered and the shipped responder cannot send before
        // its own ACCEPT, so this is a peer skipping consent, not a race.
        val actions = l.onFrame(peer.frame("early", remote))
        assertEquals(
            listOf(TextLaneSession.Action.Fail(TextLaneSession.Action.Reason.CONTENT_BEFORE_ACTIVATION)),
            actions,
        )
        assertEquals(TextLaneSession.State.FAILED, l.state)
        // And a later ACCEPT cannot un-fail it.
        assertEquals(emptyList<TextLaneSession.Action>(), l.onFrame(TextWire.ACCEPT))
        assertEquals(TextLaneSession.State.FAILED, l.state)
    }

    @Test
    fun `an initiator opens on the peer's accept and then carries both directions`() {
        val (local, remote) = keys()
        val l = lane(local, LinkProtocol.Role.INITIATOR)
        assertEquals(listOf(TextLaneSession.Action.Opened), l.onFrame(TextWire.ACCEPT))
        assertEquals(TextLaneSession.State.OPEN, l.state)
        val peer = TextWire.Sender()
        assertEquals(
            listOf(TextLaneSession.Action.Received("你好 🌍")),
            l.onFrame(peer.frame("你好 🌍", remote)),
        )
        assertEquals(1, sent(l.send("reply")).size)
    }

    // ── refusal and the end of a conversation ───────────────────────────────

    @Test
    fun `a peer refusal is terminal and says so`() {
        val (local, _) = keys()
        val l = lane(local, LinkProtocol.Role.INITIATOR)
        val actions = l.onFrame(TextWire.REJECT)
        assertEquals(
            listOf(TextLaneSession.Action.Fail(TextLaneSession.Action.Reason.REFUSED)),
            actions,
        )
        assertEquals(TextLaneSession.State.ENDED, l.state)
    }

    @Test
    fun `a peer reject during an open conversation ends it`() {
        val (local, _) = keys()
        val l = lane(local, LinkProtocol.Role.RESPONDER)
        l.accept()
        assertEquals(listOf(TextLaneSession.Action.Ended), l.onFrame(TextWire.REJECT))
        assertEquals(TextLaneSession.State.ENDED, l.state)
    }

    @Test
    fun `ending emits no byte this wire does not have`() {
        val (local, _) = keys()
        val l = lane(local, LinkProtocol.Role.RESPONDER)
        l.accept()
        val actions = l.end()
        assertEquals("there is no 0xfb on this wire", emptyList<ByteArray>(), sent(actions))
        assertEquals(listOf(TextLaneSession.Action.Ended), actions)
        assertEquals(TextLaneSession.State.ENDED, l.state)
        // Idempotent: a second end is not a second teardown.
        assertEquals(emptyList<TextLaneSession.Action>(), l.end())
    }

    @Test
    fun `a reject from the responder sends the byte and retires the conversation`() {
        val (local, _) = keys()
        val l = lane(local, LinkProtocol.Role.RESPONDER)
        val actions = l.reject()
        assertEquals(listOf(RealtimeFrame.CTRL_REJECT), sent(actions).map { it.single().toInt() and 0xff })
        assertEquals(TextLaneSession.State.ENDED, l.state)
    }

    // ── what must never fail a conversation ─────────────────────────────────

    @Test
    fun `the file generation's complete byte is ignored, not fatal`() {
        // `RealtimeConnection` reads `0xfd` in text mode and does nothing with
        // it. A peer doing exactly what the shipped client does must not be
        // able to kill a conversation.
        val (local, _) = keys()
        val l = lane(local, LinkProtocol.Role.RESPONDER)
        l.accept()
        assertEquals(emptyList<TextLaneSession.Action>(), l.onFrame(RealtimeFrame.COMPLETE))
        assertEquals(TextLaneSession.State.OPEN, l.state)
    }

    @Test
    fun `an oversize message is refused without burning a sequence number`() {
        val (local, remote) = keys()
        val l = lane(local, LinkProtocol.Role.RESPONDER)
        l.accept()
        val before = l.sendSeq
        val huge = "x".repeat(l.plainLimit + 1)
        assertEquals(
            listOf(TextLaneSession.Action.Fail(TextLaneSession.Action.Reason.MALFORMED)),
            l.send(huge),
        )
        assertEquals("a refusal must not spend a nonce", before, l.sendSeq)
        assertEquals("and the conversation survives it", TextLaneSession.State.OPEN, l.state)
        // The next message still opens on the peer's receiver at that number.
        val frame = sent(l.send("ok")).single()
        assertEquals("ok", TextWire.Receiver().feed(frame, remote))
    }

    // ── hard failures ───────────────────────────────────────────────────────

    @Test
    fun `a tampered frame fails the conversation rather than being skipped`() {
        val (local, remote) = keys()
        val l = lane(local, LinkProtocol.Role.RESPONDER)
        l.accept()
        val frame = TextWire.Sender().frame("hello", remote)
        frame[frame.size - 1] = (frame[frame.size - 1].toInt() xor 0x01).toByte()
        assertEquals(
            listOf(TextLaneSession.Action.Fail(TextLaneSession.Action.Reason.MALFORMED)),
            l.onFrame(frame),
        )
        assertEquals(TextLaneSession.State.FAILED, l.state)
    }

    @Test
    fun `a frame claiming the message kind but too short to hold a tag fails`() {
        val (local, _) = keys()
        val l = lane(local, LinkProtocol.Role.RESPONDER)
        l.accept()
        assertEquals(
            listOf(TextLaneSession.Action.Fail(TextLaneSession.Action.Reason.MALFORMED)),
            l.onFrame(byteArrayOf(TextWire.KIND.toByte(), 0, 0, 0, 0)),
        )
        assertEquals(TextLaneSession.State.FAILED, l.state)
    }

    @Test
    fun `a flood of forged lifecycle bytes is bounded before anything is decrypted`() {
        val (local, _) = keys()
        // A frozen clock, so the bucket cannot refill mid-burst.
        val l = lane(local, LinkProtocol.Role.RESPONDER, now = { 0L })
        l.accept()
        var failed: TextLaneSession.Action.Fail? = null
        repeat(TextSessionLimits.BURST + 2) {
            l.onFrame(RealtimeFrame.COMPLETE).forEach { action ->
                if (action is TextLaneSession.Action.Fail) failed = action
            }
        }
        assertEquals(TextLaneSession.Action.Reason.BOUNDS, failed?.reason)
        assertEquals(TextLaneSession.State.FAILED, l.state)
    }

    @Test
    fun `a refused enqueue strands the lane truthfully on the same codecs`() {
        val (local, _) = keys()
        val l = lane(local, LinkProtocol.Role.RESPONDER)
        l.accept()
        val before = sent(l.send("first")).single()
        assertEquals(1L, l.sendSeq)
        assertEquals(
            listOf(TextLaneSession.Action.Fail(TextLaneSession.Action.Reason.TRANSPORT)),
            l.transportSendFailed(),
        )
        assertEquals(TextLaneSession.State.FAILED, l.state)
        // No rewind, no fresh codec: the number that was spent stays spent.
        assertEquals(1L, l.sendSeq)
        assertEquals(RealtimeFrame.KIND_TEXT_ENC, before[0].toInt() and 0xff)
    }
}
