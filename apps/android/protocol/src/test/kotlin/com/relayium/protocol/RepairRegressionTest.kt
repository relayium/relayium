package com.relayium.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regressions for the second independent review round: the handshake reveal
 * ordering (R9), the text end-barrier reopen race (R4.1), the JSON escape-digit
 * laxity (R6), and the missing cancellation barriers in both directions (R5),
 * including the rule that cancelling one direction must not touch the other.
 *
 * As with the first round, each test states the violated PROPERTY, none was
 * made green by weakening an expected value, and the reopen/retry cases reuse
 * the same sessions and codecs — a fresh lane would assert the opposite of the
 * fix.
 */
class RepairRegressionTest {

    private fun mirroredKeys(): Pair<Crypto.SessionKeys, Crypto.SessionKeys> {
        val a = Crypto.generateKeyPair()
        val b = Crypto.generateKeyPair()
        return Crypto.deriveSession(Crypto.Role.INITIATOR, a, b.publicKey) to
            Crypto.deriveSession(Crypto.Role.RESPONDER, b, a.publicKey)
    }

    // ── R9: no reveal before the peer's commitment exists ───────────────────

    @Test
    fun `an initiator answer without a commitment produces NO reveal`() {
        val handshake = LinkSession.Handshake(LinkProtocol.Role.INITIATOR)
        // The relay stripped (or the peer never sent) the answer's commit. The
        // on-answer path still runs — and must hand back nothing, because a key
        // revealed here could be committed to AFTER being seen, which is the
        // exact adaptive choice commit-reveal removes.
        assertFalse(handshake.hasPeerCommit)
        assertNull("no commitment, no reveal, unconditionally", handshake.revealOnAnswer())
        // Once the commitment is recorded the same call reveals exactly once.
        val peer = LinkSession.Handshake(LinkProtocol.Role.RESPONDER)
        assertTrue(handshake.recordPeerCommit(peer.commit))
        assertNotNull(handshake.revealOnAnswer())
        assertNull("the reveal is disclosed once, ever", handshake.revealOnAnswer())
    }

    @Test
    fun `the two-role handshake completes with mirrored keys and one SAS`() {
        val initiator = LinkSession.Handshake(LinkProtocol.Role.INITIATOR)
        val responder = LinkSession.Handshake(LinkProtocol.Role.RESPONDER)

        // Offer carries the initiator's commit; answer carries the responder's.
        assertTrue(responder.recordPeerCommit(initiator.commit))
        assertTrue(initiator.recordPeerCommit(responder.commit))

        // The initiator reveals on the answer; the responder verifies it and
        // only THEN discloses its own key.
        val initiatorReveal = initiator.revealOnAnswer()!!
        val fromResponder = responder.acceptReveal(initiatorReveal.key, initiatorReveal.nonce)
        val responderReveal =
            (fromResponder as LinkSession.Handshake.RevealResult.Accepted).reveal
        assertNotNull("the responder owes its reveal after verifying", responderReveal)
        val fromInitiator = initiator.acceptReveal(responderReveal!!.key, responderReveal.nonce)
        assertTrue(fromInitiator is LinkSession.Handshake.RevealResult.Accepted)
        assertNull(
            "the initiator already revealed; accepting must not produce a second",
            (fromInitiator as LinkSession.Handshake.RevealResult.Accepted).reveal,
        )

        val a = initiator.keys!!
        val b = responder.keys!!
        assertTrue(a.sendKey.contentEquals(b.recvKey))
        assertTrue(b.sendKey.contentEquals(a.recvKey))
        assertEquals(initiator.sas, responder.sas)
    }

    @Test
    fun `a replaced commitment is refused and an identical repeat is not`() {
        val handshake = LinkSession.Handshake(LinkProtocol.Role.INITIATOR)
        val peer = LinkSession.Handshake(LinkProtocol.Role.RESPONDER)
        val other = LinkSession.Handshake(LinkProtocol.Role.RESPONDER)
        assertTrue(handshake.recordPeerCommit(peer.commit))
        assertTrue("an ICE restart redelivers the same commit", handshake.recordPeerCommit(peer.commit))
        assertFalse("a DIFFERENT commit after the first is an attack", handshake.recordPeerCommit(other.commit))
        assertFalse(handshake.recordPeerCommit("not base64!"))
        assertFalse(handshake.recordPeerCommit(Bytes.base64(ByteArray(16))))
    }

