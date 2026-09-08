package com.relayium.android.inbox

import com.relayium.protocol.stored.PlaintextSource
import java.io.Closeable
import java.io.IOException
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Descriptor ownership, against a REAL blocked read.
 *
 * A loopback socket with nothing written to it, read from a coroutine: the read
 * is genuinely blocked in the kernel, and nothing in the test releases it. The
 * only thing that can end it is the descriptor being closed by the cancellation
 * path — which is exactly the property under test, and one that a fake
 * "cancellable" source could not express at all.
 *
 * This is why the lease closes from a CHILD COROUTINE rather than from a
 * completion handler: a job blocked inside a read cannot complete, so a handler
 * that fires on completion would be waiting for the very thing it exists to
 * interrupt.
 */
class InboxSourceLeaseTest {

    private class Loopback : Closeable {
        val server = ServerSocket(0)
        val client = Socket("127.0.0.1", server.localPort)
        val peer: Socket = server.accept()

        override fun close() {
            runCatching { client.close() }
            runCatching { peer.close() }
            runCatching { server.close() }
        }
    }

    /** A source whose `read` blocks on a socket that will never carry data. */
    private fun blocking(socket: Socket, entered: CountDownLatch) = object : PlaintextSource {
        override val name = "fixture"
        override val size = 1L

        override fun read(max: Int): ByteArray {
            entered.countDown()
            val value = socket.getInputStream().read()
            return if (value < 0) ByteArray(0) else byteArrayOf(value.toByte())
        }

        override fun close() = Unit
    }

    @Test
    fun `cancelling closes an actually blocked read`() = runBlocking {
        Loopback().use { net ->
            val entered = CountDownLatch(1)
            val ended = CountDownLatch(1)
            val opener = InboxLeasedSources { _, lease ->
                assertTrue(lease.add(net.client))
                blocking(net.client, entered)
            }

            val worker = launch(Dispatchers.IO) {
                try {
                    opener.withSources(listOf(InboxSourceRef("fixture", "fixture", 1))) {
                        it.single().read(1)
                    }
                } catch (e: IOException) {
                    // The socket closed under the read. That IS the release.
                } finally {
                    ended.countDown()
                }
            }

            assertTrue("the read must actually block", entered.await(3, TimeUnit.SECONDS))
            worker.cancel()
            assertTrue(
                "cancelling must close the descriptor while the read is blocked",
                ended.await(3, TimeUnit.SECONDS),
            )
            worker.cancelAndJoin()
        }
    }

    /**
     * A descriptor opened after the lease closed is closed, not handed back.
     *
     * This is the cancellation-during-open race: the caller is already gone, and
     * a resource returned to it would be a leak nobody owns.
     */
    @Test
    fun `a resource offered to a closed lease is closed and refused`() {
        val lease = InboxSourceLease()
        val closed = AtomicBoolean(false)
        lease.closeAll()
        assertFalse(lease.add(Closeable { closed.set(true) }))
        assertTrue("the refused resource must be closed", closed.get())
    }

    /** Everything leased is closed exactly once, including on the normal path. */
    @Test
    fun `every leased resource is closed once`() = runBlocking {
        val closes = AtomicInteger(0)
        val opener = InboxLeasedSources { ref, lease ->
            lease.add(Closeable { closes.incrementAndGet() })
            com.relayium.protocol.stored.BytesSource(ref.name, ByteArray(2))
        }
        opener.withSources(
            listOf(
                InboxSourceRef("a", "a.bin", 2),
                InboxSourceRef("b", "b.bin", 2),
            ),
        ) { sources -> assertEquals(2, sources.size) }

        assertEquals(2, closes.get())
    }

    /** A source that cannot be opened names its INDEX and closes what was
     *  already opened for that staging. */
    @Test
    fun `a refused source closes the ones already open`() = runBlocking {
        val closes = AtomicInteger(0)
        val opener = InboxLeasedSources { ref, lease ->
            if (ref.name == "b.bin") return@InboxLeasedSources null
            lease.add(Closeable { closes.incrementAndGet() })
            com.relayium.protocol.stored.BytesSource(ref.name, ByteArray(2))
        }
        val failure = runCatching {
            opener.withSources(
                listOf(
                    InboxSourceRef("a", "a.bin", 2),
                    InboxSourceRef("b", "b.bin", 2),
                ),
            ) { }
        }
        assertEquals(1, (failure.exceptionOrNull() as? InboxSourceException)?.index)
        assertEquals(1, closes.get())
    }
}
