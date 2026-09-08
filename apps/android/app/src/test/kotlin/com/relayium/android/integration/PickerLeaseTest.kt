package com.relayium.android.integration

import com.relayium.android.integration.PickerLease.Claim
import com.relayium.android.integration.PickerLease.Verdict
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The bounded owned-picker lease, driven against a clock rather than a wait.
 *
 * The cases are the four the framing named for this invariant — a normal return
 * inside the lease, expiry, a late callback after expiry, and a recreation that
 * must not restart the clock — plus the two an independent probe reproduced as
 * RED against the first draft of this class:
 *
 *  * a result arriving at EXACTLY the deadline was accepted, which also left a
 *    host that slept until its own `nextDeadline` with a zero remaining delay
 *    and nothing to sweep;
 *  * a token restored across process death aliased a fresh lease's first token,
 *    so the previous runtime's pick was applied to a different operation.
 */
class PickerLeaseTest {

    private fun lease(runtimeId: String = "aaaaaaaaaaaaaaaa") =
        PickerLease(timeoutMillis = 120_000L, runtimeId = runtimeId)

    @Test
    fun `a return inside the lease is applied`() {
        val lease = lease()
        val token = lease.launch(nowMillis = 1_000L, claim = Claim.PRESENCE)
        assertEquals(Verdict.LIVE, lease.consume(token, nowMillis = 100_000L))
    }

    @Test
    fun `the deadline itself is over`() {
        val lease = lease()
        val token = lease.launch(nowMillis = 0L, claim = Claim.PRESENCE)
        // `>=`, not `>`. A host that slept until exactly this instant must find
        // the lease finished; otherwise it wakes, sweeps nothing, computes a
        // remaining delay of zero, and spins on a clock that has not moved.
        assertEquals(Verdict.EXPIRED, lease.consume(token, nowMillis = 120_000L))
    }

    @Test
    fun `a sweep at exactly the deadline retires the picker`() {
        val lease = lease()
        lease.launch(nowMillis = 0L, claim = Claim.PRESENCE)
        val due = lease.sweep(nowMillis = 120_000L)
        assertEquals(1, due.size)
        assertEquals(Claim.PRESENCE, due[0].claim)
        // Nothing left to wait for: the host has no next deadline to sleep to
        // and therefore no zero-delay wake-up to repeat.
        assertNull(lease.nextDeadline())
    }

    @Test
    fun `a result arriving after the deadline is refused`() {
        val lease = lease()
        val token = lease.launch(nowMillis = 0L, claim = Claim.PRESENCE)
        assertEquals(Verdict.EXPIRED, lease.consume(token, nowMillis = 120_001L))
    }

    @Test
    fun `a token from a previous process cannot claim a fresh operation`() {
        // The adversarial shape an independent probe found: `ActivityResultRegistry`
        // restores pending results across process death, so a token written into
        // saved instance state really does come back to a lease that did not
        // issue it. With a bare counter both are "1" and the old pick is applied
        // to whatever the new one is doing.
        val previousProcess = lease(runtimeId = "1111111111111111")
        val restoredToken = previousProcess.launch(nowMillis = 0L, claim = Claim.PRESENCE)

        val freshProcess = lease(runtimeId = "2222222222222222")
        val freshToken = freshProcess.launch(nowMillis = 0L, claim = Claim.PRESENCE)

        assertNotEquals(restoredToken, freshToken)
        assertEquals(Verdict.UNKNOWN, freshProcess.consume(restoredToken, nowMillis = 1L))
        // …and the operation the new process actually started is untouched.
        assertEquals(Verdict.LIVE, freshProcess.consume(freshToken, nowMillis = 1L))
    }

    @Test
    fun `a minted runtime id is not the default one`() {
        // The product path mints its own. Two leases built the ordinary way
        // must not be able to issue the same token either.
        val first = PickerLease().launch(nowMillis = 0L, claim = Claim.DATA)
        val second = PickerLease().launch(nowMillis = 0L, claim = Claim.DATA)
        assertNotEquals(first, second)
    }

    @Test
    fun `a token carries no payload`() {
        // It is written into saved instance state, which is outside this
        // process's memory: hex, a colon and a counter, and nothing else.
        val token = lease().launch(nowMillis = 0L, claim = Claim.PRESENCE)
        assertTrue(token, Regex("^[0-9a-f]{16}:[0-9]+$").matches(token))
    }

