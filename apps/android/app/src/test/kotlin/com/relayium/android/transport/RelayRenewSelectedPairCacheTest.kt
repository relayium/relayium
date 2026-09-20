package com.relayium.android.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The ordering rule that decides whether a relayed link is bounded at all.
 *
 * `LinkTransport` itself needs an Android `Context` and a real
 * `PeerConnectionFactory`, so this rule lived where no host test could reach
 * it — which is exactly how an event that arrives before its subscriber came to
 * be dropped in the first place. It is its own object now, so the ordering is
 * asserted here rather than argued in a comment and checked on a device.
 */
class RelayRenewSelectedPairCacheTest {

    private val first = RenewTransport.SelectedPair(
        local = "candidate:1 1 udp 100 203.0.113.9 54321 typ relay generation 0 ufrag gen0",
        remote = "candidate:2 1 udp 100 203.0.113.10 54322 typ relay generation 0 ufrag rem0",
    )
    private val second = RenewTransport.SelectedPair(
        local = "candidate:3 1 udp 100 203.0.113.9 54999 typ relay generation 0 ufrag gen1",
        remote = "candidate:4 1 udp 100 203.0.113.10 54998 typ relay generation 0 ufrag rem1",
    )

    private val cache = RelayRenewSelectedPairCache()
    private val seen = ArrayList<RenewTransport.SelectedPair>()

    /**
     * THE regression. ICE settles before the handshake does, so the selection
     * that says "this link is relayed" arrives with nobody listening. Without
     * the replay the link is never bounded: no expiry timer, no warning and no
     * renewal, until a later pair change a healthy connection never makes.
     */
    @Test
    fun `an event that arrives before the subscriber is replayed to it`() {
        cache.record(first)
        assertTrue("nothing was listening yet", seen.isEmpty())
        cache.subscribe(seen::add)
        assertEquals(listOf(first), seen)
    }

    @Test
    fun `an event that arrives after the subscriber reaches it live`() {
        cache.subscribe(seen::add)
        cache.record(first)
        assertEquals(listOf(first), seen)
    }

    @Test
    fun `the replay is the LATEST observation, not the first`() {
        cache.record(first)
        cache.record(second)
        cache.subscribe(seen::add)
        assertEquals(
            "a stale first pair would describe a path the agent has left",
            listOf(second),
            seen,
        )
        assertEquals(second, cache.lastObserved)
    }

    @Test
    fun `re-subscribing replays again, and detaching stops delivery`() {
        cache.record(first)
        cache.subscribe(seen::add)
        cache.subscribe(null)
        cache.record(second)
        assertEquals("detached, so the live event went nowhere", listOf(first), seen)
        // …and the cache kept it, so the next subscriber still learns the
        // current state rather than starting blind.
        val later = ArrayList<RenewTransport.SelectedPair>()
        cache.subscribe(later::add)
        assertEquals(listOf(second), later)
    }

    @Test
    fun `clearing is the identity fence`() {
        cache.record(first)
        cache.clear()
        assertNull(cache.lastObserved)
        cache.subscribe(seen::add)
        assertTrue(
            "a pair observed by a connection that is gone is not evidence about the next one",
            seen.isEmpty(),
        )
    }

    @Test
    fun `a subscriber attached twice does not accumulate`() {
        cache.record(first)
        cache.subscribe(seen::add)
        cache.subscribe(seen::add)
        assertEquals("one slot, replayed once per attach", listOf(first, first), seen)
        cache.record(second)
        assertEquals(listOf(first, first, second), seen)
    }
}
