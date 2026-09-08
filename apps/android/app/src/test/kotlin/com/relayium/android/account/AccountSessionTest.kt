package com.relayium.android.account

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The account state machine, driven through its real entry points.
 *
 * Almost every test here is about a response that lands LATE — after the user
 * has signed out, signed in again, or moved to another screen. That is the whole
 * risk surface of this type: each step is serialised by the owning dispatcher,
 * so the only concurrency is the suspension points, and the only bugs are the
 * writes that happen on the wrong side of one.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AccountSessionTest {

    /**
     * The session, wired to one virtual dispatcher that is BOTH its owner and
     * its IO — which is what a serialising owner plus injected blocking work
     * looks like when the clock is the test's.
     *
     * The scope is the TEST's own, deliberately, and not `backgroundScope`:
     * advancing the scheduler stops when only background work remains, so a
     * harness built on it silently runs nothing at all and every assertion here
     * fails against the initial state rather than against behaviour. Being a
     * child of the test scope also means `runTest` waits for these coroutines,
     * which is the right pressure: every gate a test holds has to be released.
     * (https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-test/kotlinx.coroutines.test/-test-scope/background-scope.html)
     */
    private class Harness(val scope: TestScope, val store: FlakyTokenStore = FlakyTokenStore()) {
        val transport = FakeTransport()
        val owner = StandardTestDispatcher(scope.testScheduler)
        val session = AccountSession(
            scope = scope,
            owner = owner,
            io = owner,
            client = AccountClient(transport),
            tokenStore = store,
            deviceName = "Pixel",
        )

        /** A server that answers a complete, ordinary sign-in. */
        fun signedInServer(token: String = "rlm_cli_a") = apply {
            transport.answer("api/auth/native/login", 200, loginBody(token))
            transport.answer("api/me", 200, meBody())
            transport.answer("api/me/usage", 200, usageBody())
            transport.answer("api/auth/logout", 200, "")
        }
    }

    private fun TestScope.harness(store: FlakyTokenStore = FlakyTokenStore()) = Harness(this, store)

    // ── the ordinary paths ──────────────────────────────────────────────────

    @Test
    fun `a sign-in ends on the account and stores the credential`() = runTest {
        val h = harness().signedInServer("rlm_cli_a")
        h.session.signIn("a@x.invalid", "pw")
        testScheduler.advanceUntilIdle()
        val ready = h.session.state.value as AccountState.Ready
        assertEquals("a@example.invalid", ready.user.email)
        assertTrue(ready.persisted)
        assertEquals("rlm_cli_a", h.store.saved)
    }

    /** Registration issues no credential, so it must touch neither the store
     *  nor the session, and its only success is the check-email screen. */
    @Test
    fun `a registration never produces a session`() = runTest {
        val h = harness()
        h.transport.answer("api/auth/register", 200, """{"status":"verification_sent","email":"a@x.invalid"}""")
        h.session.register("a@x.invalid", "pw", "A")
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.CheckEmail("a@x.invalid"), h.session.state.value)
        assertNull(h.store.saved)
        assertNull(h.session.authority())
    }

    @Test
    fun `an unverified sign-in is its own screen and holds no credential`() = runTest {
        val h = harness()
        h.transport.answer("api/auth/native/login", 403, """{"error":"email_unverified","email":"a@x.invalid"}""")
        h.session.signIn("a@x.invalid", "pw")
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.CheckEmail("a@x.invalid"), h.session.state.value)
        assertNull(h.store.saved)
    }

    /** The reactivation token the server sends beside this answer is never
     *  persisted and never carried into the state. */
    @Test
    fun `a frozen account is a notice, not a session, and keeps no reactivation token`() = runTest {
        val h = harness()
        h.transport.answer(
            "api/auth/native/login", 200,
            """{"status":"pending_deletion","purgeAfter":1900000000,"reactivateToken":"SECRET"}""",
        )
        h.session.signIn("a@x.invalid", "pw")
        testScheduler.advanceUntilIdle()
        val state = h.session.state.value
        assertEquals(AccountState.PendingDeletion(1900000000L), state)
        assertFalse(state.toString().contains("SECRET"))
        assertNull(h.store.saved)
    }

    // ── late answers ────────────────────────────────────────────────────────

    /**
     * The case the whole generation mechanism exists for. A sign-in is in
     * flight, the user signs out, and only then does the server answer. The
     * bearer must not be stored, must not be rendered — and must not simply be
     * dropped either, because it is live on the account.
     */
    @Test
    fun `a sign-in that lands after a sign-out is refused and its bearer revoked`() = runTest {
        val h = harness().signedInServer("rlm_cli_late")
        h.transport.hold("api/auth/native/login")
        h.session.signIn("a@x.invalid", "pw")
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.SigningIn, h.session.state.value)

        h.session.signOut()
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.SignedOut, h.session.state.value)

        h.transport.release("api/auth/native/login")
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.SignedOut, h.session.state.value)
        assertNull("the abandoned bearer must not be stored", h.store.saved)
        assertTrue(
            "the abandoned bearer must be revoked, not dropped",
            h.transport.calls.count { it == "POST api/auth/logout" } >= 1,
        )
    }

    /**
     * A revocation that is still in flight must block everything that depends
     * on the credential. `authority()` answering during it would let a pairing
     * code be minted — and a room joined — on a token being destroyed.
     */
    @Test
    fun `nothing may act on the account while a revocation is in flight`() = runTest {
        val h = harness().signedInServer()
        h.session.signIn("a@x.invalid", "pw")
        testScheduler.advanceUntilIdle()
        assertTrue(h.session.authority() != null)

        h.transport.hold("api/auth/logout")
        h.session.signOut()
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.SigningOut, h.session.state.value)
        assertNull("no authority while the credential is being revoked", h.session.authority())

        // And a refresh cannot supersede it: doing so would drop the logout's
        // answer and leave a live credential nothing is tracking.
        h.session.refresh()
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.SigningOut, h.session.state.value)

        h.transport.release("api/auth/logout")
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.SignedOut, h.session.state.value)
    }

    /**
     * A failed revocation KEEPS the credential. Deleting local state here would
     * leave a working server credential this device could no longer revoke —
     * the opposite of what the user asked for.
     */
    @Test
    fun `a failed sign-out keeps the credential for an explicit retry`() = runTest {
        val h = harness().signedInServer()
        h.transport.fail("api/auth/logout", TransportResult.Failure.NETWORK)
        h.session.signIn("a@x.invalid", "pw")
        testScheduler.advanceUntilIdle()
        h.session.signOut()
        testScheduler.advanceUntilIdle()

        val failed = h.session.state.value as AccountState.SignOutFailed
        assertEquals(AccountFailure.Kind.NETWORK, failed.failure.kind)
        assertEquals("the credential must still be here", "rlm_cli_a", h.store.saved)
        assertEquals("nothing may have been cleared", 0, h.store.clears)

        // The retry, once the network is back.
        h.transport.answer("api/auth/logout", 200, "")
        h.session.retrySignOut()
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.SignedOut, h.session.state.value)
        assertNull(h.store.saved)
    }

    /**
     * The revocation SUCCEEDED, so what is left on disk is inert — but "inert"
     * is a claim the user is entitled to have checked rather than assumed, and
     * the same disk failure will bite the next sign-in.
     */
    @Test
    fun `a sign-out that could not clear the store says so`() = runTest {
        val store = FlakyTokenStore()
        val h = harness(store).signedInServer()
        h.session.signIn("a@x.invalid", "pw")
        testScheduler.advanceUntilIdle()
        store.failClear = true
        h.session.signOut()
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.SignedOut, h.session.state.value)
        assertTrue("the failed removal must be reported", h.session.signOutNote.value)
    }

    /**
     * The credential is live in this process; what is false is that it will
     * survive a restart. That fact belongs to the CREDENTIAL, so it must
     * survive a failed load and a later successful retry — deriving it from
     * whatever the last `Ready` said reports a durable sign-in that was never
     * written.
     */
    @Test
    fun `a sign-in whose store write failed stays not-persisted across a retry`() = runTest {
        val store = FlakyTokenStore(failSave = true)
        val h = harness(store)
        h.transport.answer("api/auth/native/login", 200, loginBody())
        h.transport.fail("api/me", TransportResult.Failure.NETWORK)
        h.transport.answer("api/me/usage", 200, usageBody())

        h.session.signIn("a@x.invalid", "pw")
        testScheduler.advanceUntilIdle()
        assertTrue(h.session.state.value is AccountState.Unavailable)

        h.transport.answer("api/me", 200, meBody())
        h.session.refresh()
        testScheduler.advanceUntilIdle()
        val ready = h.session.state.value as AccountState.Ready
        assertFalse("the credential was never written", ready.persisted)
        assertNull(store.saved)
    }

    /**
     * The one and only signal that a stored token has gone bad. It is dropped
     * without a revoke request — the server has already refused it, so the
     * request could only earn another 401.
     */
    @Test
    fun `a 401 while loading the account signs out and drops the credential`() = runTest {
        val h = harness(FlakyTokenStore("rlm_cli_stale"))
        h.transport.answer("api/me", 401, "")
        h.session.restore()
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.SignedOut, h.session.state.value)
        assertNull(h.store.saved)
        assertEquals(0, h.transport.calls.count { it == "POST api/auth/logout" })
    }

    /** A server that is merely down keeps the credential and offers a retry;
     *  a sign-in form cannot fix it. */
    @Test
    fun `an unreachable server while restoring is a retry, not a sign-out`() = runTest {
        val h = harness(FlakyTokenStore("rlm_cli_stored"))
        h.transport.fail("api/me", TransportResult.Failure.TIMEOUT)
        h.session.restore()
        testScheduler.advanceUntilIdle()
        val state = h.session.state.value as AccountState.Unavailable
        assertEquals(AccountFailure.Kind.TIMEOUT, state.failure.kind)
        assertEquals("rlm_cli_stored", h.store.saved)
    }

    /** A refresh that fails while an account is on screen keeps the last known
     *  good and says it is not fresh, rather than blanking the screen. */
    @Test
    fun `a failed refresh keeps the account and marks it stale`() = runTest {
        val h = harness().signedInServer()
        h.session.signIn("a@x.invalid", "pw")
        testScheduler.advanceUntilIdle()
        h.transport.fail("api/me", TransportResult.Failure.NETWORK)
        h.session.refresh()
        testScheduler.advanceUntilIdle()
        assertTrue(h.session.state.value is AccountState.Ready)
        assertTrue(h.session.stale.value)
    }

    // ── the store ───────────────────────────────────────────────────────────

    /**
     * Something IS stored and this build cannot open it. Reporting "no account"
     * would hide a real failure AND let the next sign-in write over it.
     */
    @Test
    fun `a credential this device cannot read is not reported as absence`() = runTest {
        val store = FlakyTokenStore("rlm_cli_x", failLoad = true)
        val h = harness(store)
        h.session.restore()
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.CredentialUnreadable, h.session.state.value)

        // The only way out is explicit, and a removal that fails leaves the
        // screen — pretending otherwise puts the user back here next launch
        // with no explanation.
        store.failClear = true
        h.session.discardUnreadableCredential()
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.CredentialUnreadable, h.session.state.value)

        store.failClear = false
        h.session.discardUnreadableCredential()
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.SignedOut, h.session.state.value)
    }

    /** A stored value that cannot go in a header is the same fact as one that
     *  cannot be decrypted: something is here, and it is not usable. */
    @Test
    fun `a stored credential that cannot be sent is not adopted`() = runTest {
        val h = harness(FlakyTokenStore("bad\nheader"))
        h.session.restore()
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.CredentialUnreadable, h.session.state.value)
        assertTrue("nothing may have been sent with it", h.transport.calls.isEmpty())
    }

    /**
     * A sign-out in flight cannot be overtaken by a new sign-in.
     *
     * This is the FRONT DOOR of the two defenses against a sign-out deleting
     * somebody else's credential. If a second sign-in could start here, its
     * bearer would be written and the still-running sign-out would then clear
     * the store on top of it — leaving the user apparently signed in with
     * nothing stored, and a live credential on the account either way. So the
     * revocation finishes first, and the second attempt is simply not admitted.
     *
     * The second defense is inside [AccountSession]'s store lock, where the
     * generation is re-checked before any mutation runs; a check made only after
     * the fact cannot help, because by then the file is already gone. It is kept
     * deliberately even though this guard makes it unreachable today: the two
     * answer to different mistakes, and only one of them is a state machine
     * anyone can add a new entry point to.
     */
    @Test
    fun `a sign-out in flight cannot be overtaken by a new sign-in`() = runTest {
        val h = harness().signedInServer("rlm_cli_first")
        h.session.signIn("a@x.invalid", "pw")
        testScheduler.advanceUntilIdle()

        h.transport.hold("api/auth/logout")
        h.session.signOut()
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.SigningOut, h.session.state.value)

        // The user gives up waiting and tries to sign in as somebody else.
        h.transport.answer("api/auth/native/login", 200, loginBody("rlm_cli_second"))
        h.session.signIn("b@x.invalid", "pw")
        testScheduler.advanceUntilIdle()
        assertEquals("the revocation still owns the account", AccountState.SigningOut, h.session.state.value)
        assertEquals("no second credential may have been minted", "rlm_cli_first", h.store.saved)

        h.transport.release("api/auth/logout")
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.SignedOut, h.session.state.value)
        assertNull("the credential the sign-out owned is the one that went", h.store.saved)
    }

    // ── devices ─────────────────────────────────────────────────────────────

    /**
     * The list must actually arrive. Claiming the ACCOUNT generation for a
     * screen-local request invalidated the authority the same call had just
     * captured, and every answer then failed its own currency check — the list
     * never left `Loading`.
     */
    @Test
    fun `the device list loads and revoking this device signs out`() = runTest {
        val id = "a".repeat(32)
        val h = harness().signedInServer()
        h.transport.answer("api/devices", 200, devicesBody(deviceRow(id, "Pixel", current = true)))
        h.transport.answer("api/devices/$id", 200, "")
        h.session.signIn("a@x.invalid", "pw")
        testScheduler.advanceUntilIdle()

        h.session.loadDevices()
        testScheduler.advanceUntilIdle()
        val loaded = h.session.devices.value as DevicesState.Loaded
        assertEquals(1, loaded.devices.size)

        // Revoking the row this bearer is bound to cascades the token
        // server-side, so the local state follows — and without another logout
        // request, which could only present the token the server just destroyed.
        val logoutsBefore = h.transport.calls.count { it == "POST api/auth/logout" }
        h.session.revokeDevice(id)
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.SignedOut, h.session.state.value)
        assertNull(h.store.saved)
        assertEquals(logoutsBefore, h.transport.calls.count { it == "POST api/auth/logout" })
    }

    /** A screen-local request must not supersede the account: a resend that
     *  aborted an in-flight sign-in would be a fence pointed the wrong way. */
    @Test
    fun `a resend does not supersede an account operation`() = runTest {
        val h = harness()
        h.transport.answer("api/auth/native/login", 403, """{"error":"email_unverified","email":"a@x.invalid"}""")
        h.transport.answer("api/auth/email/resend", 200, """{"status":"sent"}""")
        h.session.signIn("a@x.invalid", "pw")
        testScheduler.advanceUntilIdle()

        h.session.resendVerification()
        testScheduler.advanceUntilIdle()
        assertEquals(RequestState.Requested, h.session.resend.value)
        assertEquals(
            "the screen the resend was about must still be here",
            AccountState.CheckEmail("a@x.invalid"),
            h.session.state.value,
        )
    }

    /** Every session-moving operation clears the screen-local notices: a "sent"
     *  line surviving into the next screen is a claim about an email nobody
     *  there asked for. */
    @Test
    fun `notices do not outlive the screen they were about`() = runTest {
        val h = harness()
        h.transport.answer("api/auth/native/login", 403, """{"error":"email_unverified","email":"a@x.invalid"}""")
        h.transport.answer("api/auth/email/resend", 200, "")
        h.session.signIn("a@x.invalid", "pw")
        testScheduler.advanceUntilIdle()
        h.session.resendVerification()
        testScheduler.advanceUntilIdle()
        assertEquals(RequestState.Requested, h.session.resend.value)

        h.session.backToSignIn()
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.SignedOut, h.session.state.value)
        assertEquals(RequestState.Idle, h.session.resend.value)
    }

    /** Reopening the surface must not tear down a screen that owns something
     *  the keystore cannot reproduce. */
    @Test
    fun `restore leaves screens that hold something a cold start would lose`() = runTest {
        val h = harness()
        h.transport.answer("api/auth/native/login", 403, """{"error":"email_unverified","email":"a@x.invalid"}""")
        h.session.signIn("a@x.invalid", "pw")
        testScheduler.advanceUntilIdle()
        h.session.restore()
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.CheckEmail("a@x.invalid"), h.session.state.value)
    }
}
