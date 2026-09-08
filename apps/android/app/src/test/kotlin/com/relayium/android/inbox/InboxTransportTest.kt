package com.relayium.android.inbox

import com.relayium.android.cloud.RecordingHttpServer
import com.relayium.protocol.Json
import com.relayium.protocol.inbox.InboxDeviceErrorCode
import com.relayium.protocol.inbox.InboxProtocol
import com.relayium.protocol.inbox.InboxRejection
import com.relayium.protocol.inbox.InboxTaskState
import java.io.OutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The transport against a real HTTP server on loopback.
 *
 * Not a mocked client, for the same reason `CloudClientTest` is not: the
 * properties that matter are about what a SERVER received and about what a
 * SOCKET did — a claim token that must not appear in a request target, a
 * redirect that must not be followed, and above all a healthy ciphertext body
 * that must still be readable after the call that opened it has returned. None
 * of those is observable from the client's own intentions.
 */
class InboxTransportTest {

    private fun jsonServer(body: () -> String) = RecordingHttpServer { _, out: OutputStream ->
        RecordingHttpServer.respond(out, body = body().toByteArray())
    }

    private fun receiver(origin: String, client: OkHttpClient? = null) =
        if (client == null) {
            OkHttpInboxTransport.forDevice(
                origin, "relayium-test/1", "rlm_cli_test", InboxFixtures.DEVICE_ID,
            )
        } else {
            OkHttpInboxTransport.forDevice(
                origin, "relayium-test/1", "rlm_cli_test", InboxFixtures.DEVICE_ID, client,
            )
        }

    private fun sender(origin: String) =
        OkHttpInboxTransport.forAccount(origin, "relayium-test/1", "rlm_cli_test")

    private fun deviceListBody(vararg rows: Json.Obj) =
        Json.stringify(Json.obj("devices" to Json.arr(rows.toList())))

    // ── the streaming body owns its socket ──────────────────────────────────

    /**
     * The regression that matters most in this file.
     *
     * A ciphertext body is consumed by the CALLER, after `blob` has returned. A
     * cancellation watcher whose normal exit cancels the call therefore tears
     * down every HEALTHY stream at its headers — no cancellation involved, no
     * error reported at the point of the mistake, and the delivery simply fails
     * to read. The server here holds the tail until the call has returned, which
     * is what makes the window observable rather than a race.
     */
    @Test
    fun `a healthy ciphertext body is readable after blob returns`() {
        val payload = ByteArray(128 * 1024) { (it % 251).toByte() }
        val released = CountDownLatch(1)
        val server = RecordingHttpServer { _, out: OutputStream ->
            out.write(
                (
                    "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n" +
                        "Content-Length: ${payload.size}\r\nConnection: close\r\n\r\n"
                    ).toByteArray(),
            )
            // A prefix now, the tail only once the caller holds the stream.
            out.write(payload, 0, 1024)
            out.flush()
            released.await(10, TimeUnit.SECONDS)
            out.write(payload, 1024, payload.size - 1024)
            out.flush()
        }
        server.use {
            runBlocking {
                val read = receiver(server.origin)
                    .withBlob(InboxFixtures.TASK_ID, "claim-token-value", 0) { stream ->
                        released.countDown()
                        drain(stream)
                    }
                assertEquals(payload.size, read.size)
                assertArrayEquals(payload, read)
            }
        }
    }

    /**
     * The other half of the same ownership question: a cancelled worker must
     * release the socket even while it is BLOCKED inside a read.
     *
     * The watcher spans the whole consuming block, so cancellation tears the
     * call down under the reader, which is what actually unblocks it. The
     * assertion is the TIMEOUT rather than any value: a design whose cleanup
     * waits for the caller to finish would never reach the join, because the
     * caller cannot finish while this read is outstanding.
     */
    @Test
    fun `cancelling the caller unblocks a stalled read`() {
        val holding = CountDownLatch(1)
        val server = RecordingHttpServer { _, out: OutputStream ->
            out.write(
                (
                    "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n" +
                        "Content-Length: 1048576\r\nConnection: close\r\n\r\n"
                    ).toByteArray(),
            )
            out.write(ByteArray(64))
            out.flush()
            // Never sends the rest: the reader is now genuinely stuck.
            holding.await(15, TimeUnit.SECONDS)
        }
        server.use {
            runBlocking {
                val reading = CountDownLatch(1)
                val worker = launch(Dispatchers.IO) {
                    receiver(server.origin)
                        .withBlob(InboxFixtures.TASK_ID, "claim-token-value", 0) { stream ->
                            val buffer = ByteArray(8192)
                            reading.countDown()
                            while (stream.read(buffer) >= 0) {
                                // blocks here until the socket is torn down
                            }
                        }
                }
                assertTrue("the worker never reached its read", reading.await(10, TimeUnit.SECONDS))
                worker.cancel()
                withTimeout(10_000) { worker.join() }
                holding.countDown()
            }
        }
    }