    @Test
    fun `a reveal with no commitment recorded is a mismatch, not a pass`() {
        val handshake = LinkSession.Handshake(LinkProtocol.Role.RESPONDER)
        val peer = LinkSession.Handshake(LinkProtocol.Role.INITIATOR)
        // Force the peer to disclose without ever committing to this side.
        val other = LinkSession.Handshake(LinkProtocol.Role.RESPONDER)
        peer.recordPeerCommit(other.commit)
        val reveal = peer.revealOnAnswer()!!
        assertEquals(
            LinkSession.Handshake.RevealResult.Mismatch,
            handshake.acceptReveal(reveal.key, reveal.nonce),
        )
    }

    // ── R4.1: reopening must wait for the end barrier ───────────────────────

    @Test
    fun `an immediate local reopen is refused while the END barrier is outstanding`() {
        val (tx, rx) = mirroredKeys()
        val local = TextLaneSession(tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        val peerSender = TextWire.Sender()
        local.attachReceiver()
        local.onFrame(TextWire.REQUEST)
        local.accept()

        local.end()
        assertFalse("the barrier is outstanding; a request now would erase the drain", local.canRequest)
        assertTrue(runCatching { local.request() }.exceptionOrNull() is IllegalStateException)

        // The refused request must NOT have cleared the drain: a peer message
        // already in flight is authenticated and discarded, never failed.
        val inFlight = local.onFrame(peerSender.frame("crossed", rx))
        assertTrue(inFlight.contains(TextLaneSession.Action.Drained))
        assertFalse(inFlight.any { it is TextLaneSession.Action.Fail })

        // The peer's END settles the barrier, and only then may a new
        // conversation start — on the same codecs, at the continuing sequence.
        local.onFrame(TextWire.END)
        assertTrue(local.canRequest)
        val recvSeq = local.recvSeq
        local.request()
        assertEquals(TextLaneSession.State.REQUESTED, local.state)
        local.onFrame(byteArrayOf(RealtimeFrame.CTRL_ACCEPT.toByte()))
        assertEquals(TextLaneSession.State.OPEN, local.state)
        val reopened = local.onFrame(peerSender.frame("second", rx))
        assertTrue(reopened.contains(TextLaneSession.Action.Received("second")))
        assertTrue("the drain advanced the counter and reopen continued it", local.recvSeq > recvSeq)
    }

    @Test
    fun `a peer that never answers END poisons the text lane, and only the text lane`() {
        val (tx, rx) = mirroredKeys()
        val local = TextLaneSession(tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        val files = FileLaneSession(tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        val peerSender = TextWire.Sender()
        local.attachReceiver()
        local.onFrame(TextWire.REQUEST)
        local.accept()
        local.end()
        assertFalse(local.canRequest)

        // The lease expired. Elapsed time is NOT the peer's ordering barrier:
        // how many frames it sealed before seeing the END is unknowable, so the
        // lane fails visibly and non-reopenably rather than pretending.
        val timedOut = local.endBarrierTimedOut()
        assertTrue(
            timedOut.contains(
                TextLaneSession.Action.Fail(TextLaneSession.Action.Reason.BARRIER_TIMEOUT),
            ),
        )
        assertEquals(TextLaneSession.State.FAILED, local.state)
        assertFalse("the poison is permanent on this link", local.canRequest)

        // A LATE END cannot unpoison it, and neither can late content.
        assertTrue(local.onFrame(TextWire.END).isEmpty())
        assertTrue(local.onFrame(peerSender.frame("late", rx)).isEmpty())
        assertEquals(TextLaneSession.State.FAILED, local.state)
        assertTrue(runCatching { local.request() }.exceptionOrNull() is IllegalStateException)

        // The INDEPENDENT file lane is untouched and still starts a batch.
        files.startBatch(listOf(FileMeta("still works", 0)))
        assertEquals(FileLaneSession.SendState.WAITING_ACCEPT, files.sendState)
    }

    @Test
    fun `a failed transport enqueue after a consumed nonce poisons, never resets`() {
        val (tx, _) = mirroredKeys()
        val local = TextLaneSession(tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        local.attachReceiver()
        local.onFrame(TextWire.REQUEST)
        local.accept()
        val sent = local.send("about to be refused by the channel")
        assertTrue(sent.any { it is TextLaneSession.Action.Send })
        val seqAfter = local.sendSeq
        val actions = local.transportSendFailed()
        assertTrue(
            actions.contains(TextLaneSession.Action.Fail(TextLaneSession.Action.Reason.TRANSPORT)),
        )
        assertEquals(TextLaneSession.State.FAILED, local.state)
        assertEquals("the consumed nonce stays consumed", seqAfter, local.sendSeq)
    }

    @Test
    fun `an inbound frame flood is bounded, and ordinary pacing is not`() {
        var clock = 0L
        val (tx, rx) = mirroredKeys()
        val flooded = TextLaneSession(tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES, now = { clock })
        val floodPeer = TextWire.Sender()
        flooded.attachReceiver()
        flooded.onFrame(TextWire.REQUEST)
        flooded.accept()
        var failed = false
        repeat(TextSessionLimits.BURST + 2) { n ->
            if (flooded.onFrame(floodPeer.frame("m$n", rx)).any { it is TextLaneSession.Action.Fail }) {
                failed = true
            }
        }
        assertTrue("a same-instant flood past the burst must fail the lane", failed)

        val (tx2, rx2) = mirroredKeys()
        val calm = TextLaneSession(tx2, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES, now = { clock })
        val calmPeer = TextWire.Sender()
        calm.attachReceiver()
        calm.onFrame(TextWire.REQUEST)
        calm.accept()
        repeat(40) { n ->
            clock += 500 // two frames per second, well under the refill rate
            val actions = calm.onFrame(calmPeer.frame("paced$n", rx2))
            assertTrue("paced frame $n must pass", actions.any { it is TextLaneSession.Action.Received })
        }
    }

    // ── R6: JSON escape digits are ASCII, exactly ───────────────────────────

    @Test
    fun `unicode escapes refuse non-ASCII lookalike digits`() {
        // Fullwidth F (U+FF26) and Arabic-Indic four (U+0664) are both "digits"
        // to Kotlin's lenient converters and to nothing in JSON's grammar. The
        // documents are assembled so each carries a literal backslash-u escape.
        val fullwidth = String(CharArray(4) { 0xFF26.toChar() })
        val arabicIndic = String(CharArray(4) { 0x0664.toChar() })
        assertNull(Json.parseOrNull("{\"a\":\"\\u$fullwidth\"}"))
        assertNull(Json.parseOrNull("{\"a\":\"\\u$arabicIndic\"}"))
        assertNull(Json.parseOrNull("{\"a\":\"\\u12g4\"}"))
        assertNull(Json.parseOrNull("{\"a\":\"\\u123\"}"))
    }

    @Test
    fun `valid mixed-case escapes still decode exactly`() {
        // Built with an escaped backslash so the SOURCE carries a literal
        // `\uAbCd` for the parser to decode, not a character Kotlin already
        // decoded at compile time (which would test nothing).
        val mixed = "{\"a\":\"\\uAbCd\"}"
        val value = (Json.parse(mixed) as Json.Obj)["a"]
        assertEquals(0xABCD.toChar().toString(), (value as Json.Str).value)
        val upper = "{\"a\":\"\\u0041\"}"
        assertEquals("A", ((Json.parse(upper) as Json.Obj)["a"] as Json.Str).value)
    }

    // ── R5: the sender's barrier on every non-accept outcome ────────────────

    private fun barrier(actions: List<FileLaneSession.Action>): Boolean = actions.any {
        it is FileLaneSession.Action.Send && it.frame.contentEquals(RealtimeFrame.BATCH_ABORT)
    }

    @Test
    fun `a peer REJECT mid-send retires the batch behind the ordered barrier`() {
        val (tx, _) = mirroredKeys()
        val sender = RealtimeSender()
        val session = FileLaneSession(tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES, sender = sender)
        session.startBatch(listOf(FileMeta("f", 6)))
        session.onFrame(RealtimeFrame.ACCEPT)
        session.sendChunk(byteArrayOf(1, 2, 3))
        val seqBefore = sender.nextSeq

        val actions = session.onFrame(RealtimeFrame.REJECT)
        assertTrue("the Web receiver retires a cancelled batch on this barrier", barrier(actions))
        assertTrue(
            actions.any {
                it is FileLaneSession.Action.Fail &&
                    it.failure.reason == FileLaneSession.Failure.Reason.PEER_REJECTED &&
                    it.failure.scope == FileLaneSession.Failure.Scope.SEND
            },
        )
        assertEquals(FileLaneSession.SendState.IDLE, session.sendState)
        assertEquals("the barrier is not a key event", seqBefore, sender.nextSeq)

        // The SAME session carries the retry, at a later sequence.
        session.startBatch(listOf(FileMeta("retry", 0)))
        assertTrue(sender.nextSeq > seqBefore)
    }

    @Test
    fun `a peer BUSY at the prompt retires behind the barrier and permits requeue`() {
        val (tx, _) = mirroredKeys()
        val session = FileLaneSession(tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        session.startBatch(listOf(FileMeta("f", 0)))
        val actions = session.onFrame(RealtimeFrame.BUSY)
        assertTrue(barrier(actions))
        assertEquals(FileLaneSession.SendState.IDLE, session.sendState)
        session.startBatch(listOf(FileMeta("again", 0)))
        assertEquals(FileLaneSession.SendState.WAITING_ACCEPT, session.sendState)
    }

    // ── R5: the receiver's cancel, drain and barrier ────────────────────────

    /** Wire two real lanes together and drive the receiver through a cancel. */
    @Test
    fun `receiver cancel drains authenticated frames until the barrier, then the lane reuses`() {
        val (tx, rx) = mirroredKeys()
        val peer = RealtimeSender()
        val receiverCodec = RealtimeReceiver()
        val session = FileLaneSession(
            rx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES, receiver = receiverCodec,
        )
        session.attachReceiver()

        val body = ByteArray(RealtimeFrame.CHUNK_SIZE) { (it % 251).toByte() }
        val files = listOf(FileMeta("big.bin", RealtimeFrame.CHUNK_SIZE * 3L))
        for (f in peer.batchFrames(files, tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
            session.onFrame(f)
        }
        session.acceptIncoming()

        // One chunk lands normally and is written.
        var writes = 0
        for (f in peer.chunkFrames(body, tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
            writes += session.onFrame(f).count { it is FileLaneSession.Action.Write }
        }
        assertTrue(writes > 0)

        // The user cancels. REJECT goes out, staging is discarded, the failure
        // is scoped to RECEIVE, and the lane enters the drain.
        val cancel = session.cancelIncoming()
        assertTrue(
            cancel.any {
                it is FileLaneSession.Action.Send && it.frame.contentEquals(RealtimeFrame.REJECT)
            },
        )
        assertTrue(cancel.contains(FileLaneSession.Action.DiscardIncoming))
        assertTrue(
            cancel.any {
                it is FileLaneSession.Action.Fail &&
                    it.failure.scope == FileLaneSession.Failure.Scope.RECEIVE
            },
        )
        assertEquals(FileLaneSession.ReceiveState.DRAINING, session.receiveState)

        // Frames the peer sealed before it saw the REJECT: authenticated (the
        // sequence advances) and NEVER written.
        val seqBeforeDrain = receiverCodec.nextExpectedSeq
        for (f in peer.chunkFrames(body, tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
            val actions = session.onFrame(f)
            assertTrue(actions.none { it is FileLaneSession.Action.Write })
            assertTrue(actions.none { it is FileLaneSession.Action.Fail })
        }
        val doneChain = Crypto.chainAdvance(Crypto.chainStart(), body)
        assertTrue(session.onFrame(peer.doneFrame(doneChain, tx)).isEmpty())
        assertTrue("the drain consumed sequence numbers", receiverCodec.nextExpectedSeq > seqBeforeDrain)

        // The sender's ordered barrier closes the drain, quietly: the cancel
        // already reported once.
        assertTrue(session.onFrame(RealtimeFrame.BATCH_ABORT).isEmpty())
        assertEquals(FileLaneSession.ReceiveState.IDLE, session.receiveState)

        // And the SAME lane receives the next batch, at the continuing sequence.
        val second = listOf(FileMeta("second.bin", 3))
        for (f in peer.batchFrames(second, tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
            session.onFrame(f)
        }
        assertEquals(FileLaneSession.ReceiveState.PROMPT, session.receiveState)
        session.acceptIncoming()
        val small = byteArrayOf(9, 8, 7)
        for (f in peer.chunkFrames(small, tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
            session.onFrame(f)
        }
        session.onFrame(peer.doneFrame(Crypto.chainAdvance(Crypto.chainStart(), small), tx))
        assertEquals(FileLaneSession.ReceiveState.VERIFYING, session.receiveState)
    }

    @Test
    fun `a missing abort barrier is bounded and fails the lane truthfully`() {
        val (tx, rx) = mirroredKeys()
        val peer = RealtimeSender()
        val session = FileLaneSession(rx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        session.attachReceiver()
        for (f in peer.batchFrames(listOf(FileMeta("f", 3)), tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
            session.onFrame(f)
        }
        session.acceptIncoming()
        session.cancelIncoming()
        assertEquals(FileLaneSession.ReceiveState.DRAINING, session.receiveState)
        val actions = session.abortBarrierTimedOut()
        assertTrue(
            actions.any {
                it is FileLaneSession.Action.Fail &&
                    it.failure.scope == FileLaneSession.Failure.Scope.LANE
            },
        )
        assertEquals(FileLaneSession.ReceiveState.FAILED, session.receiveState)
    }

    @Test
    fun `a drain that keeps producing past the declared batch is refused`() {
        val (tx, rx) = mirroredKeys()
        val peer = RealtimeSender()
        val session = FileLaneSession(rx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        session.attachReceiver()
        // A tiny declared batch, so the drain bound is dominated by the flow
        // window: a sender that pushes a whole window past what it could have
        // had in flight is ignoring the cancel, not draining.
        for (f in peer.batchFrames(listOf(FileMeta("tiny", 3)), tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
            session.onFrame(f)
        }
        session.acceptIncoming()
        session.cancelIncoming()
        val chunk = ByteArray(RealtimeFrame.CHUNK_SIZE) { 1 }
        var failed = false
        var fed = 0L
        while (!failed && fed <= RealtimeFrame.FLOW_WINDOW_BYTES + RealtimeFrame.CHUNK_SIZE * 2L) {
            for (f in peer.chunkFrames(chunk, tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
                if (session.onFrame(f).any { it is FileLaneSession.Action.Fail }) {
                    failed = true
                    break
                }
            }
            fed += chunk.size
        }
        assertTrue("the drain volume is bounded", failed)
        assertEquals(FileLaneSession.ReceiveState.FAILED, session.receiveState)
    }

    // ── direction-specific cancellation ─────────────────────────────────────

    @Test
    fun `cancelling the outgoing batch leaves an in-flight incoming batch untouched`() {
        val (tx, rx) = mirroredKeys()
        val peer = RealtimeSender()
        val session = FileLaneSession(rx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        session.attachReceiver()
        // Incoming batch mid-receive.
        for (f in peer.batchFrames(listOf(FileMeta("in", 3)), tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
            session.onFrame(f)
        }
        session.acceptIncoming()
        assertEquals(FileLaneSession.ReceiveState.RECEIVING, session.receiveState)
        // Outgoing batch started and cancelled.
        session.startBatch(listOf(FileMeta("out", 0)))
        session.cancelOutgoing()
        assertEquals(FileLaneSession.SendState.IDLE, session.sendState)
        assertEquals(
            "an outgoing cancel must never reset the receive side",
            FileLaneSession.ReceiveState.RECEIVING, session.receiveState,
        )
    }

    @Test
    fun `cancelling the incoming batch leaves an in-flight outgoing batch untouched`() {
        val (tx, rx) = mirroredKeys()
        val peer = RealtimeSender()
        val session = FileLaneSession(rx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        session.attachReceiver()
        session.startBatch(listOf(FileMeta("out", 3)))
        session.onFrame(RealtimeFrame.ACCEPT)
        assertEquals(FileLaneSession.SendState.SENDING, session.sendState)
        for (f in peer.batchFrames(listOf(FileMeta("in", 3)), tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
            session.onFrame(f)
        }
        session.acceptIncoming()
        session.cancelIncoming()
        assertEquals(FileLaneSession.ReceiveState.DRAINING, session.receiveState)
        assertEquals(
            "an incoming cancel must never stop the outgoing stream",
            FileLaneSession.SendState.SENDING, session.sendState,
        )
    }
}
