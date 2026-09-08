package com.relayium.android.integration

import com.relayium.android.inbox.InboxAccountId
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * One runtime across account changes, adopted once per credential generation,
 * live for exactly as long as the whole app is in front of the user.
 *
 * The recording double stands in for `InboxRuntime` on purpose: the composed
 * runtime has its own suite against real stores, and what is under test here is
 * the host's rule about WHEN to call it.
 */
class InboxHostTest {

    /**
     * Every call the host makes, in order, with nothing invented.
     *
     * [hold] parks an adoption at the await the real runtime suspends on — it
     * cancels and JOINS the previous account's work there — so a newer
     * credential can be delivered while an older adoption is in flight. That is
     * the window an obsolete session gets installed in.
     */
    private class Receiving(private val hold: CompletableDeferred<Unit>? = null) : InboxReceiving {
        val calls = ArrayList<String>()
        val adopted = ArrayList<Pair<InboxAccountId?, String?>>()
        val entered = ArrayList<String>()

        override suspend fun adopt(account: InboxAccountId?, bearer: String?) {
            val name = account?.value ?: "none"
            entered += name
            // Parked BEFORE anything is recorded: an adoption cancelled here
            // has not installed or published, which is the property under test.
            hold?.await()
            adopted += account to bearer
            calls += "adopt($name)"
        }

        override fun start(): Job? {
            calls += "start"
            return null
        }

        override fun stop(): Job? {
            calls += "stop"
            return null
        }
    }

    private val alice = "0000111122223333444455556666aaaa"
    private val bob = "9999888877776666555544443333bbbb"

    private fun credential(account: String, generation: Int, bearer: String = "t$generation") =
        Credential(accountId = account, generation = generation, bearer = bearer)

    @Test
    fun `signing in adopts the account once`() = runTest {
        val receiving = Receiving()
        val credentials = MutableSharedFlow<Credential?>(extraBufferCapacity = 16)
        val job = InboxHost(receiving).run(this, credentials)
        // The collector must be SUBSCRIBED before the first emission: a shared
        // flow with no subscriber drops what it is given, which would make this
        // test pass or fail on dispatcher scheduling rather than on the rule.
        advanceUntilIdle()

        credentials.emit(null)
        credentials.emit(credential(alice, 1))
        advanceUntilIdle()

        assertEquals(listOf("adopt(none)", "adopt($alice)"), receiving.calls)
        job.cancel()
    }

    @Test
    fun `an unchanged credential is not adopted again`() = runTest {
        val receiving = Receiving()
        val credentials = MutableSharedFlow<Credential?>(extraBufferCapacity = 16)
        val job = InboxHost(receiving).run(this, credentials)
        // The collector must be SUBSCRIBED before the first emission: a shared
        // flow with no subscriber drops what it is given, which would make this
        // test pass or fail on dispatcher scheduling rather than on the rule.
        advanceUntilIdle()

        credentials.emit(credential(alice, 1))
        // The account state flow re-emits for reasons that are not identity —
        // a usage refresh, a device list. Re-adopting on each would cancel and
        // rebuild the whole per-account bundle for a number changing.
        credentials.emit(credential(alice, 1))
        credentials.emit(credential(alice, 1))
        advanceUntilIdle()

        assertEquals(listOf("adopt($alice)"), receiving.calls)
        job.cancel()
    }

    @Test
    fun `a re-login as the same account is a new adoption`() = runTest {
        val receiving = Receiving()
        val credentials = MutableSharedFlow<Credential?>(extraBufferCapacity = 16)
        val job = InboxHost(receiving).run(this, credentials)
        // The collector must be SUBSCRIBED before the first emission: a shared
        // flow with no subscriber drops what it is given, which would make this
        // test pass or fail on dispatcher scheduling rather than on the rule.
        advanceUntilIdle()

        credentials.emit(credential(alice, 1, bearer = "first"))
        credentials.emit(null)
        credentials.emit(credential(alice, 2, bearer = "second"))
        advanceUntilIdle()

        // Three adoptions, not two: the same account id is not the same
        // session, and the runtime must cancel and JOIN the first session's
        // work before the second one exists.
        assertEquals(listOf("adopt($alice)", "adopt(none)", "adopt($alice)"), receiving.calls)
        assertEquals("first", receiving.adopted[0].second)
        assertNull(receiving.adopted[1].second)
        assertEquals("second", receiving.adopted[2].second)
        job.cancel()
    }

