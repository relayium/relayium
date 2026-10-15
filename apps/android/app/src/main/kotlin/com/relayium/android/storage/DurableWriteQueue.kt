package com.relayium.android.storage

/**
 * Coalesce realtime staging writes that are ALREADY queued into one durable run.
 *
 * Every incoming chunk used to cost one append and one fsync, and the ACK that
 * the sender's flow window waits on could only move one chunk at a time. While
 * the single storage worker is inside one of those fsyncs, further chunks keep
 * queueing behind it. A run lets the next storage task take those queued
 * chunks — in their original order — append them all, fsync each affected
 * staging file ONCE, and only then report them durable together.
 *
 * ## What it never does
 *
 * - **Wait.** A run takes only what is queued when it looks. It never blocks
 *   the only storage worker hoping for another chunk, so a tail below any
 *   threshold is flushed at once and cannot deadlock the sender's window.
 * - **Cross a barrier.** Every non-write storage effect (begin, export,
 *   discard, finish) calls [barrier] when it is submitted; a run only extends
 *   over entries offered in the same barrier interval and the same receive
 *   generation, so per-action order relative to exports and batch boundaries
 *   is exactly the executor's submission order.
 * - **Report bytes durable early.** [Run.durable] is true only when every
 *   append of the run AND the fsync of every file it touched succeeded. A
 *   failure anywhere fails the WHOLE run: bytes appended but not proven synced
 *   are never acknowledged, and the generation is poisoned so later queued
 *   writes of the same batch do no further I/O after a sink of unknown state.
 * - **Hold plaintext past its use.** An entry references the decrypted chunk
 *   the caller already counted against its storage queue caps; no bytes are
 *   copied or concatenated here. The entry is also what each per-write
 *   executor task captures, and those tasks outlive both a retired batch and
 *   a run that already wrote them — so the PAYLOAD is detached from the entry
 *   the moment it stops being needed: [clear], [withdraw] and a fenced-off
 *   orphan release it, and a run MOVES it into its own locals when it takes
 *   the entry. A queued no-op task then pins only the entry's metadata
 *   ([Entry.byteCount] stays for accounting). A run in progress keeps the
 *   bytes it took until its I/O ends; nothing clears them under an append.
 *
 * Thread contract: [offer], [barrier], [withdraw] and [clear] are called by the
 * submitting (session) thread; [drain] by the storage worker. All shared state
 * is under one lock, held only for queue bookkeeping and never across I/O.
 */
