package com.relayium.android

import com.relayium.android.storage.DurableWriteQueue
import com.relayium.android.storage.DurableWriteQueue.Entry
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The coalescer's ordering, barrier, budget and failure rules, with every I/O
 * effect recorded in one ordered log so "durable only after sync" is checked
 * against what actually happened, not against a returned flag alone.
 */
class DurableWriteQueueTest {

    private class LogIo : DurableWriteQueue.Io {
        val log = ArrayList<String>()
        var failAppendAt = -1
        var throwAppendAt = -1
        var failSync = false
        var throwSync = false
        private var appends = 0

        override fun append(fileIndex: Int, bytes: ByteArray): Boolean {
            val n = appends++
            if (n == throwAppendAt) throw IOException("append died")
            if (n == failAppendAt) {
                log.add("append-failed $fileIndex")
                return false
            }
            log.add("append $fileIndex ${bytes.size}")
            return true
        }

        override fun sync(fileIndices: Collection<Int>): Boolean {
            if (throwSync) throw IOException("fsync died")
            log.add("sync ${fileIndices.joinToString(",")}")
            return !failSync
        }

        val syncs: Int get() = log.count { it.startsWith("sync") }
        val appendsDone: Int get() = log.count { it.startsWith("append ") }
    }

    private fun queue(bytes: Long = 1L shl 30, tasks: Int = 1_000, nanos: Long = Long.MAX_VALUE, clock: () -> Long = { 0L }) =
        DurableWriteQueue(bytes, tasks, nanos, clock)

    private fun entry(gen: Int = 1, file: Int = 0, size: Int = 10, offset: Long = 0) =
        Entry(gen, file, offset, ByteArray(size))

    @Test
    fun `already-queued writes are appended in order then synced once per file`() {
        val q = queue()
        val io = LogIo()
        val es = listOf(entry(file = 0, size = 1), entry(file = 0, size = 2), entry(file = 1, size = 3), entry(file = 1, size = 4))
        es.forEach(q::offer)
        val run = q.drain(es[0], io)!!
        assertTrue(run.durable)
        assertEquals(es, run.entries)
        assertEquals(10L, run.bytes)
        assertEquals(listOf("append 0 1", "append 0 2", "append 1 3", "append 1 4", "sync 0,1"), io.log)
        // Their own tasks find nothing left to do: no second write, no second ACK.
        for (e in es.drop(1)) assertNull(q.drain(e, io))
        assertEquals(1, io.syncs)
        assertEquals(0, q.queuedEntries)
        assertEquals(0L, q.queuedBytes)
    }

    @Test
    fun `a lone write is flushed at once - a run never waits for more`() {
        val q = queue(bytes = 1L shl 30)
        val io = LogIo()
        val tiny = entry(size = 1)
        q.offer(tiny)
        val run = q.drain(tiny, io)!!
        assertTrue(run.durable)
        assertEquals(listOf("append 0 1", "sync 0"), io.log)
    }

    @Test
    fun `an empty chunk still gets its sync before it counts`() {
        val q = queue()
        val io = LogIo()
        val empty = entry(size = 0)
        q.offer(empty)
        val run = q.drain(empty, io)!!
        assertTrue(run.durable)
        assertEquals(listOf("append 0 0", "sync 0"), io.log)
    }

    @Test
    fun `a barrier is never crossed`() {
        val q = queue()
        val io = LogIo()
        val a = entry(file = 0)
        q.offer(a)
        q.barrier() // e.g. the export of file 0
        val b = entry(file = 1)
        q.offer(b)
        val first = q.drain(a, io)!!
        assertEquals(listOf(a), first.entries)
        assertEquals(listOf("append 0 10", "sync 0"), io.log)
        val second = q.drain(b, io)!!
        assertEquals(listOf(b), second.entries)
        assertEquals(2, io.syncs)
    }

    @Test
    fun `a different generation is never coalesced`() {
        val q = queue()
        val io = LogIo()
        val old = entry(gen = 1)
        val new = entry(gen = 2)
        q.offer(old)
        q.offer(new)
        assertEquals(listOf(old), q.drain(old, io)!!.entries)
        assertEquals(listOf(new), q.drain(new, io)!!.entries)
    }

