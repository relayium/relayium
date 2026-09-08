package com.relayium.android.cloud

import com.relayium.protocol.stored.BytesSource
import com.relayium.protocol.stored.ManifestFile
import com.relayium.protocol.stored.STORE_CHUNK_SIZE
import com.relayium.protocol.stored.StoreDecryptor
import com.relayium.protocol.stored.StoredManifest
import com.relayium.protocol.stored.cipherSize
import com.relayium.protocol.stored.decryptManifestRaw
import com.relayium.protocol.stored.encryptChunks
import com.relayium.protocol.stored.encryptManifest
import java.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The stored transport against a real HTTP server on loopback.
 *
 * Not a mocked client: the assertions that matter here are about bytes and
 * headers as a SERVER received them — the exact body layout, the declared
 * `Content-Length`, and above all the absence of a credential on a redirected
 * ciphertext read. A fake transport can only ever confirm what this code
 * intended to send.
 */
class CloudClientTest {

    private val key = ByteArray(32) { 0x55 }
    private val manifest = StoredManifest(
        listOf(ManifestFile("hello.txt", 11), ManifestFile("b.txt", 3)),
    )
    private val files = listOf("hello world".toByteArray(), "xyz".toByteArray())

    private fun client(origin: String) = CloudClient(origin, "relayium-test/1")

    private fun plan(burn: Boolean = false, ttl: Int = 86_400) = StoredUploadPlan(
        key = key,
        manifest = manifest,
        sources = files.mapIndexed { i, bytes -> BytesSource(manifest.files[i].name, bytes) },
        burnAfterRead = burn,
        ttlSeconds = ttl,
    )

    private fun failure(body: () -> Unit): CloudFailure =
        try {
            body()
            throw AssertionError("expected a classified cloud failure")
        } catch (e: CloudException) {
            e.failure
        }

    private fun blobBody(): ByteArray = encryptChunks(key, files)

    // ── upload ──────────────────────────────────────────────────────────────

    @Test
    fun `upload streams the exact stored-wire body under the account bearer`() {
        RecordingHttpServer { _, out ->
            RecordingHttpServer.respond(out, body = """{"id":"abc123","expiresAt":99}""".toByteArray())
        }.use { server ->
            val result = runBlocking {
                client(server.origin).upload(plan(), "secret-token") { _, _ -> }
            }
            assertEquals(StoredUploadResult("abc123", 99), result)

            val request = server.received.single()
            assertEquals("POST", request.method)
            assertEquals("/api/files", request.path)
            assertEquals("burnAfterRead=0&ttl=86400", request.query)
            assertEquals("Bearer secret-token", request.header("Authorization"))
            assertEquals("application/octet-stream", request.header("Content-Type"))

            // The body is the wire, byte for byte: uint32BE(len) || encManifest
            // || frames. Declared exactly, never chunked — the server's quota
            // pre-check reads Content-Length to refuse before the bytes cross.
            val encManifest = encryptManifest(key, manifest)
            val expected = byteArrayOf(0, 0, 0, encManifest.size.toByte()) + encManifest + blobBody()
            assertArrayEquals(expected, request.body)
            assertEquals(expected.size.toString(), request.header("Content-Length"))
            assertEquals(
                4L + encManifest.size + cipherSize(manifest.files.map { it.size }),
                expected.size.toLong(),
            )
        }
    }

    @Test
    fun `an independent reader decrypts what the upload actually sent`() {
        RecordingHttpServer { _, out ->
            RecordingHttpServer.respond(out, body = """{"id":"abc123","expiresAt":1}""".toByteArray())
        }.use { server ->
            runBlocking { client(server.origin).upload(plan(), "t") { _, _ -> } }
            val body = server.received.single().body

            // Read it back the way any other client would: length prefix, seq-0
            // manifest, then the framed stream.
            val length = ((body[0].toInt() and 0xff) shl 24) or ((body[1].toInt() and 0xff) shl 16) or
                ((body[2].toInt() and 0xff) shl 8) or (body[3].toInt() and 0xff)
            val decoded = decryptManifestRaw(key, body.copyOfRange(4, 4 + length))
            assertEquals(manifest, decoded)

            val decryptor = StoreDecryptor(key)
            val chunks = decryptor.push(body.copyOfRange(4 + length, body.size))
            decryptor.end(14)
            assertArrayEquals(files[0] + files[1], chunks.reduce { a, b -> a + b })
        }
    }