    /**
     * A cancellation that lands while the response headers are being delivered
     * must leave nothing acquired.
     *
     * This is the window a returned-handle design cannot close: the call has
     * succeeded, so a watcher that only fires "before the response is in hand"
     * stands down, and the caller never receives the handle it would have had to
     * close. Here there is no handle at all — the body is opened and closed
     * inside one block — so the property to assert is that the SERVER sees its
     * connection go away rather than stay open forever.
     */
    @Test
    fun `a cancellation racing the response leaves no live socket`() {
        val closedByClient = CountDownLatch(1)
        val server = RecordingHttpServer { _, out: OutputStream ->
            out.write(
                (
                    "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n" +
                        "Content-Length: 1048576\r\nConnection: close\r\n\r\n"
                    ).toByteArray(),
            )
            try {
                // Writing into an abandoned socket is how this side learns the
                // client let go. Without the fix it would block here instead.
                while (true) {
                    out.write(ByteArray(16 * 1024))
                    out.flush()
                }
            } catch (_: Exception) {
                closedByClient.countDown()
            }
        }
        server.use {
            runBlocking {
                val worker = launch(Dispatchers.IO) {
                    receiver(server.origin)
                        .withBlob(InboxFixtures.TASK_ID, "claim-token-value", 0) {
                            // Never reads: the coroutine is cancelled underneath.
                            kotlinx.coroutines.awaitCancellation()
                        }
                }
                Thread.sleep(200)
                worker.cancel()
                withTimeout(10_000) { worker.join() }
            }
            assertTrue(
                "the socket must not survive the cancelled caller",
                closedByClient.await(10, TimeUnit.SECONDS),
            )
        }
    }

    // ── credentials and paths ───────────────────────────────────────────────

    /** A claim token is a lease bearer. In a request target it would land in
     *  every proxy and access log between here and the server. */
    @Test
    fun `the claim token travels as a header and never in the target`() {
        val server = RecordingHttpServer { _, out: OutputStream ->
            RecordingHttpServer.respond(out, contentType = "application/octet-stream")
        }
        server.use {
            runBlocking {
                receiver(server.origin)
                    .withBlob(InboxFixtures.TASK_ID, "claim-token-value", 0) { drain(it) }
            }
            val request = server.received.single()
            assertEquals("claim-token-value", request.header(InboxProtocol.CLAIM_TOKEN_HEADER))
            assertFalse(request.target.contains("claim-token-value"))
            assertFalse(request.query.contains("claim"))
            assertTrue(request.path.endsWith("/inbox/tasks/${InboxFixtures.TASK_ID}/blob"))
        }
    }

    /**
     * An injected client must not be able to weaken this.
     *
     * The seam exists so a test can supply timeouts, not so a caller can hand in
     * a redirect-following client and quietly forward a bearer and a claim token
     * to whatever host answered. The permissive client below is exactly what
     * that mistake would look like.
     */
    @Test
    fun `an injected redirect-following client is hardened before use`() {
        val permissive = OkHttpClient.Builder()
            .followRedirects(true)
            .followSslRedirects(true)
            .build()
        val elsewhere = jsonServer { """{"devices":[]}""" }
        elsewhere.use {
            val redirecting = RecordingHttpServer { _, out: OutputStream ->
                RecordingHttpServer.redirect(out, "${elsewhere.origin}/api/devices")
            }
            redirecting.use {
                runBlocking {
                    val failed = try {
                        receiver(redirecting.origin, permissive).currentDevice()
                        false
                    } catch (_: InboxApiException) {
                        true
                    }
                    assertTrue("a 302 must not be followed", failed)
                }
                assertTrue(
                    "the credential must never reach the redirect target",
                    elsewhere.received.isEmpty(),
                )
            }
        }
    }

    // ── identity of the answer ──────────────────────────────────────────────

