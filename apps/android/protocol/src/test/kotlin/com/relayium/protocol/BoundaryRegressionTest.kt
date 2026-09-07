package com.relayium.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regressions for the four boundary defects an independent review reproduced
 * against this module before the app was built on it.
 *
 * Each one is written as the PROPERTY that was violated, not as a copy of the
 * probe that found it, and none of them was made to pass by changing an expected
 * value or by constructing a fresh lane, key or counter. The point of R2 and R4
 * in particular is that the SAME codecs keep working; a test that reached for a
 * new session would assert the opposite of the fix.
 */
class BoundaryRegressionTest {

    /** A real mirrored key pair, exactly as a link derives one. */
    private fun linkKeys(): Pair<Crypto.SessionKeys, Crypto.SessionKeys> {
        val a = Crypto.generateKeyPair()
        val b = Crypto.generateKeyPair()
        return Crypto.deriveSession(Crypto.Role.INITIATOR, a, b.publicKey) to
            Crypto.deriveSession(Crypto.Role.RESPONDER, b, a.publicKey)
    }

    // ── R1: empty non-final fragments evaded the memory bound ───────────────

    @Test
    fun `an empty non-final fragment is refused outright`() {
        val (tx, rx) = linkKeys()
        val receiver = RealtimeReceiver()
        val frame = RealtimeFrame.frame(
            RealtimeFrame.KIND_BATCH_PART, 0, Crypto.sealFile(tx, 0, ByteArray(0)),
        )
        val failure = runCatching { receiver.feed(frame, rx) }.exceptionOrNull()
        assertTrue(
            "an authenticated zero-length partial frame must be refused, not retained: $failure",
            failure is RealtimeException,
        )
        // Not a size bound: a conforming sender's non-final piece is always
        // exactly `pieceBytes`, which is floored at MIN_PIECE_BYTES.
        assertTrue(failure!!.message!!.contains("empty non-final fragment"))
    }

    @Test
    fun `ten thousand empty partial frames cannot accumulate`() {
        val (tx, rx) = linkKeys()
        val receiver = RealtimeReceiver()
        var accepted = 0
        val failure = runCatching {
            repeat(10_000) { n ->
                receiver.feed(
                    RealtimeFrame.frame(
                        RealtimeFrame.KIND_BATCH_PART, n.toLong(), Crypto.sealFile(tx, n.toLong(), ByteArray(0)),
                    ),
                    rx,
                )
                accepted++
            }
        }.exceptionOrNull()
        assertTrue("the flood must be refused", failure is RealtimeException)
        assertEquals("it must be refused on the FIRST one, not eventually", 0, accepted)
    }

    @Test
    fun `the fragment count is bounded even when every piece carries bytes`() {
        val (tx, rx) = linkKeys()
        val receiver = RealtimeReceiver()
        // One byte per piece keeps the BYTE bound far away, so only a count
        // bound can stop this. A conforming sender cuts a chunk into at most
        // CHUNK_SIZE / MIN_PIECE_BYTES = 48 non-final pieces.
        val maxParts = RealtimeFrame.CHUNK_SIZE / RealtimeFrame.MIN_PIECE_BYTES
        var accepted = 0
        val failure = runCatching {
            repeat(maxParts + 5) { n ->
                receiver.feed(
                    RealtimeFrame.frame(
                        RealtimeFrame.KIND_CHUNK_PART, n.toLong(), Crypto.sealFile(tx, n.toLong(), byteArrayOf(7)),
                    ),
                    rx,
                )
                accepted++
            }
        }.exceptionOrNull()
        assertTrue("a fragment count flood must be refused", failure is RealtimeException)
        assertEquals("refused exactly at the protocol's own ceiling", maxParts, accepted)
    }