    @Test
    fun `a follower whose generation was retired is not written`() {
        val q = queue()
        val io = LogIo()
        val a = entry()
        val b = entry()
        q.offer(a)
        q.offer(b)
        val asked = ArrayList<Int>()
        val run = q.drain(a, io) { asked.add(it); false }!!
        // `live` is asked for the follower only, and says its batch is gone.
        assertEquals(listOf(1), asked)
        assertEquals(listOf(a), run.entries)
        assertEquals(1, q.queuedEntries)
    }

    @Test
    fun `the byte budget caps a run and the remainder runs next`() {
        val q = queue(bytes = 25)
        val io = LogIo()
        val es = List(5) { entry(size = 10) }
        es.forEach(q::offer)
        assertEquals(es.take(2), q.drain(es[0], io)!!.entries)
        assertNull(q.drain(es[1], io))
        assertEquals(es.subList(2, 4), q.drain(es[2], io)!!.entries)
        assertEquals(listOf(es[4]), q.drain(es[4], io)!!.entries)
        assertEquals(3, io.syncs)
    }

    @Test
    fun `a single chunk larger than the byte budget still runs alone`() {
        val q = queue(bytes = 5)
        val io = LogIo()
        val big = entry(size = 50)
        val next = entry(size = 1)
        q.offer(big)
        q.offer(next)
        assertEquals(listOf(big), q.drain(big, io)!!.entries)
        assertEquals(listOf(next), q.drain(next, io)!!.entries)
    }

    @Test
    fun `the task budget caps a run`() {
        val q = queue(tasks = 3)
        val io = LogIo()
        val es = List(7) { entry(size = 1) }
        es.forEach(q::offer)
        assertEquals(3, q.drain(es[0], io)!!.entries.size)
        assertEquals(3, q.drain(es[3], io)!!.entries.size)
        assertEquals(1, q.drain(es[6], io)!!.entries.size)
    }

    @Test
    fun `the time budget stops taking followers`() {
        var now = 0L
        val q = queue(nanos = 100, clock = { now })
        val io = object : DurableWriteQueue.Io {
            var appends = 0
            override fun append(fileIndex: Int, bytes: ByteArray): Boolean {
                appends++
                now += 60 // each append "takes" 60ns
                return true
            }
            override fun sync(fileIndices: Collection<Int>) = true
        }
        val es = List(5) { entry(size = 1) }
        es.forEach(q::offer)
        assertEquals(2, q.drain(es[0], io)!!.entries.size)
    }

    @Test
    fun `a failed sync after physical appends reports the whole run not durable`() {
        val q = queue()
        val io = LogIo().apply { failSync = true }
        val es = List(3) { entry(size = 4) }
        es.forEach(q::offer)
        val run = q.drain(es[0], io)!!
        assertFalse("bytes appended but not proven synced must not count", run.durable)
        assertEquals(es, run.entries)
        assertEquals(3, io.appendsDone)
    }

    @Test
    fun `a throwing sync is a failure, not a crash`() {
        val q = queue()
        val io = LogIo().apply { throwSync = true }
        val e = entry()
        q.offer(e)
        assertFalse(q.drain(e, io)!!.durable)
    }

    @Test
    fun `a partial run fails as a whole, skips sync, and poisons its batch`() {
        val q = queue()
        val io = LogIo().apply { failAppendAt = 2 }
        val es = List(4) { entry(size = 4) }
        es.forEach(q::offer)
        val run = q.drain(es[0], io)!!
        assertFalse(run.durable)
        // Two good appends, the failed one; the fourth was not taken.
        assertEquals(es.take(3), run.entries)
        assertEquals(0, io.syncs)
        assertEquals(1, q.queuedEntries)
        // The fourth still gets a (failed) answer, without touching the sink.
        val before = io.log.size
        val rest = q.drain(es[3], io)!!
        assertFalse(rest.durable)
        assertEquals(listOf(es[3]), rest.entries)
        assertEquals(before, io.log.size)
        // A NEW generation is unaffected.
        val fresh = entry(gen = 2)
        q.offer(fresh)
        assertTrue(q.drain(fresh, LogIo())!!.durable)
    }