    @Test
    fun `sweeping retires the exact expired picker and leaves the others`() {
        val lease = lease()
        val early = lease.launch(nowMillis = 0L, claim = Claim.PRESENCE)
        val later = lease.launch(nowMillis = 60_000L, claim = Claim.DATA)

        val due = lease.sweep(nowMillis = 120_001L)
        assertEquals(listOf(early), due.map { it.token })
        assertEquals(1, lease.outstandingCount())
        // The one still inside its own deadline is untouched and still usable.
        assertEquals(Verdict.LIVE, lease.consume(later, nowMillis = 150_000L))
    }

    @Test
    fun `an expiry names the claim so the host retires the right thing`() {
        val lease = lease()
        lease.launch(nowMillis = 0L, claim = Claim.DATA)
        val due = lease.sweep(nowMillis = 200_000L)
        // A cloud or export round trip claimed nothing to anybody else, so the
        // host withdraws no presence for it. The distinction has to survive the
        // sweep or the host cannot tell them apart.
        assertEquals(listOf(Claim.DATA), due.map { it.claim })
    }

    @Test
    fun `a swept DATA choice is still recognised when it comes back`() {
        val lease = lease()
        val token = lease.launch(nowMillis = 0L, claim = Claim.DATA)
        // The timer fired while the user was still inside the picker. The app's
        // claim to be present is over — but the folder they then chose is still
        // the folder they chose.
        assertEquals(listOf(Claim.DATA), lease.sweep(nowMillis = 200_000L).map { it.claim })
        assertEquals(0, lease.outstandingCount())
        assertNull("a swept DATA token must not hold the app present", lease.nextDeadline())

        // EXPIRED, not UNKNOWN. Removing the token at the sweep made a valid
        // choice come back as "no such operation" and be discarded — the exact
        // opposite of what a DATA claim promises.
        assertEquals(Verdict.EXPIRED, lease.consume(token, nowMillis = 200_001L))
    }

    @Test
    fun `a swept DATA choice is recognised exactly once`() {
        val lease = lease()
        val token = lease.launch(nowMillis = 0L, claim = Claim.DATA)
        lease.sweep(nowMillis = 200_000L)
        assertEquals(Verdict.EXPIRED, lease.consume(token, nowMillis = 200_001L))
        assertEquals(Verdict.UNKNOWN, lease.consume(token, nowMillis = 200_002L))
    }

    @Test
    fun `a swept PRESENCE operation is not recognised again`() {
        val lease = lease()
        val token = lease.launch(nowMillis = 0L, claim = Claim.PRESENCE)
        lease.sweep(nowMillis = 200_000L)
        // Its operation was ENDED — the room left, the advertisement withdrawn
        // — so there is nothing a late result could be about.
        assertEquals(Verdict.UNKNOWN, lease.consume(token, nowMillis = 200_001L))
    }

    @Test
    fun `an account change stops a retained DATA choice being recognised`() {
        val lease = lease()
        val token = lease.launch(nowMillis = 0L, claim = Claim.DATA)
        lease.sweep(nowMillis = 200_000L)
        // A file chosen under one session is not one the next may act on, and
        // that stops being true at the change rather than at a callback that
        // may never arrive.
        lease.invalidateRetained()
        assertEquals(Verdict.UNKNOWN, lease.consume(token, nowMillis = 200_001L))
    }

    @Test
    fun `using a launcher again refuses the launch it replaced`() {
        val lease = lease()
        val first = lease.launch(nowMillis = 0L, claim = Claim.DATA)
        // The same launcher, used again. Whatever the platform does about
        // delivery, a result for the launch being replaced must not be applied
        // to the one starting now.
        lease.retire(first)
        val second = lease.launch(nowMillis = 1_000L, claim = Claim.DATA)

        assertEquals(Verdict.UNKNOWN, lease.consume(first, nowMillis = 2_000L))
        assertEquals(Verdict.LIVE, lease.consume(second, nowMillis = 2_000L))
    }

