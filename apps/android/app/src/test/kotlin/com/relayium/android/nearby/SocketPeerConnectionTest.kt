package com.relayium.android.nearby

import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Socket OWNERSHIP, on real sockets.
 *
 * Every case here is about one question: after a cancel, who closes the file
 * descriptor? A scripted double cannot answer it — it has no descriptor to
 * leak — so these bind real loopback sockets and assert on the real thing.
 *
 * The two races below are not hypothetical orderings. An accepted socket is
 * connected before this object exists, and the channel legitimately refuses one
 * without ever starting it; and a dial that returns while a cancel is in flight
 * has a window where neither side believes it owns the result. Both leaked.
 */
class SocketPeerConnectionTest {

    private val closeables = ArrayList<AutoCloseable>()

    @After
    fun tearDown() {
        closeables.forEach { runCatching { it.close() } }
    }

    private fun <T : AutoCloseable> keep(value: T): T = value.also(closeables::add)

    /** A real connected pair on the loopback interface. */
    private class Pair(val server: ServerSocket, val client: Socket, val accepted: Socket)

    private fun loopbackPair(): Pair {
        val server = keep(ServerSocket().apply { bind(InetSocketAddress(InetAddress.getLoopbackAddress(), 0)) })
        val client = keep(Socket())
        client.connect(InetSocketAddress(InetAddress.getLoopbackAddress(), server.localPort), 5_000)
        val accepted = keep(server.accept())
        return Pair(server, client, accepted)
    }

