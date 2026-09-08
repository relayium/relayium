package com.relayium.android.nearby

import org.junit.Assert.assertEquals
import org.junit.Test

/** The one rule that is easy to get wrong: a late edge must never overrule one
 *  that already happened. */
class LocalPeerTransportLifecycleTest {

    private val arm = LocalPeerTransportLifecycle.StartDecision.ARM
    private val ignore = LocalPeerTransportLifecycle.AnnouncementDecision.IGNORE
    private val announce = LocalPeerTransportLifecycle.AnnouncementDecision.ANNOUNCE

    @Test
    fun `both halves must be ready before anything is announced`() {
        val life = LocalPeerTransportLifecycle()
        assertEquals(arm, life.start())
        assertEquals(ignore, life.advertiseBecameReady())
        assertEquals(announce, life.browseBecameReady())
        assertEquals(LocalPeerTransportLifecycle.Phase.RUNNING, life.phase)
    }

    @Test
    fun `starting twice arms once`() {
        val life = LocalPeerTransportLifecycle()
        assertEquals(arm, life.start())
        assertEquals(LocalPeerTransportLifecycle.StartDecision.IGNORE, life.start())
    }

    @Test
    fun `the deadline cannot overrule a pair that already came up`() {
        val life = LocalPeerTransportLifecycle()
        life.start()
        life.advertiseBecameReady()
        life.browseBecameReady()
        assertEquals(ignore, life.startDeadlineElapsed())
        assertEquals(LocalPeerTransportLifecycle.Phase.RUNNING, life.phase)
    }

    @Test
    fun `the deadline cannot overrule a stop or a failure`() {
        val stopped = LocalPeerTransportLifecycle().apply { start(); stop() }
        assertEquals(ignore, stopped.startDeadlineElapsed())
        val failed = LocalPeerTransportLifecycle().apply { start(); fail() }
        assertEquals(ignore, failed.startDeadlineElapsed())
    }

    /** Neither half reported anything: `NsdManager` does not call back at all on
     *  a link with no multicast, so the deadline is the only truthful answer. */
    @Test
    fun `a silent arming window fails rather than searching forever`() {
        val life = LocalPeerTransportLifecycle()
        life.start()
        assertEquals(announce, life.startDeadlineElapsed())
        assertEquals(LocalPeerTransportLifecycle.Phase.FAILED, life.phase)
    }

    @Test
    fun `a failure is announced once and events stop`() {
        val life = LocalPeerTransportLifecycle()
        life.start()
        assertEquals(announce, life.fail())
        assertEquals(ignore, life.fail())
        assertEquals(false, life.isDeliveringEvents)
    }

    @Test
    fun `a stop tears down once`() {
        val life = LocalPeerTransportLifecycle()
        life.start()
        assertEquals(LocalPeerTransportLifecycle.StopDecision.TEAR_DOWN, life.stop())
        assertEquals(LocalPeerTransportLifecycle.StopDecision.IGNORE, life.stop())
        assertEquals(false, life.isDeliveringEvents)
    }

    @Test
    fun `a ready edge after a stop announces nothing`() {
        val life = LocalPeerTransportLifecycle()
        life.start()
        life.advertiseBecameReady()
        life.stop()
        assertEquals(ignore, life.browseBecameReady())
    }
}
