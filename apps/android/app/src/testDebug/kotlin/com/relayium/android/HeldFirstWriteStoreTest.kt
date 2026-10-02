package com.relayium.android

import com.relayium.android.storage.ProviderOps
import com.relayium.android.storage.ReceiveStore
import com.relayium.protocol.FileMeta
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The debug-only gate around the REAL [ReceiveStore]: inert unless armed, bound
 * to exactly one batch, holding exactly that batch's first write and nothing
 * else, and recording the cancellation's own rollback apart from the defensive
 * discard every `begin` performs. Every outcome here is the real store's.
 */
class HeldFirstWriteStoreTest {

    @get:Rule
    val temp = TemporaryFolder()

    private val storageThread = Executors.newSingleThreadExecutor()

    private lateinit var tree: File
    private lateinit var ops: Ops

    private class Ops : ProviderOps {
        /** A provider whose deletes stop working: the real rollback then
         *  cannot remove what it exported. */
        @Volatile
        var deletesFail = false

        inner class Node(val file: File) : ProviderOps.Node {
            override val name: String get() = file.name
            override val isDirectory: Boolean get() = file.isDirectory
            override fun delete(): Boolean = !deletesFail && file.deleteRecursively()
            override fun openOut(): OutputStream = file.outputStream()
        }

        override fun findChild(parent: ProviderOps.Node, name: String): ProviderOps.Node? =
            File((parent as Node).file, name).takeIf { it.exists() }?.let { Node(it) }

        override fun createDirectory(parent: ProviderOps.Node, name: String): ProviderOps.Node? =
            File((parent as Node).file, name).takeIf { it.mkdir() }?.let { Node(it) }

        override fun createFile(parent: ProviderOps.Node, name: String): ProviderOps.Node? =
            File((parent as Node).file, name).takeIf { it.createNewFile() }?.let { Node(it) }

        override fun deleteEmptyDirectory(node: ProviderOps.Node): Boolean = (node as Node).file.delete()
    }

    @Before
    fun setUp() {
        tree = temp.newFolder("tree")
        ops = Ops()
    }

    @After
    fun tearDown() {
        storageThread.shutdownNow()
    }

    private fun store() = HeldFirstWriteStore(temp.newFolder("staging"))

    private val batch = listOf(FileMeta("big.bin", 6), FileMeta("zero.bin", 0), FileMeta("small.bin", 2))

    private fun begin(store: ReceiveStore, files: List<FileMeta> = batch) =
        store.begin(files, ops, ops.Node(tree))

    private fun <T> onStorage(block: () -> T): Future<T> = storageThread.submit<T> { block() }