    @Test
    fun `current device must be the device this transport was built for`() {
        val other = InboxFixtures.device("ID" to Json.of(InboxFixtures.OTHER_DEVICE_ID))
        val server = jsonServer { deviceListBody(other) }
        server.use {
            runBlocking {
                val e = wireRefusal { receiver(server.origin).currentDevice() }
                assertEquals(InboxWireReason.IDENTITY_MISMATCH, e.reason)
            }
        }
    }

    @Test
    fun `two current rows are refused rather than resolved to the first`() {
        val a = InboxFixtures.device()
        val b = InboxFixtures.device("ID" to Json.of(InboxFixtures.OTHER_DEVICE_ID))
        val server = jsonServer { deviceListBody(a, b) }
        server.use {
            runBlocking {
                val e = wireRefusal { receiver(server.origin).currentDevice() }
                assertEquals(InboxWireReason.IDENTITY_MISMATCH, e.reason)
            }
        }
    }

    @Test
    fun `no current row is refused rather than defaulted to the first device`() {
        val server = jsonServer {
            deviceListBody(InboxFixtures.device("Current" to Json.of(false)))
        }
        server.use {
            runBlocking {
                val e = wireRefusal { receiver(server.origin).currentDevice() }
                assertEquals(InboxWireReason.IDENTITY_MISMATCH, e.reason)
            }
        }
    }

    /**
     * A create is the one call whose answer licenses a sender to stop retrying,
     * so its identity is checked field by field. Central converges on
     * `(user, idempotencyKey)`, and a task naming a different stored object is
     * therefore a DIFFERENT delivery — recording it as this job's outcome would
     * mark an unsent file as sent.
     */
    @Test
    fun `a create answer naming another delivery is refused`() {
        val request = InboxSendRequest(
            idempotencyKey = "idem-1",
            storedFileId = InboxFixtures.STORED_ID,
            wrappedKey = InboxFixtures.wrappedKey(),
            targetKeyId = InboxFixtures.KEY_ID,
            targetKeyGeneration = 1,
        )
        val mismatches = listOf(
            "IdempotencyKey" to Json.of("someone-elses"),
            "StoredFileID" to Json.of(InboxFixtures.OTHER_DEVICE_ID),
            "TargetKeyID" to Json.of(InboxFixtures.TASK_ID),
            "TargetKeyGeneration" to Json.of(9L),
            "TargetDeviceID" to Json.of(InboxFixtures.OTHER_DEVICE_ID),
        )
        for (mismatch in mismatches) {
            // 201, so the status/`created` agreement passes and the IDENTITY
            // check is the thing actually under test.
            val server = RecordingHttpServer { _, out: OutputStream ->
                RecordingHttpServer.respond(
                    out, status = "201 Created",
                    body = Json.stringify(
                        Json.obj(
                            "task" to InboxFixtures.task(mismatch),
                            "created" to Json.of(true),
                        ),
                    ).toByteArray(),
                )
            }
            server.use {
                runBlocking {
                    val e = wireRefusal {
                        sender(server.origin).createTask(InboxFixtures.DEVICE_ID, request)
                    }
                    assertEquals(
                        "mismatch on ${mismatch.first}",
                        InboxWireReason.IDENTITY_MISMATCH, e.reason,
                    )
                }
            }
        }
    }

    /** 200 means converged, 201 means minted. A `created` that disagrees with
     *  the status is a server this build does not understand. */
    @Test
    fun `a created flag disagreeing with the status is refused`() {
        val server = RecordingHttpServer { _, out: OutputStream ->
            RecordingHttpServer.respond(
                out,
                body = Json.stringify(
                    Json.obj("task" to InboxFixtures.task(), "created" to Json.of(true)),
                ).toByteArray(),
            )
        }
        server.use {
            runBlocking {
                val request = InboxSendRequest(
                    "idem-1", InboxFixtures.STORED_ID, InboxFixtures.wrappedKey(),
                    InboxFixtures.KEY_ID, 1,
                )
                // 200 + created:true — a converged retry cannot also be a mint.
                val e = wireRefusal {
                    sender(server.origin).createTask(InboxFixtures.DEVICE_ID, request)
                }
                assertEquals(InboxWireReason.MALFORMED, e.reason)
                assertEquals("created", e.field)
            }
        }
    }

