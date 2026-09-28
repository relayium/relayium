package com.relayium.android.inbox

import com.relayium.android.cloud.CloudClient
import com.relayium.android.cloud.FakeSecretBox
import com.relayium.android.cloud.RecordingHttpServer
import com.relayium.android.cloud.ScriptedDurableFiles
import com.relayium.protocol.inbox.InboxManifestKind
import java.io.File
import java.io.OutputStream
import kotlinx.coroutines.launch
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
 * Uploading one job's ciphertext as a `device_task` object.
 *
 * Against a real loopback server, because the properties under test are about
 * what reached the wire — the purpose query, the offsets actually followed —
 * and about the ORDER of durable writes relative to those requests. A mocked
 * client could only confirm what this code intended.
 */
class CloudInboxUploaderTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val secrets = FakeSecretBox()
    private val files = ScriptedDurableFiles()
    private val account = InboxAccountId("0000111122223333444455556666aaaa")
    private val store by lazy {
        InboxSendStore(File(folder.root, "send"), account, secrets, files)
    }

    private fun now() = 1_700_000_500L

    private suspend fun job(payload: ByteArray = ByteArray(4096) { it.toByte() }): InboxSendJob {
        val saved = store.save(
            InboxSendJob(
                jobId = InboxFixtures.STORED_ID,
                targetDeviceId = InboxFixtures.OTHER_DEVICE_ID,
                idempotencyKey = "idem-1",
                kind = InboxManifestKind.FILE,
                files = listOf("a.bin" to payload.size.toLong()),
                totalBytes = payload.size.toLong(),
                createdAt = 1_700_000_000,
            ),
            now(),
        )
        store.saveEncManifest(saved.jobId, byteArrayOf(0x7b, 0x7d))
        // Prepared through the store, so the payload identity is bound the way
        // production binds it rather than assumed by the fixture.
        return store.prepareSpool(saved, now()) { out -> out.write(payload) }
    }

    private fun uploader(origin: String) = CloudInboxUploader(
        client = CloudClient(origin, "relayium-test/1"),
        token = { "rlm_cli_test" },
        ttlSeconds = 3600,
        nowSeconds = ::now,
    )

    /** Records every request and answers the resumable protocol. */
    private fun server(
        finalizeStatus: String = "200 OK",
        offsetOverride: Long? = null,
    ) = RecordingHttpServer { request, out: OutputStream ->
        val body = when {
            request.method == "POST" && request.path.endsWith("/finalize") ->
                """{"id":"11112222333344445555666677778888","expiresAt":1700600000}"""
            request.method == "POST" && request.path.endsWith("api/uploads") ->
                """{"uploadId":"0123456789abcdef0123456789abcdef","chunkSize":262144}"""
            // The single-shot route an EMPTY payload takes: one POST, one
            // object, answered in the same shape the share route answers.
            request.method == "POST" && request.path.endsWith("api/files") ->
                """{"id":"11112222333344445555666677778888","expiresAt":1700600000}"""
            request.method == "GET" ->
                """{"received":${offsetOverride ?: 0}}"""
            else -> {
                val range = request.header("content-range").orEmpty()
                val end = range.substringAfter('-').substringBefore('/').toLongOrNull() ?: -1
                """{"received":${end + 1}}"""
            }
        }
        val status = if (request.path.endsWith("/finalize")) finalizeStatus else "200 OK"
        RecordingHttpServer.respond(out, status = status, body = body.toByteArray())
    }

    private fun queries(server: RecordingHttpServer, path: String): Map<String, String> =
        server.received.first { it.path.endsWith(path) }.query
            .split('&').filter { it.isNotEmpty() }
            .associate { it.substringBefore('=') to it.substringAfter('=', "") }

    // ── an empty payload ────────────────────────────────────────────────────

    /**
     * The resumable route cannot publish an empty payload at all: the object's
     * bytes are the frame stream, the blob is materialised by the first append,
     * and a delivery with no frames issues none. A real run produced exactly
     * that — `received=0, done=1`, no object, and the receiver reporting
     * `stored_object_unavailable`.
     */
    @Test
    fun `an empty payload is published in one request, as a device task`() = runBlocking {
        val server = server()
        server.use {
            val published = uploader(it.origin).upload(job(ByteArray(0)), store)

            // ONE request, to the single-shot route — no session, no append, no
            // finalize, because there is nothing to resume.
            assertEquals(1, server.received.size)
            val only = server.received.first()
            assertEquals("POST", only.method)
            assertTrue(only.path.endsWith("api/files"))
            val query = queries(server, "api/files")
            // Stated, never defaulted: an unset purpose publishes a SHARE,
            // whose life is its TTL *and its download count*.
            assertEquals("device_task", query["purpose"])
            assertEquals(null, query["burnAfterRead"])
            assertEquals(null, query["maxDownloads"])
            assertEquals("3600", query["ttl"])
            assertEquals("11112222333344445555666677778888", published.storedFileId)
        }
    }

    /**
     * The single-shot route has no session and no offset, so a lost answer
     * cannot say whether an object exists. Trying again would publish a
     * duplicate this device can never name — still billed, still held until its
     * TTL — so the job stays uncertain instead.
     */
    @Test
    fun `an empty publish whose answer was lost is never sent twice`() = runBlocking {
        val prepared = job(ByteArray(0))
        // The shape a lost answer leaves behind: the attempt is recorded, and
        // no object id came back.
        val attempted = store.save(prepared.copy(emptyPublishAttempted = true), now())

        val server = server()
        server.use {
            val failure = runCatching { uploader(it.origin).upload(attempted, store) }
                .exceptionOrNull() as? InboxUploadException
            assertNotNull("a second attempt must be refused", failure)
            assertTrue("the outcome is unknowable, not a failure", failure!!.ambiguous)
            // The proof that matters: nothing was sent.
            assertEquals(0, server.received.size)
        }
    }

    /** The marker is written BEFORE the request, so an attempt that could not
     *  be recorded does not happen at all. */
    @Test
    fun `an empty publish records its attempt before sending`() = runBlocking {
        val server = server()
        server.use {
            uploader(it.origin).upload(job(ByteArray(0)), store)
            val reloaded = store.load(InboxFixtures.STORED_ID)
            assertTrue("the attempt must be durable", reloaded!!.emptyPublishAttempted)
        }
    }

    /** A payload with bytes takes the route it always took. */
    @Test
    fun `a non-empty payload still uses the resumable route`() = runBlocking {
        val server = server()
        server.use {
            uploader(it.origin).upload(job(), store)
            assertTrue(
                "the resumable session must still be opened",
                server.received.any { r -> r.path.endsWith("api/uploads") },
            )
            assertTrue(
                "the single-shot route must not be used for a real payload",
                server.received.none { r -> r.path.endsWith("api/files") },
            )
        }
    }

    // ── the purpose ─────────────────────────────────────────────────────────

    /**
     * A `device_task` object has no capability link, no file-list row, and 404s
     * on the public endpoints even for its owner. Sending it as a share would
     * publish the user's delivery to anyone holding the link.
     */
    @Test
    fun `the object is opened as a device task, unlimited and never burning`() = runBlocking {
        server().use { server ->
            val start = job()
            uploader(server.origin).upload(start, store)
            val q = queries(server, "api/uploads")
            assertEquals("device_task", q["purpose"])
            assertEquals("0", q["burnAfterRead"])
            assertEquals("3600", q["ttl"])
        }
    }

    @Test
    fun `a completed upload records the object central created`() = runBlocking {
        server().use { server ->
            val start = job()
            val done = uploader(server.origin).upload(start, store)
            assertEquals("11112222333344445555666677778888", done.storedFileId)
            assertEquals(done.storedFileId, requireNotNull(store.load(start.jobId)).storedFileId)
            assertTrue(requireNotNull(store.load(start.jobId)).finalizeAttempted)
        }
    }

    /** Already published: nothing is re-sent. */
    @Test
    fun `an already-published job is not uploaded again`() = runBlocking {
        server().use { server ->
            val start = store.save(job().copy(storedFileId = InboxFixtures.TASK_ID), now())
            uploader(server.origin).upload(start, store)
            assertTrue("nothing may reach the network", server.received.isEmpty())
        }
    }

    // ── the crash gaps ──────────────────────────────────────────────────────

    /**
     * The session id is durable BEFORE a byte is appended.
     *
     * Without that ordering a death here leaves an orphaned session, and the
     * next attempt opens a second one — the account paying twice for storage it
     * cannot see.
     */
    @Test
    fun `the session is recorded before any append`() = runBlocking {
        server().use { server ->
            val start = job()
            uploader(server.origin).upload(start, store)
            // The record was written between the init and the first PATCH.
            val writes = files.writes.toList()
            val patchIndex = server.received.indexOfFirst { it.method == "PATCH" }
            assertTrue("a PATCH must have happened", patchIndex >= 0)
            assertTrue("the record must have been written", writes.isNotEmpty())
            assertNotNull(requireNotNull(store.load(start.jobId)).uploadId)
        }
    }

    /**
     * A finalize whose answer was lost may have PUBLISHED the object, so the
     * next attempt may only ask again — never open a second session.
     */
    @Test
    fun `a job whose finalize was attempted never opens a second session`() = runBlocking {
        server().use { server ->
            val start = store.save(
                job().copy(
                    uploadId = "0123456789abcdef0123456789abcdef",
                    finalizeAttempted = true,
                ),
                now(),
            )
            uploader(server.origin).upload(start, store)
            assertTrue(
                "no new session may be opened",
                server.received.none { it.method == "POST" && it.path.endsWith("api/uploads") },
            )
            assertTrue(
                "nothing may be re-uploaded",
                server.received.none { it.method == "PATCH" },
            )
        }
    }

    /**
     * `ALREADY_FINALIZED` carries no object id, so it cannot prove this upload
     * published — and it cannot license a fresh session either. The uncertainty
     * is kept rather than resolved by guessing.
     */
    @Test
    fun `a conflicted finalize is ambiguous and records no object`() = runBlocking {
        server(finalizeStatus = "409 Conflict").use { server ->
            val start = job()
            val e = try {
                uploader(server.origin).upload(start, store)
                null
            } catch (thrown: InboxUploadException) {
                thrown
            }
            assertTrue("the object may exist", e!!.ambiguous)
            assertNull(requireNotNull(store.load(start.jobId)).storedFileId)
            assertTrue(
                "the attempt must be recorded so no second session is opened",
                requireNotNull(store.load(start.jobId)).finalizeAttempted,
            )
        }
    }

    // ── finalize recovery (protocol §25, "A lost finalize answer") ──────────
    //
    // Every Device Inbox finalize carries `{"recoverFinalized":true}`. A server
    // with recovery answers a repeat from its durable record; one without it
    // ignores the field. The mapping mirrors RelayiumKit's
    // `CloudUploader.finalizeRecovering` and the server's
    // `answerFinalizeRecovery` (D4-D8).

    /** One scripted finalize reply; `null` from the script drops the answer. */
    private class Reply(
        val status: String,
        val body: String,
        val headers: List<String> = emptyList(),
        val contentType: String = "application/json",
    )

    private val recoveredReply = Reply(
        "200 OK",
        """{"id":"11112222333344445555666677778888","expiresAt":1700600000,"recovered":true}""",
    )

    private fun outcomeReply(outcome: String, vararg headers: String) = Reply(
        "409 Conflict",
        """{"error":"already_finalized","outcome":"$outcome"}""",
        headers.toList(),
    )

    /** An older server's repeat: text, no outcome. */
    private val plainConflict =
        Reply("409 Conflict", "already finalized\n", contentType = "text/plain; charset=utf-8")

    /**
     * The resumable protocol, with finalize answered by [finalize] given the
     * 0-based index of the finalize request. Everything else as [server].
     */
    private fun recoveryServer(finalize: (Int) -> Reply?): RecordingHttpServer {
        val finalizes = java.util.concurrent.atomic.AtomicInteger()
        return RecordingHttpServer { request, out: OutputStream ->
            if (request.method == "POST" && request.path.endsWith("/finalize")) {
                val scripted = finalize(finalizes.getAndIncrement()) ?: return@RecordingHttpServer
                // Faithful to central: a recovery answer (a 409 document or a
                // `recovered` 200) exists only for a request that opted in.
                // Without the opt-in a repeat is the plain-text 409.
                val optedIn = String(request.body) == """{"recoverFinalized":true}"""
                val recoveryOnly = scripted.status.startsWith("409") || "recovered" in scripted.body
                val reply = if (recoveryOnly && !optedIn) plainConflict else scripted
                RecordingHttpServer.respond(
                    out, status = reply.status, contentType = reply.contentType,
                    body = reply.body.toByteArray(), extraHeaders = reply.headers,
                )
                return@RecordingHttpServer
            }
            val body = when {
                request.method == "POST" && request.path.endsWith("api/uploads") ->
                    """{"uploadId":"0123456789abcdef0123456789abcdef","chunkSize":262144}"""
                request.method == "GET" -> """{"received":0}"""
                else -> {
                    val range = request.header("content-range").orEmpty()
                    val end = range.substringAfter('-').substringBefore('/').toLongOrNull() ?: -1
                    """{"received":${end + 1}}"""
                }
            }
            RecordingHttpServer.respond(out, body = body.toByteArray())
        }
    }

    /** Waits the uploader asked for, instead of taking them. */
    private val slept = java.util.Collections.synchronizedList(ArrayList<Long>())

    private fun recoveringUploader(origin: String) = CloudInboxUploader(
        client = CloudClient(origin, "relayium-test/1"),
        token = { "rlm_cli_test" },
        ttlSeconds = 3600,
        nowSeconds = ::now,
        sleep = { slept.add(it) },
    )

    /** A job whose finalize was sent and whose answer never arrived. */
    private suspend fun finalizeLost(): InboxSendJob = store.save(
        job().copy(uploadId = "0123456789abcdef0123456789abcdef", finalizeAttempted = true),
        now(),
    )

    private suspend fun uploadFailure(job: InboxSendJob, origin: String): InboxUploadException =
        try {
            recoveringUploader(origin).upload(job, store)
            throw AssertionError("the upload must not succeed")
        } catch (e: InboxUploadException) {
            e
        }

    private fun count(server: RecordingHttpServer, method: String, suffix: String) =
        server.received.count { it.method == method && it.path.endsWith(suffix) }

    @Test
    fun `every inbox finalize carries the recovery opt-in, the first one included`() = runBlocking {
        recoveryServer { Reply("200 OK", """{"id":"11112222333344445555666677778888","expiresAt":1700600000}""") }
            .use { server ->
                val done = recoveringUploader(server.origin).upload(job(), store)
                assertEquals("11112222333344445555666677778888", done.storedFileId)
                val finalize = server.received.single { it.path.endsWith("/finalize") }
                assertEquals("""{"recoverFinalized":true}""", String(finalize.body))
                assertTrue(finalize.header("content-type").orEmpty().startsWith("application/json"))
                // A fresh 200 without `recovered` is an ordinary completion.
                assertNull(requireNotNull(store.load(done.jobId)).finalizeOutcome)
            }
    }

    @Test
    fun `a recovered finalize records the object and re-sends nothing`() = runBlocking {
        recoveryServer { recoveredReply }.use { server ->
            val start = finalizeLost()
            val done = recoveringUploader(server.origin).upload(start, store)
            assertEquals("11112222333344445555666677778888", done.storedFileId)
            assertEquals(
                "11112222333344445555666677778888",
                requireNotNull(store.load(start.jobId)).storedFileId,
            )
            assertEquals("no second session", 0, count(server, "POST", "api/uploads"))
            assertEquals("no byte re-sent", 0, count(server, "PATCH", ""))
            assertEquals("asked exactly once", 1, count(server, "POST", "/finalize"))
        }
    }

    @Test
    fun `a running finalize honours Retry-After, then converges on the object`() = runBlocking {
        recoveryServer { i -> if (i < 2) outcomeReply("running", "Retry-After: 3") else recoveredReply }
            .use { server ->
                val start = finalizeLost()
                val done = recoveringUploader(server.origin).upload(start, store)
                assertEquals("11112222333344445555666677778888", done.storedFileId)
                assertEquals("each wait is the server's hint", listOf(3_000L, 3_000L), slept.toList())
                assertEquals(3, count(server, "POST", "/finalize"))
                assertEquals(0, count(server, "POST", "api/uploads"))
            }
    }

    @Test
    fun `a finalize that keeps running is uncertain and keeps the job`() = runBlocking {
        recoveryServer { outcomeReply("running", "Retry-After: 3") }.use { server ->
            val start = finalizeLost()
            val e = uploadFailure(start, server.origin)
            assertTrue("still running is not a verdict", e.ambiguous)
            assertNull(e.unavailable)
            // Bounded by poll count (12 answers, 11 waits of 3 s = 33 s < 60 s).
            assertEquals(12, count(server, "POST", "/finalize"))
            assertEquals(List(11) { 3_000L }, slept.toList())
            val kept = requireNotNull(store.load(start.jobId))
            assertNull(kept.storedFileId)
            assertNull("never inferred from elapsed time", kept.finalizeOutcome)
            assertTrue(kept.finalizeAttempted)
            assertTrue(kept.uploadUnsettled)
            assertEquals(0, count(server, "POST", "api/uploads"))
            assertEquals(0, count(server, "PATCH", ""))
        }
    }

    @Test
    fun `running waits are clamped and bounded by the total budget`() = runBlocking {
        // No hint: the 5 s default. A huge hint: clamped to 10 s, and the 60 s
        // budget ends the polling before the poll count does.
        recoveryServer { i -> if (i == 0) outcomeReply("running") else outcomeReply("running", "Retry-After: 999") }
            .use { server ->
                val e = uploadFailure(finalizeLost(), server.origin)
                assertTrue(e.ambiguous)
                assertEquals(listOf(5_000L) + List(5) { 10_000L }, slept.toList())
                assertTrue("never more than the budget", slept.sum() <= 60_000L)
            }
    }

    @Test
    fun `a definitive outcome is recorded durably and ends the job's uploading`() = runBlocking {
        for (outcome in listOf("failed", "expired", "removed")) {
            store.release(InboxFixtures.STORED_ID)
            recoveryServer { outcomeReply(outcome) }.use { server ->
                val start = finalizeLost()
                val e = uploadFailure(start, server.origin)
                assertFalse("$outcome is central's own verdict", e.ambiguous)
                assertEquals(outcome, e.unavailable?.wire)
                val kept = requireNotNull(store.load(start.jobId))
                assertEquals("durable before it is reported", outcome, kept.finalizeOutcome?.wire)
                assertNull(kept.storedFileId)
                assertFalse("settled: nothing live remains", kept.uploadUnsettled)

                // A later attempt asks nobody and re-sends nothing.
                val before = server.received.size
                val again = uploadFailure(kept, server.origin)
                assertFalse(again.ambiguous)
                assertEquals(outcome, again.unavailable?.wire)
                assertEquals("no request at all", before, server.received.size)
                assertEquals(0, count(server, "POST", "api/uploads"))
                assertEquals(0, count(server, "PATCH", ""))
            }
        }
    }

    @Test
    fun `a 409 without a recognised outcome keeps today's uncertain stop`() = runBlocking {
        val shapes = listOf(
            plainConflict,
            Reply("409 Conflict", """{"error":"already_finalized"}"""),
            Reply("409 Conflict", """{"error":"already_finalized","outcome":"banana"}"""),
            // The outcome counts only inside the recovery document.
            Reply("409 Conflict", """{"error":"something_else","outcome":"failed"}"""),
            Reply("409 Conflict", """{"error":"already_finalized","outcome":7}"""),
        )
        for (shape in shapes) {
            store.release(InboxFixtures.STORED_ID)
            recoveryServer { shape }.use { server ->
                val start = finalizeLost()
                val e = uploadFailure(start, server.origin)
                assertTrue("'${shape.body.trim()}' must stay uncertain", e.ambiguous)
                assertNull(e.unavailable)
                val kept = requireNotNull(store.load(start.jobId))
                assertNull(kept.finalizeOutcome)
                assertTrue(kept.uploadUnsettled)
                assertEquals("asked once, not polled", 1, count(server, "POST", "/finalize"))
                assertTrue(slept.isEmpty())
            }
        }
    }

    /**
     * An older server ignores the body. Its first finalize answers 200 exactly
     * as before — recorded — and its repeat is the text 409, which stays the
     * uncertainty it always was. A 404 (the session collected) likewise.
     */
    @Test
    fun `against a server without recovery the client behaves exactly as before`() = runBlocking {
        recoveryServer { Reply("200 OK", """{"id":"11112222333344445555666677778888","expiresAt":1700600000}""") }
            .use { server ->
                val done = recoveringUploader(server.origin).upload(job(), store)
                assertEquals("11112222333344445555666677778888", done.storedFileId)
            }
        for (reply in listOf(plainConflict, Reply("404 Not Found", "not found\n", contentType = "text/plain"))) {
            store.release(InboxFixtures.STORED_ID)
            recoveryServer { reply }.use { server ->
                val e = uploadFailure(finalizeLost(), server.origin)
                assertTrue(e.ambiguous)
                assertNull(e.unavailable)
                assertNull(requireNotNull(store.load(InboxFixtures.STORED_ID)).finalizeOutcome)
            }
        }
    }

    /**
     * The definitive outcome could not be written. It must stay UNCERTAIN —
     * reporting it without the durable record would let a relaunch forget it —
     * and everything recovery needs stays. The next attempt re-asks the SAME
     * session, hears the same answer from central's record, and records it.
     */
    @Test
    fun `a definitive outcome that cannot be recorded stays uncertain and is recorded on the next ask`() = runBlocking {
        recoveryServer { outcomeReply("failed") }.use { server ->
            val start = finalizeLost()
            files.failWrites.add(start.jobId + ".json")
            val e = uploadFailure(start, server.origin)
            files.failWrites.clear()
            assertTrue("not recorded, so not reported as definitive", e.ambiguous)
            assertNull(e.unavailable)
            val kept = requireNotNull(store.load(start.jobId))
            assertNull(kept.finalizeOutcome)
            assertTrue(kept.finalizeAttempted)
            assertEquals(start.uploadId, kept.uploadId)
            assertTrue("the spool stays", store.spool(start.jobId).exists())
            assertNotNull("the sealed manifest stays", store.encManifest(start.jobId))

            val again = uploadFailure(kept, server.origin)
            assertFalse(again.ambiguous)
            assertEquals("failed", again.unavailable?.wire)
            assertEquals("failed", requireNotNull(store.load(start.jobId)).finalizeOutcome?.wire)
            assertEquals("the same session was asked twice", 2, count(server, "POST", "/finalize"))
            assertTrue(server.received.filter { it.path.endsWith("/finalize") }.all { it.path.contains(start.uploadId!!) })
            assertEquals(0, count(server, "POST", "api/uploads"))
            assertEquals(0, count(server, "PATCH", ""))
        }
    }

    /** `running` several times and then a definitive answer, in ONE attempt:
     *  the outcome is recorded exactly once and nothing else is sent. */
    @Test
    fun `running answers then failed within one attempt records the outcome once`() = runBlocking {
        recoveryServer { i -> if (i < 3) outcomeReply("running", "Retry-After: 2") else outcomeReply("failed") }
            .use { server ->
                val start = finalizeLost()
                val writesBefore = files.writes.count { it == start.jobId + ".json" }
                val e = uploadFailure(start, server.origin)
                assertFalse(e.ambiguous)
                assertEquals("failed", e.unavailable?.wire)
                assertEquals(listOf(2_000L, 2_000L, 2_000L), slept.toList())
                assertEquals(4, count(server, "POST", "/finalize"))
                assertEquals(
                    "one durable write: the outcome",
                    writesBefore + 1, files.writes.count { it == start.jobId + ".json" },
                )
                assertEquals("failed", requireNotNull(store.load(start.jobId)).finalizeOutcome?.wire)
                assertEquals(0, count(server, "POST", "api/uploads"))
                assertEquals(0, count(server, "PATCH", ""))
            }
    }

    /** `Retry-After: 0` is clamped UP to the 1 s floor; an HTTP-date (legal
     *  HTTP, but not the delta-seconds central sends) falls back to the 5 s
     *  default rather than being misread. */
    @Test
    fun `a zero or HTTP-date Retry-After is clamped or defaulted`() = runBlocking {
        recoveryServer { i ->
            when (i) {
                0 -> outcomeReply("running", "Retry-After: 0")
                1 -> outcomeReply("running", "Retry-After: Wed, 21 Oct 2026 07:28:00 GMT")
                else -> recoveredReply
            }
        }.use { server ->
            val done = recoveringUploader(server.origin).upload(finalizeLost(), store)
            assertEquals("11112222333344445555666677778888", done.storedFileId)
            assertEquals(listOf(1_000L, 5_000L), slept.toList())
        }
    }

    /**
     * Cancelled while WAITING between `running` answers: the record is exactly
     * as it was (the session, the attempt marker, no outcome, no object), and
     * nothing more is sent.
     *
     * Deterministic, no wall clock: the injectable wait records the requested
     * millis and then suspends on a gate the test owns and never opens. The
     * uploader cannot send its next poll until the wait returns, and this wait
     * only ever ends by cancellation — so the test cancels while the attempt
     * is provably inside the wait, and exactly one finalize can have been sent.
     * (A `CompletableDeferred.await` honours cancellation exactly as the
     * production `delay` does.)
     */
    @Test
    fun `cancelling during a running wait changes nothing and sends nothing more`() = runBlocking {
        recoveryServer { outcomeReply("running", "Retry-After: 1") }.use { server ->
            val start = finalizeLost()
            val requested = kotlinx.coroutines.CompletableDeferred<Long>()
            val neverOpened = kotlinx.coroutines.CompletableDeferred<Unit>()
            val uploader = CloudInboxUploader(
                client = CloudClient(server.origin, "relayium-test/1"),
                token = { "rlm_cli_test" },
                ttlSeconds = 3600,
                nowSeconds = ::now,
                sleep = { ms -> requested.complete(ms); neverOpened.await() },
            )
            val attempt = launch { uploader.upload(start, store) }
            assertEquals("the server's hint, clamped", 1_000L, kotlinx.coroutines.withTimeout(10_000) { requested.await() })
            attempt.cancel()
            attempt.join()
            assertTrue(attempt.isCancelled)
            assertFalse("the wait was never released", neverOpened.isCompleted)
            assertEquals("exactly one finalize was sent", 1, count(server, "POST", "/finalize"))
            assertEquals(0, count(server, "POST", "api/uploads"))
            assertEquals(0, count(server, "PATCH", ""))
            val kept = requireNotNull(store.load(start.jobId))
            assertEquals(start.uploadId, kept.uploadId)
            assertTrue(kept.finalizeAttempted)
            assertNull(kept.finalizeOutcome)
            assertNull(kept.storedFileId)
            assertTrue(store.spool(start.jobId).exists())
        }
    }

    /** A 200 this build cannot read is never an object id and never a verdict. */
    @Test
    fun `an unreadable 200 is uncertain`() = runBlocking {
        for (body in listOf(
            """{"id":"11112222333344445555666677778888","expiresAt":0}""",
            """{"id":"11112222333344445555666677778888","expiresAt":1700600000,"recovered":"yes"}""",
            """{"expiresAt":1700600000}""",
        )) {
            store.release(InboxFixtures.STORED_ID)
            recoveryServer { Reply("200 OK", body) }.use { server ->
                val e = uploadFailure(finalizeLost(), server.origin)
                assertTrue(body, e.ambiguous)
                val kept = requireNotNull(store.load(InboxFixtures.STORED_ID))
                assertNull(kept.storedFileId)
                assertNull(kept.finalizeOutcome)
            }
        }
    }

    // ── a hostile or broken server's offsets ────────────────────────────────

    /**
     * An offset the stored transport parsed but never bounded.
     *
     * It knows the number is a whole non-negative integer; it has no idea what
     * this job's spool contains. A negative one would seek backwards out of the
     * file, and one past the end would let the loop finish early and finalize an
     * object that was never fully sent — so the bound belongs here.
     */
    @Test
    fun `an offset outside the payload is refused`() = runBlocking {
        for (bogus in listOf(-1L, 99_999L)) {
            val server = RecordingHttpServer { request, out: OutputStream ->
                val body = if (request.method == "GET") """{"received":$bogus}"""
                else """{"uploadId":"0123456789abcdef0123456789abcdef","chunkSize":262144}"""
                RecordingHttpServer.respond(out, body = body.toByteArray())
            }
            server.use {
                store.release(InboxFixtures.STORED_ID)
                val start = job()
                val e = try {
                    uploader(server.origin).upload(start, store)
                    null
                } catch (thrown: InboxUploadException) {
                    thrown
                }
                assertNotNull("offset $bogus must be refused", e)
                assertFalse(e!!.ambiguous)
                assertTrue(
                    "nothing may be finalized",
                    server.received.none { it.path.endsWith("/finalize") },
                )
            }
        }
    }

    /**
     * A SUCCESS cannot acknowledge more than was actually offered.
     *
     * A server claiming so is describing bytes this client never sent, and
     * continuing from that number would finalize an object with a hole in it.
     * The payload here is larger than one append, so the guard is distinct from
     * the "within the payload" bound above.
     */
    @Test
    fun `a success acknowledging more than one append offered is refused`() = runBlocking {
        val payload = ByteArray(2 * 1024 * 1024) { it.toByte() }
        val server = RecordingHttpServer { request, out: OutputStream ->
            val body = when {
                request.method == "POST" && request.path.endsWith("api/uploads") ->
                    """{"uploadId":"0123456789abcdef0123456789abcdef","chunkSize":262144}"""
                request.method == "GET" -> """{"received":0}"""
                // Inside the payload, but far beyond what this append offered.
                else -> """{"received":1500000}"""
            }
            RecordingHttpServer.respond(out, body = body.toByteArray())
        }
        server.use {
            val e = try {
                uploader(server.origin).upload(job(payload), store)
                null
            } catch (thrown: InboxUploadException) {
                thrown
            }
            assertNotNull("a success beyond the offer must be refused", e)
            assertFalse(e!!.ambiguous)
            assertTrue(
                "nothing may be finalized",
                server.received.none { it.path.endsWith("/finalize") },
            )
        }
    }

    /**
     * A 409 reports an authoritative offset and is a legitimate answer — but the
     * same offset forever, or two that oscillate, will never converge.
     *
     * Following them is an upload that never ends and never fails, which is
     * worse than stopping: the user sees a send that is permanently "in
     * progress".
     */
    @Test
    fun `a server that never advances is bounded rather than looped`() = runBlocking {
        var patches = 0
        val server = RecordingHttpServer { request, out: OutputStream ->
            when {
                request.method == "POST" && request.path.endsWith("api/uploads") ->
                    RecordingHttpServer.respond(
                        out,
                        body = """{"uploadId":"0123456789abcdef0123456789abcdef","chunkSize":262144}"""
                            .toByteArray(),
                    )
                request.method == "GET" ->
                    RecordingHttpServer.respond(out, body = """{"received":0}""".toByteArray())
                else -> {
                    patches += 1
                    // Always conflicts, always back at zero.
                    RecordingHttpServer.respond(
                        out, status = "409 Conflict",
                        body = """{"received":0}""".toByteArray(),
                    )
                }
            }
        }
        server.use {
            val e = try {
                uploader(server.origin).upload(job(), store)
                null
            } catch (thrown: InboxUploadException) {
                thrown
            }
            assertNotNull("a non-advancing server must stop the upload", e)
            assertFalse(e!!.ambiguous)
            assertTrue("the attempts must be bounded", patches in 1..10)
            assertTrue(
                "nothing may be finalized",
                server.received.none { it.path.endsWith("/finalize") },
            )
        }
    }

    /**
     * An oscillating offset never converges either — and a consecutive-stall
     * counter alone does NOT catch it: 0 -> 8 -> 0 -> 8 resets the counter on
     * every other step. The total append budget is what bounds this.
     */
    @Test
    fun `an oscillating offset is bounded`() = runBlocking {
        var toggle = false
        val server = RecordingHttpServer { request, out: OutputStream ->
            when {
                request.method == "POST" && request.path.endsWith("api/uploads") ->
                    RecordingHttpServer.respond(
                        out,
                        body = """{"uploadId":"0123456789abcdef0123456789abcdef","chunkSize":262144}"""
                            .toByteArray(),
                    )
                request.method == "GET" ->
                    RecordingHttpServer.respond(out, body = """{"received":0}""".toByteArray())
                else -> {
                    toggle = !toggle
                    RecordingHttpServer.respond(
                        out, status = "409 Conflict",
                        body = """{"received":${if (toggle) 8 else 0}}""".toByteArray(),
                    )
                }
            }
        }
        server.use {
            val e = try {
                uploader(server.origin).upload(job(), store)
                null
            } catch (thrown: InboxUploadException) {
                thrown
            }
            assertNotNull(e)
            assertFalse(e!!.ambiguous)
        }
    }

    /**
     * The spool must be EXACTLY what preparation wrote.
     *
     * Absence and emptiness are the obvious cases. The one that needs a digest
     * is TRUNCATION at a frame boundary: a well-formed prefix that would upload
     * and finalize cleanly as a smaller object the recipient could never
     * reconcile with the manifest it was promised. Corruption in place is caught
     * for the same reason, and neither is visible to a length check.
     */
    @Test
    fun `a spool that is not what was prepared stops before any request`() = runBlocking {
        val payload = ByteArray(4096) { it.toByte() }
        val damage: List<Pair<String, (File) -> Unit>> = listOf(
            "missing" to { it.delete() },
            "empty" to { it.writeBytes(ByteArray(0)) },
            "truncated" to { it.writeBytes(payload.copyOf(2048)) },
            "corrupted in place" to {
                it.writeBytes(payload.copyOf().also { b -> b[100] = (b[100] + 1).toByte() })
            },
        )
        for ((name, break_) in damage) {
            server().use { server ->
                store.release(InboxFixtures.STORED_ID)
                val start = job(payload)
                break_(store.spool(start.jobId))

                val e = try {
                    uploader(server.origin).upload(start, store)
                    null
                } catch (thrown: InboxUploadException) {
                    thrown
                }
                assertNotNull("a $name spool must be refused", e)
                assertFalse(e!!.ambiguous)
                assertTrue("nothing may reach the network for $name", server.received.isEmpty())
            }
        }
    }

    /**
     * The prepared identity is IMMUTABLE once it exists.
     *
     * A duplicate or stale prepare must not rewrite the spool an upload is
     * midway through — between its digest check and its final append — which
     * would publish an object matching neither identity. A fresh send is a new
     * job id, not a rewrite of this one.
     */
    @Test
    fun `a prepared job cannot have its payload rewritten`() = runBlocking {
        val prepared = job()
        val before = prepared.ciphertextSha256

        val e = try {
            store.prepareSpool(prepared, now()) { out -> out.write(ByteArray(8)) }
            null
        } catch (thrown: InboxSendStoreException) {
            thrown
        }
        assertNotNull("a prepared job may not be re-prepared", e)
        assertEquals(before, requireNotNull(store.load(prepared.jobId)).ciphertextSha256)
        assertTrue(store.spoolMatches(requireNotNull(store.load(prepared.jobId))))
    }

    /** …and likewise once a session exists or an object has been published. */
    @Test
    fun `a job with a session or an object cannot be re-prepared`() = runBlocking {
        for (mutate in listOf<(InboxSendJob) -> InboxSendJob>(
            { it.copy(uploadId = "0123456789abcdef0123456789abcdef") },
            { it.copy(storedFileId = InboxFixtures.TASK_ID) },
        )) {
            store.release(InboxFixtures.STORED_ID)
            val prepared = store.save(mutate(job()), now())
            val e = try {
                store.prepareSpool(prepared, now()) { out -> out.write(ByteArray(8)) }
                null
            } catch (thrown: InboxSendStoreException) {
                thrown
            }
            assertNotNull(e)
        }
    }

    /** The identity is bound at preparation, from the bytes as they are
     *  written — not derived later from the file being checked. */
    @Test
    fun `preparation records the exact length and digest`() = runBlocking {
        val payload = ByteArray(4096) { it.toByte() }
        val prepared = job(payload)
        assertEquals(payload.size.toLong(), prepared.ciphertextBytes)
        assertEquals(
            InboxCommit.digestOf(store.spool(prepared.jobId)),
            prepared.ciphertextSha256,
        )
        assertTrue(store.spoolMatches(prepared))
        assertEquals(prepared.ciphertextSha256, requireNotNull(store.load(prepared.jobId)).ciphertextSha256)
    }

    // ── the offset is the server's ──────────────────────────────────────────

    /**
     * Resumed from the SERVER's offset, never from a local idea of what was
     * sent — the server caps what one append commits, so a 200 may acknowledge
     * less than was offered.
     */
    @Test
    fun `the append resumes from the offset the server reports`() = runBlocking {
        val payload = ByteArray(4096) { it.toByte() }
        server(offsetOverride = 1024).use { server ->
            uploader(server.origin).upload(job(payload), store)
            val firstPatch = server.received.first { it.method == "PATCH" }
            assertEquals(
                "bytes 1024-4095/4096",
                firstPatch.header("Content-Range"),
            )
            assertEquals(3072, firstPatch.body.size)
        }
    }

    /** Nothing left to send: the append is skipped entirely. */
    @Test
    fun `an already-complete session appends nothing`() = runBlocking {
        val payload = ByteArray(4096) { it.toByte() }
        server(offsetOverride = 4096).use { server ->
            uploader(server.origin).upload(job(payload), store)
            assertTrue(server.received.none { it.method == "PATCH" })
            assertTrue(server.received.any { it.path.endsWith("/finalize") })
        }
    }

    @Test
    fun `a missing sealed manifest stops before any request`() = runBlocking {
        server().use { server ->
            val start = store.save(
                InboxSendJob(
                    jobId = InboxFixtures.TASK_ID,
                    targetDeviceId = InboxFixtures.OTHER_DEVICE_ID,
                    idempotencyKey = "idem-2",
                    kind = InboxManifestKind.FILE,
                    files = listOf("a.bin" to 4L),
                    totalBytes = 4,
                    createdAt = 1_700_000_000,
                ),
                now(),
            )
            val e = try {
                uploader(server.origin).upload(start, store)
                null
            } catch (thrown: InboxUploadException) {
                thrown
            }
            assertFalse("nothing was sent", e!!.ambiguous)
            assertTrue(server.received.isEmpty())
        }
    }
}