    @Test
    fun `a replaced bearer under one generation is still a new adoption`() = runTest {
        val receiving = Receiving()
        val credentials = MutableSharedFlow<Credential?>(extraBufferCapacity = 16)
        val job = InboxHost(receiving).run(this, credentials)
        // The collector must be SUBSCRIBED before the first emission: a shared
        // flow with no subscriber drops what it is given, which would make this
        // test pass or fail on dispatcher scheduling rather than on the rule.
        advanceUntilIdle()

        credentials.emit(credential(alice, 1, bearer = "first"))
        // A browser approval adopted mid-session replaces the token without
        // the account changing. The old bundle is authenticated as the old
        // token and must not survive it.
        credentials.emit(credential(alice, 1, bearer = "adopted"))
        advanceUntilIdle()

        assertEquals(2, receiving.adopted.size)
        assertEquals("adopted", receiving.adopted[1].second)
        job.cancel()
    }

    @Test
    fun `switching accounts adopts the new one`() = runTest {
        val receiving = Receiving()
        val credentials = MutableSharedFlow<Credential?>(extraBufferCapacity = 16)
        val job = InboxHost(receiving).run(this, credentials)
        // The collector must be SUBSCRIBED before the first emission: a shared
        // flow with no subscriber drops what it is given, which would make this
        // test pass or fail on dispatcher scheduling rather than on the rule.
        advanceUntilIdle()

        credentials.emit(credential(alice, 1))
        credentials.emit(credential(bob, 2))
        advanceUntilIdle()

        assertEquals(listOf("adopt($alice)", "adopt($bob)"), receiving.calls)
        job.cancel()
    }

    @Test
    fun `the newest credential is the one that ends up adopted`() = runTest {
        val receiving = Receiving()
        val credentials = MutableSharedFlow<Credential?>(extraBufferCapacity = 16)
        val job = InboxHost(receiving).run(this, credentials)
        advanceUntilIdle()

        credentials.emit(credential(alice, 1))
        credentials.emit(credential(bob, 2))
        credentials.emit(null)
        credentials.emit(credential(alice, 3))
        advanceUntilIdle()

        // Whatever intermediate adoptions were superseded before they could
        // publish, the session that is installed at the end is the newest one.
        assertEquals(alice, receiving.adopted.last().first?.value)
        assertEquals("t3", receiving.adopted.last().second)
        job.cancel()
    }

    @Test
    fun `a superseded adoption never publishes its obsolete session`() = runTest {
        // The exact failure an independent probe reproduced: A's adoption is
        // held at its await, B signs in, and A is released. A sequential
        // collector applies A anyway — installing and starting a session the
        // user had already left, then applying B on top of it.
        val gate = CompletableDeferred<Unit>()
        val receiving = Receiving(hold = gate)
        val credentials = MutableSharedFlow<Credential?>(extraBufferCapacity = 16)
        val job = InboxHost(receiving).run(this, credentials)
        advanceUntilIdle()

        credentials.emit(credential(alice, 1))
        advanceUntilIdle()
        // A is inside its adoption, suspended where the runtime cancels and
        // joins the previous account's work.
        assertEquals(listOf(alice), receiving.entered)
        assertTrue(receiving.adopted.isEmpty())

        credentials.emit(credential(bob, 2))
        advanceUntilIdle()
        gate.complete(Unit)
        advanceUntilIdle()

        // A was cancelled by B and published nothing. B is the only session
        // installed — and B's own adoption is what cancels and joins whatever
        // A's abandoned one would have.
        assertEquals(listOf("adopt($bob)"), receiving.calls)
        job.cancel()
    }

    @Test
    fun `a sign-out cancels an adoption in flight`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val receiving = Receiving(hold = gate)
        val credentials = MutableSharedFlow<Credential?>(extraBufferCapacity = 16)
        val job = InboxHost(receiving).run(this, credentials)
        advanceUntilIdle()

        credentials.emit(credential(alice, 1))
        advanceUntilIdle()
        credentials.emit(null)
        advanceUntilIdle()
        gate.complete(Unit)
        advanceUntilIdle()

