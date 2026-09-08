package com.relayium.android.inbox

import com.relayium.android.cloud.FakeSecretBox
import com.relayium.android.cloud.ScriptedDurableFiles
import com.relayium.protocol.Json
import com.relayium.protocol.inbox.InboxAutoAccept
import com.relayium.protocol.inbox.InboxDeviceErrorCode
import com.relayium.protocol.inbox.InboxKeyMaterial
import com.relayium.protocol.inbox.InboxManifest
import com.relayium.protocol.inbox.InboxManifestV3
import com.relayium.protocol.inbox.InboxProtocol
import com.relayium.protocol.inbox.InboxRejection
import com.relayium.protocol.inbox.InboxTaskState
import com.relayium.protocol.stored.encryptChunks
import java.io.File
import java.util.Base64
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * One bounded pass of the receive loop.
 *
 * Most of what matters here is what the pass does NOT do: claim while receiving
 * is off, answer an `ask` question on the user's behalf, acknowledge a `saved`
 * central never stored, or die silently on a storage failure and stop receiving
 * altogether.
 */
class InboxReceiveEngineTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val secrets = FakeSecretBox()
    private val files = ScriptedDurableFiles()
    private val account = InboxAccountId("0000111122223333444455556666aaaa")
    private val transport = FakeInboxTransport()
    private val taskId = InboxFixtures.TASK_ID
    private val contentKey = ByteArray(InboxProtocol.CONTENT_KEY_BYTES) { (it + 3).toByte() }

    private var policy = InboxAutoAccept.AUTO

    private val container by lazy { InboxContainer(folder.root, files) }
    private val journals by lazy {
        InboxJournalStore(container.journals(account), account, secrets, files)
    }
    private val messages by lazy {
        InboxMessageStore(container.messages(account), account, secrets, files)
    }
    private val keys by lazy { InboxKeyStore(folder.root, secrets, files) }
    private lateinit var keyPair: com.relayium.protocol.inbox.InboxDeviceKeyPair

    private fun now() = 1_700_000_500L

    private fun engine() = InboxReceiveEngine(
        transport = transport, keys = keys, journals = journals, messages = messages,
        container = container, secrets = secrets, files = files, account = account,
        policy = { policy }, nowSeconds = ::now,
        platform = "android", appVersion = "0.1.0", presentsText = true,
    )

    private suspend fun enrolKey() {
        keyPair = InboxKeyMaterial.generateKeyPair()
        keys.append(keyPair, account, 1_700_000_000)
        keys.bind(InboxKeyMaterial.encode(keyPair.publicKey), InboxFixtures.KEY_ID, 1, account)
    }

    private fun delivery(manifest: InboxManifestV3, payloads: List<ByteArray>): InboxDelivery {
        val wrapped = InboxKeyMaterial.sealContentKey(
            InboxProtocol.KEY_ALGORITHM,
            InboxKeyMaterial.encode(keyPair.publicKey),
            contentKey,
        )
        val ciphertext = encryptChunks(contentKey, payloads)
        transport.blobs[taskId] = ciphertext
        return InboxDelivery.read(
            InboxFixtures.delivery(
                "EncManifest" to Json.of(
                    Base64.getEncoder().encodeToString(InboxManifest.seal(contentKey, manifest)),
                ),
                "WrappedKey" to Json.of(wrapped),
                "CiphertextBytes" to Json.of(ciphertext.size.toLong()),
            ),
        )
    }

    private suspend fun queueOneFile(text: String = "alpha"): InboxDelivery {
        enrolKey()
        val payload = text.toByteArray()
        val d = delivery(InboxManifest.files(listOf("a.txt" to payload.size.toLong())), listOf(payload))
        transport.pending = listOf(d.task)
        transport.claimResult = InboxClaimResult(listOf(d), InboxProtocol.DEFAULT_LEASE_SECONDS)
        return d
    }

    // ── the default-off policy ──────────────────────────────────────────────

    /**
     * Enforced at the ENGINE boundary, not only by central refusing to queue.
     *
     * Central's record of this device's policy can be stale — an enrolment not
     * yet sent, a switch flipped a moment ago — and a device that claimed on the
     * strength of it would write to the user's storage on a permission they had
     * already withdrawn.
     */
    @Test
    fun `receiving off claims nothing even when central offers work`() = runBlocking {
        queueOneFile()
        policy = InboxAutoAccept.OFF

        val result = engine().pass()
        assertTrue(result is InboxReceiveEngine.PassResult.NotReceiving)
        assertEquals(0, transport.count("claim"))
        assertEquals(0, transport.count("pending"))
        assertEquals("not even presence is asserted", 0, transport.count("heartbeat"))
        assertEquals(emptyList<String>(), container.directory(account).list().orEmpty().toList())
    }

    // ── the ordinary pass ───────────────────────────────────────────────────

    @Test
    fun `a pass claims one task, publishes it and reports saved`() = runBlocking {
        val d = queueOneFile()
        transport.savedTaskState = InboxTaskState.SAVED

        assertEquals(InboxReceiveEngine.PassResult.Worked, engine().pass())
        assertEquals(1, transport.count("claim"))
        val journal = requireNotNull(journals.load(taskId))
        assertTrue(journal.isCompleted)
        assertEquals("alpha", File(journal.taskDirectory, "a.txt").readText())
        // `saved` is reachable only from `verifying`, so both are reported.
        val states = transport.reports.map { it.second }
        assertTrue(states.contains(InboxTaskState.VERIFYING))
        assertTrue(states.contains(InboxTaskState.SAVED))
        assertTrue(requireNotNull(journals.load(taskId)).isSavedReported)
        assertEquals(d.task.id, taskId)
    }

    @Test
    fun `an empty queue is idle and prunes`() = runBlocking {
        transport.pending = emptyList()
        assertEquals(InboxReceiveEngine.PassResult.Idle, engine().pass())
        assertEquals(1, transport.count("heartbeat"))
        assertEquals(0, transport.count("claim"))
    }

    /** Pending said there was work but the claim leased none: another worker
     *  took it, or it expired between the two calls. Not an error. */
    @Test
    fun `a claim that leases nothing is idle`() = runBlocking {
        enrolKey()
        transport.pending = listOf(InboxTaskRow.read(InboxFixtures.task()))
        transport.claimResult = InboxClaimResult(emptyList(), 0)
        assertEquals(InboxReceiveEngine.PassResult.Idle, engine().pass())
    }

    // ── acknowledging saved ─────────────────────────────────────────────────

    /**
     * `task_terminal` is NOT proof that central stored `saved`.
     *
     * It is equally what expiry, revocation and a terminal failure answer, so
     * treating it as an acknowledgement would record that a delivery was
     * confirmed when it may have been cancelled. The local journal keeps the
     * delivery as history either way — nothing the user received is lost by
     * withholding the acknowledgement.
     */
    @Test
    fun `a terminal rejection is not treated as a saved acknowledgement`() = runBlocking {
        queueOneFile()
        transport.reportFailureAfter = 1        // `verifying` lands, `saved` is refused
        transport.reportFailure = InboxApiException(409, InboxRejection.TASK_TERMINAL)

        engine().pass()
        val journal = requireNotNull(journals.load(taskId))
        assertTrue("the files are published either way", journal.isCompleted)
        assertFalse("central never said saved", journal.isSavedReported)
    }

    /** …and a `saved` response naming a different task is likewise not this
     *  delivery's acknowledgement. */
    @Test
    fun `a saved response for another task is not an acknowledgement`() = runBlocking {
        queueOneFile()
        transport.savedTaskId = InboxFixtures.STORED_ID

        engine().pass()
        val journal = requireNotNull(journals.load(taskId))
        assertTrue(journal.isCompleted)
        assertFalse(journal.isSavedReported)
    }

    /** A report that never reaches central leaves the delivery published and
     *  unacknowledged, to be re-reported rather than re-delivered. */
    @Test
    fun `a lost saved report leaves the delivery published and unacknowledged`() = runBlocking {
        queueOneFile()
        transport.reportFailureAfter = 1
        transport.reportFailure = InboxTransportException(InboxTransportException.Kind.TIMEOUT)

        engine().pass()
        val journal = requireNotNull(journals.load(taskId))
        assertTrue(journal.isCompleted)
        assertFalse(journal.isSavedReported)
        assertEquals("alpha", File(journal.taskDirectory, "a.txt").readText())
    }

    // ── failures are reported, not swallowed ────────────────────────────────

    /**
     * A local failure is reported with a closed code and the pass ends normally.
     *
     * Letting one escape would kill the receive loop silently; saying nothing
     * would leave the task leased until it expired.
     */
    @Test
    fun `a delivery failure is reported and the pass completes`() = runBlocking {
        enrolKey()
        val payload = ByteArray(4000) { it.toByte() }
        val d = delivery(
            InboxManifest.files(listOf("a.bin" to payload.size.toLong())), listOf(payload),
        )
        transport.blobs[taskId] = transport.blobs.getValue(taskId)
            .also { it[40] = (it[40] + 1).toByte() }
        transport.pending = listOf(d.task)
        transport.claimResult = InboxClaimResult(listOf(d), InboxProtocol.DEFAULT_LEASE_SECONDS)

        assertEquals(InboxReceiveEngine.PassResult.Worked, engine().pass())
        val reported = transport.reports.last()
        assertEquals(InboxTaskState.FAILED_TERMINAL, reported.second)
        assertEquals(InboxDeviceErrorCode.VERIFY_FAILED, reported.third)
    }

    /** Central taking the task away is answered with silence: a report would
     *  mutate a task another worker now holds. */
    @Test
    fun `an abandoned delivery reports nothing`() = runBlocking {
        val d = queueOneFile()
        transport.blobFailure = InboxApiException(409, InboxRejection.STALE_CLAIM)

        assertEquals(InboxReceiveEngine.PassResult.Worked, engine().pass())
        assertTrue(
            "nothing may be reported under a lost lease",
            transport.reports.none { it.first == d.task.id },
        )
    }

    // ── the ask policy ──────────────────────────────────────────────────────

    /**
     * A task held under `ask` carries NO error code, and auto-accepting one
     * would be this machine answering a question that was asked of its owner.
     */
    @Test
    fun `an ask-held task is never answered by the engine`() = runBlocking {
        enrolKey()
        policy = InboxAutoAccept.ASK
        val held = InboxTaskRow.read(
            InboxFixtures.task("State" to Json.of("attention_required")),
        )
        transport.pending = listOf(held)
        transport.claimResult = InboxClaimResult(emptyList(), 0)

        engine().pass()
        assertTrue("only a person may answer", transport.accepts.isEmpty())
    }

    /** Under `auto`, a task central parked with no code is claimed so its KIND
     *  can be discovered — a message needs no container at all. */
    @Test
    fun `an unjudged task is requeued only under auto`() = runBlocking {
        enrolKey()
        val held = InboxTaskRow.read(
            InboxFixtures.task("State" to Json.of("attention_required")),
        )
        transport.pending = listOf(held)
        transport.claimResult = InboxClaimResult(emptyList(), 0)

        policy = InboxAutoAccept.ASK
        engine().pass()
        assertTrue(transport.accepts.isEmpty())

        policy = InboxAutoAccept.AUTO
        engine().pass()
        assertEquals(listOf(held.id to true), transport.accepts.toList())
    }

    /** A `name_conflict` needs a person to look; the engine must not keep
     *  re-queuing it. */
    @Test
    fun `a task parked for a conflict is not requeued`() = runBlocking {
        enrolKey()
        transport.pending = listOf(
            InboxTaskRow.read(
                InboxFixtures.task(
                    "State" to Json.of("attention_required"),
                    "ErrorCode" to Json.of("name_conflict"),
                ),
            ),
        )
        transport.claimResult = InboxClaimResult(emptyList(), 0)
        engine().pass()
        assertTrue(transport.accepts.isEmpty())
    }

    // ── responding, and stopping ────────────────────────────────────────────

    @Test
    fun `responding to an ask is the only way a held task is resolved`() = runBlocking {
        engine().respond(taskId, accept = true)
        assertEquals(listOf(taskId to true), transport.accepts.toList())
        engine().respond(taskId, accept = false)
        assertEquals(taskId to false, transport.accepts.last())
    }

    /**
     * Announcing `off` is not politeness. Central keeps the last policy a device
     * announced, so a device that stopped without saying so would go on being
     * offered as a target and the sender's file would sit queued until it
     * expired.
     */
    @Test
    fun `stopping announces the policy and expires presence`() = runBlocking {
        policy = InboxAutoAccept.OFF
        engine().announceStopped()
        assertTrue(transport.calls.contains("enrol"))
        assertTrue(transport.calls.contains("goOffline"))
    }
}
