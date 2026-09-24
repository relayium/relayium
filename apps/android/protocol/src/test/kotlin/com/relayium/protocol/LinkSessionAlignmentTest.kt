package com.relayium.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The file-lane divergences the cross-language link-session vectors found
 * between this machine and the Web authority (`mixed-file-session.svelte.ts`)
 * and the Go `linksession` tables.
 *
 * - A08e-D6: a DONE whose chained digest does not verify must REJECT, discard
 *   the batch, DRAIN to the sender's barrier and leave the lane usable. Failing
 *   the whole lane with no byte left a Web sender waiting in "finishing" until
 *   its completion stall, and cost the user every later batch on the link.
 * - A08e-D4: a peer REJECT or BUSY received while still WAITING for consent is
 *   itself the complete barrier — the sender emitted nothing but the manifest
 *   — so no BATCH_ABORT answers it.
 *
 * Until the shared fixture (`link-session-vectors.json`, A08e) lands in this
 * tree these are asserted here directly. When it lands, its Kotlin divergence
 * entries for `file.integrity-then-retry` (D6) and `file.peer-declines` (D4)
 * must be REMOVED: the Kotlin consumer now follows the shared expectation.
 */
class LinkSessionAlignmentTest {

    private val maxFrame = RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES

    private fun mirroredKeys(): Pair<Crypto.SessionKeys, Crypto.SessionKeys> {
        val a = Crypto.generateKeyPair()
        val b = Crypto.generateKeyPair()
        return Crypto.deriveSession(Crypto.Role.INITIATOR, a, b.publicKey) to
            Crypto.deriveSession(Crypto.Role.RESPONDER, b, a.publicKey)
    }

    private fun List<FileLaneSession.Action>.sent(frame: ByteArray): Boolean =
        any { it is FileLaneSession.Action.Send && it.frame.contentEquals(frame) }

    private fun List<FileLaneSession.Action>.failure(): FileLaneSession.Failure? =
        filterIsInstance<FileLaneSession.Action.Fail>().singleOrNull()?.failure

    private fun chain(bytes: ByteArray) = Crypto.chainAdvance(Crypto.chainStart(), bytes)

    private class Rig(barrier: Boolean = true) {
        val keys = run {
            val a = Crypto.generateKeyPair()
            val b = Crypto.generateKeyPair()
            Crypto.deriveSession(Crypto.Role.INITIATOR, a, b.publicKey) to
                Crypto.deriveSession(Crypto.Role.RESPONDER, b, a.publicKey)
        }
        val tx = keys.first
        val peer = RealtimeSender()
        val receiver = RealtimeReceiver()
        val session = FileLaneSession(
            keys.second, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES,
            receiver = receiver, barrier = barrier,
        ).also { it.attachReceiver() }

