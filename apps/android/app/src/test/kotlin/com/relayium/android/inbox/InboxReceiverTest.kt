package com.relayium.android.inbox

import com.relayium.android.cloud.FakeSecretBox
import com.relayium.android.cloud.ScriptedDurableFiles
import com.relayium.protocol.Json
import com.relayium.protocol.inbox.InboxDeviceErrorCode
import com.relayium.protocol.inbox.InboxKeyMaterial
import com.relayium.protocol.inbox.InboxManifest
import com.relayium.protocol.inbox.InboxManifestItem
import com.relayium.protocol.inbox.InboxManifestV3
import com.relayium.protocol.inbox.InboxProtocol
import com.relayium.protocol.inbox.InboxRejection
import com.relayium.protocol.inbox.InboxTaskState
import com.relayium.protocol.stored.encryptChunks
import java.io.File
import java.util.Base64
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * One delivery, end to end, against real crypto.
 *
 * The ciphertext here is produced by the protocol module's own framing and the
 * manifest by its own sealer, so the receiver is exercised against the bytes a
 * real sender emits rather than against a fake that agrees with it. Nothing is
 * stubbed between the wire and the published directory except the transport
 * itself.
 */
class InboxReceiverTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val secrets = FakeSecretBox()
    private val files = ScriptedDurableFiles()
    private val account = InboxAccountId("0000111122223333444455556666aaaa")
    private val transport = FakeInboxTransport()
    private val taskId = InboxFixtures.TASK_ID

    private val contentKey = ByteArray(InboxProtocol.CONTENT_KEY_BYTES) { (it + 3).toByte() }
    private lateinit var keyPair: com.relayium.protocol.inbox.InboxDeviceKeyPair

    private val container by lazy { InboxContainer(folder.root, files) }
    private val journals by lazy {
        InboxJournalStore(container.journals(account), account, secrets, files)
    }
    private val messages by lazy {
        InboxMessageStore(container.messages(account), account, secrets, files)
    }
    private val keys by lazy { InboxKeyStore(folder.root, secrets, files) }

    private fun now() = 1_700_000_500L

    /** The account's device key, published under the id the task will name. */
    private suspend fun enrolKey() {
        keyPair = InboxKeyMaterial.generateKeyPair()
        keys.append(keyPair, account, 1_700_000_000)
        keys.bind(InboxKeyMaterial.encode(keyPair.publicKey), InboxFixtures.KEY_ID, 1, account)
    }

    /** A delivery whose manifest and ciphertext are produced by the real codecs. */
    private fun delivery(
        manifest: InboxManifestV3,
        payloads: List<ByteArray>,
        wrapAlgorithm: String = InboxProtocol.KEY_ALGORITHM,
    ): InboxDelivery {
        val wrapped = InboxKeyMaterial.sealContentKey(
            InboxProtocol.KEY_ALGORITHM,
            InboxKeyMaterial.encode(keyPair.publicKey),
            contentKey,
        )
        val sealedManifest = InboxManifest.seal(contentKey, manifest)
        val ciphertext = encryptChunks(contentKey, payloads)
        transport.blobs[taskId] = ciphertext
        return InboxDelivery.read(
            InboxFixtures.delivery(
                "EncManifest" to Json.of(Base64.getEncoder().encodeToString(sealedManifest)),
                "WrappedKey" to Json.of(wrapped),
                "WrapAlgorithm" to Json.of(wrapAlgorithm),
                "CiphertextBytes" to Json.of(ciphertext.size.toLong()),
            ),
        )
    }

    private fun receiver(
        root: File? = container.directory(account),
        freeBytes: () -> Long? = { null },
    ) = InboxReceiver(
        transport = transport, keys = keys, journals = journals, messages = messages,
        container = container, secrets = secrets, files = files, account = account,
        nowSeconds = ::now, root = root, freeBytes = freeBytes,
    )

    private suspend fun ready(): File {
        container.probe(account)
        return container.directory(account)
    }

    /**
     * What the user would actually SEE in the container.
     *
     * The staging directory lives inside it — that is what makes publication a
     * same-filesystem rename — so its presence is not a delivered anything. It
     * is filtered here rather than asserted around, because "nothing was
     * published" is the property under test and the workspace is not a
     * publication. Both names are reserved, so no manifest can produce one.
     */
    private fun publishedEntries(): List<String> =
        container.directory(account).list().orEmpty()
            .filterNot { it == InboxContainer.STAGING || it == InboxContainer.PROBE }
            .sorted()

    private fun failure(body: suspend () -> Unit): InboxFailure = runBlocking {
        try {
            body()
            throw AssertionError("expected a delivery failure")
        } catch (e: InboxFailure) {
            e
        }
    }

    // ── file deliveries ─────────────────────────────────────────────────────

    @Test
    fun `a file delivery is published with its exact bytes`() = runBlocking {
        enrolKey()
        ready()
        val alpha = "alpha contents".toByteArray()
        val bravo = ByteArray(3000) { (it % 251).toByte() }
        val manifest = InboxManifest.files(listOf("a.txt" to alpha.size.toLong(), "nested/b.bin" to bravo.size.toLong()))

        val outcome = receiver().deliver(delivery(manifest, listOf(alpha, bravo)))
        assertEquals(InboxReceiver.Outcome.COMMITTED, outcome)

        val directory = requireNotNull(journals.load(taskId)).taskDirectory
        assertArrayEquals(alpha, File(directory, "a.txt").readBytes())
        assertArrayEquals(bravo, File(directory, "nested/b.bin").readBytes())
        assertTrue(requireNotNull(journals.load(taskId)).isCompleted)
    }

    /** An empty file is part of what the manifest described, so it must exist —
     *  a stream carrying no bytes for it does not make it optional. */
    @Test
    fun `an empty file is still delivered`() = runBlocking {
        enrolKey()
        ready()
        val manifest = InboxManifest.files(listOf("empty.txt" to 0L, "after.txt" to 5L))
        receiver().deliver(delivery(manifest, listOf(ByteArray(0), "after".toByteArray())))

        val directory = requireNotNull(journals.load(taskId)).taskDirectory
        assertTrue(File(directory, "empty.txt").isFile)
        assertEquals(0L, File(directory, "empty.txt").length())
        assertEquals("after", File(directory, "after.txt").readText())
    }

    @Test
    fun `a unicode name round-trips`() = runBlocking {
        enrolKey()
        ready()
        val payload = "内容".toByteArray()
        val manifest = InboxManifest.files(listOf("文档/报告 🎉.txt" to payload.size.toLong()))
        receiver().deliver(delivery(manifest, listOf(payload)))
        val directory = requireNotNull(journals.load(taskId)).taskDirectory
        assertArrayEquals(payload, File(directory, "文档/报告 🎉.txt").readBytes())
    }

    /** Nothing enters the container until the whole stream has been proven. */
    @Test
    fun `a corrupt ciphertext leaves nothing behind`() = runBlocking {
        enrolKey()
        ready()
        val payload = ByteArray(5000) { it.toByte() }
        val manifest = InboxManifest.files(listOf("a.bin" to payload.size.toLong()))
        val d = delivery(manifest, listOf(payload))
        // Flip a byte inside an authenticated frame.
        transport.blobs[taskId] = transport.blobs.getValue(taskId).also { it[64] = (it[64] + 1).toByte() }

        val e = failure { receiver().deliver(d) }
        assertEquals(InboxFailure.Reason.CIPHERTEXT_INVALID, e.reason)
        assertEquals(InboxTaskState.FAILED_TERMINAL, e.state)
        assertEquals(InboxDeviceErrorCode.VERIFY_FAILED, e.code)
        assertEquals("nothing may be published", emptyList<String>(), publishedEntries())
    }

    /**
     * A stream cut on a FRAME BOUNDARY leaves every delivered frame perfectly
     * authentic, so the declared size is the only thing that distinguishes "the
     * file ended" from "someone stopped it early".
     */
    @Test
    fun `a boundary-aligned truncation is refused`() = runBlocking {
        enrolKey()
        ready()
        val payload = ByteArray(400_000) { it.toByte() }   // several frames
        val manifest = InboxManifest.files(listOf("a.bin" to payload.size.toLong()))
        val d = delivery(manifest, listOf(payload))
        val whole = transport.blobs.getValue(taskId)
        // Cut at a frame boundary: the first frame's length prefix says how long
        // it is, so this is a prefix of complete frames.
        val firstFrame = 4 + ((whole[0].toInt() and 0xff shl 24) or
            (whole[1].toInt() and 0xff shl 16) or
            (whole[2].toInt() and 0xff shl 8) or
            (whole[3].toInt() and 0xff))
        transport.blobs[taskId] = whole.copyOf(firstFrame)

        val e = failure { receiver().deliver(d) }
        assertEquals(InboxFailure.Reason.CIPHERTEXT_INVALID, e.reason)
        assertEquals(emptyList<String>(), publishedEntries())
    }

    @Test
    fun `a manifest declaring more than the ciphertext could hold is refused`() = runBlocking {
        enrolKey()
        ready()
        val payload = "small".toByteArray()
        val manifest = InboxManifest.files(listOf("a.txt" to payload.size.toLong()))
        val d = delivery(manifest, listOf(payload))
        // Central measured the object; a manifest claiming more than that is a
        // lie central can be used to catch, before space is reserved for it.
        val lying = InboxDelivery(
            task = d.task.copy(ciphertextBytes = 1),
            encManifest = d.encManifest, wrappedKey = d.wrappedKey, claimToken = d.claimToken,
        )
        val e = failure { receiver().deliver(lying) }
        assertEquals(InboxFailure.Reason.MANIFEST_EXCEEDS_CIPHERTEXT, e.reason)
    }

    // ── key custody ─────────────────────────────────────────────────────────

    /** Central sealed to a key this account does not hold here. Nothing can ever
     *  open it, so the refusal is terminal rather than retried forever. */
    @Test
    fun `a task sealed to a key this device does not hold is refused terminally`() = runBlocking {
        keyPair = InboxKeyMaterial.generateKeyPair()   // never appended to the store
        ready()
        val payload = "x".toByteArray()
        val manifest = InboxManifest.files(listOf("a.txt" to 1L))

        val e = failure { receiver().deliver(delivery(manifest, listOf(payload))) }
        assertEquals(InboxFailure.Reason.NO_LOCAL_PRIVATE_KEY, e.reason)
        assertEquals(InboxTaskState.FAILED_TERMINAL, e.state)
        assertEquals(InboxDeviceErrorCode.DECRYPT_FAILED, e.code)
    }

    // ── message deliveries ──────────────────────────────────────────────────

    /**
     * A message is committed to the protected store and never to the container —
     * which is why the container is not even consulted for one.
     */
    @Test
    fun `a message lands with no usable container at all`() = runBlocking {
        enrolKey()
        val text = "hello 世界"
        val bytes = text.toByteArray()
        val manifest = InboxManifest.text(bytes.size.toLong())

        val outcome = receiver(root = null).deliver(delivery(manifest, listOf(bytes)))
        assertEquals(InboxReceiver.Outcome.COMMITTED, outcome)
        assertEquals(text, requireNotNull(messages.read(taskId)).text)
        assertEquals(InboxFixtures.OTHER_DEVICE_ID, requireNotNull(messages.read(taskId)).senderDeviceId)
        assertTrue(requireNotNull(journals.load(taskId)).isCompleted)
        assertFalse(container.directory(account).exists())
    }

    /** …while a FILE delivery is the only thing a missing container blocks. */
    @Test
    fun `a file delivery without a container reports directory unavailable`() = runBlocking {
        enrolKey()
        val payload = "x".toByteArray()
        val manifest = InboxManifest.files(listOf("a.txt" to 1L))

        val e = failure { receiver(root = null).deliver(delivery(manifest, listOf(payload))) }
        assertEquals(InboxFailure.Reason.DIRECTORY_UNAVAILABLE, e.reason)
        assertEquals(InboxTaskState.ATTENTION_REQUIRED, e.state)
        assertEquals(InboxDeviceErrorCode.DIRECTORY_UNAVAILABLE, e.code)
    }

    /**
     * Bytes that authenticate and are exactly as long as declared are still not
     * a MESSAGE. A receiver that repaired invalid UTF-8 would show the user
     * something nobody wrote.
     */
    @Test
    fun `authenticated bytes that are not valid text are refused`() = runBlocking {
        enrolKey()
        val invalid = byteArrayOf(0xC3.toByte(), 0x28)     // a truncated sequence
        val manifest = InboxManifest.text(invalid.size.toLong())

        val e = failure { receiver(root = null).deliver(delivery(manifest, listOf(invalid))) }
        assertEquals(InboxFailure.Reason.MESSAGE_MALFORMED, e.reason)
        assertEquals(InboxTaskState.FAILED_TERMINAL, e.state)
        assertNull(messages.read(taskId))
    }

    // ── already delivered ───────────────────────────────────────────────────

    /**
     * A task whose journal already says completed is RE-REPORTED, never
     * re-delivered: the files are real and already published, and downloading
     * them again would duplicate the delivery.
     */
    @Test
    fun `a completed journal is re-asserted rather than re-delivered`() = runBlocking {
        enrolKey()
        ready()
        val payload = "alpha".toByteArray()
        val manifest = InboxManifest.files(listOf("a.txt" to payload.size.toLong()))
        val d = delivery(manifest, listOf(payload))
        receiver().deliver(d)

        val downloadsBefore = transport.count("withBlob")
        val outcome = receiver().deliver(d)
        assertEquals(InboxReceiver.Outcome.ALREADY_COMMITTED, outcome)
        assertEquals("nothing may be downloaded again", downloadsBefore, transport.count("withBlob"))
    }

    /** A journal whose immutable bindings disagree with the claim is not this
     *  delivery's, and resuming under it would land the task twice or nowhere. */
    @Test
    fun `a journal describing another delivery is refused`() = runBlocking {
        enrolKey()
        ready()
        val payload = "alpha".toByteArray()
        val manifest = InboxManifest.files(listOf("a.txt" to payload.size.toLong()))
        val d = delivery(manifest, listOf(payload))
        receiver().deliver(d)

        val impostor = InboxDelivery(
            task = d.task.copy(storedFileId = InboxFixtures.OTHER_DEVICE_ID),
            encManifest = d.encManifest, wrappedKey = d.wrappedKey, claimToken = d.claimToken,
        )
        val e = failure { receiver().deliver(impostor) }
        assertEquals(InboxFailure.Reason.JOURNAL_UNREADABLE, e.reason)
    }

    // ── recovering an already-published delivery ────────────────────────────

    /**
     * The crash between the rename and the journal write, under the two
     * conditions that make recovery ORDER matter.
     *
     * The delivery is already on disk, but the volume no longer has room for a
     * second copy and the ciphertext object is gone. A recovery attempted after
     * the free-space check and the re-download would fail both — reporting
     * `disk_full` for files the user already has, or dying on a blob that no
     * longer exists — and the delivery would never be acknowledged. So the
     * recovery runs FIRST.
     */
    @Test
    fun `an already-published delivery is recovered before space is measured or bytes fetched`() =
        runBlocking {
            enrolKey()
            ready()
            val payload = "alpha".toByteArray()
            val manifest = InboxManifest.files(listOf("a.txt" to payload.size.toLong()))
            val d = delivery(manifest, listOf(payload))
            receiver().deliver(d)
            val directory = requireNotNull(journals.load(taskId)).taskDirectory

            // Roll the journal back to the pre-record state, as a crash would.
            journals.save(
                requireNotNull(journals.load(taskId)).copy(committed = emptyList(), isCompleted = false),
                now(),
            )
            val downloadsBefore = transport.count("withBlob")
            // Neither of these may be reached.
            transport.blobFailure = InboxApiException(409, InboxRejection.STORED_OBJECT_UNAVAILABLE)

            val outcome = receiver(freeBytes = { 1L }).deliver(d)
            assertEquals(InboxReceiver.Outcome.ALREADY_COMMITTED, outcome)
            assertTrue(requireNotNull(journals.load(taskId)).isCompleted)
            assertEquals("nothing may be downloaded again", downloadsBefore, transport.count("withBlob"))
            assertEquals("alpha", File(directory, "a.txt").readText())
        }

    /** The recovery preserves the refusals: a directory that cannot prove it is
     *  this delivery's is refused rather than adopted, even here. */
    @Test
    fun `early recovery still refuses a foreign directory and wrong same-size bytes`() =
        runBlocking {
            enrolKey()
            ready()
            val payload = "alpha".toByteArray()
            val manifest = InboxManifest.files(listOf("a.txt" to payload.size.toLong()))
            val d = delivery(manifest, listOf(payload))
            receiver().deliver(d)
            val directory = File(requireNotNull(journals.load(taskId)).taskDirectory)

            // Same length, different bytes — and a receipt that no longer matches.
            File(directory, "a.txt").writeText("WRONG")
            journals.save(
                requireNotNull(journals.load(taskId)).copy(committed = emptyList(), isCompleted = false),
                now(),
            )

            val e = failure { receiver(freeBytes = { 1L }).deliver(d) }
            assertEquals(InboxFailure.Reason.NAME_CONFLICT, e.reason)
            assertEquals(InboxTaskState.ATTENTION_REQUIRED, e.state)
            assertEquals(InboxDeviceErrorCode.NAME_CONFLICT, e.code)
            assertEquals("the bytes there are untouched", "WRONG", File(directory, "a.txt").readText())
            assertFalse(requireNotNull(journals.load(taskId)).isCompleted)
        }

    // ── the lease ───────────────────────────────────────────────────────────

    /**
     * A refused lease renewal means this worker is no longer authorised to
     * assert anything about the task, so it reports NOTHING — a report would
     * mutate a task another worker now holds.
     */
    @Test
    fun `a refused renewal abandons rather than reporting`() = runBlocking {
        enrolKey()
        ready()
        val payload = "alpha".toByteArray()
        val manifest = InboxManifest.files(listOf("a.txt" to payload.size.toLong()))
        val d = delivery(manifest, listOf(payload))
        transport.reportFailure = InboxApiException(409, InboxRejection.STALE_CLAIM)

        val abandoned = try {
            receiver().deliver(d)
            null
        } catch (e: InboxAbandon) {
            e
        }
        assertEquals(InboxAbandon.Cause.LEASE_RENEWAL_REFUSED, abandoned?.why)
        assertEquals(
            "nothing may be published under a lost lease",
            emptyList<String>(), publishedEntries(),
        )
    }

    /** Central's own refusals on the blob route are its judgement, not something
     *  a reconnect fixes: the delivery is abandoned silently. */
    @Test
    fun `central taking the task away is abandoned silently`() = runBlocking {
        enrolKey()
        ready()
        val payload = "alpha".toByteArray()
        val manifest = InboxManifest.files(listOf("a.txt" to payload.size.toLong()))
        val d = delivery(manifest, listOf(payload))

        for ((rejection, cause) in listOf(
            InboxRejection.STALE_CLAIM to InboxAbandon.Cause.STALE_CLAIM,
            InboxRejection.TASK_TERMINAL to InboxAbandon.Cause.TASK_TERMINAL,
            InboxRejection.STORED_OBJECT_UNAVAILABLE to
                InboxAbandon.Cause.STORED_OBJECT_UNAVAILABLE,
        )) {
            journals.remove(taskId)
            transport.blobFailure = InboxApiException(409, rejection)
            val abandoned = try {
                receiver().deliver(d)
                null
            } catch (e: InboxAbandon) {
                e
            }
            assertEquals(cause, abandoned?.why)
        }
    }

    // ── resume ──────────────────────────────────────────────────────────────

    /**
     * A transport interruption resumes from the last COMPLETE authenticated
     * frame, so a resumed request neither re-feeds a partial frame nor skips
     * one. This is what makes announcing `inbox.resume.v1` truthful.
     */
    @Test
    fun `an interrupted stream resumes from an authenticated frame boundary`() = runBlocking {
        enrolKey()
        ready()
        val payload = ByteArray(500_000) { (it % 253).toByte() }
        val manifest = InboxManifest.files(listOf("big.bin" to payload.size.toLong()))
        val d = delivery(manifest, listOf(payload))
        // Break the first read after some frames have been delivered.
        transport.breakAfterBytes = 300_000

        receiver().deliver(d)
        assertTrue("the stream must have been resumed", transport.count("withBlob") > 1)
        assertTrue("the resume must have asked for a tail", transport.blobOffsets.any { it > 0 })
        val directory = requireNotNull(journals.load(taskId)).taskDirectory
        assertArrayEquals(payload, File(directory, "big.bin").readBytes())
    }

    /**
     * A resume the server answered with a FULL body is a fresh start, not a
     * tail. Splicing it into the middle of the stream would produce
     * authenticated-looking rubbish.
     */
    @Test
    fun `a resume answered with a full body restarts rather than splicing`() = runBlocking {
        enrolKey()
        ready()
        val payload = ByteArray(500_000) { (it % 253).toByte() }
        val manifest = InboxManifest.files(listOf("big.bin" to payload.size.toLong()))
        val d = delivery(manifest, listOf(payload))
        transport.breakAfterBytes = 300_000
        transport.ignoreRange = true

        val e = failure { receiver().deliver(d) }
        assertEquals(InboxFailure.Reason.RANGE_IGNORED, e.reason)
        assertEquals(InboxTaskState.FAILED_RETRYABLE, e.state)
        assertEquals(emptyList<String>(), publishedEntries())
    }
}
