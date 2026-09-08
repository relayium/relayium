package com.relayium.android.scan

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A viewfinder decodes the same code many times a second, on a thread that does
 * not stop when the sheet closes. Both of those are what this fences.
 */
class ScanSessionTest {

    private val origin = "https://relayium.com"
    private val link = "$origin/cross-network#c=042913"
    private val other = "$origin/cross-network#c=555555"

    @Test
    fun `the first readable frame produces the one result`() {
        val session = ScanSession()
        val generation = session.open()
        val result = session.offer(generation, link, origin)
        assertNotNull(result)
        assertEquals("042913", result!!.code.digits)
    }

    @Test
    fun `the same code decoded again is not a second thing the user did`() {
        val session = ScanSession()
        val generation = session.open()
        assertNotNull(session.offer(generation, link, origin))
        repeat(30) { assertNull(session.offer(generation, link, origin)) }
        assertFalse(session.isOpen)
    }

    @Test
    fun `a different code in the same run cannot overwrite the first answer`() {
        // The user pointed the camera at one thing; a second code drifting
        // through the frame afterwards is not a correction.
        val session = ScanSession()
        val generation = session.open()
        assertEquals("042913", session.offer(generation, link, origin)!!.code.digits)
        assertNull(session.offer(generation, other, origin))
    }

    @Test
    fun `a frame that arrives after the sheet closed lands nowhere`() {
        // Frames already in flight when the user dismisses. Without the fence
        // they prefill a code into whatever the user moved on to.
        val session = ScanSession()
        val generation = session.open()
        session.close()
        assertNull(session.offer(generation, link, origin))
        assertFalse(session.isOpen)
    }

    @Test
    fun `a frame from a superseded run lands nowhere`() {
        val session = ScanSession()
        val first = session.open()
        val second = session.open()
        assertNull("a frame from the old run", session.offer(first, link, origin))
        assertNotNull("the current run still works", session.offer(second, link, origin))
    }

    @Test
    fun `reopening starts a run that a stale frame cannot reach`() {
        // Close and reopen must not reset the fence — a late frame from the
        // first run would otherwise land in the second.
        val session = ScanSession()
        val first = session.open()
        assertNotNull(session.offer(first, link, origin))
        session.close()
        val second = session.open()
        assertNull("the spent run's frame", session.offer(first, link, origin))
        assertNotNull("the new run scans", session.offer(second, link, origin))
    }

    @Test
    fun `an unreadable payload does not spend the run`() {
        // Pointing the camera at a poster, a URL, a wifi QR: none of it is a
        // pairing code and none of it should stop the scanner working.
        val session = ScanSession()
        val generation = session.open()
        for (junk in listOf(
            "hello",
            "042913",
            "https://evil.example/cross-network#c=042913",
            "$origin/cross-network#c=12345",
            "$origin/d/abc123#k=x",
            "",
        )) {
            assertNull(junk, session.offer(generation, junk, origin))
        }
        assertTrue(session.isOpen)
        assertNotNull("a real code still scans afterwards", session.offer(generation, link, origin))
    }

    @Test
    fun `a scan cannot be produced before the run is opened`() {
        val session = ScanSession()
        assertNull(session.offer(1, link, origin))
        assertFalse(session.isOpen)
    }

    @Test
    fun `closing twice is not an error`() {
        val session = ScanSession()
        val generation = session.open()
        session.close()
        session.close()
        assertNull(session.offer(generation, link, origin))
    }

    @Test
    fun `a spent run is still current until it is closed`() {
        // The delivery fence asks this AFTER a result has been accepted: the
        // run that produced the result is exactly the run that spent itself
        // producing it, so consuming must not make its own result late.
        val session = ScanSession()
        val generation = session.open()
        assertNotNull(session.offer(generation, link, origin))
        assertTrue("the producing run must still be deliverable", session.isCurrent(generation))
        assertFalse("but it accepts nothing more", session.isOpen)
    }

    @Test
    fun `a dismissal between the decode and the delivery wins`() {
        // The real gap: the decode finished on the camera executor, the
        // callback is on its way to the main thread, and the user closed the
        // sheet inside it. Delivering anyway prefills a code into whatever
        // they opened next.
        val session = ScanSession()
        val generation = session.open()
        assertNotNull(session.offer(generation, link, origin))
        session.close()
        assertFalse(session.isCurrent(generation))
    }

    @Test
    fun `a generation that never existed is not current`() {
        val session = ScanSession()
        assertFalse(session.isCurrent(0))
        assertFalse(session.isCurrent(99))
        val generation = session.open()
        assertTrue(session.isCurrent(generation))
        assertFalse(session.isCurrent(generation + 1))
        assertFalse(session.isCurrent(generation - 1))
    }

    @Test
    fun `only one of many concurrent frames wins`() {
        // The real shape: an analysis executor delivering frames while the main
        // thread is doing something else. Exactly one result, whatever the
        // interleaving.
        val session = ScanSession()
        val generation = session.open()
        val threads = 8
        val pool = Executors.newFixedThreadPool(threads)
        val start = CountDownLatch(1)
        val done = CountDownLatch(threads)
        val wins = AtomicInteger()
        repeat(threads) {
            pool.execute {
                start.await()
                repeat(50) { if (session.offer(generation, link, origin) != null) wins.incrementAndGet() }
                done.countDown()
            }
        }
        start.countDown()
        assertTrue(done.await(30, TimeUnit.SECONDS))
        pool.shutdown()
        assertEquals(1, wins.get())
    }

    @Test
    fun `a close racing the frames leaves at most one result and never more`() {
        val session = ScanSession()
        val generation = session.open()
        val pool = Executors.newFixedThreadPool(4)
        val wins = AtomicInteger()
        val done = CountDownLatch(4)
        repeat(3) {
            pool.execute {
                repeat(200) { if (session.offer(generation, link, origin) != null) wins.incrementAndGet() }
                done.countDown()
            }
        }
        pool.execute {
            Thread.yield()
            session.close()
            done.countDown()
        }
        assertTrue(done.await(30, TimeUnit.SECONDS))
        pool.shutdown()
        assertTrue("at most one result, got ${wins.get()}", wins.get() <= 1)
        assertFalse(session.isOpen)
    }
}