        fun offer(files: List<FileMeta>) {
            for (f in peer.batchFrames(files, tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
                session.onFrame(f)
            }
        }

        fun content(bytes: ByteArray): List<FileLaneSession.Action> =
            peer.chunkFrames(bytes, tx, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
                .flatMap { session.onFrame(it) }

        fun done(chain: ByteArray): List<FileLaneSession.Action> =
            session.onFrame(peer.doneFrame(chain, tx))
    }

    // ── A08e-D6: digest mismatch ────────────────────────────────────────────

    @Test
    fun `a DONE digest mismatch REJECTs, discards, drains and keeps the lane reusable`() {
        val rig = Rig()
        val session = rig.session
        rig.offer(listOf(FileMeta("hello.txt", 5)))
        assertEquals(FileLaneSession.ReceiveState.PROMPT, session.receiveState)
        session.acceptIncoming()
        val hello = "hello".encodeToByteArray()
        assertTrue(rig.content(hello).any { it is FileLaneSession.Action.Write })

        // The DONE is at the right sequence, but its digest covers other bytes.
        val actions = rig.done(chain("world".encodeToByteArray()))

        assertTrue("the Web and Go answer a mismatch with REJECT", actions.sent(RealtimeFrame.REJECT))
        assertFalse("never a COMPLETE for bytes that did not verify", actions.sent(RealtimeFrame.COMPLETE))
        assertTrue(actions.contains(FileLaneSession.Action.FileCorrupt(0)))
        assertTrue("the batch's staged output is discarded", actions.contains(FileLaneSession.Action.DiscardIncoming))
        assertFalse(actions.any { it is FileLaneSession.Action.FileVerified })
        val failure = actions.failure()
        assertEquals(FileLaneSession.Failure.Reason.INTEGRITY, failure?.reason)
        assertEquals(
            "an integrity failure retires the BATCH, not the lane",
            FileLaneSession.Failure.Scope.RECEIVE, failure?.scope,
        )
        // REJECT precedes the discard so the sender stops as early as possible.
        val rejectAt = actions.indexOfFirst {
            it is FileLaneSession.Action.Send && it.frame.contentEquals(RealtimeFrame.REJECT)
        }
        assertEquals(0, rejectAt)
        assertEquals(FileLaneSession.ReceiveState.DRAINING, session.receiveState)
        assertEquals("the send side is untouched", FileLaneSession.SendState.IDLE, session.sendState)

        // The sender's ordered barrier closes the drain quietly: the mismatch
        // already reported once.
        assertTrue(session.onFrame(RealtimeFrame.BATCH_ABORT).isEmpty())
        assertEquals(FileLaneSession.ReceiveState.IDLE, session.receiveState)

        // The SAME lane takes the retry at the continuing sequence, and this
        // time it verifies and completes.
        rig.offer(listOf(FileMeta("hello.txt", 5)))
        assertEquals(FileLaneSession.ReceiveState.PROMPT, session.receiveState)
        session.acceptIncoming()
        rig.content(hello)
        assertTrue(rig.done(chain(hello)).contains(FileLaneSession.Action.FileVerified(0)))
        assertEquals(FileLaneSession.ReceiveState.VERIFYING, session.receiveState)
        assertTrue(session.onBatchExported().sent(RealtimeFrame.COMPLETE))
        assertEquals(FileLaneSession.ReceiveState.DONE, session.receiveState)
    }

    @Test
    fun `a mismatch on an early file drains the rest of the batch without writing or verifying`() {
        val rig = Rig()
        val session = rig.session
        val first = byteArrayOf(1, 2, 3)
        val second = byteArrayOf(4, 5, 6, 7)
        rig.offer(listOf(FileMeta("a.bin", 3), FileMeta("b.bin", 4)))
        session.acceptIncoming()
        rig.content(first)
        assertTrue(rig.done(chain(byteArrayOf(9, 9, 9))).sent(RealtimeFrame.REJECT))
        assertEquals(FileLaneSession.ReceiveState.DRAINING, session.receiveState)

        // What the sender sealed before it saw the REJECT: authenticated, in
        // sequence, and thrown away — even a DONE that WOULD verify.
        val seq = rig.receiver.nextExpectedSeq
        val drained = rig.content(second) + rig.done(chain(second))
        assertTrue(drained.isEmpty())
        assertTrue("the drain consumed sequence numbers", rig.receiver.nextExpectedSeq > seq)

        assertTrue(session.onFrame(RealtimeFrame.BATCH_ABORT).isEmpty())
        assertEquals(FileLaneSession.ReceiveState.IDLE, session.receiveState)
    }

    @Test
    fun `a mismatch drain with no barrier is bounded like any other drain`() {
        val rig = Rig()
        rig.offer(listOf(FileMeta("f", 3)))
        rig.session.acceptIncoming()
        rig.content(byteArrayOf(1, 2, 3))
        rig.done(chain(byteArrayOf(0)))
        val timedOut = rig.session.abortBarrierTimedOut()
        assertEquals(FileLaneSession.Failure.Scope.LANE, timedOut.failure()?.scope)
        assertEquals(FileLaneSession.ReceiveState.FAILED, rig.session.receiveState)
    }

    @Test
    fun `on the older wire a mismatch still fails the lane, since there is no barrier to drain to`() {
        val rig = Rig(barrier = false)
        rig.offer(listOf(FileMeta("f", 3)))
        rig.session.acceptIncoming()
        rig.content(byteArrayOf(1, 2, 3))
        val actions = rig.done(chain(byteArrayOf(0)))
        assertTrue(actions.contains(FileLaneSession.Action.FileCorrupt(0)))
        assertTrue(actions.contains(FileLaneSession.Action.DiscardIncoming))
        assertEquals(FileLaneSession.Failure.Scope.LANE, actions.failure()?.scope)
        assertEquals(FileLaneSession.ReceiveState.FAILED, rig.session.receiveState)
    }

    // ── A08e-D4: no barrier after a pre-consent REJECT or BUSY ──────────────

    @Test
    fun `a peer REJECT while waiting for consent retires the batch with no BATCH_ABORT`() {
        val (tx, _) = mirroredKeys()
        val sender = RealtimeSender()
        val session = FileLaneSession(tx, maxFrame, sender = sender)
        session.startBatch(listOf(FileMeta("f", 5)))
        val seq = sender.nextSeq
        val actions = session.onFrame(RealtimeFrame.REJECT)
        assertFalse(actions.any { it is FileLaneSession.Action.Send })
        assertEquals(FileLaneSession.Failure.Reason.PEER_REJECTED, actions.failure()?.reason)
        assertEquals(FileLaneSession.Failure.Scope.SEND, actions.failure()?.scope)
        assertEquals(FileLaneSession.SendState.IDLE, session.sendState)
        assertEquals(seq, sender.nextSeq)
        session.startBatch(listOf(FileMeta("next", 0)))
        assertEquals(FileLaneSession.SendState.WAITING_ACCEPT, session.sendState)
    }

    @Test
    fun `a peer BUSY while waiting for consent retires the batch with no BATCH_ABORT`() {
        val (tx, _) = mirroredKeys()
        val session = FileLaneSession(tx, maxFrame)
        session.startBatch(listOf(FileMeta("f", 5)))
        val actions = session.onFrame(RealtimeFrame.BUSY)
        assertFalse(actions.any { it is FileLaneSession.Action.Send })
        assertEquals(FileLaneSession.Failure.Reason.PEER_BUSY, actions.failure()?.reason)
        assertEquals(FileLaneSession.Failure.Scope.SEND, actions.failure()?.scope)
        assertEquals(FileLaneSession.SendState.IDLE, session.sendState)
    }

    @Test
    fun `a peer REJECT after ACCEPT still answers with the ordered barrier`() {
        val (tx, _) = mirroredKeys()
        val session = FileLaneSession(tx, maxFrame)
        session.startBatch(listOf(FileMeta("f", 5)))
        session.onFrame(RealtimeFrame.ACCEPT)
        session.sendChunk(byteArrayOf(1, 2))
        assertTrue(session.onFrame(RealtimeFrame.REJECT).sent(RealtimeFrame.BATCH_ABORT))
    }
}