    private fun awaitTrue(what: String, predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return
            Thread.sleep(5)
        }
        throw AssertionError("timed out waiting for: $what")
    }

    @Test
    fun `unarmed it is the real store - writes, exports and discards pass straight through`() {
        val store = store()
        assertEquals(ReceiveStore.Outcome.Ok, begin(store))
        assertEquals(ReceiveStore.Outcome.Ok, store.write(0, byteArrayOf(1, 2, 3, 4, 5, 6)))
        assertEquals(ReceiveStore.Outcome.Ok, store.export(0))
        assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5, 6), File(tree, "big.bin").readBytes())
        assertEquals(ReceiveStore.Outcome.Ok, store.discard())
        assertFalse("the real rollback removes what the batch exported", File(tree, "big.bin").exists())
    }

    @Test
    fun `armed, it binds to the NEXT begin and holds only that batch's file 0`() {
        val store = store()
        val token = store.arm(5_000)
        assertEquals(ReceiveStore.Outcome.Ok, begin(store))
        // Other files of the bound batch are never held.
        assertEquals(ReceiveStore.Outcome.Ok, store.write(2, byteArrayOf(9, 9)))
        val held = onStorage { store.write(0, byteArrayOf(1, 2, 3)) }
        awaitTrue("file 0 is held") { store.holding(token) }
        assertFalse("a held write has not returned", held.isDone)
        store.mark(token, "cancelCalled")
        store.release(token)
        assertEquals("the released write is the REAL write's outcome", ReceiveStore.Outcome.Ok, held.get(5, TimeUnit.SECONDS))
        val report = store.report(token)
        assertEquals(1, report["boundGeneration"])
        assertEquals(listOf("big.bin", "zero.bin", "small.bin"), report["manifest"])
        assertEquals(0, report["heldIndex"])
        assertEquals(3, report["heldBytes"])
        assertEquals("one write of another file completed first, none of file 0", 1, report["okWritesBeforeHold"])
        assertEquals("test", report["releasedBy"])
        assertEquals("ok", report["heldWriteOutcome"])
        val holdSeq = report["holdSeq"] as Long
        val cancel = (report["marks"] as Map<*, *>)["cancelCalled"] as Long
        val release = report["releaseSeq"] as Long
        val done = report["heldWriteSeq"] as Long
        assertTrue("events in the order they happened: $holdSeq < $cancel < $release < $done",
            holdSeq < cancel && cancel < release && release < done)
        // A second write of file 0 in the same batch is not held again.
        assertEquals(ReceiveStore.Outcome.Ok, store.write(0, byteArrayOf(4)))
        store.disarm(token)
    }

    @Test
    fun `a batch begun BEFORE arming is never held, and the gate waits for the next one`() {
        val store = store()
        assertEquals(ReceiveStore.Outcome.Ok, begin(store))
        val token = store.arm(5_000)
        assertEquals("the pre-arm batch writes straight through", ReceiveStore.Outcome.Ok, store.write(0, byteArrayOf(1)))
        assertFalse(store.holding(token))
        assertEquals(0, store.report(token)["boundGeneration"])
        assertEquals(ReceiveStore.Outcome.Ok, begin(store))
        assertEquals(2, store.report(token)["boundGeneration"])
        store.disarm(token)
    }

    @Test
    fun `the defensive discard inside begin never counts as the cancellation's rollback`() {
        val store = store()
        val token = store.arm(5_000)
        assertEquals(ReceiveStore.Outcome.Ok, begin(store))
        // The real begin discarded defensively; it is recorded, but as duringBegin.
        assertEquals("the begin's own defensive discard is recorded AS a begin discard",
            1, store.report(token)["beginDiscards"])
        assertEquals(1, store.report(token)["discardsObserved"])
        val held = onStorage { store.write(0, byteArrayOf(1)) }
        awaitTrue("held") { store.holding(token) }
        assertNull("no rollback before the hold is released", store.cancelDiscard(token))
        store.release(token)
        held.get(5, TimeUnit.SECONDS)
        assertNull("the begin-time discard does not satisfy the cancellation's rollback", store.cancelDiscard(token))
        assertEquals(ReceiveStore.Outcome.Ok, store.discard())
        val rollback = store.cancelDiscard(token)
        assertNotNull(rollback)
        assertEquals(1, rollback!!.generation)
        assertFalse(rollback.duringBegin)
        assertTrue(rollback.ok)
        store.disarm(token)
    }

    @Test
    fun `a discard BEFORE the bound batch began never satisfies its rollback`() {
        val store = store()
        val token = store.arm(5_000)
        // A teardown-style discard while armed but before any begin.
        assertEquals(ReceiveStore.Outcome.Ok, store.discard())
        assertEquals(ReceiveStore.Outcome.Ok, begin(store))
        val held = onStorage { store.write(0, byteArrayOf(1)) }
        awaitTrue("held") { store.holding(token) }
        store.release(token)
        held.get(5, TimeUnit.SECONDS)
        assertNull("a pre-begin discard is not the bound batch's rollback", store.cancelDiscard(token))
        store.disarm(token)
    }

    @Test
    fun `a discard of a different generation never satisfies the bound batch's rollback`() {
        val store = store()
        val token = store.arm(5_000)
        assertEquals(ReceiveStore.Outcome.Ok, begin(store))
        val held = onStorage { store.write(0, byteArrayOf(1)) }
        awaitTrue("held") { store.holding(token) }
        store.release(token)
        held.get(5, TimeUnit.SECONDS)
        // A NEXT batch begins before any rollback of the bound one is seen:
        // its begin-time discard and any later discard are generation 2.
        assertEquals(ReceiveStore.Outcome.Ok, begin(store))
        assertEquals(ReceiveStore.Outcome.Ok, store.discard())
        assertNull("only the bound generation's own rollback counts", store.cancelDiscard(token))
        store.disarm(token)
    }

    @Test
    fun `a rollback the real store could not complete is recorded as failed, not ok`() {
        val store = store()
        val token = store.arm(5_000)
        assertEquals(ReceiveStore.Outcome.Ok, begin(store, listOf(FileMeta("n.bin", 1))))
        val held = onStorage { store.write(0, byteArrayOf(7)) }
        awaitTrue("held") { store.holding(token) }
        store.release(token)
        assertEquals(ReceiveStore.Outcome.Ok, held.get(5, TimeUnit.SECONDS))
        assertEquals(ReceiveStore.Outcome.Ok, store.export(0))
        ops.deletesFail = true
        assertTrue("the real store reports an incomplete rollback", store.discard() is ReceiveStore.Outcome.Failed)
        val rollback = store.cancelDiscard(token)
        assertNotNull(rollback)
        assertFalse("a failed real rollback is never recorded as ok", rollback!!.ok)
        assertEquals("failed", store.report(token)["discardOutcome"])
        store.disarm(token)
    }

    @Test
    fun `the released write returns the REAL write's failure, not a faked success`() {
        val failingIo = object : ReceiveStore.FileIo {
            override fun open(target: File): ReceiveStore.FileIo.Sink = object : ReceiveStore.FileIo.Sink {
                override fun append(bytes: ByteArray) = throw IOException("disk gone")
                override fun sync() = Unit
                override fun close() = Unit
            }
        }
        val store = HeldFirstWriteStore(temp.newFolder("staging-failing"), failingIo)
        val token = store.arm(5_000)
        assertEquals(ReceiveStore.Outcome.Ok, begin(store))
        val held = onStorage { store.write(0, byteArrayOf(1)) }
        awaitTrue("held") { store.holding(token) }
        store.release(token)
        assertTrue(held.get(5, TimeUnit.SECONDS) is ReceiveStore.Outcome.Failed)
        assertEquals("failed", store.report(token)["heldWriteOutcome"])
        store.disarm(token)
    }

    @Test
    fun `an unreleased hold ends on its own and is recorded PERMANENTLY as a timeout`() {
        val store = store()
        val token = store.arm(200)
        assertEquals(ReceiveStore.Outcome.Ok, begin(store))
        val started = System.nanoTime()
        assertEquals(ReceiveStore.Outcome.Ok, store.write(0, byteArrayOf(1)))
        assertTrue("the hold is bounded", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < 5_000)
        store.release(token)
        assertEquals("a later release does not overwrite the timeout", "timeout", store.report(token)["releasedBy"])
        store.disarm(token)
    }

    /**
     * The race root and Go found in r1: the storage thread's bounded wait
     * returns at the deadline but must then take the gate's lock to record the
     * timeout, and a release that gets the lock first would record "test" —
     * washing out a hold that really expired.
     *
     * Made deterministic with the REAL code paths: this test takes the gate's
     * own lock (reflection, no production API) while the real write is held,
     * keeps it past the real deadline — so the storage thread cannot record
     * anything — and releases from inside that lock (monitors are reentrant).
     * An expired hold must be a timeout no matter which thread gets the lock
     * first, must no longer read as holding, and the release must change
     * nothing.
     */
    @Test
    fun `a hold that really expired is a timeout even when the release takes the lock first`() {
        val store = store()
        val limitMs = 200L
        val token = store.arm(limitMs)
        assertEquals(ReceiveStore.Outcome.Ok, begin(store))
        val held = onStorage { store.write(0, byteArrayOf(1)) }
        try {
            awaitTrue("file 0 is held") { store.holding(token) }
            val lock = HeldFirstWriteStore::class.java.getDeclaredField("lock")
                .apply { isAccessible = true }
                .get(store)!!
            synchronized(lock) {
                // Past the real deadline while the storage thread is shut out.
                Thread.sleep(limitMs * 2 + 100)
                // Both observations first, then one assertion naming both, so a
                // failure shows exactly what the gate reported.
                val holdingAfterExpiry = store.holding(token)
                store.release(token)
                val releasedBy = store.report(token)["releasedBy"]
                assertEquals(
                    "a hold that expired before the release is a TIMEOUT, whichever thread took the lock " +
                        "first, and no longer holding: holding=$holdingAfterExpiry releasedBy=$releasedBy",
                    "holding=false releasedBy=timeout",
                    "holding=$holdingAfterExpiry releasedBy=$releasedBy",
                )
            }
            assertEquals("the real write still ran", ReceiveStore.Outcome.Ok, held.get(5, TimeUnit.SECONDS))
            store.release(token)
            assertEquals("no later release can wash out the timeout", "timeout", store.report(token)["releasedBy"])
        } finally {
            store.disarm(token)
        }
    }

    @Test
    fun `the gate is one-shot - after it, the next batch's file 0 is not held`() {
        val store = store()
        val token = store.arm(200)
        assertEquals(ReceiveStore.Outcome.Ok, begin(store))
        assertEquals(ReceiveStore.Outcome.Ok, store.write(0, byteArrayOf(1)))
        assertEquals(ReceiveStore.Outcome.Ok, begin(store, listOf(FileMeta("second.bin", 1))))
        val started = System.nanoTime()
        assertEquals(ReceiveStore.Outcome.Ok, store.write(0, byteArrayOf(2)))
        assertTrue("the second batch is ungated", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < 150)
        store.disarm(token)
    }

    @Test
    fun `ownership - one owner at a time, stale owners refused, disarm frees a held write`() {
        val store = store()
        val token = store.arm(5_000)
        try {
            store.arm(5_000)
            throw AssertionError("a second arm while owned must be refused")
        } catch (_: IllegalStateException) {
            // expected
        }
        assertEquals(ReceiveStore.Outcome.Ok, begin(store))
        val held = onStorage { store.write(0, byteArrayOf(1)) }
        awaitTrue("held") { store.holding(token) }
        assertFalse("a stale token does not see the hold", store.holding(token + 1))
        try {
            store.release(token + 1)
            throw AssertionError("a stale owner's release must be refused")
        } catch (_: IllegalStateException) {
            // expected
        }
        assertTrue("still held after the refused release", store.holding(token))
        val report = store.report(token)
        store.disarm(token)
        assertEquals("disarm lets the storage thread go", ReceiveStore.Outcome.Ok, held.get(5, TimeUnit.SECONDS))
        assertEquals(null, report["releasedBy"])
        val again = store.arm(5_000)
        assertTrue("a fresh owner gets a fresh token", again != token)
        store.disarm(again)
    }

    @Test
    fun `arming refuses a hold longer than 30 seconds`() {
        try {
            store().arm(30_001)
            throw AssertionError("a hold past 30 s must be refused")
        } catch (_: IllegalArgumentException) {
            // expected
        }
    }
}