    @Test
    fun `burn-after-read and retention travel as the server reads them`() {
        RecordingHttpServer { _, out ->
            RecordingHttpServer.respond(out, body = """{"id":"a","expiresAt":1}""".toByteArray())
        }.use { server ->
            runBlocking { client(server.origin).upload(plan(burn = true, ttl = 3600), "t") { _, _ -> } }
            assertEquals("burnAfterRead=1&ttl=3600", server.received.single().query)
        }
    }

    @Test
    fun `progress reaches the declared total exactly once`() {
        RecordingHttpServer { _, out ->
            RecordingHttpServer.respond(out, body = """{"id":"a","expiresAt":1}""".toByteArray())
        }.use { server ->
            val seen = ArrayList<Pair<Long, Long>>()
            runBlocking { client(server.origin).upload(plan(), "t") { s, t -> seen.add(s to t) } }
            val total = seen.first().second
            assertEquals(total, seen.last().first)
            assertTrue("progress must not go backwards", seen.zipWithNext().all { it.first.first <= it.second.first })
        }
    }

    @Test
    fun `a large file is streamed in chunks, not buffered whole`() {
        val big = ByteArray(STORE_CHUNK_SIZE * 2 + 5) { (it % 251).toByte() }
        val bigManifest = StoredManifest(listOf(ManifestFile("big.bin", big.size.toLong())))
        RecordingHttpServer { _, out ->
            RecordingHttpServer.respond(out, body = """{"id":"a","expiresAt":1}""".toByteArray())
        }.use { server ->
            runBlocking {
                client(server.origin).upload(
                    StoredUploadPlan(key, bigManifest, listOf(BytesSource("big.bin", big)), false, 3600),
                    "t",
                ) { _, _ -> }
            }
            val body = server.received.single().body
            val encManifest = encryptManifest(key, bigManifest)
            val stream = body.copyOfRange(4 + encManifest.size, body.size)
            val decryptor = StoreDecryptor(key)
            val chunks = decryptor.push(stream)
            decryptor.end(big.size.toLong())
            // Three frames: two full chunks and a five-byte tail.
            assertEquals(listOf(STORE_CHUNK_SIZE, STORE_CHUNK_SIZE, 5), chunks.map { it.size })
        }
    }

    @Test
    fun `every upload refusal is classified, never rendered from server prose`() {
        val cases = listOf(
            "400 Bad Request" to CloudFailure(CloudFailure.Kind.REJECTED),
            "401 Unauthorized" to CloudFailure(CloudFailure.Kind.UNAUTHORIZED),
            "413 Payload Too Large" to CloudFailure(CloudFailure.Kind.STORAGE_LIMIT),
            "503 Service Unavailable" to CloudFailure(CloudFailure.Kind.STORAGE_UNAVAILABLE),
            "507 Insufficient Storage" to CloudFailure(CloudFailure.Kind.SERVER_FULL),
            "500 Internal Server Error" to CloudFailure(CloudFailure.Kind.SERVER, 500),
        )
        for ((status, expected) in cases) {
            RecordingHttpServer { _, out ->
                RecordingHttpServer.respond(out, status = status, body = "nope".toByteArray())
            }.use { server ->
                val failure = failure {
                    runBlocking { client(server.origin).upload(plan(), "t") { _, _ -> } }
                }
                assertEquals(status, expected, failure)
            }
        }
    }

    @Test
    fun `the three different 429s are told apart, and an unknown one fails safe`() {
        val cases = listOf(
            "daily quota exceeded" to CloudFailure.Kind.DAILY_QUOTA,
            "monthly traffic limit reached — upgrade to continue" to CloudFailure.Kind.MONTHLY_TRAFFIC,
            "too many concurrent uploads" to CloudFailure.Kind.RATE_LIMITED,
            "something new the server started saying" to CloudFailure.Kind.RATE_LIMITED,
        )
        for ((body, expected) in cases) {
            RecordingHttpServer { _, out ->
                RecordingHttpServer.respond(out, status = "429 Too Many Requests", body = body.toByteArray())
            }.use { server ->
                val failure = failure {
                    runBlocking { client(server.origin).upload(plan(), "t") { _, _ -> } }
                }
                assertEquals(body, expected, failure.kind)
            }
        }
    }

    @Test
    fun `an upload never follows a redirect, because it carries a bearer`() {
        RecordingHttpServer { _, out ->
            RecordingHttpServer.redirect(out, "http://127.0.0.1:1/steal")
        }.use { server ->
            val failure = failure {
                runBlocking { client(server.origin).upload(plan(), "t") { _, _ -> } }
            }
            assertEquals(CloudFailure(CloudFailure.Kind.SERVER, 302), failure)
            assertEquals(1, server.received.size)
        }
    }

    // ── metadata ────────────────────────────────────────────────────────────

