package com.relayium.android.account

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The two models that produce something on the account's behalf: a bearer from
 * a browser approval, and a pairing code from a mint.
 *
 * Both spend most of their life WAITING — for a human at a browser, or for a
 * server round trip — so what is asserted here is almost entirely about what
 * happens when the answer lands after the world has moved.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AccessModelsTest {

    private class Harness(
        val scope: TestScope,
        val store: FlakyTokenStore = FlakyTokenStore(),
    ) {
        val transport = FakeTransport()
        val owner = StandardTestDispatcher(scope.testScheduler)
        val client = AccountClient(transport)
        var now = 1_000L
        val session = AccountSession(
            scope = scope, owner = owner, io = owner,
            client = client, tokenStore = store, deviceName = "Pixel",
        )
        val browser = BrowserLoginModel(
            scope = scope, owner = owner, client = client, session = session,
            deviceName = "Pixel", trustedOrigin = ORIGIN, now = { now },
            // Virtual time, so a five-second poll interval costs nothing.
            sleep = { millis -> delay(millis) },
        )
        val create = CreateLinkModel(
            scope = scope, owner = owner, client = client, session = session,
            origin = ORIGIN, now = { now },
        )

        fun signedInServer() = apply {
            transport.answer("api/auth/native/login", 200, loginBody())
            transport.answer("api/me", 200, meBody())
            transport.answer("api/me/usage", 200, usageBody())
            transport.answer("api/auth/logout", 200, "")
        }

        fun startBody(interval: Int = 5, expires: Int = 600) =
            """{"user_code":"WDJB-MJHT","device_code":"dc","verification_uri":"$ORIGIN/device",""" +
                """"interval":$interval,"expires_in":$expires}"""
    }

    private companion object {
        const val ORIGIN = "https://relayium.com"
    }

    private fun TestScope.harness() = Harness(this)

    // ── browser approval ────────────────────────────────────────────────────

    @Test
    fun `an approval signs the account in`() = runTest {
        val h = harness().signedInServer()
        h.transport.answer("api/cli/device/start", 200, h.startBody())
        h.transport.answer("api/cli/device/poll", 200, """{"status":"ok","access_token":"rlm_cli_b"}""")
        h.browser.begin()
        testScheduler.advanceUntilIdle()
        assertTrue(h.session.state.value is AccountState.Ready)
        assertEquals("rlm_cli_b", h.store.saved)
    }

    @Test
    fun `pending polls at the interval the server asked for, not faster`() = runTest {
        val h = harness().signedInServer()
        h.transport.answer("api/cli/device/start", 200, h.startBody(interval = 7))
        h.transport.answer("api/cli/device/poll", 200, """{"status":"authorization_pending"}""")
        h.browser.begin()
        testScheduler.advanceTimeBy(1)
        testScheduler.runCurrent()
        val afterFirst = h.transport.calls.count { it == "POST api/cli/device/poll" }
        assertEquals(1, afterFirst)
        // Six seconds later there must STILL be only one: polling sooner than
        // the server's floor earns a 429 that reads as a failed login.
        testScheduler.advanceTimeBy(6_000)
        assertEquals(1, h.transport.calls.count { it == "POST api/cli/device/poll" })
        testScheduler.advanceTimeBy(1_500)
        assertEquals(2, h.transport.calls.count { it == "POST api/cli/device/poll" })
        h.browser.cancel()
        testScheduler.advanceUntilIdle()
    }

    @Test
    fun `a refusal and an expiry each keep their own meaning`() = runTest {
        for ((body, expected) in listOf(
            """{"status":"denied"}""" to AccountFailure.Kind.DEVICE_DENIED,
            """{"status":"expired"}""" to AccountFailure.Kind.DEVICE_EXPIRED,
        )) {
            val h = harness().signedInServer()
            h.transport.answer("api/cli/device/start", 200, h.startBody())
            h.transport.answer("api/cli/device/poll", 200, body)
            h.browser.begin()
            testScheduler.advanceUntilIdle()
            val failed = h.browser.state.value as BrowserLoginModel.State.Failed
            assertEquals(body, expected, failed.failure.kind)
            // A refused approval produces no credential at all. (The session is
            // still `Restoring` here: nothing in this test restored it, and a
            // failed approval is not a thing that moves it.)
            assertFalse(h.session.state.value is AccountState.Ready)
            assertNull(h.store.saved)
        }
    }

    /** The run outlives its own deadline without the server ever saying so.
     *  Reported as expired rather than left spinning. */
    @Test
    fun `a request that runs out of time ends as expired`() = runTest {
        val h = harness().signedInServer()
        h.transport.answer("api/cli/device/start", 200, h.startBody(interval = 5, expires = 10))
        h.transport.answer("api/cli/device/poll", 200, """{"status":"authorization_pending"}""")
        h.browser.begin()
        testScheduler.advanceTimeBy(1)
        testScheduler.runCurrent()
        // The model reads a clock the test owns, so this is the deadline passing
        // rather than a wait.
        h.now += 11
        testScheduler.advanceUntilIdle()
        val failed = h.browser.state.value as BrowserLoginModel.State.Failed
        assertEquals(AccountFailure.Kind.DEVICE_EXPIRED, failed.failure.kind)
    }

    /** A failed run leaves a retry available rather than a dead screen. */
    @Test
    fun `a failed approval can simply be started again`() = runTest {
        val h = harness().signedInServer()
        h.transport.fail("api/cli/device/start", TransportResult.Failure.NETWORK)
        h.browser.begin()
        testScheduler.advanceUntilIdle()
        assertTrue(h.browser.state.value is BrowserLoginModel.State.Failed)

        h.transport.answer("api/cli/device/start", 200, h.startBody())
        h.transport.answer("api/cli/device/poll", 200, """{"status":"ok","access_token":"rlm_cli_b"}""")
        h.browser.begin()
        testScheduler.advanceUntilIdle()
        assertTrue(h.session.state.value is AccountState.Ready)
    }

    /** The page that authorises a credential must be ours. A response naming
     *  anywhere else is refused before anything is shown or opened. */
    @Test
    fun `an untrusted verification page stops the flow before it starts`() = runTest {
        val h = harness()
        h.transport.answer(
            "api/cli/device/start", 200,
            """{"user_code":"A-B","device_code":"dc","verification_uri":"https://evil.example/device",""" +
                """"interval":5,"expires_in":600}""",
        )
        h.browser.begin()
        testScheduler.advanceUntilIdle()
        val failed = h.browser.state.value as BrowserLoginModel.State.Failed
        assertEquals(AccountFailure.Kind.UNTRUSTED_VERIFICATION_URL, failed.failure.kind)
        assertEquals("nothing may have been polled", 0, h.transport.calls.count { it.endsWith("poll") })
    }

    /**
     * The sequence that used to sign a user back in after they had left.
     *
     * Start a browser approval, sign in with a password instead, sign out — and
     * only THEN let the approval complete. The bearer is live, so it is revoked
     * rather than dropped, and it must not become the session.
     */
    @Test
    fun `an abandoned approval cannot undo a later sign-out, and its bearer is revoked`() = runTest {
        val h = harness().signedInServer()
        h.transport.answer("api/cli/device/start", 200, h.startBody())
        h.transport.answer("api/cli/device/poll", 200, """{"status":"ok","access_token":"rlm_cli_late"}""")
        h.transport.hold("api/cli/device/poll")
        h.browser.begin()
        testScheduler.advanceUntilIdle()
        assertTrue(h.browser.state.value is BrowserLoginModel.State.Waiting)

        h.session.signIn("a@x.invalid", "pw")
        testScheduler.advanceUntilIdle()
        assertTrue(h.session.state.value is AccountState.Ready)

        h.session.signOut()
        testScheduler.advanceUntilIdle()
        assertEquals(AccountState.SignedOut, h.session.state.value)

        val logoutsBefore = h.transport.calls.count { it == "POST api/auth/logout" }
        h.transport.release("api/cli/device/poll")
        testScheduler.advanceUntilIdle()

        assertEquals(
            "the abandoned approval must not become the session",
            AccountState.SignedOut,
            h.session.state.value,
        )
        assertNull(h.store.saved)
        assertEquals(
            "the abandoned bearer must be revoked exactly once",
            logoutsBefore + 1,
            h.transport.calls.count { it == "POST api/auth/logout" },
        )
    }

    // ── minting ─────────────────────────────────────────────────────────────

    private fun alwaysJoin(): Pair<(MintedCode) -> Boolean, MutableList<String>> {
        val joined = mutableListOf<String>()
        return ({ code: MintedCode -> joined.add(code.code); true }) to joined
    }

    @Test
    fun `a mint shows the code and the official link for the same room`() = runTest {
        val h = harness().signedInServer()
        h.transport.answer("api/pair", 200, """{"code":"004291","expiresAt":2000}""")
        h.session.signIn("a@x.invalid", "pw")
        testScheduler.advanceUntilIdle()

        val (commit, joined) = alwaysJoin()
        h.create.create(commit)
        testScheduler.advanceUntilIdle()

        val showing = h.create.state.value as CreateLinkModel.State.Showing
        assertEquals("004291", showing.code)
        assertEquals("https://relayium.com/cross-network#c=004291", showing.link)
        assertEquals(listOf("004291"), joined)
    }

    @Test
    fun `a mint without an account never reaches the server`() = runTest {
        val h = harness()
        val (commit, joined) = alwaysJoin()
        h.create.create(commit)
        testScheduler.advanceUntilIdle()
        val failed = h.create.state.value as CreateLinkModel.State.Failed
        assertEquals(AccountFailure.Kind.NOT_SIGNED_IN, failed.failure.kind)
        assertTrue(joined.isEmpty())
        assertTrue(h.transport.calls.none { it == "POST api/pair" })
    }

    /**
     * A code minted for one account must never create or join a room under
     * another — nor under none at all.
     */
    @Test
    fun `a mint that lands after a sign-out joins nothing`() = runTest {
        val h = harness().signedInServer()
        h.transport.answer("api/pair", 200, """{"code":"004291","expiresAt":2000}""")
        h.session.signIn("a@x.invalid", "pw")
        testScheduler.advanceUntilIdle()

        h.transport.hold("api/pair")
        val (commit, joined) = alwaysJoin()
        h.create.create(commit)
        testScheduler.advanceUntilIdle()

        h.session.signOut()
        testScheduler.advanceUntilIdle()

        h.transport.release("api/pair")
        testScheduler.advanceUntilIdle()

        assertEquals(CreateLinkModel.State.Superseded, h.create.state.value)
        assertTrue("no room may have been joined", joined.isEmpty())
    }

    /** The expiry is checked at the COMMIT, not only at the parse: a code that
     *  died while the request was in flight must not be joined. */
    @Test
    fun `a code that expired while it was in flight is not joined`() = runTest {
        val h = harness().signedInServer()
        h.transport.answer("api/pair", 200, """{"code":"004291","expiresAt":1500}""")
        h.session.signIn("a@x.invalid", "pw")
        testScheduler.advanceUntilIdle()

        h.transport.hold("api/pair")
        val (commit, joined) = alwaysJoin()
        h.create.create(commit)
        testScheduler.advanceUntilIdle()
        h.now = 1_600
        h.transport.release("api/pair")
        testScheduler.advanceUntilIdle()

        assertEquals(CreateLinkModel.State.Superseded, h.create.state.value)
        assertTrue(joined.isEmpty())
    }

    /** The transfer side's own veto: a device that is already in a session must
     *  not have it torn down by a late mint. */
    @Test
    fun `a commit that refuses leaves the code unshown`() = runTest {
        val h = harness().signedInServer()
        h.transport.answer("api/pair", 200, """{"code":"004291","expiresAt":2000}""")
        h.session.signIn("a@x.invalid", "pw")
        testScheduler.advanceUntilIdle()

        h.create.create { false }
        testScheduler.advanceUntilIdle()
        assertEquals(CreateLinkModel.State.Superseded, h.create.state.value)
    }

    @Test
    fun `a cancelled mint's answer is never written`() = runTest {
        val h = harness().signedInServer()
        h.transport.answer("api/pair", 200, """{"code":"004291","expiresAt":2000}""")
        h.session.signIn("a@x.invalid", "pw")
        testScheduler.advanceUntilIdle()

        h.transport.hold("api/pair")
        val (commit, joined) = alwaysJoin()
        h.create.create(commit)
        testScheduler.advanceUntilIdle()
        h.create.cancel()
        testScheduler.advanceUntilIdle()
        h.transport.release("api/pair")
        testScheduler.advanceUntilIdle()

        assertEquals(CreateLinkModel.State.Idle, h.create.state.value)
        assertTrue(joined.isEmpty())
    }

    // ── expiry ──────────────────────────────────────────────────────────────

    /** The server refuses the code FROM `expiresAt` onward, so usability and a
     *  countdown of nothing arrive in the same instant. */
    @Test
    fun `usability ends exactly when the server says it does`() {
        val before = PairCodeExpiry.presentation(expiresAt = 1_000, now = 999)
        assertTrue(before.usable)
        assertEquals(1L, before.remainingSeconds)
        assertEquals("0:01", before.countdown)

        val at = PairCodeExpiry.presentation(expiresAt = 1_000, now = 1_000)
        assertFalse(at.usable)
        assertNull("no countdown to a moment that has passed", at.countdown)

        assertFalse(PairCodeExpiry.presentation(expiresAt = 1_000, now = 1_001).usable)
    }

    /** A mint that answered no deadline is usable and uncounted: refusing a
     *  code over a missing field would break a working transfer, and the server
     *  still refuses it at the real moment. */
    @Test
    fun `a code with no deadline is offered without a countdown`() {
        val p = PairCodeExpiry.presentation(expiresAt = 0, now = 5_000)
        assertTrue(p.usable)
        assertNull(p.countdown)
    }

    @Test
    fun `the countdown reads like a clock`() {
        assertEquals("4:32", PairCodeExpiry.presentation(1_000 + 272, 1_000).countdown)
        assertEquals("1:00:00", PairCodeExpiry.presentation(1_000 + 3_600, 1_000).countdown)
    }

    // ── the access draft ────────────────────────────────────────────────────

    /**
     * The form is removed from the composition while a sign-in is in flight, so
     * anything it remembered is gone by the time the rejection puts a new one
     * back. The observed effect was an error beside two empty fields, with a
     * rejected REGISTRATION coming back as a sign-in form.
     */
    @Test
    fun `the access draft survives the submit it is removed by`() {
        val draft = AccountAccessDraft()
        draft.setCreating(true)
        draft.setEmail("a@x.invalid")
        draft.setDisplayName("A")
        // Whatever the session does in between, this object is not part of it.
        assertEquals(
            AccountAccessDraft.Value("a@x.invalid", "A", creating = true),
            draft.value.value,
        )
        draft.clear()
        assertEquals(AccountAccessDraft.Value(), draft.value.value)
    }
}
