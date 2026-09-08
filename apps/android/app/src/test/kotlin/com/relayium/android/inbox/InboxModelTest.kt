package com.relayium.android.inbox

import com.relayium.protocol.Json
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The authority fence.
 *
 * Nearly every operation on this surface suspends, and an account can be
 * switched while one is in flight. What is asserted here is that the answer
 * arriving afterwards cannot land in the new session — because publishing one
 * account's devices, conversations or delivery result under another's is the
 * failure this fence exists for.
 */
class InboxModelTest {

    private val a = InboxAccountId("0000111122223333444455556666aaaa")
    private val b = InboxAccountId("9999888877776666555544443333bbbb")

    private fun model(scope: kotlinx.coroutines.CoroutineScope) =
        InboxModel(scope) { 1_700_000_500 }

    @Test
    fun `a result from a superseded account is dropped`() = runTest {
        val model = model(this)
        val first = requireNotNull(model.adopt(a))
        model.adopt(b)

        val published = model.publish(first) { it.copy(loading = true) }
        assertFalse("the old session may not speak", published)
        assertEquals(b, model.state.value.authority?.account)
        assertFalse(model.state.value.loading)
    }

    /**
     * Signing out and back in to the SAME account is a new session.
     *
     * An identity comparison alone would let a result from the first session
     * land in the second, which is exactly the case a generation exists for.
     */
    @Test
    fun `re-adopting the same account supersedes the old session`() = runTest {
        val model = model(this)
        val first = requireNotNull(model.adopt(a))
        val second = requireNotNull(model.adopt(a))

        assertFalse(first == second)
        assertFalse(model.isCurrent(first))
        assertTrue(model.isCurrent(second))
        assertFalse(model.publish(first) { it.copy(loading = true) })
        assertTrue(model.publish(second) { it.copy(loading = true) })
    }

    /**
     * A switch clears the surface wholesale rather than filtering it.
     *
     * A partial refresh under the new account would otherwise leave the previous
     * account's conversations or devices visible until each was overwritten.
     */
    @Test
    fun `adopting another account leaves nothing of the previous one`() = runTest {
        val model = model(this)
        val first = requireNotNull(model.adopt(a))
        model.publish(first) {
            it.copy(
                conversations = listOf(
                    InboxConversation(InboxFixtures.OTHER_DEVICE_ID, emptyList()),
                ),
                awaitingAnswer = listOf(InboxTaskRow.read(InboxFixtures.task())),
                failure = InboxModel.State.Failure.NETWORK,
            )
        }
        assertEquals(1, model.state.value.conversations.size)

        model.adopt(b)
        val state = model.state.value
        assertTrue(state.conversations.isEmpty())
        assertTrue(state.awaitingAnswer.isEmpty())
        assertTrue(state.devices.isEmpty())
        assertNull(state.failure)
        assertEquals(b, state.authority?.account)
    }

    /** Signing out leaves no authority, and nothing may publish afterwards. */
    @Test
    fun `signing out ends every operation`() = runTest {
        val model = model(this)
        val first = requireNotNull(model.adopt(a))
        assertNull(model.adopt(null))
        assertNull(model.authority())
        assertFalse(model.publish(first) { it.copy(loading = true) })
    }

    /**
     * The check happens AFTER the work, which is the point: an operation that
     * started under one account and finished under another must not publish.
     */
    @Test
    fun `a switch during an in-flight operation drops its result`() = runTest {
        val model = model(this)
        val first = requireNotNull(model.adopt(a))
        val release = CompletableDeferred<Unit>()

        var published: Boolean? = null
        val job = launch {
            release.await()
            published = model.publish(first) { it.copy(loading = true) }
        }
        // The account changes while the operation is suspended.
        model.adopt(b)
        release.complete(Unit)
        job.join()

        assertEquals(false, published)
        assertFalse(model.state.value.loading)
    }

    /** An operation may update what it learned, never who it belongs to. */
    @Test
    fun `a change cannot rewrite the authority`() = runTest {
        val model = model(this)
        val first = requireNotNull(model.adopt(a))
        val forged = InboxModel.Authority(b, 99)
        model.publish(first) { it.copy(authority = forged, loading = true) }
        assertEquals(first, model.state.value.authority)
    }

    // ── device partitioning ─────────────────────────────────────────────────

    /**
     * A blocked device is SHOWN with its reason, not hidden.
     *
     * Each block has a different remedy, and a picker that silently omitted them
     * would leave a user wondering where their device went.
     */
    @Test
    fun `blocked devices are surfaced with the reason they are blocked`() = runBlocking {
        val model = InboxModel(kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined)) { 0 }
        val sendable = InboxDeviceRow.read(
            InboxFixtures.device(
                "ID" to Json.of(InboxFixtures.OTHER_DEVICE_ID),
                "Current" to Json.of(false),
            ),
        )
        val receivingOff = InboxDeviceRow.read(
            InboxFixtures.device(
                "ID" to Json.of("cccccccccccccccccccccccccccccccc"),
                "Current" to Json.of(false),
                "Inbox" to InboxFixtures.enrolment("AutoAccept" to Json.of("off")),
            ),
        )
        val notEnrolled = InboxDeviceRow.read(
            InboxFixtures.device(
                "ID" to Json.of("dddddddddddddddddddddddddddddddd"),
                "Current" to Json.of(false),
                "Inbox" to null,
            ),
        )
        val self = InboxDeviceRow.read(InboxFixtures.device())

        val (targets, blocked) = model.partition(listOf(sendable, receivingOff, notEnrolled, self))
        assertEquals(listOf(InboxFixtures.OTHER_DEVICE_ID), targets.map { it.deviceId })
        assertEquals(
            listOf(InboxTargetBlock.RECEIVE_OFF, InboxTargetBlock.NOT_ENROLLED),
            blocked.map { it.second },
        )
        assertTrue(
            "this device is not a target for itself",
            blocked.none { it.first.isCurrent } && targets.none { it.deviceId == InboxFixtures.DEVICE_ID },
        )
    }
}