class DurableWriteQueue(
    private val maxRunBytes: Long,
    private val maxRunTasks: Int,
    private val maxRunNanos: Long,
    private val nanoTime: () -> Long = System::nanoTime,
) {
    init {
        require(maxRunBytes > 0 && maxRunTasks > 0 && maxRunNanos >= 0)
    }

    /** One decrypted, in-sequence chunk awaiting its durable write. */
    class Entry(val gen: Int, val fileIndex: Int, val offset: Long, bytes: ByteArray) {
        /** The chunk's length, kept after the payload is released. */
        val byteCount: Int = bytes.size

        /** Null once released or taken by a run. Written only under the
         *  queue's lock; volatile so an unlocked reader sees the release. */
        @Volatile
        private var payload: ByteArray? = bytes

        /** The payload while the entry still holds it, else empty. Never the
         *  bytes a run is writing: those moved out when the run took them. */
        val bytes: ByteArray get() = payload ?: EMPTY

        /** Whether this entry still references its plaintext. */
        val holdsPayload: Boolean get() = payload != null

        internal var barrier = 0L
        internal var queued = false

        internal fun release() {
            payload = null
        }

        internal fun takePayload(): ByteArray = (payload ?: EMPTY).also { payload = null }

        private companion object {
            val EMPTY = ByteArray(0)
        }
    }

    /** The staging effects a run performs. */
    interface Io {
        /** Append without any durability claim. False or a throw is a failure. */
        fun append(fileIndex: Int, bytes: ByteArray): Boolean

        /** Flush and fsync each listed file once. False or a throw is a failure. */
        fun sync(fileIndices: Collection<Int>): Boolean
    }

    /** One drained run, in original order. [durable] covers EVERY entry or none. */
    class Run(val entries: List<Entry>, val durable: Boolean) {
        val bytes: Long get() = entries.sumOf { it.byteCount.toLong() }
    }

    private val lock = Any()
    private val pending = ArrayDeque<Entry>()
    private var barrierCount = 0L
    private var pendingBytes = 0L
    private var poisonedGen: Int? = null

    fun offer(entry: Entry) = synchronized(lock) {
        check(!entry.queued) { "entry offered twice" }
        check(entry.holdsPayload || entry.byteCount == 0) { "entry already released" }
        entry.barrier = barrierCount
        entry.queued = true
        pending.addLast(entry)
        pendingBytes += entry.byteCount
    }

    /** A non-write storage effect was submitted: nothing offered before this
     *  may be coalesced with anything offered after it. */
    fun barrier() = synchronized(lock) { barrierCount++ }

    /** The entry's storage task was never accepted by the executor: drop it so
     *  its plaintext is not retained, and so no later run writes it. */
    fun withdraw(entry: Entry) = synchronized(lock) {
        if (entry.queued) {
            entry.queued = false
            pending.remove(entry)
            pendingBytes -= entry.byteCount
            entry.release()
        }
    }

    /** A batch was retired: drop every queued reference to its plaintext,
     *  including the one each entry's own pending executor task still holds.
     *  Entries a run has already taken are not here, and keep nothing. */
    fun clear() = synchronized(lock) {
        for (entry in pending) {
            entry.queued = false
            entry.release()
        }
        pending.clear()
        pendingBytes = 0
        barrierCount++
    }

    val queuedEntries: Int get() = synchronized(lock) { pending.size }
    val queuedBytes: Long get() = synchronized(lock) { pendingBytes }

    private fun removeHeadLocked(): Entry {
        val entry = pending.removeFirst()
        entry.queued = false
        pendingBytes -= entry.byteCount
        return entry
    }

    /**
     * Storage worker: write [head] and whatever is queued contiguously behind
     * it, then sync. Null when [head] was already written by an earlier run
     * (or dropped by [clear]/[withdraw]) — its task then has nothing to do.
     *
     * [live] is asked before each follower is taken, so a follower is not
     * written once its generation has been retired.
     */
    fun drain(head: Entry, io: Io, live: (Int) -> Boolean = { true }): Run? {
        val start = nanoTime()
        var data: ByteArray
        synchronized(lock) {
            if (!head.queued) return null
            // Anything still ahead of [head] belongs to a task that already ran
            // and was fenced off (a retired generation): it is never written,
            // and its plaintext goes now.
            while (pending.first() !== head) removeHeadLocked().release()
            removeHeadLocked()
            if (poisonedGen == head.gen) {
                head.release()
                return Run(listOf(head), durable = false)
            }
            // The run owns these bytes from here; the entry keeps metadata only.
            data = head.takePayload()
        }
        val taken = ArrayList<Entry>()
        var bytes = 0L
        var ok = true
        var next: Entry? = head
        while (next != null) {
            taken.add(next)
            if (!runCatching { io.append(next.fileIndex, data) }.getOrDefault(false)) {
                ok = false
                break
            }
            bytes += next.byteCount
            if (taken.size >= maxRunTasks || nanoTime() - start >= maxRunNanos) break
            next = synchronized(lock) {
                val candidate = pending.firstOrNull()
                if (candidate != null &&
                    candidate.gen == head.gen &&
                    candidate.barrier == head.barrier &&
                    bytes + candidate.byteCount <= maxRunBytes &&
                    live(candidate.gen)
                ) {
                    removeHeadLocked().also { data = it.takePayload() }
                } else {
                    null
                }
            }
        }
        if (ok) {
            val files = LinkedHashSet<Int>()
            for (entry in taken) files.add(entry.fileIndex)
            ok = runCatching { io.sync(files) }.getOrDefault(false)
        }
        if (!ok) synchronized(lock) { poisonedGen = head.gen }
        return Run(taken, ok)
    }
}
