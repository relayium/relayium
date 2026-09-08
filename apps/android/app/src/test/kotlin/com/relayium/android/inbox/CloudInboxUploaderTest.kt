package com.relayium.android.inbox

import com.relayium.android.cloud.CloudClient
import com.relayium.android.cloud.FakeSecretBox
import com.relayium.android.cloud.RecordingHttpServer
import com.relayium.android.cloud.ScriptedDurableFiles
import com.relayium.protocol.inbox.InboxManifestKind
import java.io.File
import java.io.OutputStream
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