    private fun metaJson(): String {
        val encoded = Base64.getEncoder().encodeToString(encryptManifest(key, manifest))
        return """{"encManifest":"$encoded","size":54,"burnAfterRead":true,"expiresAt":123}"""
    }

    @Test
    fun `metadata is fetched anonymously and decrypts to the manifest`() {
        RecordingHttpServer { _, out ->
            RecordingHttpServer.respond(out, body = metaJson().toByteArray())
        }.use { server ->
            val meta = runBlocking { client(server.origin).fetchMeta("abc123") }
            assertEquals(54L, meta.size)
            assertTrue(meta.burnAfterRead)
            assertEquals(123L, meta.expiresAt)
            assertEquals(manifest, decryptManifestRaw(key, meta.encManifest))

            val request = server.received.single()
            assertEquals("/api/files/abc123/meta", request.path)
            // Anonymous: a stored object is opened by holding its key, not by
            // being anybody. Nothing identifying is offered for it.
            assertNull(request.header("Authorization"))
            assertNull(request.header("Cookie"))
        }
    }

    @Test
    fun `an identifier that is not one never reaches the network`() {
        RecordingHttpServer { _, out -> RecordingHttpServer.respond(out) }.use { server ->
            for (bad in listOf("../secrets", "a/b", "a?b", "a#b", "", "a".repeat(129))) {
                val failure = failure { runBlocking { client(server.origin).fetchMeta(bad) } }
                assertEquals(bad, CloudFailure.Kind.LINK_INVALID, failure.kind)
            }
            assertEquals(0, server.received.size)
        }
    }

    @Test
    fun `a missing or limited object is named as such, not as a server error`() {
        val cases = listOf(
            "404 Not Found" to CloudFailure(CloudFailure.Kind.NOT_FOUND),
            "429 Too Many Requests" to CloudFailure(CloudFailure.Kind.DOWNLOAD_LIMITED),
            "503 Service Unavailable" to CloudFailure(CloudFailure.Kind.DOWNLOAD_UNAVAILABLE, 503),
        )
        for ((status, expected) in cases) {
            RecordingHttpServer { _, out ->
                RecordingHttpServer.respond(out, status = status, body = "x".toByteArray())
            }.use { server ->
                assertEquals(
                    status,
                    expected,
                    failure { runBlocking { client(server.origin).fetchMeta("abc123") } },
                )
            }
        }
    }

    // ── ciphertext download ─────────────────────────────────────────────────

    private fun serveBlob(body: ByteArray) = RecordingHttpServer { _, out ->
        RecordingHttpServer.respond(out, contentType = "application/octet-stream", body = body)
    }

