package com.relayium.android.transport

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Owner report, 0.2.3: a connected cross-network link ended on the first blip.
 * `LinkTransport` cannot run on a JVM (it is real WebRTC), so the rule it now
 * applies to `DISCONNECTED` lives in [DisconnectGrace] and is tested as a rule.
 */
class DisconnectGraceTest {

    private val executor = Executors.newSingleThreadScheduledExecutor()

    @After fun tearDown() { executor.shutdownNow() }

    private fun <T> onExecutor(body: () -> T): T = executor.submit(body).get(5, TimeUnit.SECONDS)

    @Test
    fun `a connection that comes back inside the grace is never reported lost`() {
        val expired = AtomicInteger(0)
        val notes = CopyOnWriteArrayList<Boolean>()
        val grace = DisconnectGrace(executor, 150, { notes.add(it) }, { expired.incrementAndGet() })

        onExecutor { grace.disconnected() }
        assertTrue(onExecutor { grace.pending })
        onExecutor { grace.recovered() }

        Thread.sleep(350)
        assertEquals("it recovered, so it never expires", 0, expired.get())
        assertEquals("interrupted, then back", listOf(true, false), notes.toList())
        assertFalse(onExecutor { grace.pending })
    }

    @Test
    fun `a connection that stays away is lost when the grace runs out and not before`() {
        val expired = CountDownLatch(1)
        val grace = DisconnectGrace(executor, 150, {}, { expired.countDown() })
        val started = System.nanoTime()
        onExecutor { grace.disconnected() }
        assertTrue("bounded: it does end", expired.await(3, TimeUnit.SECONDS))
        val waitedMs = (System.nanoTime() - started) / 1_000_000
        assertTrue("but not on the first DISCONNECTED (waited $waitedMs ms)", waitedMs >= 140)
    }

    @Test
    fun `a repeated DISCONNECTED does not extend the wait`() {
        val expired = CountDownLatch(1)
        val notes = CopyOnWriteArrayList<Boolean>()
        val grace = DisconnectGrace(executor, 200, { notes.add(it) }, { expired.countDown() })
        val started = System.nanoTime()
        onExecutor { grace.disconnected() }
        Thread.sleep(120)
        onExecutor { grace.disconnected() }
        assertTrue(expired.await(3, TimeUnit.SECONDS))
        val waitedMs = (System.nanoTime() - started) / 1_000_000
        assertTrue("bounded from the FIRST loss (waited $waitedMs ms)", waitedMs < 320)
        assertEquals("and announced once", listOf(true), notes.toList())
    }

    @Test
    fun `a link that ends for another reason cancels the wait silently`() {
        val expired = AtomicInteger(0)
        val notes = CopyOnWriteArrayList<Boolean>()
        val grace = DisconnectGrace(executor, 120, { notes.add(it) }, { expired.incrementAndGet() })
        onExecutor { grace.disconnected() }
        onExecutor { grace.cancel() }
        Thread.sleep(300)
        assertEquals(0, expired.get())
        assertEquals("no 'recovered' is claimed for a link that ended", listOf(true), notes.toList())
    }
}
