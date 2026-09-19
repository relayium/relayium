package com.relayium.android.transport

import com.relayium.protocol.LinkProtocol
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The local half of the candidate race, as a pure value holder. */
class LocalCandidateGateTest {

    private fun gate(limit: Int = LinkProtocol.HELD_SIGNAL_MAX) =
        LocalCandidateGate<String>(limit)

    @Test
    fun `a fresh gate holds - nothing may precede the description it belongs to`() {
        val gate = gate()
        assertFalse("a gate that starts open gates nothing", gate.isOpen)
        assertEquals(LocalCandidateGate.Admission.HOLD, gate.admit("host-1"))
        assertEquals(1, gate.pendingCount)
    }

    @Test
    fun `release hands back everything held, in gathering order`() {
        val gate = gate()
        val gathered = listOf("host-1", "host-2", "srflx-1", "relay-1")
        for (candidate in gathered) assertEquals(
            LocalCandidateGate.Admission.HOLD, gate.admit(candidate),
        )
        assertEquals(gathered, gate.release())
        assertTrue(gate.isOpen)
        assertEquals(0, gate.pendingCount)
    }

    @Test
    fun `an open gate sends through, and a second release replays nothing`() {
        val gate = gate()
        gate.admit("host-1")
        gate.release()
        assertEquals(LocalCandidateGate.Admission.SEND, gate.admit("srflx-1"))
        assertEquals(0, gate.pendingCount)
        assertEquals(
            "a backlog is flushed once, never replayed",
            emptyList<String>(), gate.release(),
        )
    }

    @Test
    fun `arming again holds the next generation without losing an unsent one`() {
        val gate = gate()
        gate.admit("host-1")
        // A description that was applied but whose candidates had not all been
        // released when the next one began: what is held is UNSENT either way.
        gate.arm()
        assertEquals(LocalCandidateGate.Admission.HOLD, gate.admit("host-2"))
        assertEquals(listOf("host-1", "host-2"), gate.release())
    }

    @Test
    fun `a released gate re-arms for a restart`() {
        val gate = gate()
        gate.release()
        assertEquals(LocalCandidateGate.Admission.SEND, gate.admit("host-1"))
        gate.arm()
        assertFalse(gate.isOpen)
        assertEquals(LocalCandidateGate.Admission.HOLD, gate.admit("host-2"))
        assertEquals(listOf("host-2"), gate.release())
    }

    @Test
    fun `the bound is exact and overflow is refused rather than truncated`() {
        val gate = gate()
        repeat(LinkProtocol.HELD_SIGNAL_MAX) {
            assertEquals(LocalCandidateGate.Admission.HOLD, gate.admit("c$it"))
        }
        assertEquals(
            "the 65th must be refused, not admitted",
            LocalCandidateGate.Admission.OVERFLOW, gate.admit("one-too-many"),
        )
        val released = gate.release()
        assertEquals(LinkProtocol.HELD_SIGNAL_MAX, released.size)
        assertEquals(
            "the earliest candidates — the host ones — are the ones kept",
            "c0", released.first(),
        )
        assertEquals("c${LinkProtocol.HELD_SIGNAL_MAX - 1}", released.last())
    }

    @Test
    fun `an overflowing gate keeps refusing rather than quietly recovering`() {
        val gate = gate(limit = 2)
        gate.admit("a")
        gate.admit("b")
        assertEquals(LocalCandidateGate.Admission.OVERFLOW, gate.admit("c"))
        assertEquals(LocalCandidateGate.Admission.OVERFLOW, gate.admit("d"))
        assertEquals(2, gate.pendingCount)
    }

    @Test
    fun `discard drops the backlog without opening the gate`() {
        val gate = gate()
        gate.admit("host-1")
        gate.discard()
        assertEquals(0, gate.pendingCount)
        assertFalse("teardown must not turn into a release", gate.isOpen)
        assertEquals(
            "and what was discarded does not come back",
            emptyList<String>(), gate.release(),
        )
    }
}
