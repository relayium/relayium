package com.relayium.android.integration

import java.io.Closeable
import org.junit.Assert.*
import org.junit.Test

class SessionDropLeaseTest {
    private val ready = SessionDropLease.Context(7, true, true, 3, false)
    private class Grant : Closeable { var closes = 0; override fun close() { closes++ } }

    @Test fun `actual interrupted state blocks new drops but retains active source permission`() {
        val state = com.relayium.android.TransferController.State(
            phase = com.relayium.android.TransferController.Phase.CONNECTED,
            wire = com.relayium.android.TransferController.Wire.LINK,
            linkId = 7,
            nearby = com.relayium.android.TransferController.Nearby(active = true),
        )
        val initial = SessionDropLease.context(state)
        val g = Grant(); val owner = SessionDropLease(); val t = owner.begin(7, initial, g)!!
        owner.admission(t, true)
        val interrupted = SessionDropLease.context(state.copy(linkInterrupted = true))
        assertTrue(interrupted.usable); assertFalse(interrupted.acceptsNew)
        owner.observe(interrupted); assertEquals(0, g.closes)
        owner.observe(SessionDropLease.context(state.copy(linkId = 8))); assertEquals(1, g.closes)
    }

    @Test fun `metadata and accepted stream keep grant until verified completion`() {
        val g = Grant(); val owner = SessionDropLease(); val t = owner.begin(7, ready, g)!!
        owner.observe(ready); assertTrue(owner.maySubmit(t, ready)); assertEquals(0, g.closes)
        owner.admission(t, true); owner.observe(ready.copy(outgoing = true, acceptsNew = false))
        assertEquals(0, g.closes)
        owner.observe(ready.copy(completed = 4)); owner.close(); assertEquals(1, g.closes)
    }

    @Test fun `coalesced fast completion uses monotonic count without seeing outgoing`() {
        val g = Grant(); val owner = SessionDropLease(); val t = owner.begin(7, ready, g)!!
        owner.admission(t, true); owner.observe(ready.copy(completed = 4)); assertEquals(1, g.closes)
    }

    @Test fun `stale drag and closed admission refuse and release without provider work`() {
        for (c in listOf(ready.copy(link = 8), ready.copy(usable = false), ready.copy(acceptsNew = false))) {
            val g = Grant(); assertNull(SessionDropLease().begin(7, c, g)); assertEquals(1, g.closes)
        }
    }

    @Test fun `peer changes during delayed metadata close once and never submit`() {
        val g = Grant(); val owner = SessionDropLease(); val t = owner.begin(7, ready, g)!!
        owner.observe(ready.copy(link = 8)); assertFalse(owner.maySubmit(t, ready.copy(link = 8)))
        owner.abandon(t); owner.close(); assertEquals(1, g.closes)
    }

    @Test fun `second drop cannot replace the first grant while metadata is pending`() {
        val g = Grant(); val other = Grant(); val owner = SessionDropLease()
        val t = owner.begin(7, ready, g)!!; assertNull(owner.begin(7, ready, other))
        assertEquals(1, other.closes); assertEquals(0, g.closes); assertTrue(owner.maySubmit(t, ready))
        owner.abandon(t); assertEquals(1, g.closes)
    }

    @Test fun `controller refusal after metadata closes without waiting for state emission`() {
        val g = Grant(); val owner = SessionDropLease(); val t = owner.begin(7, ready, g)!!
        owner.admission(t, false); owner.abandon(t); assertEquals(1, g.closes)
    }

    @Test fun `cancel or file lane loss closes the observed batch`() {
        for (terminal in listOf(ready, ready.copy(usable = false))) {
            val g = Grant(); val owner = SessionDropLease(); val t = owner.begin(7, ready, g)!!
            owner.admission(t, true); owner.observe(ready.copy(outgoing = true))
            owner.observe(terminal); assertEquals(1, g.closes)
        }
    }

    @Test fun `old callback cannot release a newer selection`() {
        val owner = SessionDropLease(); val old = owner.begin(7, ready, Grant())!!
        owner.abandon(old); val g = Grant(); owner.begin(7, ready, g)!!
        owner.admission(old, false); owner.abandon(old); assertEquals(0, g.closes)
        owner.close(); owner.close(); assertEquals(1, g.closes)
    }

    @Test fun `closing metadata or a throwing grant still clears busy state`() {
        val changes = mutableListOf<Boolean>(); val owner = SessionDropLease(changes::add)
        owner.begin(7, ready, Closeable { error("grant release refused") }); owner.close()
        assertEquals(listOf(true, false), changes)
    }
}