    @Test
    fun `a throwing append is a failure`() {
        val q = queue()
        val io = LogIo().apply { throwAppendAt = 0 }
        val e = entry()
        q.offer(e)
        val run = q.drain(e, io)!!
        assertFalse(run.durable)
        assertEquals(0, io.syncs)
    }

    @Test
    fun `clear drops every queued plaintext reference`() {
        val q = queue()
        val es = List(3) { entry(size = 7) }
        es.forEach(q::offer)
        assertEquals(21L, q.queuedBytes)
        q.clear()
        assertEquals(0, q.queuedEntries)
        assertEquals(0L, q.queuedBytes)
        val io = LogIo()
        for (e in es) assertNull(q.drain(e, io))
        assertTrue(io.log.isEmpty())
    }

    @Test
    fun `clear is also a barrier for what follows`() {
        val q = queue()
        val io = LogIo()
        val a = entry()
        q.offer(a)
        val run = q.drain(a, io)!!
        assertTrue(run.durable)
        val b = entry()
        q.offer(b)
        q.clear()
        val c = entry()
        q.offer(c)
        assertEquals(listOf(c), q.drain(c, io)!!.entries)
    }

    @Test
    fun `a withdrawn entry is never written`() {
        val q = queue()
        val a = entry()
        val b = entry()
        q.offer(a)
        q.offer(b)
        q.withdraw(b)
        val io = LogIo()
        assertEquals(listOf(a), q.drain(a, io)!!.entries)
        assertNull(q.drain(b, io))
        assertEquals(0L, q.queuedBytes)
    }

    @Test
    fun `entries left ahead by a fenced-off task are dropped unwritten`() {
        val q = queue()
        val stale = entry(gen = 1)
        q.offer(stale)
        // Its task was skipped by the generation fence; a later batch's write runs.
        val live = entry(gen = 2)
        q.offer(live)
        val io = LogIo()
        assertEquals(listOf(live), q.drain(live, io)!!.entries)
        assertEquals(listOf("append 0 10", "sync 0"), io.log)
        assertNull(q.drain(stale, io))
    }

    @Test
    fun `writes queued while a run is busy coalesce into the next run`() {
        val q = queue()
        val first = entry()
        q.offer(first)
        val late = List(5) { entry() }
        val io = object : DurableWriteQueue.Io {
            var syncs = 0
            override fun append(fileIndex: Int, bytes: ByteArray) = true
            override fun sync(fileIndices: Collection<Int>): Boolean {
                // While the first run is inside its fsync, more chunks arrive.
                if (syncs++ == 0) late.forEach(q::offer)
                return true
            }
        }
        assertEquals(listOf(first), q.drain(first, io)!!.entries)
        assertEquals(late, q.drain(late[0], io)!!.entries)
        assertEquals(2, io.syncs)
    }

    @Test(expected = IllegalStateException::class)
    fun `an entry cannot be offered twice`() {
        val q = queue()
        val e = entry()
        q.offer(e)
        q.offer(e)
    }

    // ── plaintext retention: the payload leaves the entry when it stops mattering ──

    @Test
    fun `retired generations behind a blocked worker pin no plaintext in their tasks`() {
        // Root's O7-LIVE-REVIEW counterexample, as a regression: the per-write
        // executor task captures its Entry exactly as TransferController.onWrite
        // does, the worker is busy, and each generation is retired by clear().
        val q = queue(bytes = 1L shl 20, tasks = 64, nanos = 25_000_000)
        val worker = ScheduledThreadPoolExecutor(1)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val retainedWhileQueued = AtomicLong()
        try {
            worker.execute { entered.countDown(); release.await(10, TimeUnit.SECONDS) }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            val entries = ArrayList<Entry>()
            repeat(32) { gen ->
                val e = Entry(gen, 0, 0L, ByteArray(65_536))
                entries.add(e)
                q.offer(e)
                worker.execute { retainedWhileQueued.addAndGet(e.bytes.size.toLong()) }
                q.clear()
                assertEquals(0L, q.queuedBytes)
                assertEquals(0, q.queuedEntries)
            }
            // Measured while every one of those tasks is still queued.
            assertEquals(0L, entries.sumOf { it.bytes.size.toLong() })
            assertTrue(entries.none { it.holdsPayload })
            assertEquals(65_536, entries[0].byteCount)
        } finally {
            release.countDown()
            worker.shutdown()
            assertTrue(worker.awaitTermination(5, TimeUnit.SECONDS))
        }
        assertEquals(0L, retainedWhileQueued.get())
    }

