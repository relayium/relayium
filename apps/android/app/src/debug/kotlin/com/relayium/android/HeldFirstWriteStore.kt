package com.relayium.android

import com.relayium.android.storage.ProviderOps
import com.relayium.android.storage.ReceiveStore
import com.relayium.protocol.FileMeta
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * DEBUG ONLY: the real [ReceiveStore], with a one-shot gate an instrumentation
 * can arm to hold the FIRST real staging write of ONE batch.
 *
 * Why: a receiver acknowledges only bytes its store wrote durably
 * (`TransferController.onWrite` → `FileLaneSession.onDurableBytes`), and a
 * conforming sender may run at most one flow window (8 MiB) ahead of that. So
 * while the first write of a batch whose first file is larger than the window
 * is held, nothing is acknowledged, the sender cannot reach its last byte, and
 * the batch cannot leave RECEIVING. A cancel issued then is a cancel of an
 * ACTIVE transfer — deterministically, not by timing.
 *
 * Inert unless armed: every call goes straight to the real store. Armed, it
 * binds to the NEXT [begin] only, holds only `write(index = 0)` of that batch,
 * BEFORE the real write (so before append, sync and the ACK that follows),
 * and then delegates to the real write — the real outcome is returned, and
 * nothing is faked. A hold that is not released by its owner ends on its own
 * after [holdLimitMs] and is recorded PERMANENTLY as a timeout: the deadline is
 * absolute (taken when the hold starts), and every path that reads or releases
 * the gate classifies an expired hold as a timeout under the gate's lock FIRST
 * — so a release that reaches the lock after the deadline, before the storage
 * thread does, can never record an expired hold as released by the test.
 *
 * Every event is numbered by one monotonic counter, so the report states the
 * order in which things actually happened on the threads that did them.
 */