    /** Any other 2xx is not a contract this build knows; treating one as success
     *  would record an unacknowledged send as delivered. */
    @Test
    fun `an accepted-but-not-created status is refused`() {
        val server = RecordingHttpServer { _, out: OutputStream ->
            RecordingHttpServer.respond(
                out, status = "202 Accepted",
                body = Json.stringify(
                    Json.obj("task" to InboxFixtures.task(), "created" to Json.of(false)),
                ).toByteArray(),
            )
        }
        server.use {
            runBlocking {
                val request = InboxSendRequest(
                    "idem-1", InboxFixtures.STORED_ID, InboxFixtures.wrappedKey(),
                    InboxFixtures.KEY_ID, 1,
                )
                val e = wireRefusal {
                    sender(server.origin).createTask(InboxFixtures.DEVICE_ID, request)
                }
                assertEquals(InboxWireReason.MALFORMED, e.reason)
                assertEquals("status", e.field)
            }
        }
    }

    /** A registration that named a different public key would bind a local
     *  private key to the wrong id, making every task sealed to it unopenable. */
    @Test
    fun `a key registration answering with another public key is refused`() {
        val server = jsonServer {
            Json.stringify(Json.obj("key" to InboxFixtures.key()))
        }
        server.use {
            runBlocking {
                val e = wireRefusal {
                    receiver(server.origin).registerKey(
                        InboxProtocol.KEY_ALGORITHM, "a-different-public-key", null,
                    )
                }
                assertEquals(InboxWireReason.IDENTITY_MISMATCH, e.reason)
            }
        }
    }

    @Test
    fun `a report answering about another task is refused`() {
        val server = jsonServer {
            Json.stringify(
                Json.obj("task" to InboxFixtures.task("ID" to Json.of(InboxFixtures.STORED_ID))),
            )
        }
        server.use {
            runBlocking {
                val e = wireRefusal {
                    receiver(server.origin).report(
                        InboxFixtures.TASK_ID, "claim", InboxTaskState.DOWNLOADING,
                        InboxDeviceErrorCode.NONE, committed = false,
                    )
                }
                assertEquals(InboxWireReason.IDENTITY_MISMATCH, e.reason)
            }
        }
    }

    // ── refusals before the wire ────────────────────────────────────────────

    /**
     * Asserted by the server having received NOTHING — the only way to tell
     * "refused locally" apart from "refused after we said it".
     */
    @Test
    fun `saved without a commit assertion never reaches the network`() {
        val server = jsonServer { """{"task":{}}""" }
        server.use {
            runBlocking {
                assertRejectedLocally {
                    receiver(server.origin).report(
                        InboxFixtures.TASK_ID, "claim", InboxTaskState.SAVED,
                        InboxDeviceErrorCode.NONE, committed = false,
                    )
                }
                assertRejectedLocally {
                    receiver(server.origin).report(
                        // Central's own decisions about time and scheduling; a
                        // device that could report them could reset its backoff
                        // or forge central's account of events.
                        InboxFixtures.TASK_ID, "claim", InboxTaskState.QUEUED,
                        InboxDeviceErrorCode.NONE, committed = false,
                    )
                }
                assertRejectedLocally {
                    receiver(server.origin).report(
                        InboxFixtures.TASK_ID, "", InboxTaskState.DOWNLOADING,
                        InboxDeviceErrorCode.NONE, committed = false,
                    )
                }
            }
            assertTrue("nothing may reach the network", server.received.isEmpty())
        }
    }

    // ── ranges ──────────────────────────────────────────────────────────────

    @Test
    fun `a partial answer reports its range start`() {
        val server = RecordingHttpServer { _, out: OutputStream ->
            RecordingHttpServer.respond(
                out, status = "206 Partial Content",
                contentType = "application/octet-stream",
                body = ByteArray(16),
                extraHeaders = listOf("Content-Range: bytes 4096-4111/4112"),
            )
        }
        server.use {
            runBlocking {
                receiver(server.origin).withBlob(InboxFixtures.TASK_ID, "claim", 4096) {
                    assertTrue(it.isPartial)
                    assertEquals(4096L, it.rangeStart)
                }
            }
            assertEquals("bytes=4096-", server.received.single().header("Range"))
        }
    }

    /**
     * A 206 this build cannot read is refused BEFORE the body is consumed.
     *
     * The refusal belongs here rather than in the receiver: by the time
     * plaintext is being produced, a wrong offset has already been spliced in,
     * and every frame of it authenticates.
     */
    @Test
    fun `a partial answer with a malformed range is refused before any body is read`() {
        val server = RecordingHttpServer { _, out: OutputStream ->
            RecordingHttpServer.respond(
                out, status = "206 Partial Content",
                contentType = "application/octet-stream",
                body = ByteArray(16),
                extraHeaders = listOf("Content-Range: bytes 4096-garbage"),
            )
        }
        server.use {
            runBlocking {
                var consumed = false
                val e = wireRefusal {
                    receiver(server.origin)
                        .withBlob(InboxFixtures.TASK_ID, "claim", 4096) { consumed = true }
                }
                assertEquals(InboxWireReason.MALFORMED, e.reason)
                assertEquals("Content-Range", e.field)
                assertFalse("the body must not be consumed", consumed)
            }
        }
    }

