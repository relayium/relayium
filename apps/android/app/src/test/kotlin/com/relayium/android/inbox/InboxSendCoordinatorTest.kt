package com.relayium.android.inbox

import com.relayium.android.cloud.FakeSecretBox
import com.relayium.android.cloud.ScriptedDurableFiles
import com.relayium.protocol.Json
import com.relayium.protocol.inbox.InboxKeyMaterial
import com.relayium.protocol.inbox.InboxManifestKind
import com.relayium.protocol.inbox.InboxProtocol
import com.relayium.protocol.inbox.InboxRejection
import java.io.File
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Driving one staged delivery to exactly one task.
 *
 * Almost every property here is about the difference between DEFINITIVE and
 * AMBIGUOUS. A definitive refusal means central rolled back and the invisible
 * `device_task` object may be released; an ambiguous one means a delivery may be
 * live, and releasing then destroys a real transfer of the user's file. The
 * asserted behaviour is therefore usually what is NOT thrown away.
 */
class InboxSendCoordinatorTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val secrets = FakeSecretBox()
    private val files = ScriptedDurableFiles()
    private val account = InboxAccountId("0000111122223333444455556666aaaa")
    private val contentKey = ByteArray(InboxProtocol.CONTENT_KEY_BYTES) { (it + 5).toByte() }

    private val store by lazy {
        InboxSendStore(File(folder.root, "send"), account, secrets, files)
    }
    private val sender = FakeSenderTransport()
    private val uploader = FakeUploader(contentKey)

    private fun now() = 1_700_000_500L

    private fun coordinator() = InboxSendCoordinator(sender, store, uploader, ::now)

    /**
     * A job that has already sent a create whose answer was lost.
     *
     * The complete immutable request comes with it, because a record claiming an
     * outstanding create without one cannot be replayed — and must never be
     * mistaken for a fresh job, since a new upload and a new sealed box under
     * the same idempotency key is exactly what central refuses.
     */
    private fun outstanding(job: InboxSendJob) = job.copy(
        unresolvedCreate = true,
        storedFileId = InboxFixtures.STORED_ID,
        wrappedKey = InboxFixtures.wrappedKey(),
        targetKeyId = InboxFixtures.KEY_ID,
        targetKeyGeneration = 1,
    )

    /**
     * A staged job, prepared exactly as the preparer prepares one — BEFORE any
     * delivery begins.
     *
     * That ordering is the production rule rather than a fixture convenience:
     * preparation takes the same per-job operation lock a delivery holds, so an
     * uploader that prepared would deadlock against the delivery calling it.
     */
    private suspend fun job(): InboxSendJob {
        store.saveContentKey(InboxFixtures.STORED_ID, contentKey)
        val staged = store.save(
            InboxSendJob(
                jobId = InboxFixtures.STORED_ID,
                targetDeviceId = InboxFixtures.OTHER_DEVICE_ID,
                idempotencyKey = "idem-1",
                kind = InboxManifestKind.FILE,
                files = listOf("a.txt" to 5L),
                totalBytes = 5,
                createdAt = 1_700_000_000,
            ),
            now(),
        )
        return store.prepareSpool(staged, now()) { out ->
            out.write("ciphertext".toByteArray())
        }
    }

    // ── the request identity is durable before the first create ─────────────

    /**
     * A sealed box is RANDOMIZED, so re-sealing is not a retry: central answers
     * a different box under the same idempotency key with a conflict. The exact
     * bytes are therefore persisted before the create, and reproduced verbatim
     * by any later process.
     */
    @Test
    fun `the exact wrapped box is durable before the create and reused on retry`() = runBlocking {
        val start = job()
        sender.createFailure = InboxTransportException(InboxTransportException.Kind.TIMEOUT)

        coordinator().deliver(start.jobId)
        val persisted = requireNotNull(store.load(start.jobId))
        val box = requireNotNull(persisted.wrappedKey)
        assertNotNull(persisted.targetKeyId)
        assertTrue(persisted.targetKeyGeneration > 0)

        // A later attempt — a different process, as far as the store is
        // concerned — sends the identical request.
        sender.createFailure = null
        sender.requests.clear()
        coordinator().deliver(start.jobId)
        val sent = sender.requests.single()
        assertEquals("the box must be byte-identical", box, sent.wrappedKey)
        assertEquals("idem-1", sent.idempotencyKey)
    }

    @Test
    fun `a successful create records the task before anything is cleaned up`() = runBlocking {
        job()
        val result = coordinator().deliver(InboxFixtures.STORED_ID)
        assertTrue(result is InboxSendCoordinator.Result.Delivered)
        assertEquals(InboxFixtures.TASK_ID, requireNotNull(store.load(InboxFixtures.STORED_ID)).taskId)
    }

    /** A job that already names a task is a previous attempt that succeeded and
     *  died tidying up. Creating again is the one thing that must never happen. */
    @Test
    fun `a job that already names a task is read, never created again`() = runBlocking {
        job()
        coordinator().deliver(InboxFixtures.STORED_ID)
        sender.requests.clear()
        val result = coordinator().deliver(InboxFixtures.STORED_ID)
        assertTrue(result is InboxSendCoordinator.Result.Delivered)
        assertFalse((result as InboxSendCoordinator.Result.Delivered).created)
        assertTrue("no second create", sender.requests.isEmpty())
    }

    // ── definitive versus ambiguous ─────────────────────────────────────────

    @Test
    fun `a lost create answer is ambiguous and releases nothing`() = runBlocking {
        val start = job()
        sender.createFailure = InboxTransportException(InboxTransportException.Kind.TIMEOUT)

        val result = coordinator().deliver(start.jobId) as InboxSendCoordinator.Result.Stopped
        assertTrue("a lost answer may still have created a task", result.ambiguous)
        coordinator().release(start.jobId, result)
        assertNotNull("the job must survive", store.load(start.jobId))
        assertTrue("the spool must survive", uploader.spool(start).exists())
    }

    /**
     * A refusal central makes BEFORE storing anything is definitive — but only
     * when no earlier attempt of this job is still outstanding.
     */
    @Test
    fun `pre-storage refusals are definitive on a first attempt`() = runBlocking {
        for (rejection in listOf(
            InboxRejection.INBOX_QUEUE_FULL,
            InboxRejection.AUTO_RECEIVE_DISABLED,
            InboxRejection.DEVICE_CANNOT_RECEIVE,
        )) {
            store.release(InboxFixtures.STORED_ID)
            val start = job()
            sender.createFailure = InboxApiException(409, rejection)
            val result = coordinator().deliver(start.jobId) as InboxSendCoordinator.Result.Stopped
            assertFalse("$rejection must be definitive here", result.ambiguous)
            coordinator().release(start.jobId, result)
            assertNull("$rejection may release the job", store.load(start.jobId))
        }
    }

    /**
     * `idempotency_key_conflict` is a 4xx and is NOT definitive.
     *
     * It says a task exists under this idempotency key describing something
     * else — and that task may be this job's own, created by an attempt whose
     * answer was lost. Releasing its object would destroy a live delivery, so
     * classification is by CODE and by this job's own attempt history, never by
     * "it was a 4xx".
     */
    @Test
    fun `an idempotency conflict never justifies releasing the object`() = runBlocking {
        val start = job()
        sender.createFailure = InboxApiException(409, InboxRejection.IDEMPOTENCY_KEY_CONFLICT)

        val result = coordinator().deliver(start.jobId) as InboxSendCoordinator.Result.Stopped
        assertEquals(InboxSendCoordinator.Result.Reason.IDEMPOTENCY_CONFLICT, result.reason)
        assertTrue("a task may exist under this key", result.ambiguous)
        coordinator().release(start.jobId, result)
        assertNotNull("the job and its object must survive", store.load(start.jobId))
        assertTrue(uploader.spool(start).exists())
    }

    /**
     * The same pre-storage refusal is AMBIGUOUS once an earlier attempt is
     * outstanding: the refusal describes this request, not the earlier one.
     */
    @Test
    fun `a pre-storage refusal after an unresolved attempt stays ambiguous`() = runBlocking {
        val start = store.save(outstanding(job()), now())
        sender.createFailure = InboxApiException(409, InboxRejection.INBOX_QUEUE_FULL)

        val result = coordinator().deliver(start.jobId) as InboxSendCoordinator.Result.Stopped
        assertTrue("an earlier attempt may have created a task", result.ambiguous)
        coordinator().release(start.jobId, result)
        assertNotNull(store.load(start.jobId))
    }

    /** The uncertainty is durable BEFORE the request leaves, so a process that
     *  dies mid-create comes back knowing a task may exist. */
    @Test
    fun `create uncertainty is recorded before the request is sent`() = runBlocking {
        val start = job()
        sender.createFailure = InboxTransportException(InboxTransportException.Kind.TIMEOUT)
        coordinator().deliver(start.jobId)
        assertTrue(requireNotNull(store.load(start.jobId)).unresolvedCreate)
    }

    @Test
    fun `a successful create resolves the uncertainty`() = runBlocking {
        job()
        coordinator().deliver(InboxFixtures.STORED_ID)
        assertFalse(requireNotNull(store.load(InboxFixtures.STORED_ID)).unresolvedCreate)
    }

    /** A status this build cannot classify is not evidence that nothing
     *  happened. */
    @Test
    fun `an unclassified rejection is treated as ambiguous`() = runBlocking {
        val start = job()
        sender.createFailure = InboxApiException(500, null)
        val result = coordinator().deliver(start.jobId) as InboxSendCoordinator.Result.Stopped
        assertTrue(result.ambiguous)
        coordinator().release(start.jobId, result)
        assertNotNull(store.load(start.jobId))
    }

    /** An ambiguous FINALIZE may have published the object, so the job is kept
     *  exactly as it is — a new session would create a second invisible object
     *  the account pays for. */
    @Test
    fun `an ambiguous finalize keeps the job and opens no second session`() = runBlocking {
        val start = job()
        uploader.failure = InboxUploadException(ambiguous = true)
        val result = coordinator().deliver(start.jobId) as InboxSendCoordinator.Result.Stopped
        assertTrue(result.ambiguous)
        coordinator().release(start.jobId, result)
        assertNotNull(store.load(start.jobId))
        assertNull("no object may be recorded", requireNotNull(store.load(start.jobId)).storedFileId)
    }

    // ── the one permitted reseal ────────────────────────────────────────────

    /**
     * `stale_target_key` is DEFINITIVE: the create rolled back, so the retry is
     * a first binding rather than a rebinding, and no byte is re-uploaded.
     * Exactly one reseal is allowed.
     */
    @Test
    fun `a definitive stale target key permits exactly one reseal`() = runBlocking {
        val start = job()
        sender.staleTargetKeyOnce = true

        val result = coordinator().deliver(start.jobId)
        assertTrue(result is InboxSendCoordinator.Result.Delivered)
        val persisted = requireNotNull(store.load(start.jobId))
        assertTrue("the reseal must be recorded as spent", persisted.targetKeyResealed)
        assertEquals("two creates: the refused one and the resealed one", 2, sender.requests.size)
        assertFalse(
            "the second create must carry a different box",
            sender.requests[0].wrappedKey == sender.requests[1].wrappedKey,
        )
        assertEquals(
            "…under the same idempotency key",
            sender.requests[0].idempotencyKey, sender.requests[1].idempotencyKey,
        )
        assertEquals("nothing may be re-uploaded", 1, uploader.uploads)
    }

    /** A second one means the target is rotating faster than this send can
     *  follow, and continuing would be a loop. */
    @Test
    fun `a second stale target key stops rather than looping`() = runBlocking {
        val start = store.save(job().copy(targetKeyResealed = true), now())
        sender.staleTargetKeyOnce = true
        sender.staleAlways = true

        val result = coordinator().deliver(start.jobId) as InboxSendCoordinator.Result.Stopped
        assertEquals(InboxSendCoordinator.Result.Reason.STALE_TARGET_KEY, result.reason)
        assertFalse(result.ambiguous)
    }

    /**
     * A reseal is permitted only when this refusal is the ONLY unresolved
     * create.
     *
     * With an earlier attempt outstanding, a task may already exist under this
     * idempotency key — and a create carrying a DIFFERENT box would collide with
     * it rather than converge. So the send stops, ambiguously, and the job is
     * kept.
     */
    @Test
    fun `no reseal is attempted while an earlier create is unresolved`() = runBlocking {
        val start = store.save(outstanding(job()), now())
        sender.staleTargetKeyOnce = true
        sender.staleAlways = true

        val result = coordinator().deliver(start.jobId) as InboxSendCoordinator.Result.Stopped
        assertEquals(InboxSendCoordinator.Result.Reason.STALE_TARGET_KEY, result.reason)
        assertTrue("a task may exist under this key", result.ambiguous)
        assertFalse(
            "no reseal may be spent",
            requireNotNull(store.load(start.jobId)).targetKeyResealed,
        )
        assertEquals("exactly one create attempt", 1, sender.requests.size)
        coordinator().release(start.jobId, result)
        assertNotNull(store.load(start.jobId))
    }

    /**
     * The box is sealed ONCE and never silently replaced.
     *
     * A target whose key looks different on a later read must not trigger a new
     * box: that would be a second, contradictory description of one delivery
     * under the same idempotency key, which central refuses as a conflict
     * instead of converging.
     */
    @Test
    fun `a rotated target key does not silently change the persisted box`() = runBlocking {
        val start = job()
        sender.createFailure = InboxTransportException(InboxTransportException.Kind.TIMEOUT)
        coordinator().deliver(start.jobId)
        val box = requireNotNull(requireNotNull(store.load(start.jobId)).wrappedKey)

        // The fake mints a fresh key on every device read, so the next attempt
        // sees a different one.
        sender.createFailure = null
        sender.requests.clear()
        coordinator().deliver(start.jobId)
        assertEquals(box, sender.requests.single().wrappedKey)
        assertEquals(box, requireNotNull(store.load(start.jobId)).wrappedKey)
    }

    // ── the target ──────────────────────────────────────────────────────────

    /** Checked BEFORE a byte moves: discovering it after an encrypted upload
     *  would cost the user the whole transfer. */
    @Test
    fun `an ineligible target stops before anything is uploaded`() = runBlocking {
        sender.rows = listOf(
            InboxDeviceRow.read(
                InboxFixtures.device(
                    "ID" to Json.of(InboxFixtures.OTHER_DEVICE_ID),
                    "Current" to Json.of(false),
                    "Inbox" to InboxFixtures.enrolment("AutoAccept" to Json.of("off")),
                ),
            ),
        )
        val result = coordinator().deliver(job().jobId) as InboxSendCoordinator.Result.Stopped
        assertEquals(InboxSendCoordinator.Result.Reason.TARGET_INELIGIBLE, result.reason)
        assertFalse(result.ambiguous)
        assertEquals("nothing may be uploaded", 0, uploader.uploads)
    }

    // ── the exact-retry replay path ─────────────────────────────────────────

    /**
     * An exact retry of a create whose answer was lost must reach the WIRE, even
     * when the target has since become ineligible.
     *
     * Central's idempotency converges the original request onto the task it
     * already holds. Re-running the eligibility preflight here would abandon a
     * delivery that is already queued, and — worse — report it as a definitive
     * refusal, which is what licenses deleting its object.
     */
    @Test
    fun `an unresolved create replays even after the target turns receiving off`() = runBlocking {
        val start = job()
        sender.createFailure = InboxTransportException(InboxTransportException.Kind.TIMEOUT)
        coordinator().deliver(start.jobId)
        assertTrue(requireNotNull(store.load(start.jobId)).unresolvedCreate)

        // The target now refuses everything, and the device list says so.
        sender.rows = listOf(
            InboxDeviceRow.read(
                InboxFixtures.device(
                    "ID" to Json.of(InboxFixtures.OTHER_DEVICE_ID),
                    "Current" to Json.of(false),
                    "Inbox" to InboxFixtures.enrolment("AutoAccept" to Json.of("off")),
                ),
            ),
        )
        sender.createFailure = null
        sender.requests.clear()

        val result = coordinator().deliver(start.jobId)
        assertTrue("the exact request must still reach the server", result is InboxSendCoordinator.Result.Delivered)
        assertEquals(1, sender.requests.size)
        assertEquals(start.idempotencyKey, sender.requests.single().idempotencyKey)
    }

    /** …and it must not re-upload or re-seal on that path either. */
    @Test
    fun `an unresolved create replays without re-uploading or re-sealing`() = runBlocking {
        val start = job()
        sender.createFailure = InboxTransportException(InboxTransportException.Kind.TIMEOUT)
        coordinator().deliver(start.jobId)
        val box = requireNotNull(requireNotNull(store.load(start.jobId)).wrappedKey)
        val uploadsBefore = uploader.uploads

        sender.createFailure = null
        sender.requests.clear()
        coordinator().deliver(start.jobId)
        assertEquals(uploadsBefore, uploader.uploads)
        assertEquals(box, sender.requests.single().wrappedKey)
    }

    // ── unknown is not the same as refused ──────────────────────────────────

    /**
     * An unreachable device list is NOT a confirmed refusal.
     *
     * Collapsing the two is a task-loss path: the unknown would be reported as
     * definitive, and a definitive stop is what licenses deleting the job and
     * its spool.
     */
    @Test
    fun `an unreachable device list is not a confirmed refusal`() = runBlocking {
        val start = job()
        sender.devicesFailure = InboxTransportException(InboxTransportException.Kind.NETWORK)
        val result = coordinator().deliver(start.jobId) as InboxSendCoordinator.Result.Stopped
        assertEquals(InboxSendCoordinator.Result.Reason.TRANSPORT, result.reason)
        assertEquals("nothing may be uploaded", 0, uploader.uploads)
        coordinator().release(start.jobId, result)
        assertNotNull("an unknown target may not release the job", store.load(start.jobId))
    }

    // ── ambiguity is monotonic ──────────────────────────────────────────────

    /**
     * A first attempt that ended ambiguously poisons every later classification
     * in the SAME call.
     *
     * Reading the flag once before the retry loop would classify "IOException,
     * then queue_full" as definitive — and delete the object of a delivery the
     * first request may already have created.
     */
    @Test
    fun `an ambiguous first attempt makes a later definitive-looking refusal ambiguous`() =
        runBlocking {
            val start = job()
            sender.createFailures = ArrayDeque(
                listOf<Throwable>(
                    InboxTransportException(InboxTransportException.Kind.TIMEOUT),
                    InboxApiException(429, InboxRejection.INBOX_QUEUE_FULL),
                ),
            )

            val result = coordinator().deliver(start.jobId) as InboxSendCoordinator.Result.Stopped
            assertEquals(InboxSendCoordinator.Result.Reason.QUEUE_FULL, result.reason)
            assertTrue("the first attempt may have created a task", result.ambiguous)
            coordinator().release(start.jobId, result)
            assertNotNull(store.load(start.jobId))
        }

    // ── release refuses to guess ────────────────────────────────────────────

    /**
     * Release re-checks the durable record INDEPENDENTLY.
     *
     * A caller holding a stale result — or a stale job — must not be able to
     * delete the spool of a delivery that has since acquired a task, or that
     * still records an outstanding create.
     */
    @Test
    fun `release refuses a job that has since acquired a task`() = runBlocking {
        val start = job()
        store.save(start.copy(taskId = InboxFixtures.TASK_ID, storedFileId = InboxFixtures.STORED_ID, wrappedKey = InboxFixtures.wrappedKey(), targetKeyId = InboxFixtures.KEY_ID, targetKeyGeneration = 1), now())
        coordinator().release(
            start.jobId,
            InboxSendCoordinator.Result.Stopped(
                InboxSendCoordinator.Result.Reason.QUEUE_FULL, ambiguous = false,
            ),
        )
        assertNotNull(store.load(start.jobId))
    }

    @Test
    fun `release refuses a job that still records an outstanding create`() = runBlocking {
        val start = job()
        store.save(outstanding(start), now())
        coordinator().release(
            start.jobId,
            InboxSendCoordinator.Result.Stopped(
                InboxSendCoordinator.Result.Reason.QUEUE_FULL, ambiguous = false,
            ),
        )
        assertNotNull(store.load(start.jobId))
    }

    /**
     * A stale caller record cannot bypass the persisted state.
     *
     * `deliver` is addressed by ID and reloads: a UI copy taken before the task
     * was created carries no task id, and acting on it would create a second
     * task for a delivery that already has one.
     */
    @Test
    fun `a stale caller record cannot cause a second create`() = runBlocking {
        val start = job()
        coordinator().deliver(start.jobId)
        assertNotNull(requireNotNull(store.load(start.jobId)).taskId)
        sender.requests.clear()

        // The caller still holds `start`, which knows nothing about the task.
        coordinator().deliver(start.jobId)
        assertTrue("no second create", sender.requests.isEmpty())
    }


    /** Release deletes the spool, which may be the last copy Relayium holds of
     *  what the user asked to send. It refuses an ambiguous result rather than
     *  trusting its caller. */
    /** A non-terminal stop never releases, however definite it is: a network
     *  that could not be reached will very likely work next time. */
    @Test
    fun `a non-terminal stop never releases the staged bytes`() = runBlocking {
        val start = job()
        for (reason in listOf(
            InboxSendCoordinator.Result.Reason.TRANSPORT,
            InboxSendCoordinator.Result.Reason.STORAGE,
            InboxSendCoordinator.Result.Reason.IDEMPOTENCY_CONFLICT,
            InboxSendCoordinator.Result.Reason.OBJECT_ALREADY_BOUND,
        )) {
            coordinator().release(
                start.jobId,
                InboxSendCoordinator.Result.Stopped(reason, ambiguous = false),
            )
            assertNotNull("$reason must not release", store.load(start.jobId))
        }
    }

    @Test
    fun `release refuses an ambiguous result`() = runBlocking {
        val start = job()
        coordinator().release(
            start.jobId,
            InboxSendCoordinator.Result.Stopped(
                InboxSendCoordinator.Result.Reason.TRANSPORT, ambiguous = true,
            ),
        )
        assertNotNull(store.load(start.jobId))
    }

    // ── one operation at a time, per job ────────────────────────────────────

    /**
     * The window between reload and write, closed.
     *
     * Every step reloads the durable record and then SUSPENDS before acting on
     * it. Without a per-job operation lock a release can observe no outstanding
     * create, a concurrent deliver can then record one and start a create, and
     * the release deletes the job and its spool underneath a delivery that may
     * already exist.
     *
     * The latch holds the deliver inside its create, which is precisely the
     * moment the record says "a task may exist".
     */
    @Test
    fun `a release cannot run inside a concurrent deliver`() = runBlocking {
        val start = job()
        val insideCreate = java.util.concurrent.CountDownLatch(1)
        val holdCreate = java.util.concurrent.CountDownLatch(1)
        sender.onCreate = {
            insideCreate.countDown()
            holdCreate.await(10, java.util.concurrent.TimeUnit.SECONDS)
        }

        val delivering = async(kotlinx.coroutines.Dispatchers.IO) {
            coordinator().deliver(start.jobId)
        }
        assertTrue(insideCreate.await(10, java.util.concurrent.TimeUnit.SECONDS))

        val releasing = async(kotlinx.coroutines.Dispatchers.IO) {
            coordinator().release(
                start.jobId,
                InboxSendCoordinator.Result.Stopped(
                    InboxSendCoordinator.Result.Reason.QUEUE_FULL, ambiguous = false,
                ),
            )
        }
        // The release must not have run yet: it is waiting on the job lock.
        Thread.sleep(200)
        assertNotNull("the job must survive while a deliver holds it", store.load(start.jobId))

        holdCreate.countDown()
        delivering.await()
        releasing.await()

        // …and once the deliver finished, the job names a task, so the release
        // refuses on its own re-check too.
        assertNotNull(store.load(start.jobId))
        assertNotNull(requireNotNull(store.load(start.jobId)).taskId)
    }

    /**
     * Two concurrent delivers under one id must not both create.
     *
     * Serialised, the second reloads a record that already names a task and
     * reads the delivery instead of minting a second one.
     */
    @Test
    fun `two concurrent delivers create exactly one task`() = runBlocking {
        val start = job()
        val insideCreate = java.util.concurrent.CountDownLatch(1)
        val holdCreate = java.util.concurrent.CountDownLatch(1)
        sender.onCreate = {
            insideCreate.countDown()
            holdCreate.await(10, java.util.concurrent.TimeUnit.SECONDS)
        }

        val first = async(kotlinx.coroutines.Dispatchers.IO) {
            coordinator().deliver(start.jobId)
        }
        assertTrue(insideCreate.await(10, java.util.concurrent.TimeUnit.SECONDS))
        // A SECOND coordinator over the same store: a lock private to one
        // instance would order only half the writers.
        val second = async(kotlinx.coroutines.Dispatchers.IO) {
            InboxSendCoordinator(sender, store, uploader, ::now).deliver(start.jobId)
        }
        Thread.sleep(200)
        holdCreate.countDown()

        first.await()
        second.await()
        assertEquals("exactly one create", 1, sender.requests.size)
        assertEquals(1, uploader.uploads)
    }

    /**
     * A record claiming an outstanding create without the request it names is
     * unreadable — never a fresh job.
     *
     * Entering a fresh upload and a new sealed box under the same idempotency
     * key is exactly what central refuses as a conflict, and the conflicting
     * task could be this job's own.
     */
    @Test
    fun `an outstanding create without its request is refused as unreadable`() = runBlocking {
        val e = try {
            store.save(job().copy(unresolvedCreate = true), now())
            null
        } catch (thrown: InboxSendStoreException) {
            thrown
        }
        assertEquals(InboxSendStoreReason.UNREADABLE, e?.reason)
    }

    // ── fakes ───────────────────────────────────────────────────────────────

    private inner class FakeUploader(private val key: ByteArray) : InboxCiphertextUploader {
        var uploads = 0
        var failure: InboxUploadException? = null

        /**
         * Uploads what preparation already wrote; it never prepares.
         *
         * That ordering is the production rule, not a fixture convenience:
         * preparation is the immutable handoff a send begins from, and it takes
         * the same per-job operation lock a delivery holds — so an uploader that
         * prepared would deadlock against the delivery calling it.
         */
        override suspend fun upload(job: InboxSendJob, store: InboxSendStore): InboxSendJob {
            failure?.let { throw it }
            uploads += 1
            return store.save(job.copy(storedFileId = InboxFixtures.STORED_ID), now())
        }

        fun spool(job: InboxSendJob): File = store.spool(job.jobId)
    }

    private inner class FakeSenderTransport : InboxSenderTransport {
        val requests = java.util.Collections.synchronizedList(ArrayList<InboxSendRequest>())
        var createFailure: Throwable? = null

        /** Runs inside `createTask`, so a test can hold the operation open. */
        var onCreate: (() -> Unit)? = null

        /** Successive failures, so one attempt can differ from the next. */
        var createFailures: ArrayDeque<Throwable>? = null
        var devicesFailure: Throwable? = null
        var staleTargetKeyOnce = false
        var staleAlways = false

        /** A target whose key rotates once, so a reseal is observable. */
        private var keyOrdinal = 0
        var rows: List<InboxDeviceRow>? = null

        override suspend fun devices(): List<InboxDeviceRow> {
            devicesFailure?.let { throw it }
            rows?.let { return it }
            val public = InboxKeyMaterial.encode(InboxKeyMaterial.generateKeyPair().publicKey)
            keyOrdinal += 1
            return listOf(
                InboxDeviceRow.read(
                    InboxFixtures.device(
                        "ID" to Json.of(InboxFixtures.OTHER_DEVICE_ID),
                        "Current" to Json.of(false),
                        "Inbox" to InboxFixtures.enrolment(
                            "Key" to InboxFixtures.key(
                                "ID" to Json.of("key%030d".format(keyOrdinal)),
                                "PublicKey" to Json.of(public),
                                "Generation" to Json.of(keyOrdinal.toLong()),
                            ),
                        ),
                    ),
                ),
            )
        }

        override suspend fun createTask(
            targetDeviceId: String,
            request: InboxSendRequest,
        ): InboxTaskCreation {
            requests.add(request)
            onCreate?.invoke()
            createFailures?.let { queue ->
                if (queue.isNotEmpty()) throw queue.removeFirst()
            }
            createFailure?.let { throw it }
            if (staleTargetKeyOnce) {
                if (!staleAlways) staleTargetKeyOnce = false
                throw InboxApiException(409, InboxRejection.STALE_TARGET_KEY)
            }
            return InboxTaskCreation(InboxTaskRow.read(InboxFixtures.task()), created = true)
        }

        override suspend fun task(targetDeviceId: String, taskId: String): InboxTaskRow =
            InboxTaskRow.read(InboxFixtures.task())

        override suspend fun tasks(targetDeviceId: String, limit: Int): List<InboxTaskRow> =
            emptyList()

        override suspend fun cancelTask(targetDeviceId: String, taskId: String) = Unit
    }
}