class HeldFirstWriteStore(
    stagingRoot: File,
    io: ReceiveStore.FileIo = ReceiveStore.FileIo.Real,
) : ReceiveStore(stagingRoot, io) {

    /** One discard the real store performed, as observed here. */
    data class Discard(
        val seq: Long,
        val generation: Int,
        val duringBegin: Boolean,
        val ok: Boolean,
    )

    private val lock = Any()
    private var seq = 0L
    private var generation = 0
    private var inBegin = false
    private var nextToken = 0L

    // The one gate, guarded by [lock].
    private var token = 0L
    private var holdLimitMs = 0L
    private var boundGeneration = 0
    private var manifest: List<String>? = null
    private var okWritesInBound = 0
    private var okWritesBeforeHold = -1
    private var heldIndex = -1
    private var heldBytes = -1
    private var holdSeq = 0L
    private var holdDeadlineNanos = 0L
    private var releaseSeq = 0L
    private var releasedBy: String? = null
    private var heldWriteSeq = 0L
    private var heldWriteOk: Boolean? = null
    private var latch: CountDownLatch? = null
    private val marks = LinkedHashMap<String, Long>()
    private val discards = ArrayList<Discard>()

    private fun next(): Long = ++seq

    /**
     * Under [lock]: a hold whose absolute deadline has passed and that nothing
     * has ended yet IS a timeout, whichever thread gets here first. Called by
     * every path that reads or ends the hold, before it does anything else.
     */
    private fun expireIfDue() {
        if (holdSeq != 0L && releaseSeq == 0L && System.nanoTime() - holdDeadlineNanos >= 0L) {
            releaseSeq = next()
            releasedBy = "timeout"
        }
    }

    /**
     * Arm the gate for the NEXT batch. One owner at a time: arming while a
     * gate is owned is a test error, not a silent re-arm.
     */
    fun arm(holdLimitMs: Long = 30_000L): Long = synchronized(lock) {
        check(token == 0L) { "the receive gate is already armed (token $token)" }
        require(holdLimitMs in 1..30_000L) { "a hold must end within 30 s (the CLI stalls a send at 60 s)" }
        token = ++nextToken
        this.holdLimitMs = holdLimitMs
        boundGeneration = 0
        manifest = null
        okWritesInBound = 0
        okWritesBeforeHold = -1
        heldIndex = -1
        heldBytes = -1
        holdSeq = 0L
        holdDeadlineNanos = 0L
        releaseSeq = 0L
        releasedBy = null
        heldWriteSeq = 0L
        heldWriteOk = null
        latch = CountDownLatch(1)
        marks.clear()
        discards.clear()
        token
    }

    /** Is the owner's write being held right now? */
    fun holding(owner: Long): Boolean = synchronized(lock) {
        if (owner != token) return false
        expireIfDue()
        holdSeq != 0L && releaseSeq == 0L
    }

    /** Number an event the OWNER observed (for example "cancelCalled"). */
    fun mark(owner: Long, name: String): Long = synchronized(lock) {
        check(owner == token) { "mark from a stale gate owner" }
        check(name !in marks) { "event $name was already marked" }
        next().also { marks[name] = it }
    }

    /**
     * The owner releases its hold. A hold that already ended by timeout stays
     * recorded as a timeout: the release changes nothing it did not cause.
     */
    fun release(owner: Long) {
        val l = synchronized(lock) {
            check(owner == token) { "release from a stale gate owner" }
            expireIfDue()
            if (releaseSeq == 0L) {
                releaseSeq = next()
                releasedBy = "test"
            }
            latch
        }
        l?.countDown()
    }

    /**
     * Give up ownership (the test's `finally`). A write still held is let go
     * — the storage thread must never stay blocked past its test — and is
     * recorded as released by disarm, never as a normal release.
     */
    fun disarm(owner: Long) {
        val l = synchronized(lock) {
            if (owner != token) return
            expireIfDue()
            if (holdSeq != 0L && releaseSeq == 0L) {
                releaseSeq = next()
                releasedBy = "disarm"
            }
            token = 0L
            latch
        }
        l?.countDown()
    }

    /** The cancellation's own rollback: the first discard of the bound batch,
     *  outside any begin, after the hold was released. Null until it happened. */
    fun cancelDiscard(owner: Long): Discard? = synchronized(lock) {
        if (owner != token) return null
        expireIfDue()
        if (boundGeneration == 0 || releaseSeq == 0L) return null
        discards.firstOrNull { !it.duringBegin && it.generation == boundGeneration && it.seq > releaseSeq }
    }

    /** Everything the gate observed, for the round's report. */
    fun report(owner: Long): Map<String, Any?> = synchronized(lock) {
        check(owner == token) { "report from a stale gate owner" }
        expireIfDue()
        val cancel = discards.firstOrNull { !it.duringBegin && it.generation == boundGeneration && releaseSeq != 0L && it.seq > releaseSeq }
        linkedMapOf(
            "token" to token,
            "boundGeneration" to boundGeneration,
            "manifest" to manifest,
            "heldIndex" to heldIndex,
            "heldBytes" to heldBytes,
            "okWritesBeforeHold" to okWritesBeforeHold,
            "holdSeq" to holdSeq,
            "marks" to LinkedHashMap(marks),
            "releaseSeq" to releaseSeq,
            "releasedBy" to releasedBy,
            "heldWriteSeq" to heldWriteSeq,
            "heldWriteOutcome" to when (heldWriteOk) { null -> null; true -> "ok"; false -> "failed" },
            "discardSeq" to cancel?.seq,
            "discardGeneration" to cancel?.generation,
            "discardDuringBegin" to cancel?.duringBegin,
            "discardOutcome" to when (cancel?.ok) { null -> null; true -> "ok"; false -> "failed" },
            "discardsObserved" to discards.size,
            // The defensive discards the real begin performed, recorded as such.
            // They are kept out of the rollback by generation and order already;
            // this count is what makes the `duringBegin` record itself checkable.
            "beginDiscards" to discards.count { it.duringBegin },
        )
    }

    override fun begin(files: List<FileMeta>, ops: ProviderOps, root: ProviderOps.Node): ReceiveStore.Outcome {
        synchronized(lock) {
            generation++
            inBegin = true
            if (token != 0L && boundGeneration == 0) {
                boundGeneration = generation
                manifest = files.map { it.name }
            }
        }
        try {
            // The real begin, including its own defensive discard of anything
            // earlier — recorded below as `duringBegin`, so it can never count
            // as the cancellation's rollback.
            return super.begin(files, ops, root)
        } finally {
            synchronized(lock) { inBegin = false }
        }
    }

    override fun write(index: Int, bytes: ByteArray): ReceiveStore.Outcome {
        val hold: CountDownLatch?
        val limit: Long
        synchronized(lock) {
            val bound = token != 0L && boundGeneration != 0 && generation == boundGeneration
            if (bound && index == 0 && holdSeq == 0L) {
                okWritesBeforeHold = okWritesInBound
                heldIndex = index
                heldBytes = bytes.size
                holdSeq = next()
                holdDeadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(holdLimitMs)
                hold = latch
                limit = holdLimitMs
            } else {
                hold = null
                limit = 0L
            }
        }
        if (hold != null) {
            // The wait ends at the deadline at the latest; whether it timed out
            // is decided by the absolute deadline under the lock, not by which
            // thread reached the lock first.
            hold.await(limit, TimeUnit.MILLISECONDS)
            synchronized(lock) { expireIfDue() }
        }
        val outcome = super.write(index, bytes)
        synchronized(lock) {
            if (hold != null) {
                heldWriteSeq = next()
                heldWriteOk = outcome is ReceiveStore.Outcome.Ok
            }
            if (outcome is ReceiveStore.Outcome.Ok && boundGeneration != 0 && generation == boundGeneration) okWritesInBound++
        }
        return outcome
    }

    override fun discard(): ReceiveStore.Outcome {
        val outcome = super.discard()
        synchronized(lock) {
            if (token != 0L) {
                discards.add(Discard(next(), generation, inBegin, outcome is ReceiveStore.Outcome.Ok))
            }
        }
        return outcome
    }
}