    private fun download(origin: String, id: String = "abc123"): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        runBlocking {
            client(origin).downloadBlob(StoredLink.of(id, key)!!, manifest) { out.write(it) }
        }
        return out.toByteArray()
    }

    @Test
    fun `the ciphertext is read anonymously and authenticates back to the files`() {
        serveBlob(blobBody()).use { server ->
            assertArrayEquals(files[0] + files[1], download(server.origin))
            val request = server.received.single()
            assertEquals("/api/files/abc123/blob", request.path)
            assertNull(request.header("Authorization"))
            assertNull(request.header("Cookie"))
            // Native clients opt into the BYO own-node redirect explicitly; the
            // fleet redirect happens with or without it.
            assertEquals("1", request.header("X-Relayium-Direct-Download"))
        }
    }

    @Test
    fun `a validated redirect is followed and carries no credential to the new host`() {
        // This is the case the account transport's blanket redirect refusal
        // would break: server/account/files.go 302s to a fleet node whenever the
        // file is eligible, header or no header.
        serveBlob(blobBody()).use { node ->
            RecordingHttpServer { _, out ->
                RecordingHttpServer.redirect(out, "${node.origin}/dl/blobkey?t=signed")
            }.use { central ->
                assertArrayEquals(files[0] + files[1], download(central.origin))

                val hop = node.received.single()
                assertEquals("/dl/blobkey", hop.path)
                assertEquals("t=signed", hop.query)
                // The whole point: the second host is a DIFFERENT origin, and
                // nothing identifying followed the redirect there.
                assertNull("no bearer may cross a redirect", hop.header("Authorization"))
                assertNull(hop.header("Cookie"))
                // Nor may the key, which never leaves this device in any form.
                assertTrue(hop.headers.values.none { it.contains("VVVV") })
                assertNull(hop.header("Range"))
            }
        }
    }

    @Test
    fun `a redirect this client will not follow is refused, not silently retried`() {
        val refused = listOf(
            "http://user:pass@127.0.0.1:9/blob",
            "http://127.0.0.1:9/blob#k=leak",
            "intent://evil/#Intent;scheme=http;end",
            "file:///etc/passwd",
            "",
        )
        for (target in refused) {
            RecordingHttpServer { _, out -> RecordingHttpServer.redirect(out, target) }.use { server ->
                val failure = failure { download(server.origin) }
                assertEquals(target, CloudFailure.Kind.UNTRUSTED_REDIRECT, failure.kind)
            }
        }
    }

    @Test
    fun `a redirect loop stops rather than running`() {
        RecordingHttpServer { request, out ->
            RecordingHttpServer.redirect(out, "http://127.0.0.1:${request.header("x-port")}/again")
        }.use { server ->
            // Points at itself: every hop is admissible on its own and the chain
            // never ends, which is exactly what the hop bound is for.
            val looping = RecordingHttpServer { _, out ->
                RecordingHttpServer.redirect(out, "${server.origin}/again")
            }
            looping.use {
                val failure = failure { download(it.origin) }
                assertEquals(CloudFailure.Kind.UNTRUSTED_REDIRECT, failure.kind)
                assertTrue("hops must be bounded", server.received.size <= BlobRedirect.MAX_HOPS)
            }
        }
    }

    @Test
    fun `a stream cut on a frame boundary is refused against the manifest total`() {
        val body = blobBody()
        // The first file's frame, complete and perfectly authentic. Only the
        // manifest's total says the second file is missing.
        val cut = body.copyOfRange(0, 4 + 11 + 16)
        serveBlob(cut).use { server ->
            assertEquals(CloudFailure.Kind.DAMAGED, failure { download(server.origin) }.kind)
        }
    }

    @Test
    fun `an altered ciphertext byte is refused`() {
        val body = blobBody()
        body[10] = (body[10].toInt() xor 0x01).toByte()
        serveBlob(body).use { server ->
            assertEquals(CloudFailure.Kind.DAMAGED, failure { download(server.origin) }.kind)
        }
    }

    @Test
    fun `a truncated frame is refused`() {
        serveBlob(blobBody().copyOfRange(0, 12)).use { server ->
            assertEquals(CloudFailure.Kind.DAMAGED, failure { download(server.origin) }.kind)
        }
    }

    @Test
    fun `the wrong key never yields plaintext`() {
        serveBlob(blobBody()).use { server ->
            val failure = failure {
                runBlocking {
                    client(server.origin)
                        .downloadBlob(StoredLink.of("abc123", ByteArray(32) { 1 })!!, manifest) { }
                }
            }
            assertEquals(CloudFailure.Kind.DAMAGED, failure.kind)
        }
    }

    @Test
    fun `a server fact that is not a whole number is refused, never rounded`() {
        // These are facts the app then STATES to the user — when a file expires,
        // how large it is. `toLong()` would turn 1.9 into 1, -1 into a negative
        // expiry and 1e300 into Long.MAX_VALUE, each presented as though the
        // server had said it.
        val encoded = Base64.getEncoder().encodeToString(encryptManifest(key, manifest))
        val bad = listOf(
            """{"encManifest":"$encoded","size":1.5,"burnAfterRead":false,"expiresAt":1}""",
            """{"encManifest":"$encoded","size":-1,"burnAfterRead":false,"expiresAt":1}""",
            """{"encManifest":"$encoded","size":1,"burnAfterRead":false,"expiresAt":-1}""",
            """{"encManifest":"$encoded","size":1,"burnAfterRead":false,"expiresAt":1e300}""",
            """{"encManifest":"$encoded","size":1,"burnAfterRead":false}""",
            """{"encManifest":"$encoded","size":1,"expiresAt":1}""",
            """{"encManifest":"$encoded","size":1,"burnAfterRead":"yes","expiresAt":1}""",
            """{"size":1,"burnAfterRead":false,"expiresAt":1}""",
            """{"encManifest":"not base64!!","size":1,"burnAfterRead":false,"expiresAt":1}""",
        )
        for (body in bad) {
            RecordingHttpServer { _, out ->
                RecordingHttpServer.respond(out, body = body.toByteArray())
            }.use { server ->
                val failure = failure { runBlocking { client(server.origin).fetchMeta("abc123") } }
                assertEquals(body, CloudFailure.Kind.MALFORMED, failure.kind)
            }
        }
    }

    @Test
    fun `burn-after-read is never defaulted to false`() {
        // A default here would tell the user a one-shot file can be fetched
        // again, which is the one thing this flag exists to prevent.
        val encoded = Base64.getEncoder().encodeToString(encryptManifest(key, manifest))
        RecordingHttpServer { _, out ->
            RecordingHttpServer.respond(
                out,
                body = """{"encManifest":"$encoded","size":1,"burnAfterRead":true,"expiresAt":1}""".toByteArray(),
            )
        }.use { server ->
            assertTrue(runBlocking { client(server.origin).fetchMeta("abc123") }.burnAfterRead)
        }
    }

    @Test
    fun `an upload result the server could not have meant is refused`() {
        for (body in listOf(
            """{"id":"abc","expiresAt":1.5}""",
            """{"id":"abc","expiresAt":-1}""",
            """{"id":"abc"}""",
            """{"id":"../escape","expiresAt":1}""",
            """{"expiresAt":1}""",
            """not json""",
        )) {
            RecordingHttpServer { _, out ->
                RecordingHttpServer.respond(out, body = body.toByteArray())
            }.use { server ->
                val failure = failure {
                    runBlocking { client(server.origin).upload(plan(), "t") { _, _ -> } }
                }
                assertEquals(body, CloudFailure.Kind.MALFORMED, failure.kind)
            }
        }
    }

    @Test
    fun `cancelling a stalled download really stops it`() {
        // An IO dispatcher alone does not cancel a blocked socket read: without
        // binding the coroutine's cancellation to Call.cancel, this coroutine
        // would sit in `read` until a timeout the transfer deliberately does not
        // impose, long after the user left the screen.
        val stalled = java.util.concurrent.CountDownLatch(1)
        RecordingHttpServer { _, out ->
            // Headers and one frame's worth of nothing, then silence — a
            // declared length the server never finishes sending.
            RecordingHttpServer.respond(
                out,
                contentType = "application/octet-stream",
                body = blobBody().copyOfRange(0, 4),
                declaredLength = 1_000_000,
            )
            out.flush()
            stalled.await(10, java.util.concurrent.TimeUnit.SECONDS)
        }.use { server ->
            val elapsed = kotlin.system.measureTimeMillis {
                runBlocking {
                    val job = launch(Dispatchers.IO) {
                        client(server.origin).downloadBlob(StoredLink.of("abc123", key)!!, manifest) { }
                    }
                    // Give the read a moment to actually block, then cancel.
                    delay(300)
                    job.cancelAndJoin()
                }
            }
            stalled.countDown()
            assertTrue("cancellation must not wait for a timeout, took ${elapsed}ms", elapsed < 5_000)
        }
    }

    @Test
    fun `cancelling a stalled metadata read really stops it`() {
        // Valid headers, then silence. The response never arrives, so only
        // cancelling the CALL unblocks the read.
        val stalled = java.util.concurrent.CountDownLatch(1)
        RecordingHttpServer { _, out ->
            // A length UNDER the client's own body ceiling, so the read really
            // waits for the rest instead of being refused as oversize.
            RecordingHttpServer.respond(out, body = """{"encMani""".toByteArray(), declaredLength = 1_000)
            out.flush()
            stalled.await(10, java.util.concurrent.TimeUnit.SECONDS)
        }.use { server ->
            val elapsed = kotlin.system.measureTimeMillis {
                runBlocking {
                    val job = launch(Dispatchers.IO) { client(server.origin).fetchMeta("abc123") }
                    delay(300)
                    job.cancelAndJoin()
                }
            }
            stalled.countDown()
            assertTrue("cancellation must not wait for a timeout, took ${elapsed}ms", elapsed < 5_000)
        }
    }

    @Test
    fun `an already-cancelled caller issues no request at all`() {
        // The watcher that cancels the call must be registered BEFORE the
        // blocking work, and an already-cancelled scope must not reach the
        // network — otherwise a request is started only to be torn down, and a
        // watcher cancelled before it was ever dispatched would never have run
        // its cleanup.
        RecordingHttpServer { _, out -> RecordingHttpServer.respond(out) }.use { server ->
            val scope = kotlinx.coroutines.CoroutineScope(Dispatchers.IO)
            scope.cancel()
            runBlocking {
                val job = scope.launch { client(server.origin).fetchMeta("abc123") }
                job.join()
            }
            assertTrue(job(server), server.received.isEmpty())
        }
    }

    private fun job(server: RecordingHttpServer) =
        "a cancelled caller must not reach the network, saw ${server.received.size} request(s)"

    @Test
    fun `a burned or expired object reads as gone, not as a broken link`() {
        RecordingHttpServer { _, out ->
            RecordingHttpServer.respond(out, status = "404 Not Found", body = "not found".toByteArray())
        }.use { server ->
            assertEquals(CloudFailure.Kind.NOT_FOUND, failure { download(server.origin) }.kind)
        }
    }
}