    private fun awaitTrue(what: String, timeoutMs: Long = 5_000, predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return
            Thread.sleep(5)
        }
        throw AssertionError("timed out waiting for: $what")
    }

    // ── the two leaks ───────────────────────────────────────────────────────

    /**
     * The channel refuses an inbound stream — it is over its bound, or the room
     * is already closed — by cancelling it and never starting it. The socket is
     * already connected at that point, and nothing else will ever see it.
     */
    @Test
    fun `an accepted socket refused before it is ever started is closed`() {
        val pair = loopbackPair()
        val connection = SocketPeerConnection.accepted(pair.accepted)
        connection.cancel()
        assertTrue("the descriptor the channel refused must not stay open", pair.accepted.isClosed)
    }

    @Test
    fun `refusing an accepted socket still delivers the close edge`() {
        val pair = loopbackPair()
        val connection = SocketPeerConnection.accepted(pair.accepted)
        val closed = CountDownLatch(1)
        connection.onClosed = { closed.countDown() }
        connection.cancel()
        assertTrue("its owner is told, once", closed.await(2, TimeUnit.SECONDS))
    }

    @Test
    fun `a close handler installed after the refusal is still owed the edge`() {
        val pair = loopbackPair()
        val connection = SocketPeerConnection.accepted(pair.accepted)
        connection.cancel()
        val closed = CountDownLatch(1)
        connection.onClosed = { closed.countDown() }
        assertTrue(closed.await(2, TimeUnit.SECONDS))
    }

    /**
     * A cancel that lands while the dial is still running. The worker owns a
     * socket the canceller cannot see, so the worker has to be the one that
     * closes it.
     */
    @Test
    fun `a socket dialled after the cancel is closed by the thread that opened it`() {
        val pair = loopbackPair()
        val release = CountDownLatch(1)
        val opened = CountDownLatch(1)
        val connection = SocketPeerConnection.dialling {
            opened.countDown()
            release.await(5, TimeUnit.SECONDS)
            pair.client
        }
        connection.start()
        assertTrue("the dial is in flight", opened.await(5, TimeUnit.SECONDS))
        connection.cancel()
        release.countDown()
        awaitTrue("the worker closed what it opened") { pair.client.isClosed }
    }

    /**
     * The publication race, driven deterministically through the object's own
     * ownership lock: the worker is held at the exact instant it would adopt the
     * socket, the cancel runs while the field is still null, and the socket must
     * still end up closed.
     */
    @Test
    fun `a cancel while the worker waits to publish still closes the socket`() {
        val pair = loopbackPair()
        val connection = SocketPeerConnection.dialling { pair.client }
        val lockField = SocketPeerConnection::class.java.getDeclaredField("lock")
        lockField.isAccessible = true
        val lock = lockField.get(connection)

        synchronized(lock) {
            connection.start()
            // Wait until the worker is genuinely blocked on this monitor, rather
            // than merely started: a sleep here would sample a timing, not the
            // ordering under test.
            awaitTrue("the worker is blocked at publication") {
                Thread.getAllStackTraces().keys.any {
                    it.name == "relayium-nearby-stream" && it.state == Thread.State.BLOCKED
                }
            }
            // Re-entrant: this thread already holds the lock, and the field the
            // canceller would read is still null.
            connection.cancel()
        }
        awaitTrue("the socket is closed once the worker gets the lock") { pair.client.isClosed }
    }

    @Test
    fun `a dial that throws closes nothing and still reports the end`() {
        val connection = SocketPeerConnection.dialling { throw IOException("no route") }
        val closed = CountDownLatch(1)
        connection.onClosed = { closed.countDown() }
        connection.start()
        assertTrue(closed.await(5, TimeUnit.SECONDS))
    }

    // ── the ordinary path still works ───────────────────────────────────────

    @Test
    fun `bytes flow, and the peer closing is reported once`() {
        val pair = loopbackPair()
        val connection = SocketPeerConnection.accepted(pair.accepted)
        val received = java.io.ByteArrayOutputStream()
        val gotSomething = CountDownLatch(1)
        connection.onBytes = { bytes, count ->
            synchronized(received) { received.write(bytes, 0, count) }
            gotSomething.countDown()
        }
        val closed = CountDownLatch(1)
        connection.onClosed = { closed.countDown() }
        connection.start()

        pair.client.getOutputStream().write(byteArrayOf(1, 2, 3, 4))
        pair.client.getOutputStream().flush()
        assertTrue("inbound bytes reached the handler", gotSomething.await(5, TimeUnit.SECONDS))

        connection.send(byteArrayOf(9, 8))
        val readBack = ByteArray(2)
        var read = 0
        while (read < 2) {
            val n = pair.client.getInputStream().read(readBack, read, 2 - read)
            if (n < 0) break
            read += n
        }
        assertEquals(listOf<Byte>(9, 8), readBack.toList())

        pair.client.close()
        assertTrue("the end was reported", closed.await(5, TimeUnit.SECONDS))
        awaitTrue("and this side's descriptor went with it") { pair.accepted.isClosed }
    }

    @Test
    fun `cancelling a running stream closes it and reports once`() {
        val pair = loopbackPair()
        val connection = SocketPeerConnection.accepted(pair.accepted)
        val closes = java.util.concurrent.atomic.AtomicInteger(0)
        connection.onClosed = { closes.incrementAndGet() }
        connection.start()
        awaitTrue("running") { Thread.getAllStackTraces().keys.any { it.name == "relayium-nearby-stream" } }
        connection.cancel()
        awaitTrue("closed") { pair.accepted.isClosed }
        connection.cancel()
        Thread.sleep(150)
        assertEquals("the close edge is delivered exactly once", 1, closes.get())
    }

    /** A peer that stops reading must not be able to grow this process's
     *  memory. The stream is dropped instead. */
    @Test
    fun `a full send queue drops the stream rather than growing`() {
        val pair = loopbackPair()
        val connection = SocketPeerConnection.accepted(pair.accepted)
        val closed = AtomicBoolean(false)
        connection.onClosed = { closed.set(true) }
        // Never started, so nothing drains the outbox: every offer stays.
        repeat(SocketPeerConnection.SEND_QUEUE_FRAMES + 1) {
            connection.send(ByteArray(8))
        }
        assertTrue("the stream was dropped at the bound", pair.accepted.isClosed)
        assertTrue(closed.get())
    }

    // ── the accept hand-off, which owns a descriptor ────────────────────────

    /**
     * `stop()` shuts the transport's queue down, and it can do so between an
     * `accept()` returning and the hand-off onto that queue. Nothing else holds
     * the socket at that instant, so a silently dropped dispatch is a leaked
     * file descriptor AND a dead accept thread.
     */
    @Test
    fun `a rejected hand-off closes the accepted socket and stops the loop`() {
        val pair = loopbackPair()
        val stopped = java.util.concurrent.Executors.newSingleThreadExecutor().apply { shutdown() }
        val delivered = AtomicBoolean(false)
        val keepAccepting = handOffAccepted(
            accepted = pair.accepted,
            submit = { task -> stopped.execute(task) },
            receive = { delivered.set(true); true },
        )
        assertFalse("the caller is told to stop accepting", keepAccepting)
        assertFalse("and nothing was delivered", delivered.get())
        assertTrue("the descriptor nobody else held is closed", pair.accepted.isClosed)
    }

    /** No delegate, or a room that has stopped delivering events: an accepted
     *  socket with nobody to give it to is still this side's to close. */
    @Test
    fun `a hand-off nobody receives closes the socket`() {
        val pair = loopbackPair()
        val ran = CountDownLatch(1)
        val keepAccepting = handOffAccepted(
            accepted = pair.accepted,
            submit = { task -> task.run(); ran.countDown() },
            receive = { false },
        )
        assertTrue("the queue accepted the work", keepAccepting)
        assertTrue(ran.await(2, TimeUnit.SECONDS))
        assertTrue(pair.accepted.isClosed)
    }

    @Test
    fun `an accepted hand-off reaches the receiver with a live stream`() {
        val pair = loopbackPair()
        var handed: LocalPeerConnection? = null
        val keepAccepting = handOffAccepted(
            accepted = pair.accepted,
            submit = { task -> task.run() },
            receive = { connection -> handed = connection; true },
        )
        assertTrue(keepAccepting)
        assertFalse("it is the receiver's now, and still open", pair.accepted.isClosed)
        handed!!.cancel()
        assertTrue("and cancelling it closes it", pair.accepted.isClosed)
    }

    @Test
    fun `a cancelled stream refuses further sends`() {
        val pair = loopbackPair()
        val connection = SocketPeerConnection.accepted(pair.accepted)
        connection.cancel()
        connection.send(ByteArray(4))
        assertFalse("and nothing revived it", !pair.accepted.isClosed)
    }
}
