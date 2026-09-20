package com.relayium.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The credential boundary, the renewal margin and the real-user-data clock.
 *
 * Pure arithmetic over an injected `now`, which is the point: every instant
 * below is a real bound the controller arms a timer off, and none of them needs
 * a second of wall clock to assert.
 */
class RelayRenewPolicyTest {

    private val hour = 60 * 60_000L
    private val now = 1_790_000_000_000L

    private fun turn(expirySeconds: Long, urls: List<String> = listOf("turn:relay.example:3478")) =
        RelayRenewPolicy.Credential(urls, "$expirySeconds:token")

    // ── the boundary ────────────────────────────────────────────────────────

    @Test
    fun `a one-hour grant is bounded a clock-skew margin early`() {
        val bound = RelayRenewPolicy.deadline(listOf(turn((now + hour) / 1000)), now)!!
        assertEquals(now + hour, bound.expiresAt)
        assertEquals(now + hour - RelayRenewPolicy.CLOCK_SKEW_MS, bound.deadlineAt)
        assertEquals(bound.deadlineAt - RelayRenewPolicy.WARN_MS, bound.warnAt)
        assertFalse(bound.expired)
    }

    @Test
    fun `nothing that can hold an allocation means no boundary at all`() {
        // The LAN answer, and the answer for a STUN-only room. A boundary here
        // would end a link that never relays.
        assertNull(
            RelayRenewPolicy.deadline(
                listOf(
                    RelayRenewPolicy.Credential(listOf("stun:stun.example:3478"), "$now:token"),
                ),
                now,
            ),
        )
        assertNull(RelayRenewPolicy.deadline(emptyList(), now))
    }

    @Test
    fun `the EARLIEST expiry in the pool is the bound`() {
        val bound = RelayRenewPolicy.deadline(
            listOf(
                turn((now + 3 * hour) / 1000, listOf("turn:a.example:3478")),
                turn((now + hour) / 1000, listOf("turns:b.example:5349")),
                turn((now + 2 * hour) / 1000, listOf("turn:c.example:3478")),
            ),
            now,
        )!!
        assertEquals(now + hour, bound.expiresAt)
    }

    @Test
    fun `a malformed neighbour never removes a valid entry's bound`() {
        val bound = RelayRenewPolicy.deadline(
            listOf(
                RelayRenewPolicy.Credential(listOf("turn:broken.example:3478"), "not-a-number:x"),
                RelayRenewPolicy.Credential(listOf("turn:none.example:3478"), null),
                turn((now + hour) / 1000),
            ),
            now,
        )!!
        assertEquals(now + hour, bound.expiresAt)
    }

    @Test
    fun `a TURN REST username is read strictly`() {
        assertEquals(1_790_000_000L, RelayRenewPolicy.restExpirySeconds("1790000000:abc"))
        // Each of these is finite under a lenient numeric conversion, and each
        // would impose a deadline read out of noise.
        assertNull(RelayRenewPolicy.restExpirySeconds(":abc"))
        assertNull(RelayRenewPolicy.restExpirySeconds(" 12 :abc"))
        assertNull(RelayRenewPolicy.restExpirySeconds("0x10:abc"))
        assertNull(RelayRenewPolicy.restExpirySeconds("+12:abc"))
        assertNull(RelayRenewPolicy.restExpirySeconds("0:abc"))
        assertNull(RelayRenewPolicy.restExpirySeconds("1790000000"))
        assertNull(RelayRenewPolicy.restExpirySeconds(null))
    }

    @Test
    fun `an already-dead credential is terminal, not renewable`() {
        val bound = RelayRenewPolicy.deadline(listOf(turn((now - hour) / 1000)), now)!!
        assertEquals(now, bound.deadlineAt)
        assertEquals(now, bound.warnAt)
        assertTrue(bound.expired)
    }

    // ── the margin, and the trap it is built to avoid ───────────────────────

    @Test
    fun `a one-hour grant becomes due ten minutes before its boundary`() {
        val bound = RelayRenewPolicy.deadline(listOf(turn((now + hour) / 1000)), now)!!
        assertEquals(bound.deadlineAt - RelayRenewPolicy.MAX_MARGIN_MS, bound.renewAt)
    }

    /**
     * The regression this whole anchoring rule exists for.
     *
     * With the margin recomputed from the time REMAINING at each tick —
     * `margin = remaining / 3` — the test `now < deadlineAt - margin` reduces
     * to `remaining > remaining / 3`, which is true for every positive
     * remaining. The renewal would then be "not due yet" at fifty minutes, at
     * fifty-five, at fifty-nine, and would fire only once the link was already
     * dead. Anchoring the margin to the grant's whole lifetime, once, at arming
     * time, is what makes the fifty-minute tick due.
     */
    @Test
    fun `a tick at fifty minutes of a sixty-minute grant is due`() {
        val bound = RelayRenewPolicy.deadline(listOf(turn((now + hour) / 1000)), now)!!
        assertFalse(now + 40 * 60_000L >= bound.renewAt, "not yet at forty minutes")
        assertTrue(now + 50 * 60_000L >= bound.renewAt, "due at fifty minutes")
        // And still due five minutes later, which is what makes user data at
        // fifty-five a legitimate trigger rather than a missed window.
        assertTrue(now + 55 * 60_000L >= bound.renewAt)
        assertTrue(now + 55 * 60_000L < bound.deadlineAt)
    }

    @Test
    fun `a short grant scales rather than going negative or never firing`() {
        // A third of the lifetime, so an accelerated test credential renews
        // before its boundary instead of never.
        assertEquals(20_000L, RelayRenewPolicy.marginMs(60_000L))
        assertEquals(60_000L, RelayRenewPolicy.marginMs(3 * 60_000L))
        // Capped at ten minutes however long the grant is.
        assertEquals(RelayRenewPolicy.MAX_MARGIN_MS, RelayRenewPolicy.marginMs(24 * hour))
        // Never negative, whatever it is handed.
        assertEquals(0L, RelayRenewPolicy.marginMs(0))
        assertEquals(0L, RelayRenewPolicy.marginMs(-hour))
    }

    @Test
    fun `renewAt is never before the boundary was armed`() {
        val bound = RelayRenewPolicy.deadline(listOf(turn((now + 30_000) / 1000)), now)!!
        // A credential shorter than the clock-skew margin collapses to an
        // immediate boundary; the renewal instant must not precede arming, or
        // the trigger would fire in a loop against a link that must end.
        assertTrue(bound.renewAt >= bound.armedAt)
        assertTrue(bound.expired)
    }

    // ── the activity clock ──────────────────────────────────────────────────

    @Test
    fun `a link that has carried no user data is never active`() {
        val activity = RelayRenewPolicy.Activity()
        assertNull(activity.lastUserDataAt)
        assertFalse(activity.active(now))
    }

    @Test
    fun `activity expires on the same ten minutes the idle policy uses`() {
        val activity = RelayRenewPolicy.Activity()
        activity.note(now)
        assertTrue(activity.active(now))
        assertTrue(activity.active(now + RelayRenewPolicy.USER_DATA_WINDOW_MS))
        assertFalse(activity.active(now + RelayRenewPolicy.USER_DATA_WINDOW_MS + 1))
    }

    @Test
    fun `the clock only ever moves forward`() {
        val activity = RelayRenewPolicy.Activity()
        activity.note(now)
        activity.note(now - hour)
        assertEquals(now, activity.lastUserDataAt)
    }
}
