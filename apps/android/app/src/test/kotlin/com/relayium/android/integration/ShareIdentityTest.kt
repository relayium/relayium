package com.relayium.android.integration

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Staging identity and delivery identity, which are deliberately not the same
 * counter.
 *
 * The case that drives the whole design is the cold-start share: an intent
 * arrives while the account is still restoring, and an epoch that treated
 * "nobody → A" as a change would release the user's share at the exact moment
 * the restore completed — silently, on every launch.
 */
class ShareEpochTest {

    @Test
    fun `a cold restore does not disturb a share staged before it`() {
        val epoch = ShareEpoch()
        // The share is staged while nobody is signed in.
        val staged = epoch.current
        // The restore completes some hundreds of milliseconds later.
        assertEquals(staged, epoch.observe("account-a"))
    }

    @Test
    fun `a refresh of the same account is not a new identity`() {
        val epoch = ShareEpoch()
        val first = epoch.observe("account-a")
        assertEquals(first, epoch.observe("account-a"))
        assertEquals(first, epoch.observe("account-a"))
    }

    @Test
    fun `switching accounts advances the epoch`() {
        val epoch = ShareEpoch()
        val asA = epoch.observe("account-a")
        val asB = epoch.observe("account-b")
        // B may not dispatch a file staged while A was signed in.
        assertTrue(asB > asA)
    }

    @Test
    fun `signing out advances the epoch`() {
        val epoch = ShareEpoch()
        val asA = epoch.observe("account-a")
        assertTrue(epoch.observe(null) > asA)
    }

    @Test
    fun `signing back in after a sign-out does not disturb a share staged meanwhile`() {
        val epoch = ShareEpoch()
        epoch.observe("account-a")
        val out = epoch.observe(null)
        // The sign-out already advanced the epoch, which is what releases
        // anything staged while A was signed in. A share staged AFTER it — in
        // the signed-out window, which is where a share arriving from another
        // app most often lands — is account-independent input, and signing in
        // to send it is the ordinary flow rather than a change of identity.
        // Same shape as the cold restore above, same answer.
        assertEquals(out, epoch.observe("account-a"))
    }

    @Test
    fun `a share staged as one account does not survive that account leaving`() {
        val epoch = ShareEpoch()
        val staged = epoch.observe("account-a")
        // Whatever happens next, the epoch a delivery would run under is no
        // longer the one the share was held under, so `ShareStaging` releases
        // it rather than letting a later session dispatch it.
        assertTrue(epoch.observe(null) > staged)
    }

    @Test
    fun `an anonymous stretch before any sign-in never advances`() {
        val epoch = ShareEpoch()
        val start = epoch.current
        epoch.observe(null)
        epoch.observe(null)
        assertEquals(start, epoch.observe(null))
    }
}

/** What a dispatch is allowed to do once the tap is over. */
class DispatchAuthorityTest {

    private val a = AccountBinding("account-a", generation = 3)

    @Test
    fun `an anonymous destination needs no credential`() {
        val authority = DispatchAuthority(shareId = 1, epoch = 0, account = null)
        // Cross-network and Nearby present no bearer and nobody pays for them,
        // so a fence on the account would have nothing behind it.
        assertTrue(authority.isCurrent(epochNow = 0, accountNow = null))
        assertTrue(authority.isCurrent(epochNow = 0, accountNow = a))
    }

    @Test
    fun `an anonymous dispatch still dies with its staging epoch`() {
        val authority = DispatchAuthority(shareId = 1, epoch = 0, account = null)
        assertFalse(authority.isCurrent(epochNow = 1, accountNow = null))
    }

    @Test
    fun `an account-bound dispatch refuses after a sign-out`() {
        val authority = DispatchAuthority(shareId = 1, epoch = 4, account = a)
        assertFalse(authority.isCurrent(epochNow = 4, accountNow = null))
    }

    @Test
    fun `an account-bound dispatch refuses under a different account`() {
        val authority = DispatchAuthority(shareId = 1, epoch = 4, account = a)
        val b = AccountBinding("account-b", generation = 3)
        assertFalse(authority.isCurrent(epochNow = 4, accountNow = b))
    }

    @Test
    fun `an account-bound dispatch refuses after a re-login as the same account`() {
        val authority = DispatchAuthority(shareId = 1, epoch = 4, account = a)
        // Same id, new session. A late callback from before the sign-out must
        // not complete against the credential that replaced it.
        val relogin = AccountBinding("account-a", generation = 4)
        assertFalse(authority.isCurrent(epochNow = 4, accountNow = relogin))
    }

    @Test
    fun `an account-bound dispatch under the unchanged session proceeds`() {
        val authority = DispatchAuthority(shareId = 1, epoch = 4, account = a, target = "device-1")
        assertTrue(authority.isCurrent(epochNow = 4, accountNow = a))
        assertEquals("device-1", authority.target)
    }

    @Test
    fun `the account id never reaches failure text`() {
        val authority = DispatchAuthority(shareId = 9, epoch = 2, account = a, target = "device-1")
        assertFalse(authority.toString(), authority.toString().contains("account-a"))
        assertTrue(authority.toString(), authority.toString().contains("accountBound=true"))
    }
}