        // Signing out while A was still adopting must not end with A adopted.
        assertEquals(listOf("adopt(none)"), receiving.calls)
        job.cancel()
    }

    @Test
    fun `a re-login supersedes an adoption in flight for the same account`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val receiving = Receiving(hold = gate)
        val credentials = MutableSharedFlow<Credential?>(extraBufferCapacity = 16)
        val job = InboxHost(receiving).run(this, credentials)
        advanceUntilIdle()

        credentials.emit(credential(alice, 1, bearer = "first"))
        advanceUntilIdle()
        credentials.emit(credential(alice, 2, bearer = "second"))
        advanceUntilIdle()
        gate.complete(Unit)
        advanceUntilIdle()

        // Same account id, new session. The obsolete bearer must not be the one
        // the runtime ends up authenticated with.
        assertEquals(1, receiving.adopted.size)
        assertEquals("second", receiving.adopted.single().second)
        job.cancel()
    }

    @Test
    fun `a re-emission carrying no identity change does not disturb an adoption`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val receiving = Receiving(hold = gate)
        val credentials = MutableSharedFlow<Credential?>(extraBufferCapacity = 16)
        val job = InboxHost(receiving).run(this, credentials)
        advanceUntilIdle()

        credentials.emit(credential(alice, 1))
        advanceUntilIdle()
        // A usage refresh or a device-list update re-emits the account state
        // with the SAME identity. Reaching the cancellation point with it would
        // cancel a legitimate adoption and then decide there was nothing to do,
        // leaving no session adopted at all.
        credentials.emit(credential(alice, 1))
        credentials.emit(credential(alice, 1))
        advanceUntilIdle()
        gate.complete(Unit)
        advanceUntilIdle()

        assertEquals(listOf("adopt($alice)"), receiving.calls)
        job.cancel()
    }

    @Test
    fun `an account id this build cannot use as a store identity adopts nothing`() = runTest {
        val receiving = Receiving()
        val refused = ArrayList<Credential>()
        val credentials = MutableSharedFlow<Credential?>(extraBufferCapacity = 16)
        val job = InboxHost(receiving, onUnusableAccount = { refused += it }).run(this, credentials)
        // The collector must be SUBSCRIBED before the first emission: a shared
        // flow with no subscriber drops what it is given, which would make this
        // test pass or fail on dispatcher scheduling rather than on the rule.
        advanceUntilIdle()

        // A slash would name a path outside the store's own directory. The app
        // reports signed out rather than crashing, and the condition is
        // surfaced rather than looking like a sign-out the user performed.
        credentials.emit(credential("../../etc", 1))
        advanceUntilIdle()

        assertEquals(listOf("adopt(none)"), receiving.calls)
        assertEquals(1, refused.size)
        job.cancel()
    }

    @Test
    fun `foreground is app-wide, not tab-owned`() {
        val receiving = Receiving()
        val host = InboxHost(receiving)

        host.foreground(true)
        host.foreground(false)
        host.foreground(true)

        // Nothing about a destination reaches this class: the only input is
        // whether the app itself is in front of the user.
        assertEquals(listOf("start", "stop", "start"), receiving.calls)
    }

    @Test
    fun `a credential never prints its bearer`() {
        val text = credential(alice, 1, bearer = "super-secret-token").toString()
        assertFalse(text, text.contains("super-secret-token"))
        assertTrue(text, text.contains(alice))
    }
}

/** The adoption rule on its own, with no scope and no runtime. */
class InboxAdoptionTest {

    private fun credential(account: String, generation: Int, bearer: String = "t") =
        Credential(accountId = account, generation = generation, bearer = bearer)

    @Test
    fun `the first observation is always a decision`() {
        // Even "nobody is signed in": the runtime starts holding no session,
        // but saying so once is what makes every later state a comparison
        // against something rather than against an assumption.
        val adoption = InboxAdoption()
        val decision = adoption.next(null)
        assertTrue(decision != null)
        assertNull(decision!!.credential)
    }

    @Test
    fun `a repeated null is not a decision`() {
        val adoption = InboxAdoption()
        adoption.next(null)
        assertNull(adoption.next(null))
    }

    @Test
    fun `an identical credential is not a decision`() {
        val adoption = InboxAdoption()
        adoption.next(credential("a", 1))
        assertNull(adoption.next(credential("a", 1)))
    }

    @Test
    fun `each part of the credential is load-bearing`() {
        val adoption = InboxAdoption()
        adoption.next(credential("a", 1, "t"))
        assertTrue(adoption.next(credential("b", 1, "t")) != null)
        assertTrue(adoption.next(credential("b", 2, "t")) != null)
        assertTrue(adoption.next(credential("b", 2, "u")) != null)
        assertNull(adoption.next(credential("b", 2, "u")))
    }
}
