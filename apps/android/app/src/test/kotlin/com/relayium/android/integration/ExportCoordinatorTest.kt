package com.relayium.android.integration

import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Stopping an export that is already inside a provider write, and leaving the
 * user's folder in a state this app can describe truthfully.
 *
 * ## Why these run against a genuinely BLOCKING stream
 *
 * The behaviour under test is not "does a coroutine stop being scheduled". It
 * is: a thread is parked inside `OutputStream.write`, in another process's
 * code, and something outside has to end it. A test whose sink returned
 * immediately would pass against a per-file check, against a per-chunk check,
 * and against no cancellation at all — it would prove nothing about the one
 * case that matters. So the sink here really blocks, and is really unblocked by
 * its own descriptor being closed.
 *
 * These cases fail against the shape that checked the account between files and
 * awaited an `async` started on another scope: there, the write in flight ran
 * to completion and the cleanup never happened.
 *
 * The driving coroutines run on [Dispatchers.IO] rather than on `runBlocking`'s
 * own loop: the assertions below block that thread waiting for a latch, and a
 * body scheduled on it would never start.
 */
class ExportCoordinatorTest {

    /**
     * A sink that parks in `write` until it is closed, exactly as a document
     * provider that has stopped answering does.
     */
    private class BlockingSink : OutputStream() {
        val entered = CountDownLatch(1)
        val released = CountDownLatch(1)
        val closed = AtomicBoolean(false)
        val bytesWritten = AtomicInteger(0)

        override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)

        override fun write(b: ByteArray, off: Int, len: Int) {
            entered.countDown()
            // Parked until the descriptor is closed from another thread. That
            // close is the only thing that can end this, which is the whole
            // point of the lease.
            released.await()
            if (closed.get()) throw IOException("closed while writing")
            bytesWritten.addAndGet(len)
        }