    @Test
    fun `retiring a swept DATA identity also refuses it`() {
        val lease = lease()
        val token = lease.launch(nowMillis = 0L, claim = Claim.DATA)
        lease.sweep(nowMillis = 200_000L)
        lease.retire(token)
        assertEquals(Verdict.UNKNOWN, lease.consume(token, nowMillis = 200_001L))
    }

    @Test
    fun `retiring everything forgets retained choices too`() {
        val lease = lease()
        val token = lease.launch(nowMillis = 0L, claim = Claim.DATA)
        lease.sweep(nowMillis = 200_000L)
        lease.retireAll()
        assertEquals(Verdict.UNKNOWN, lease.consume(token, nowMillis = 200_001L))
    }

    @Test
    fun `a late callback after a sweep cannot revive its operation`() {
        val lease = lease()
        val token = lease.launch(nowMillis = 0L, claim = Claim.PRESENCE)
        lease.sweep(nowMillis = 200_000L)
        // UNKNOWN rather than EXPIRED: the sweep already said the operation was
        // over and retired it. Either verdict refuses; only one of them is
        // still true a second time.
        assertEquals(Verdict.UNKNOWN, lease.consume(token, nowMillis = 200_001L))
    }

    @Test
    fun `a token is spent by its first result`() {
        val lease = lease()
        val token = lease.launch(nowMillis = 0L, claim = Claim.PRESENCE)
        assertEquals(Verdict.LIVE, lease.consume(token, nowMillis = 1L))
        assertEquals(Verdict.UNKNOWN, lease.consume(token, nowMillis = 2L))
    }

    @Test
    fun `a token this lease never issued is refused`() {
        assertEquals(Verdict.UNKNOWN, lease().consume("aaaaaaaaaaaaaaaa:7", nowMillis = 0L))
    }

    @Test
    fun `overlapping round trips each keep their own deadline`() {
        val lease = lease()
        val first = lease.launch(nowMillis = 0L, claim = Claim.PRESENCE)
        val second = lease.launch(nowMillis = 10_000L, claim = Claim.PRESENCE)
        assertEquals(2, lease.outstandingCount())

        // The first one to return does not end the second's lease.
        assertEquals(Verdict.LIVE, lease.consume(first, nowMillis = 20_000L))
        assertEquals(1, lease.outstandingCount())
        assertEquals(Verdict.LIVE, lease.consume(second, nowMillis = 125_000L))
    }

    @Test
    fun `the deadline is anchored to the original launch and nothing renews it`() {
        val lease = lease()
        val token = lease.launch(nowMillis = 0L, claim = Claim.PRESENCE)
        // A recreation re-runs the composition, which restores the TOKEN and
        // nothing else. There is deliberately no call it could make here that
        // would move the deadline, so the only observable effect of asking
        // again is that the answer has not changed.
        assertEquals(120_000L, lease.nextDeadline())
        assertEquals(120_000L, lease.nextDeadline())
        assertEquals(Verdict.EXPIRED, lease.consume(token, nowMillis = 120_500L))
    }

    @Test
    fun `the next deadline is the soonest one`() {
        val lease = lease()
        lease.launch(nowMillis = 5_000L, claim = Claim.PRESENCE)
        lease.launch(nowMillis = 1_000L, claim = Claim.DATA)
        assertEquals(121_000L, lease.nextDeadline())
    }

    @Test
    fun `nothing outstanding has no deadline to wait for`() {
        val lease = lease()
        assertNull(lease.nextDeadline())
        assertTrue(lease.sweep(nowMillis = Long.MAX_VALUE).isEmpty())
    }

    @Test
    fun `retiring everything does not report a timeout that did not happen`() {
        val lease = lease()
        val token = lease.launch(nowMillis = 0L, claim = Claim.PRESENCE)
        lease.retireAll()
        assertEquals(0, lease.outstandingCount())
        assertEquals(Verdict.UNKNOWN, lease.consume(token, nowMillis = 1L))
    }

    @Test
    fun `the shipped bound is two minutes`() {
        // Stated once, in the product's own constant, and asserted here so a
        // change to it is a deliberate edit to a named value rather than a
        // number drifting inside a call site.
        assertEquals(120_000L, PickerLease.DEFAULT_TIMEOUT_MILLIS)
        assertEquals(120_000L, PickerLease().timeoutMillis)
    }
}