    /** A tail starting somewhere other than where the resume asked would splice
     *  the wrong region of the object into the stream. */
    @Test
    fun `a partial answer starting at another offset is refused`() {
        val server = RecordingHttpServer { _, out: OutputStream ->
            RecordingHttpServer.respond(
                out, status = "206 Partial Content",
                contentType = "application/octet-stream",
                body = ByteArray(16),
                extraHeaders = listOf("Content-Range: bytes 8192-8207/16384"),
            )
        }
        server.use {
            runBlocking {
                var consumed = false
                val e = wireRefusal {
                    receiver(server.origin)
                        .withBlob(InboxFixtures.TASK_ID, "claim", 4096) { consumed = true }
                }
                assertEquals(InboxWireReason.IDENTITY_MISMATCH, e.reason)
                assertEquals("Content-Range", e.field)
                assertFalse("the body must not be consumed", consumed)
            }
        }
    }

    /**
     * A resume the server answered with a full body is a FRESH START, and the
     * transport says so rather than letting a caller splice it into the middle
     * of a stream — which would produce authenticated-looking rubbish.
     */
    @Test
    fun `a resume answered with a full body is not reported as partial`() {
        val server = RecordingHttpServer { _, out: OutputStream ->
            RecordingHttpServer.respond(
                out, contentType = "application/octet-stream", body = ByteArray(16),
            )
        }
        server.use {
            runBlocking {
                receiver(server.origin).withBlob(InboxFixtures.TASK_ID, "claim", 4096) {
                    assertFalse("a 200 is not a tail", it.isPartial)
                    assertEquals(-1L, it.rangeStart)
                }
            }
        }
    }

    // ── rejections ──────────────────────────────────────────────────────────

    @Test
    fun `a rejection contributes its status and token and nothing else`() {
        val server = RecordingHttpServer { _, out: OutputStream ->
            RecordingHttpServer.respond(
                out, status = "409 Conflict",
                body = """{"error":"stale_claim","secret":"/Users/lily/photo.jpg"}""".toByteArray(),
            )
        }
        server.use {
            runBlocking {
                val e = try {
                    receiver(server.origin).withBlob(InboxFixtures.TASK_ID, "claim", 0) { }
                    throw AssertionError("expected a rejection")
                } catch (thrown: InboxApiException) {
                    thrown
                }
                assertEquals(409, e.status)
                assertEquals(InboxRejection.STALE_CLAIM, e.rejection)
                assertFalse(
                    "a rejection must not carry the body",
                    e.message!!.contains("photo.jpg"),
                )
            }
        }
    }

    /** An unrecognised token keeps its status and stays unrecognised, so it can
     *  never be mistaken for one this build branches on. */
    @Test
    fun `an unknown rejection token is not resolved to a known one`() {
        val server = RecordingHttpServer { _, out: OutputStream ->
            RecordingHttpServer.respond(
                out, status = "409 Conflict", body = """{"error":"brand_new_reason"}""".toByteArray(),
            )
        }
        server.use {
            runBlocking {
                val e = try {
                    receiver(server.origin).heartbeat(true)
                    throw AssertionError("expected a rejection")
                } catch (thrown: InboxApiException) {
                    thrown
                }
                assertEquals(409, e.status)
                assertNull(e.rejection)
            }
        }
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private fun drain(stream: InboxBlobStream): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val n = stream.read(buffer)
            if (n < 0) break
            out.write(buffer, 0, n)
        }
        return out.toByteArray()
    }

    private inline fun wireRefusal(body: () -> Unit): InboxWireException =
        try {
            body()
            throw AssertionError("expected a wire refusal")
        } catch (e: InboxWireException) {
            e
        }

    private inline fun assertRejectedLocally(body: () -> Unit) {
        try {
            body()
            throw AssertionError("expected a local refusal")
        } catch (_: IllegalArgumentException) {
            // expected: refused before a request was built
        }
    }

    private fun assertArrayEquals(expected: ByteArray, actual: ByteArray) {
        org.junit.Assert.assertArrayEquals(expected, actual)
    }

}