    @Test
    fun `followers a run consumed keep metadata only`() {
        val q = queue()
        val es = List(5) { entry(size = 1_000) }
        es.forEach(q::offer)
        val run = q.drain(es[0], LogIo())!!
        assertTrue(run.durable)
        assertTrue("a written entry must not pin its chunk for its no-op task", es.none { it.holdsPayload })
        assertEquals(5_000L, run.bytes)
        assertEquals(List(5) { 1_000 }, es.map { it.byteCount })
    }

    @Test
    fun `withdraw, orphan removal and a poisoned batch all release the payload`() {
        val q = queue()
        val withdrawn = entry()
        q.offer(withdrawn)
        q.withdraw(withdrawn)
        assertFalse(withdrawn.holdsPayload)

        val orphan = entry(gen = 1)
        val live = entry(gen = 2)
        q.offer(orphan)
        q.offer(live)
        q.drain(live, LogIo())
        assertFalse(orphan.holdsPayload)

        val io = LogIo().apply { failSync = true }
        val a = entry(gen = 3)
        q.offer(a)
        assertFalse(q.drain(a, io)!!.durable)
        val b = entry(gen = 3)
        q.offer(b)
        assertFalse(q.drain(b, io)!!.durable)
        assertFalse(b.holdsPayload)
    }

    @Test
    fun `the exact bytes are appended in order`() {
        val q = queue()
        val es = List(4) { i -> Entry(1, i / 2, 0L, ByteArray(3) { (i * 3 + it).toByte() }) }
        es.forEach(q::offer)
        val seen = ArrayList<Byte>()
        val io = object : DurableWriteQueue.Io {
            override fun append(fileIndex: Int, bytes: ByteArray): Boolean { seen.addAll(bytes.toList()); return true }
            override fun sync(fileIndices: Collection<Int>) = true
        }
        assertTrue(q.drain(es[0], io)!!.durable)
        assertEquals((0 until 12).map { it.toByte() }, seen)
    }

    @Test
    fun `a clear during an in-flight append leaves the active bytes intact and drops only queued ones`() {
        val q = queue()
        val head = Entry(1, 0, 0L, ByteArray(4096) { 5 })
        val queuedBehind = Entry(1, 0, 4096L, ByteArray(4096) { 6 })
        q.offer(head)
        q.offer(queuedBehind)
        val inAppend = CountDownLatch(1)
        val proceed = CountDownLatch(1)
        val written = ArrayList<ByteArray>()
        val io = object : DurableWriteQueue.Io {
            override fun append(fileIndex: Int, bytes: ByteArray): Boolean {
                inAppend.countDown()
                assertTrue(proceed.await(5, TimeUnit.SECONDS))
                // Copied only AFTER the concurrent clear: it must still be whole.
                written.add(bytes.copyOf())
                return true
            }
            override fun sync(fileIndices: Collection<Int>) = true
        }
        var live = true
        var run: DurableWriteQueue.Run? = null
        val worker = Thread { run = q.drain(head, io) { live } }
        worker.start()
        assertTrue(inAppend.await(5, TimeUnit.SECONDS))
        live = false
        q.clear()
        assertFalse(queuedBehind.holdsPayload)
        proceed.countDown()
        worker.join(5_000)
        assertEquals(1, written.size)
        assertTrue(written[0].all { it == 5.toByte() } && written[0].size == 4096)
        // The run reports what it did; the controller's generation fence, not
        // the queue, keeps it from acknowledging into a newer batch.
        assertEquals(listOf(head), run!!.entries)
        assertEquals(0L, q.queuedBytes)
    }
}