    @Test
    fun `an unfragmented logical unit still clears partial state`() {
        // The zero-buffered shortcut used to return before dropParts(), so a
        // kind recorded with no bytes survived into the next logical unit and
        // made a legitimate fragmented chunk look interleaved.
        val (tx, rx) = linkKeys()
        val sender = RealtimeSender()
        val receiver = RealtimeReceiver()
        val files = listOf(FileMeta("a.bin", 3))
        for (f in sender.batchFrames(files, tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
            receiver.feed(f, rx)
        }
        // A chunk immediately afterwards, fragmented, must reassemble.
        val chunk = byteArrayOf(1, 2, 3)
        var out: RealtimeReceiver.Output = RealtimeReceiver.Output.Buffered
        for (f in sender.chunkFrames(chunk, tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
            out = receiver.feed(f, rx)
        }
        assertTrue(out is RealtimeReceiver.Output.Chunk)
        assertArrayEqualsMessage(chunk, (out as RealtimeReceiver.Output.Chunk).plaintext)
    }

    // ── R2: a completed batch left the link unusable ────────────────────────

    @Test
    fun `two batches complete in a row on the same link and the sequence never rewinds`() {
        val (tx, _) = linkKeys()
        val sender = RealtimeSender()
        val session = FileLaneSession(tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES, sender = sender)

        session.startBatch(listOf(FileMeta("first", 0)))
        val seqAfterFirstManifest = sender.nextSeq
        session.onFrame(RealtimeFrame.ACCEPT)
        session.sendDone(Crypto.chainStart())
        session.finishSending()
        val firstComplete = session.onFrame(RealtimeFrame.COMPLETE)
        assertTrue(firstComplete.contains(FileLaneSession.Action.SendComplete))

        // The SAME session. No new keys, no new codecs, no reset counter.
        val seqBeforeSecond = sender.nextSeq
        session.startBatch(listOf(FileMeta("second", 0)))
        session.onFrame(RealtimeFrame.ACCEPT)
        session.sendDone(Crypto.chainStart())
        session.finishSending()
        assertTrue(session.onFrame(RealtimeFrame.COMPLETE).contains(FileLaneSession.Action.SendComplete))

        assertTrue(
            "the second batch must continue the sequence, never restart it",
            sender.nextSeq > seqBeforeSecond && seqBeforeSecond >= seqAfterFirstManifest,
        )
    }

    @Test
    fun `two incoming batches are received in a row on the same receiver`() {
        val (tx, rx) = linkKeys()
        val peer = RealtimeSender()
        val receiver = RealtimeReceiver()
        val session = FileLaneSession(rx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES, receiver = receiver)
        session.attachReceiver()

        repeat(2) { round ->
            val files = listOf(FileMeta("round-$round.bin", 3))
            for (f in peer.batchFrames(files, tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
                session.onFrame(f)
            }
            assertEquals(
                "round $round must reach the consent prompt",
                FileLaneSession.ReceiveState.PROMPT, session.receiveState,
            )
            session.acceptIncoming()
            val body = byteArrayOf(9, 8, 7)
            for (f in peer.chunkFrames(body, tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
                session.onFrame(f)
            }
            session.sendDoneForTest(peer, tx, body)
            assertEquals(
                "round $round must verify",
                FileLaneSession.ReceiveState.VERIFYING, session.receiveState,
            )
            val done = session.onBatchExported()
            assertTrue(done.contains(FileLaneSession.Action.ReceiveComplete))
        }
        assertEquals(
            "the receive sequence must have advanced across both batches",
            peer.nextSeq, receiver.nextExpectedSeq,
        )
    }

    @Test
    fun `a cancelled batch is followed by a working retry on the same link`() {
        val (tx, _) = linkKeys()
        val sender = RealtimeSender()
        val session = FileLaneSession(tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES, sender = sender)
        session.startBatch(listOf(FileMeta("doomed", 3)))
        session.onFrame(RealtimeFrame.ACCEPT)
        session.sendChunk(byteArrayOf(1, 2, 3))
        val seqBeforeCancel = sender.nextSeq
        val cancel = session.cancelOutgoing()
        assertTrue(
            "cancel emits the ordered barrier and nothing else",
            cancel.any { it is FileLaneSession.Action.Send && it.frame.contentEquals(RealtimeFrame.BATCH_ABORT) },
        )
        assertEquals(
            "a cancel is not a key event: the sequence continues across the barrier",
            seqBeforeCancel, sender.nextSeq,
        )
        // The retry works, at a LATER sequence number.
        session.startBatch(listOf(FileMeta("retry", 3)))
        assertTrue(sender.nextSeq > seqBeforeCancel)
    }

    // ── R3: the flow window counted wire bytes against plaintext ACKs ───────

    @Test
    fun `a fully acknowledged batch restores the entire window`() {
        val (tx, _) = linkKeys()
        val session = FileLaneSession(tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        session.startBatch(listOf(FileMeta("three", 3)))
        session.onFrame(RealtimeFrame.ACCEPT)
        session.sendChunk(byteArrayOf(1, 2, 3))
        assertEquals("credit is spent in CONTENT bytes", 3L, session.sentContentBytes)
        session.onFrame(RealtimeFrame.ackFrame(3))
        assertEquals(
            "durably acknowledging every content byte must return the whole window",
            RealtimeFrame.FLOW_WINDOW_BYTES, session.sendCredit,
        )
    }

    @Test
    fun `framing overhead never accumulates across a fragmented multi-chunk send`() {
        val (tx, _) = linkKeys()
        // A ceiling that forces many pieces per logical chunk, so an
        // overhead-per-frame leak would be large and obvious.
        val session = FileLaneSession(tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        val chunk = ByteArray(RealtimeFrame.CHUNK_SIZE) { (it % 251).toByte() }
        session.startBatch(listOf(FileMeta("big", RealtimeFrame.CHUNK_SIZE * 3L)))
        session.onFrame(RealtimeFrame.ACCEPT)
        var total = 0L
        repeat(3) {
            val actions = session.sendChunk(chunk)
            assertTrue("this ceiling must actually fragment", actions.size > 1)
            total += chunk.size
        }
        assertEquals("only plaintext content is charged to the window", total, session.sentContentBytes)
        session.onFrame(RealtimeFrame.ackFrame(total))
        assertEquals(RealtimeFrame.FLOW_WINDOW_BYTES, session.sendCredit)
    }

    @Test
    fun `the manifest and DONE are outside the window on both sides`() {
        val (tx, _) = linkKeys()
        val session = FileLaneSession(tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        session.startBatch(listOf(FileMeta("empty", 0)))
        assertEquals("the manifest spends no window", 0L, session.sentContentBytes)
        session.onFrame(RealtimeFrame.ACCEPT)
        session.sendDone(Crypto.chainStart())
        assertEquals("DONE spends no window either", 0L, session.sentContentBytes)
        assertEquals(RealtimeFrame.FLOW_WINDOW_BYTES, session.sendCredit)
    }

    @Test
    fun `an empty file consumes no window and still completes`() {
        val (tx, _) = linkKeys()
        val session = FileLaneSession(tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        session.startBatch(listOf(FileMeta("zero", 0)))
        session.onFrame(RealtimeFrame.ACCEPT)
        session.sendDone(Crypto.chainStart())
        session.finishSending()
        assertTrue(session.onFrame(RealtimeFrame.COMPLETE).contains(FileLaneSession.Action.SendComplete))
        assertEquals(RealtimeFrame.FLOW_WINDOW_BYTES, session.sendCredit)
    }

    @Test
    fun `a forged or replayed ACK cannot open more window than was emitted`() {
        val (tx, _) = linkKeys()
        val session = FileLaneSession(tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        session.startBatch(listOf(FileMeta("three", 3)))
        session.onFrame(RealtimeFrame.ACCEPT)
        session.sendChunk(byteArrayOf(1, 2, 3))
        // Beyond what this attempt emitted is IGNORED, not clamped down to it:
        // `advanceAck` returns the previous value unchanged. Clamping would let
        // a forged ACK ratchet the window to the batch's full emitted size on a
        // single frame, which is most of what the guard is for.
        session.onFrame(RealtimeFrame.ackFrame(1_000_000))
        assertEquals("an over-large ACK moves nothing", 0L, session.ackedContentBytes)
        // A legitimate one still lands afterwards.
        session.onFrame(RealtimeFrame.ackFrame(3))
        assertEquals(3L, session.ackedContentBytes)
        // And a rewind is ignored.
        session.onFrame(RealtimeFrame.ackFrame(1))
        assertEquals("a rewind is ignored", 3L, session.ackedContentBytes)
        assertEquals(RealtimeFrame.FLOW_WINDOW_BYTES, session.sendCredit)
    }

    // ── R4: END had no drain and no reopen ──────────────────────────────────

    @Test
    fun `text ends, drains the peer's in-flight tail, and reopens on the same counters`() {
        val (tx, rx) = linkKeys()
        val local = TextLaneSession(tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        // The peer's sender under the mirrored key, so its frames really open.
        val peerSender = TextWire.Sender()

        local.attachReceiver()
        local.onFrame(TextWire.REQUEST)
        assertEquals(TextLaneSession.State.INCOMING_REQUEST, local.state)
        local.accept()
        assertEquals(TextLaneSession.State.OPEN, local.state)

        // One message each way while open.
        local.onFrame(peerSender.frame("hello", rx))
        local.send("hi")
        val sendSeqBeforeEnd = local.sendSeq
        val recvSeqBeforeEnd = local.recvSeq

        // Local END. The peer had already sealed one more message.
        val ended = local.end()
        assertTrue(ended.any { it is TextLaneSession.Action.Send && it.frame.contentEquals(TextWire.END) })
        assertEquals(TextLaneSession.State.ENDED, local.state)

        val inFlight = local.onFrame(peerSender.frame("crossed the barrier", rx))
        assertTrue(
            "an in-flight authenticated frame must be DRAINED, not failed",
            inFlight.contains(TextLaneSession.Action.Drained),
        )
        assertFalse(
            "and it must never be surfaced",
            inFlight.any { it is TextLaneSession.Action.Received },
        )
        assertNotEquals(
            "draining advances the receive counter, which is the whole point",
            recvSeqBeforeEnd, local.recvSeq,
        )
        assertEquals("draining does not touch the send counter", sendSeqBeforeEnd, local.sendSeq)

        // The peer's ordered barrier closes the drain.
        local.onFrame(TextWire.END)
        assertEquals(TextLaneSession.State.ENDED, local.state)

        // Reopen, on the SAME session and therefore the same codecs.
        val recvSeqBeforeReopen = local.recvSeq
        val sendSeqBeforeReopen = local.sendSeq
        local.onFrame(TextWire.REQUEST)
        assertEquals(TextLaneSession.State.INCOMING_REQUEST, local.state)
        local.accept()
        assertEquals(TextLaneSession.State.OPEN, local.state)

        val reopened = local.onFrame(peerSender.frame("second conversation", rx))
        assertTrue(
            "a reopened conversation must decrypt at the CONTINUING sequence",
            reopened.contains(TextLaneSession.Action.Received("second conversation")),
        )
        assertTrue("the receive counter never rewound", local.recvSeq > recvSeqBeforeReopen)
        local.send("and back")
        assertTrue("the send counter never rewound", local.sendSeq > sendSeqBeforeReopen)
    }

    @Test
    fun `content after a completed end barrier is a hard lane failure, not a drain`() {
        val (tx, rx) = linkKeys()
        val local = TextLaneSession(tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        val peerSender = TextWire.Sender()
        local.attachReceiver()
        local.onFrame(TextWire.REQUEST)
        local.accept()
        local.end()
        local.onFrame(TextWire.END) // the barrier: the drain is over

        val late = local.onFrame(peerSender.frame("far too late", rx))
        assertTrue(
            late.contains(
                TextLaneSession.Action.Fail(TextLaneSession.Action.Reason.CONTENT_BEFORE_ACTIVATION),
            ),
        )
        assertEquals(TextLaneSession.State.FAILED, local.state)
    }

    @Test
    fun `a peer END while open sends the symmetric barrier and allows a reopen`() {
        val (tx, _) = linkKeys()
        val local = TextLaneSession(tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        local.attachReceiver()
        local.onFrame(TextWire.REQUEST)
        local.accept()
        val actions = local.onFrame(TextWire.END)
        assertTrue(
            "the side that ends SECOND answers with the symmetric barrier",
            actions.any { it is TextLaneSession.Action.Send && it.frame.contentEquals(TextWire.END) },
        )
        assertTrue(actions.contains(TextLaneSession.Action.Ended))
        assertEquals(TextLaneSession.State.ENDED, local.state)
        // And a local reopen is allowed from there.
        val request = local.request()
        assertTrue(request.any { it is TextLaneSession.Action.Send && it.frame.contentEquals(TextWire.REQUEST) })
        assertEquals(TextLaneSession.State.REQUESTED, local.state)
    }

    @Test
    fun `a request during an open conversation is refused, not silently dropped`() {
        val (tx, _) = linkKeys()
        val local = TextLaneSession(tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        local.attachReceiver()
        local.onFrame(TextWire.REQUEST)
        local.accept()
        val actions = local.onFrame(TextWire.REQUEST)
        assertTrue(
            "the peer must be told, or it waits out its own timeout",
            actions.any { it is TextLaneSession.Action.Send && it.frame.contentEquals(TextWire.REJECT) },
        )
        assertEquals(TextLaneSession.State.OPEN, local.state)
    }

    @Test
    fun `the file lane survives a text lane failure and the reverse`() {
        val (tx, rx) = linkKeys()
        val text = TextLaneSession(tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        val files = FileLaneSession(tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        // A truncated kind-9 frame fails the text lane.
        text.onFrame(byteArrayOf(9, 0, 0, 0, 0))
        assertEquals(TextLaneSession.State.FAILED, text.state)
        // The file lane is untouched and still starts a batch.
        files.startBatch(listOf(FileMeta("still works", 0)))
        assertEquals(FileLaneSession.SendState.WAITING_ACCEPT, files.sendState)
        // And in the other direction: an unroutable file frame does not reach text.
        val other = TextLaneSession(rx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        files.onFrame(byteArrayOf(13, 0, 0, 0, 0, 1))
        assertEquals(FileLaneSession.SendState.FAILED, files.sendState)
        assertEquals(TextLaneSession.State.IDLE, other.state)
    }

    private fun assertArrayEqualsMessage(expected: ByteArray, actual: ByteArray) {
        assertTrue(
            "expected ${Bytes.hex(expected)} but was ${Bytes.hex(actual)}",
            expected.contentEquals(actual),
        )
    }
}

/**
 * Drive the peer's DONE frame for a body the test just sent, so the receiving
 * session sees a real chained digest rather than a value the test invented.
 */
private fun FileLaneSession.sendDoneForTest(
    peer: RealtimeSender,
    peerKeys: Crypto.SessionKeys,
    body: ByteArray,
) {
    val chain = Crypto.chainAdvance(Crypto.chainStart(), body)
    onFrame(peer.doneFrame(chain, peerKeys))
}
