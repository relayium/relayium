package com.relayium.android.inbox

import com.relayium.protocol.Json
import com.relayium.protocol.inbox.InboxAutoAccept
import com.relayium.protocol.inbox.InboxKeyMaterial
import com.relayium.protocol.inbox.InboxManifest
import com.relayium.protocol.inbox.InboxManifestV3
import com.relayium.protocol.inbox.InboxProtocol
import com.relayium.protocol.inbox.InboxTaskState
import com.relayium.protocol.stored.encryptChunks
import java.io.File
import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The composed feature: what a refresh publishes, what the receive loop does and
 * refuses to do, what a send leaves behind, and what history does with it.
 *
 * Everything here runs against the REAL stores on a temporary directory and the
 * real engine, coordinator and preparer — the only substitutions are the server
 * and the ciphertext upload. What is being tested is the composition, and a
 * composition tested against mocks of its own parts tests nothing.
 */
class InboxRuntimeTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val account = InboxAccountId("0000111122223333444455556666aaaa")
    private val other = InboxAccountId("9999888877776666555544443333bbbb")

    private fun now() = 1_700_000_500L

    /** Parks the receive loop after each pass, so a test drives it one pass at a
     *  time instead of racing a timer. */
    private class Pause {
        val entered = AtomicInteger(0)

        @Volatile
        var gate = CompletableDeferred<Unit>()

        suspend fun await(millis: Long) {
            entered.incrementAndGet()
            gate.await()
        }

        /** Let the loop take one more pass. */
        fun release() {
            val open = gate
            gate = CompletableDeferred()
            open.complete(Unit)
        }
    }

    private class World(
        val services: TestInboxServices,
        val runtime: InboxRuntime,
        val model: InboxModel,
        val pause: Pause,
        val opened: MutableList<Pair<InboxAccountId, String>>,
    )

    private fun TestScope.world(
        account: InboxAccountId = this@InboxRuntimeTest.account,
        root: File = folder.newFolder(),
    ): World {
        val services = TestInboxServices(root, account, nowSeconds = ::now)
        val opened = java.util.Collections.synchronizedList(ArrayList<Pair<InboxAccountId, String>>())
        val pause = Pause()
        val model = InboxModel(backgroundScope, ::now)
        val runtime = InboxRuntime(
            model = model,
            factory = { requested, bearer ->
                opened.add(requested to bearer)
                services.bundle()
            },
            nowSeconds = ::now,
            appVersion = "0.1.1",
            pause = pause::await,
        )
        services.server.devices = listOf(services.self(), services.peer())
        return World(services, runtime, model, pause, opened)
    }

    private suspend fun World.adopt(bearer: String = "bearer-a") {
        runtime.adopt(services.account, bearer)
    }

    // ── refresh ─────────────────────────────────────────────────────────────

    /** The current device is the row central MARKS, and the rest are sorted into
     *  what may be sent to and what may not — with the reason kept. */
    @Test
    fun `a refresh publishes this device and partitions the others`() = runTest {
        val w = world()
        w.services.server.devices = listOf(
            w.services.self(),
            w.services.peer(),
            w.services.peer(
                "ID" to Json.of("cccccccccccccccccccccccccccccccc"),
                "Name" to Json.of("Old phone"),
                "Inbox" to null,
            ),
        )
        w.adopt()
        w.runtime.refresh()?.join()
        advanceUntilIdle()

        val state = w.model.state.value
        assertTrue(state.ready)
        assertEquals("Pixel", state.deviceName)
        assertEquals(listOf(InboxFixtures.OTHER_DEVICE_ID), state.devices.map { it.deviceId })
        assertEquals(listOf(InboxTargetBlock.NOT_ENROLLED), state.blockedDevices.map { it.second })
        assertNull(state.failure)
        assertFalse(state.loading)
    }

    /**
     * Two rows claiming to be current is refused, not resolved.
     *
     * Picking one would mean enrolling, keying and claiming under an identity
     * the protocol never named — and the first row is not an answer.
     */
    @Test
    fun `a device list with two current rows is refused`() = runTest {
        val w = world()
        w.services.server.devices = listOf(
            w.services.self(),
            w.services.self("ID" to Json.of("cccccccccccccccccccccccccccccccc")),
        )
        w.adopt()
        w.runtime.refresh()?.join()
        advanceUntilIdle()

        assertEquals(InboxModel.State.Failure.PROTOCOL, w.model.state.value.failure)
        assertTrue(w.model.state.value.devices.isEmpty())
    }

    /** One account's services are opened with that account's bearer, once. */
    @Test
    fun `services are opened once, for the adopted account and bearer`() = runTest {
        val w = world()
        w.adopt("bearer-a")
        w.runtime.refresh()?.join()
        w.runtime.refresh()?.join()
        advanceUntilIdle()

        assertEquals(listOf(account to "bearer-a"), w.opened.toList())
    }

    // ── receiving ───────────────────────────────────────────────────────────

    /**
     * Default OFF, and OFF is enforced HERE as well as by central.
     *
     * No heartbeat, no poll, no claim: a device that receives on a permission
     * its owner withdrew is the failure this default exists for.
     */
    @Test
    fun `receiving off runs no loop at all`() = runTest {
        val w = world()
        w.adopt()
        w.runtime.start()?.join()
        advanceUntilIdle()

        assertEquals(InboxReceiving.OFF, w.model.state.value.receiving)
        assertEquals(0, w.services.server.device.count("heartbeat"))
        assertEquals(0, w.services.server.device.count("pending"))
        assertEquals(0, w.services.server.device.count("claim"))
        assertEquals(0, w.pause.entered.get())
    }

    /** Switching on is durable BEFORE anything acts on it, and starts exactly
     *  one loop. */
    @Test
    fun `switching receiving on is durable and starts one loop`() = runTest {
        val w = world()
        w.services.holdKey()
        w.adopt()
        w.runtime.start()?.join()
        advanceUntilIdle()
        w.runtime.setPolicy(InboxAutoAccept.AUTO)?.join()
        advanceUntilIdle()

        assertEquals(InboxAutoAccept.AUTO, w.services.policies.read())
        assertEquals(InboxAutoAccept.AUTO, w.model.state.value.policy)
        assertEquals(InboxReceiving.LISTENING, w.model.state.value.receiving)
        assertEquals(1, w.services.server.device.count("heartbeat"))
        assertEquals(1, w.pause.entered.get())
    }

    /**
     * Switching off tells central and goes offline.
     *
     * Central keeps the last policy a device announced. A device that went quiet
     * without saying so would go on being offered as a target, and every send to
     * it would queue and then expire.
     */
    @Test
    fun `switching receiving off announces it and goes offline`() = runTest {
        val w = world()
        w.services.holdKey()
        w.adopt()
        w.runtime.start()?.join()
        advanceUntilIdle()
        w.runtime.setPolicy(InboxAutoAccept.AUTO)?.join()
        advanceUntilIdle()
        w.runtime.setPolicy(InboxAutoAccept.OFF)?.join()
        advanceUntilIdle()

        assertEquals(InboxReceiving.OFF, w.model.state.value.receiving)
        assertEquals(1, w.services.server.device.count("goOffline"))
        assertEquals(InboxAutoAccept.OFF, w.services.policies.read())
        assertNull("a withdrawn enrolment asserts nothing about a key", w.model.state.value.keyHealth)
    }

    /**
     * A key this device cannot open stops the loop instead of claiming.
     *
     * Claiming would take a delivery off the queue only to fail it terminally —
     * the sender's file destroyed by this device's own repair problem.
     */
    @Test
    fun `a key that needs repair stops the loop before any claim`() = runTest {
        val w = world()
        // Central's enrolment publishes an active key this account has no
        // private half for — a restored device, or a cleared keystore.
        w.services.server.device.enrolResult = InboxEnrolResult(
            inbox = InboxEnrolmentView.read(InboxFixtures.enrolment()),
            protocolVersion = InboxProtocol.MAX_PROTOCOL_VERSION,
            receiveCapability = com.relayium.protocol.inbox.InboxCapability.REQUIRED_RECEIVE,
            keyAlgorithm = InboxProtocol.KEY_ALGORITHM,
        )
        w.adopt()
        w.runtime.start()?.join()
        advanceUntilIdle()
        w.runtime.setPolicy(InboxAutoAccept.AUTO)?.join()
        advanceUntilIdle()

        val health = w.model.state.value.keyHealth
        assertTrue("expected a repair verdict, got $health", health is InboxKeyHealth.NeedsRepair)
        assertEquals(0, w.services.server.device.count("claim"))
        assertEquals(InboxReceiving.STOPPED, w.model.state.value.receiving)
    }

    /** A delivery that landed becomes exactly one unread history entry. */
    @Test
    fun `a delivered file becomes one unread history entry`() = runTest {
        val w = world()
        val pair = InboxKeyMaterial.generateKeyPair()
        w.services.keys.append(pair, account, 1_700_000_000)
        w.services.keys.bind(InboxKeyMaterial.encode(pair.publicKey), InboxFixtures.KEY_ID, 1, account)
        w.services.server.device.enrolResult = InboxEnrolResult(
            inbox = InboxEnrolmentView.read(
                InboxFixtures.enrolment(
                    "Key" to InboxFixtures.key(
                        "PublicKey" to Json.of(InboxKeyMaterial.encode(pair.publicKey)),
                    ),
                ),
            ),
            protocolVersion = InboxProtocol.MAX_PROTOCOL_VERSION,
            receiveCapability = com.relayium.protocol.inbox.InboxCapability.REQUIRED_RECEIVE,
            keyAlgorithm = InboxProtocol.KEY_ALGORITHM,
        )
        queue(w, pair, "hello".toByteArray())

        w.adopt()
        w.runtime.start()?.join()
        advanceUntilIdle()
        w.runtime.setPolicy(InboxAutoAccept.AUTO)?.join()
        advanceUntilIdle()

        val conversations = w.model.state.value.conversations
        assertEquals(1, conversations.size)
        val entry = conversations.single().entries.single()
        assertEquals(InboxConversationEntry.Direction.RECEIVED, entry.direction)
        assertEquals(listOf("a.txt"), entry.names)
        assertTrue(entry.isUnread)
        assertEquals(1, conversations.single().unreadCount)
    }

    // ── sending ─────────────────────────────────────────────────────────────

    /** A text send is a real message end to end, and the sender keeps its own
     *  copy so its history can show what was written. */
    @Test
    fun `sending text delivers it and stores the sender's own copy`() = runTest {
        val w = world()
        w.adopt()
        w.runtime.refresh()?.join()
        advanceUntilIdle()
        val target = w.model.state.value.devices.single()

        w.runtime.sendText(target, "the meeting moved to four")?.join()
        advanceUntilIdle()

        assertEquals(1, w.services.server.count("createTask"))
        val send = w.model.state.value.sends.single()
        assertEquals(InboxSendStatus.Phase.DELIVERED, send.phase)
        assertNotNull(send.taskId)

        val entry = w.model.state.value.conversations.single().entries.single()
        assertEquals(InboxConversationEntry.Direction.SENT, entry.direction)
        assertEquals(InboxConversationEntry.Kind.MESSAGE, entry.kind)
        assertEquals(InboxConversationEntry.SentState.CREATED, entry.sentState)
        assertEquals("the meeting moved to four", w.runtime.message(entry))
    }

    /** A repeat names the durable JOB, so central is never asked to create a
     *  second delivery for one the user asked for once. */
    @Test
    fun `retrying a job never creates a second task`() = runTest {
        val w = world()
        w.adopt()
        w.runtime.refresh()?.join()
        advanceUntilIdle()
        val target = w.model.state.value.devices.single()
        w.runtime.sendText(target, "once")?.join()
        advanceUntilIdle()

        val jobId = w.model.state.value.sends.single().jobId
        w.runtime.send(jobId)?.join()
        w.runtime.send(jobId)?.join()
        advanceUntilIdle()

        assertEquals(1, w.services.server.count("createTask"))
        assertEquals(1, w.services.server.tasks.size)
    }

    /**
     * `saved` comes from central saying `saved`, and from nothing else.
     *
     * Expired, revoked and failed are all terminal, and none of them is evidence
     * that a file landed.
     */
    @Test
    fun `a generic terminal state is never reported as saved`() = runTest {
        val w = world()
        w.adopt()
        w.runtime.refresh()?.join()
        advanceUntilIdle()
        val target = w.model.state.value.devices.single()
        w.runtime.sendText(target, "will expire")?.join()
        advanceUntilIdle()

        val taskId = w.model.state.value.sends.single().taskId!!
        w.services.server.settle(taskId, InboxTaskState.EXPIRED)
        w.runtime.refresh()?.join()
        advanceUntilIdle()

        val entry = w.model.state.value.conversations.single().entries.single()
        assertEquals(InboxConversationEntry.SentState.STOPPED, entry.sentState)
    }

    /** The same job, settled as saved, is the only path to SAVED. */
    @Test
    fun `central saying saved is what marks a send saved`() = runTest {
        val w = world()
        w.adopt()
        w.runtime.refresh()?.join()
        advanceUntilIdle()
        val target = w.model.state.value.devices.single()
        w.runtime.sendText(target, "will land")?.join()
        advanceUntilIdle()

        val taskId = w.model.state.value.sends.single().taskId!!
        w.services.server.settle(taskId, InboxTaskState.SAVED)
        w.runtime.refresh()?.join()
        advanceUntilIdle()

        assertEquals(
            InboxConversationEntry.SentState.SAVED,
            w.model.state.value.conversations.single().entries.single().sentState,
        )
    }

    // ── history ─────────────────────────────────────────────────────────────

    /**
     * Deleting is local, durable, and does not resurrect on the next refresh.
     *
     * It also takes the message body with it: a tombstone that hid the row while
     * the plaintext stayed on disk would be a deletion the user was told about
     * and did not get.
     */
    @Test
    fun `deleting a sent message is local, takes the body, and does not come back`() = runTest {
        val w = world()
        w.adopt()
        w.runtime.refresh()?.join()
        advanceUntilIdle()
        val target = w.model.state.value.devices.single()
        w.runtime.sendText(target, "delete me")?.join()
        advanceUntilIdle()
        val entry = w.model.state.value.conversations.single().entries.single()

        w.runtime.deleteHistory(setOf(entry.id))?.join()
        advanceUntilIdle()
        assertTrue(w.model.state.value.conversations.isEmpty())
        assertNull("the body goes with the row", w.services.outgoing.read(entry.id))

        // The job is still durable and central still holds the task; a refresh
        // rebuilds from those sources and must NOT bring the row back.
        w.runtime.refresh()?.join()
        advanceUntilIdle()
        assertTrue(w.model.state.value.conversations.isEmpty())
        assertNull(w.runtime.message(entry))
        assertEquals("history is not a cancel", 0, w.services.server.count("cancelTask"))
        assertEquals(0, w.services.server.device.count("clearInbox"))
    }

    /** A received message's body goes with its row too, and the receipt that
     *  prevents a duplicate delivery stays exactly where it is. */
    @Test
    fun `deleting a received message keeps the receipt and drops the body`() = runTest {
        val w = world()
        w.services.messages.commit(InboxFixtures.TASK_ID, InboxFixtures.OTHER_DEVICE_ID, "hi", now())
        w.services.journals.save(messageJournal(), now())
        w.adopt()
        w.runtime.refresh()?.join()
        advanceUntilIdle()
        val entry = w.model.state.value.conversations.single().entries.single()
        assertEquals("hi", w.runtime.message(entry))

        w.runtime.deleteHistory(setOf(entry.id))?.join()
        w.runtime.refresh()?.join()
        advanceUntilIdle()

        assertTrue(w.model.state.value.conversations.isEmpty())
        assertNull(w.services.messages.read(InboxFixtures.TASK_ID))
        assertNotNull(
            "the receipt outlives the history entry",
            w.services.journals.load(InboxFixtures.TASK_ID),
        )
    }

    /** Refreshing does not re-read, re-date or reorder what is already there. */
    @Test
    fun `a refresh does not disturb read marks`() = runTest {
        val w = world()
        w.services.messages.commit(InboxFixtures.TASK_ID, InboxFixtures.OTHER_DEVICE_ID, "hi", now())
        w.services.journals.save(messageJournal(), now())
        w.adopt()
        w.runtime.refresh()?.join()
        advanceUntilIdle()
        val entry = w.model.state.value.conversations.single().entries.single()
        w.runtime.markRead(setOf(entry.id))?.join()
        advanceUntilIdle()
        assertFalse(w.model.state.value.conversations.single().entries.single().isUnread)

        w.runtime.refresh()?.join()
        advanceUntilIdle()
        val after = w.model.state.value.conversations.single().entries.single()
        assertFalse("a poll must not un-read what the user read", after.isUnread)
        assertEquals(entry.at, after.at)
    }

    // ── answering ───────────────────────────────────────────────────────────

    /**
     * A refused answer keeps the question.
     *
     * Central still holds the task; dropping the row would leave a delivery
     * waiting for an answer the user believes they gave.
     */
    @Test
    fun `a failed accept keeps the question and reports the failure`() = runTest {
        val w = world()
        w.adopt()
        w.runtime.refresh()?.join()
        advanceUntilIdle()
        val task = InboxTaskRow.read(
            InboxFixtures.task("State" to Json.of("attention_required")),
        )
        w.model.publish(w.model.authority()!!) { it.copy(awaitingAnswer = listOf(task)) }
        w.services.server.acceptFailure = InboxTransportException(InboxTransportException.Kind.NETWORK)

        w.runtime.respond(task.id, true)?.join()
        advanceUntilIdle()

        assertEquals(listOf(task.id), w.model.state.value.awaitingAnswer.map { it.id })
        assertEquals(InboxModel.State.Failure.NETWORK, w.model.state.value.failure)
        assertTrue(w.model.state.value.answering.isEmpty())
    }

    // ── accounts ────────────────────────────────────────────────────────────

    /** One account's history is not visible under another's, and is still there
     *  when it comes back. */
    @Test
    fun `an account switch hides one history and preserves both`() = runTest {
        val rootA = folder.newFolder()
        val w = world(root = rootA)
        w.services.messages.commit(InboxFixtures.TASK_ID, InboxFixtures.OTHER_DEVICE_ID, "hi", now())
        w.services.journals.save(messageJournal(), now())
        w.adopt()
        w.runtime.refresh()?.join()
        advanceUntilIdle()
        assertEquals(1, w.model.state.value.conversations.size)

        w.runtime.adopt(other, "bearer-b")
        advanceUntilIdle()
        assertTrue(w.model.state.value.conversations.isEmpty())
        assertEquals(other, w.model.state.value.authority?.account)

        w.runtime.adopt(account, "bearer-a")
        w.runtime.refresh()?.join()
        advanceUntilIdle()
        assertEquals(1, w.model.state.value.conversations.size)
    }

    /** Signing out leaves nothing on the surface and nothing running. */
    @Test
    fun `signing out clears the surface`() = runTest {
        val w = world()
        w.services.holdKey()
        w.adopt()
        w.runtime.start()?.join()
        w.runtime.setPolicy(InboxAutoAccept.AUTO)?.join()
        advanceUntilIdle()

        w.runtime.adopt(null, null)
        advanceUntilIdle()

        assertNull(w.model.state.value.authority)
        assertTrue(w.model.state.value.conversations.isEmpty())
        assertEquals(InboxReceiving.OFF, w.model.state.value.receiving)
    }

    // ── fixtures ────────────────────────────────────────────────────────────

    private fun messageJournal() = InboxJournal(
        taskId = InboxFixtures.TASK_ID,
        storedFileId = InboxFixtures.STORED_ID,
        targetKeyId = InboxFixtures.KEY_ID,
        senderDeviceId = InboxFixtures.OTHER_DEVICE_ID,
        kind = com.relayium.protocol.inbox.InboxManifestKind.TEXT,
        root = "messages",
        plan = emptyList(),
        taskDirectory = "",
        plannedAt = now(),
        committed = listOf(InboxFixtures.TASK_ID),
        isCompleted = true,
        messageBytes = 2,
        completedAt = now(),
    )

    /** A real sealed delivery, framed by the same encoder the sender uses. */
    private fun queue(
        w: World,
        pair: com.relayium.protocol.inbox.InboxDeviceKeyPair,
        payload: ByteArray,
    ) {
        val contentKey = ByteArray(InboxProtocol.CONTENT_KEY_BYTES) { (it + 3).toByte() }
        val manifest: InboxManifestV3 =
            InboxManifest.files(listOf("a.txt" to payload.size.toLong()))
        val wrapped = InboxKeyMaterial.sealContentKey(
            InboxProtocol.KEY_ALGORITHM,
            InboxKeyMaterial.encode(pair.publicKey),
            contentKey,
        )
        val ciphertext = encryptChunks(contentKey, listOf(payload))
        w.services.server.device.blobs[InboxFixtures.TASK_ID] = ciphertext
        val delivery = InboxDelivery.read(
            InboxFixtures.delivery(
                "EncManifest" to Json.of(
                    Base64.getEncoder().encodeToString(InboxManifest.seal(contentKey, manifest)),
                ),
                "WrappedKey" to Json.of(wrapped),
                "CiphertextBytes" to Json.of(ciphertext.size.toLong()),
            ),
        )
        w.services.server.device.pending = listOf(delivery.task)
        w.services.server.device.claimResult =
            InboxClaimResult(listOf(delivery), InboxProtocol.DEFAULT_LEASE_SECONDS)
    }
}