        override fun close() {
            closed.set(true)
            released.countDown()
        }
    }

    /** A sink that accepts everything, for the ordinary paths. */
    private class OpenSink : OutputStream() {
        val bytes = ArrayList<Byte>()
        val closed = AtomicBoolean(false)
        override fun write(b: Int) {
            bytes.add(b.toByte())
        }
        override fun close() {
            closed.set(true)
        }
    }

    /**
     * A sink that accepts every byte and then fails to COMMIT them.
     *
     * The shape of a cloud-backed document provider that buffers a write and
     * uploads on `close()`: every `write` succeeds, the flush succeeds, and the
     * failure surfaces only at the close — which is the one call that says
     * whether the file exists on the other side.
     */
    private class CommitFailingSink : OutputStream() {
        var closeAttempted = false
        override fun write(b: Int) = Unit
        override fun write(b: ByteArray, off: Int, len: Int) = Unit
        override fun close() {
            closeAttempted = true
            throw IOException("the provider could not commit the write")
        }
    }

    private fun source(size: Int): InputStream = ByteArrayInputStream(ByteArray(size))

    /** A created document, and whether it was removed. */
    private class Node(val name: String, val deletable: Boolean = true) {
        var deleted = false
        fun asDeletable() = ExportCoordinator.Session.Deletable {
            if (!deletable) return@Deletable false
            deleted = true
            true
        }
    }

    @Test
    fun `a copy completes and reports done`() = runBlocking {
        val coordinator = ExportCoordinator(io = Dispatchers.IO)
        val sink = OpenSink()
        val outcome = coordinator.export { session ->
            session.recordCreated(Node("a.bin").asDeletable())
            session.copy({ source(1024) }, { sink })
            ExportCoordinator.Outcome.DONE
        }
        assertEquals(ExportCoordinator.Outcome.DONE, outcome)
        assertEquals(1024, sink.bytes.size)
    }

    @Test
    fun `stopping ends a write that is already blocked inside the provider`() = runBlocking {
        val coordinator = ExportCoordinator(io = Dispatchers.IO)
        val sink = BlockingSink()
        val node = Node("half-written.bin")

        val export = launch(Dispatchers.IO) {
            coordinator.export { session ->
                session.recordCreated(node.asDeletable())
                session.copy({ source(256 * 1024) }, { sink })
                ExportCoordinator.Outcome.DONE
            }
        }

        // Wait until the thread is genuinely parked inside `write`.
        assertTrue("the sink never blocked", sink.entered.await(5, TimeUnit.SECONDS))

        // This is the account-changed path. Cancelling the job alone would
        // leave the thread inside `write` until the provider returned on its
        // own — closing the stream is what actually ends it.
        coordinator.stop()

        withTimeout(5_000) { export.join() }
        assertTrue("the stream was not closed under the blocked write", sink.closed.get())
        assertTrue("what the export created was not removed", node.deleted)
    }

    @Test
    fun `cancelling the caller stops the work rather than only the wait`() = runBlocking {
        val coordinator = ExportCoordinator(io = Dispatchers.IO)
        val sink = BlockingSink()
        val node = Node("half-written.bin")

        val caller = launch(Dispatchers.IO) {
            coordinator.export { session ->
                session.recordCreated(node.asDeletable())
                session.copy({ source(256 * 1024) }, { sink })
                ExportCoordinator.Outcome.DONE
            }
        }
        assertTrue(sink.entered.await(5, TimeUnit.SECONDS))

        // The body runs in the CALLER's context. An `async` started on some
        // other scope would leave the copy running with only the `await`
        // cancelled — the write would finish and nothing would be cleaned up.
        caller.cancel()
        withTimeout(5_000) { caller.join() }

        assertTrue("cancelling the caller did not close the write", sink.closed.get())
        assertTrue("a cancelled export left what it created behind", node.deleted)
    }

    @Test
    fun `an account change on the last file stops before it is written`() = runBlocking {
        val coordinator = ExportCoordinator(io = Dispatchers.IO)
        val written = ArrayList<String>()
        val nodes = listOf(Node("a.bin"), Node("b.bin"), Node("c.bin"))
        var account = "a"

        val outcome = coordinator.export { session ->
            var result = ExportCoordinator.Outcome.DONE
            for ((index, node) in nodes.withIndex()) {
                // The identity moves just before the LAST file — the case a
                // check placed only at the top of the loop still catches, and
                // the one a check placed only after the copy does not.
                if (index == nodes.lastIndex) account = "b"
                if (account != "a") {
                    result = ExportCoordinator.Outcome.UNAVAILABLE
                    break
                }
                session.recordCreated(node.asDeletable())
                val sink = OpenSink()
                session.copy({ source(8) }, { sink })
                written.add(node.name)
            }
            result
        }

        assertEquals(ExportCoordinator.Outcome.UNAVAILABLE, outcome)
        assertEquals(listOf("a.bin", "b.bin"), written)
        // …and the two that WERE written are removed: a partial export is a
        // folder of files the user cannot tell apart from a complete one.
        assertTrue(nodes[0].deleted)
        assertTrue(nodes[1].deleted)
        assertFalse("a file that was never created must not be deleted", nodes[2].deleted)
    }

    @Test
    fun `two exports never overlap`() = runBlocking {
        val coordinator = ExportCoordinator(io = Dispatchers.IO)
        val inFlight = AtomicInteger(0)
        val overlapped = AtomicBoolean(false)
        val started = CountDownLatch(2)

        val bodies = (0 until 2).map {
            launch(Dispatchers.IO) {
                runCatching {
                    coordinator.export { session ->
                        // Decremented in a `finally`. A superseding export
                        // cancels the one before it, so the body can leave
                        // through cancellation — and a counter decremented only
                        // on the success path would then report an overlap that
                        // never happened.
                        if (inFlight.incrementAndGet() > 1) overlapped.set(true)
                        try {
                            started.countDown()
                            val sink = OpenSink()
                            session.copy({ source(64 * 1024) }, { sink })
                            ExportCoordinator.Outcome.DONE
                        } finally {
                            inFlight.decrementAndGet()
                        }
                    }
                }
            }
        }
        withTimeout(10_000) { bodies.forEach { it.join() } }

        // "Cancel the previous job, then publish mine" lets both callers cancel
        // and both publish, and both then run — two exports writing into the
        // same tree, interleaving their cleanups.
        assertFalse("two exports held streams at the same time", overlapped.get())
    }

    @Test
    fun `a newer export supersedes one that is blocked`() = runBlocking {
        val coordinator = ExportCoordinator(io = Dispatchers.IO)
        val firstSink = BlockingSink()
        val firstNode = Node("first.bin")
        val secondRan = AtomicBoolean(false)

        val first = launch(Dispatchers.IO) {
            runCatching {
                coordinator.export { session ->
                    session.recordCreated(firstNode.asDeletable())
                    session.copy({ source(256 * 1024) }, { firstSink })
                    ExportCoordinator.Outcome.DONE
                }
            }
        }
        assertTrue(firstSink.entered.await(5, TimeUnit.SECONDS))

        // The newer one must not wait behind a write nothing has told to end.
        val second = launch(Dispatchers.IO) {
            coordinator.export { session ->
                secondRan.set(true)
                session.copy({ source(8) }, { OpenSink() })
                ExportCoordinator.Outcome.DONE
            }
        }
        withTimeout(10_000) {
            first.join()
            second.join()
        }

        assertTrue("the superseding export never ran", secondRan.get())
        assertTrue("the superseded export was not unblocked", firstSink.closed.get())
        assertTrue("the superseded export left its file behind", firstNode.deleted)
    }

    @Test
    fun `a cleanup that cannot remove everything says so`() = runBlocking {
        val coordinator = ExportCoordinator(io = Dispatchers.IO)
        val stubborn = Node("stuck.bin", deletable = false)

        val outcome = coordinator.export { session ->
            session.recordCreated(stubborn.asDeletable())
            session.copy({ source(8) }, { OpenSink() })
            ExportCoordinator.Outcome.FAILED
        }

        // Not a silent FAILED: the folder holds something this app put there
        // and could not take back, and the user is the one who has to deal
        // with it.
        assertEquals(ExportCoordinator.Outcome.FAILED_INCOMPLETE, outcome)
    }

    @Test
    fun `a sink that fails to close is not a completed export`() = runBlocking {
        val coordinator = ExportCoordinator(io = Dispatchers.IO)
        val sink = CommitFailingSink()
        val node = Node("never-committed.bin")

        // The real call site's shape: the copy is attempted, and its failure —
        // from the WRITE or from the close — becomes the export's failure.
        val outcome = coordinator.export { session ->
            session.recordCreated(node.asDeletable())
            val copied = runCatching { session.copy({ source(4096) }, { sink }) }
            if (copied.isFailure) {
                ExportCoordinator.Outcome.FAILED
            } else {
                ExportCoordinator.Outcome.DONE
            }
        }

        // Every write succeeded and the flush succeeded; the provider then
        // failed to COMMIT. Reporting DONE here would tell the user their files
        // are in the folder they chose when the provider never kept them —
        // the strongest wrong claim this class can make.
        assertTrue("the sink was never closed by the copy", sink.closeAttempted)
        assertNotEquals(
            "an export reported DONE for a write the provider did not commit",
            ExportCoordinator.Outcome.DONE,
            outcome,
        )
        assertTrue("the uncommitted file was left behind", node.deleted)
    }

    @Test
    fun `a close failure cannot be ignored into a success`() = runBlocking {
        val coordinator = ExportCoordinator(io = Dispatchers.IO)
        val node = Node("never-committed.bin")

        // A body that does NOT check the copy — the shape a future call site
        // could easily take. The failure still has to reach the caller, or the
        // claim "your files are in that folder" rests on whoever remembered to
        // wrap the call.
        val thrown = runCatching {
            coordinator.export { session ->
                session.recordCreated(node.asDeletable())
                session.copy({ source(4096) }, { CommitFailingSink() })
                ExportCoordinator.Outcome.DONE
            }
        }
        assertTrue("the close failure was swallowed", thrown.isFailure)
        assertTrue("the uncommitted file was left behind", node.deleted)
    }

    @Test
    fun `a stop is told what it left behind, after the run has actually finished`() = runBlocking {
        // The race this closes: `stop()` cancels and closes, and returns. The
        // export still has to unwind, and its deletes run after that. A host
        // that read a field straight after `stop()` saw nothing — so a user
        // whose folder had been left with files this app could not remove was
        // told nothing at all.
        val announced = java.util.concurrent.LinkedBlockingQueue<ExportCoordinator.Cleanup>()
        val coordinator = ExportCoordinator(
            io = Dispatchers.IO,
            onCleanup = { announced.add(it) },
        )
        val sink = BlockingSink()
        val stubborn = Node("stuck.bin", deletable = false)

        val export = launch(Dispatchers.IO) {
            runCatching {
                coordinator.export { session ->
                    session.recordCreated(stubborn.asDeletable())
                    session.recordCreatedDirectory()
                    session.copy({ source(256 * 1024) }, { sink })
                    ExportCoordinator.Outcome.DONE
                }
            }
        }
        assertTrue("the sink never blocked", sink.entered.await(5, TimeUnit.SECONDS))

        // Nothing has been announced yet — the run has not finished.
        assertTrue("a notice arrived before the run ended", announced.isEmpty())

        coordinator.stop()
        val cleanup = announced.poll(5, TimeUnit.SECONDS)
        withTimeout(5_000) { export.join() }

        assertNotNull("the account-cancel path announced nothing at all", cleanup)
        assertFalse("a file that could not be removed was reported as clean", cleanup!!.filesRemoved)
        assertEquals(
            "a directory this run created was not reported as a leftover",
            1,
            cleanup.leftoverDirectories,
        )
        assertFalse(cleanup.isClean)
    }

    @Test
    fun `a clean run announces nothing`() = runBlocking {
        val announced = java.util.concurrent.LinkedBlockingQueue<ExportCoordinator.Cleanup>()
        val coordinator = ExportCoordinator(io = Dispatchers.IO, onCleanup = { announced.add(it) })

        coordinator.export { session ->
            session.recordCreated(Node("kept.bin").asDeletable())
            session.copy({ source(8) }, { OpenSink() })
            ExportCoordinator.Outcome.DONE
        }
        // A banner for an export that finished would be a warning about
        // nothing, and the next real one would be ignored.
        assertTrue("a completed export announced leftovers", announced.isEmpty())
    }

    @Test
    fun `a failed run that cleaned up completely announces nothing`() = runBlocking {
        val announced = java.util.concurrent.LinkedBlockingQueue<ExportCoordinator.Cleanup>()
        val coordinator = ExportCoordinator(io = Dispatchers.IO, onCleanup = { announced.add(it) })
        val node = Node("gone.bin")

        coordinator.export { session ->
            session.recordCreated(node.asDeletable())
            ExportCoordinator.Outcome.FAILED
        }
        assertTrue(node.deleted)
        // It failed, but the folder is as the user left it. The notice is about
        // what was LEFT, not about the failure.
        assertTrue("a fully cleaned failure announced leftovers", announced.isEmpty())
    }

    @Test
    fun `the notice belongs to the run that produced it`() = runBlocking {
        val announced = java.util.concurrent.LinkedBlockingQueue<ExportCoordinator.Cleanup>()
        val coordinator = ExportCoordinator(io = Dispatchers.IO, onCleanup = { announced.add(it) })

        // A dirty run, then a clean one. The second must not clear or restate
        // the first's result, and the first must not be announced twice.
        coordinator.export { session ->
            session.recordCreated(Node("stuck.bin", deletable = false).asDeletable())
            ExportCoordinator.Outcome.FAILED
        }
        assertEquals(1, announced.size)
        coordinator.export { ExportCoordinator.Outcome.DONE }
        assertEquals("a later run announced something of its own", 1, announced.size)
    }

    @Test
    fun `a successful export keeps what it wrote`() = runBlocking {
        val coordinator = ExportCoordinator(io = Dispatchers.IO)
        val node = Node("kept.bin")
        val outcome = coordinator.export { session ->
            session.recordCreated(node.asDeletable())
            session.copy({ source(8) }, { OpenSink() })
            ExportCoordinator.Outcome.DONE
        }
        assertEquals(ExportCoordinator.Outcome.DONE, outcome)
        assertFalse("a completed export deleted its own output", node.deleted)
    }

    @Test
    fun `the body's own reason survives a clean cleanup`() = runBlocking {
        val coordinator = ExportCoordinator(io = Dispatchers.IO)
        val node = Node("gone.bin")
        val outcome = coordinator.export { session ->
            session.recordCreated(node.asDeletable())
            ExportCoordinator.Outcome.UNAVAILABLE
        }
        // An export the account outlived is UNAVAILABLE, not FAILED: reporting
        // a write failure for an identity change would send the user to fix
        // something that is not broken.
        assertEquals(ExportCoordinator.Outcome.UNAVAILABLE, outcome)
        assertTrue(node.deleted)
    }

    @Test
    fun `stopping when nothing is running is safe`() = runBlocking {
        val coordinator = ExportCoordinator(io = Dispatchers.IO)
        coordinator.stop()
        val outcome = coordinator.export { ExportCoordinator.Outcome.DONE }
        assertEquals(ExportCoordinator.Outcome.DONE, outcome)
    }
}
