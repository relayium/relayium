package com.relayium.android.cloud

import com.relayium.protocol.stored.ManifestFile
import com.relayium.protocol.stored.STORE_CHUNK_SIZE
import com.relayium.protocol.stored.StoredManifest
import com.relayium.protocol.stored.encryptChunks
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The stored download's bounded recovery, against a real HTTP server that can
 * break a connection wherever the case needs it broken.
 *
 * ## What these assert, and why each is a separate case
 *
 * The recovery is a transport that keeps feeding ONE decryptor across more than
 * one request, so the failure this suite exists to catch is not "the retry did
 * not happen" — it is a retry that happened and produced plausible rubbish.
 * Every case therefore checks the BYTES, not just the outcome: a resume that
 * re-fed one frame, skipped one, or spliced a fresh body into the middle would
 * still reach the end of the stream, and only an exact comparison against the
 * plaintext the sender encrypted tells the two apart.
 *
 * The other half is what must NOT be retried. A download-limited or
 * burn-after-read object is a request the client may issue exactly once, and the
 * server's own `Accept-Ranges` is what says which kind is in front of it — so
 * the "one GET" cases below are a metering and burn-semantics assertion, not a
 * performance one.
 */
class CloudResumeTest {

    private val key = ByteArray(32) { 0x55 }

    /** Two files, and the first spans more than one 192 KiB frame — so a cut
     *  "mid-frame" and a cut "on a frame boundary" are genuinely different
     *  offsets in this body rather than the same one twice. */
    private val bodies = listOf(
        ByteArray(STORE_CHUNK_SIZE + 4_096) { (it % 251).toByte() },
        "the second file".toByteArray(),
    )

    private val manifest = StoredManifest(
        listOf(
            ManifestFile("big.bin", bodies[0].size.toLong()),
            ManifestFile("small.txt", bodies[1].size.toLong()),
        ),
    )

    private val plaintext = bodies[0] + bodies[1]
    private val cipher = encryptChunks(key, bodies)

    /** The first frame's exact ciphertext length: 4-byte prefix, chunk, tag. */
    private val firstFrame = 4 + STORE_CHUNK_SIZE + 16

    private fun client(origin: String) = CloudClient(origin, "relayium-test/1")

    private fun failure(body: () -> Unit): CloudFailure =
        try {
            body()
            throw AssertionError("expected a classified cloud failure")
        } catch (e: CloudException) {
            e.failure
        }

    // ── the server ──────────────────────────────────────────────────────────

    /**
     * A blob host that serves `cipher`, cutting the body where a case says and
     * answering `Range` the way a case says.
     *
     * [cuts] is consulted per request: a null entry serves that attempt whole.
     * The point of driving it per-attempt rather than per-server is that the
     * interesting sequences are "break, then behave" and "break, then misbehave",
     * and both need the same connection story on the first request.
     */
    private fun host(
        cuts: List<Int?>,
        acceptRanges: Boolean = true,
        rangeAnswer: RangeAnswer = RangeAnswer.HONOUR,
    ): RecordingHttpServer {
        val attempt = AtomicInteger(0)
        return RecordingHttpServer { request, out ->
            val n = attempt.getAndIncrement()
            val range = request.header("Range")
            val start = range?.removePrefix("bytes=")?.removeSuffix("-")?.toLongOrNull() ?: 0L
            val cut = cuts.getOrNull(n)
            when {
                range == null -> {
                    val body = cipher.copyOfRange(0, cut ?: cipher.size)
                    val extra = buildList {
                        if (acceptRanges) add("Accept-Ranges: bytes")
                    }
                    // The DECLARED length is always the whole object, even when
                    // this connection is about to deliver less: that is exactly
                    // what a real interrupted download looks like, and it is
                    // what tells a short body from a complete one.
                    writeHead(out, "200 OK", cipher.size.toLong(), extra)
                    out.write(body)
                }

                rangeAnswer == RangeAnswer.IGNORE -> {
                    // The dangerous answer: a full body in reply to a resume.
                    writeHead(out, "200 OK", cipher.size.toLong(), listOf("Accept-Ranges: bytes"))
                    out.write(cipher)
                }

                else -> {
                    val total = cipher.size.toLong()
                    val reported = when (rangeAnswer) {
                        RangeAnswer.WRONG_START -> start + 1
                        else -> start
                    }
                    val reportedTotal = when (rangeAnswer) {
                        RangeAnswer.CHANGED_TOTAL -> total + 1
                        else -> total
                    }
                    val slice = cipher.copyOfRange(start.toInt(), cut ?: cipher.size)
                    writeHead(
                        out,
                        "206 Partial Content",
                        total - start,
                        listOf(
                            "Accept-Ranges: bytes",
                            "Content-Range: bytes $reported-${reportedTotal - 1}/$reportedTotal",
                        ),
                    )
                    out.write(slice)
                }
            }
            out.flush()
        }
    }

    private enum class RangeAnswer { HONOUR, IGNORE, WRONG_START, CHANGED_TOTAL }

    private fun writeHead(out: OutputStream, status: String, length: Long, extra: List<String>) {
        val head = StringBuilder("HTTP/1.1 $status\r\n")
        head.append("Content-Type: application/octet-stream\r\n")
        head.append("Content-Length: $length\r\n")
        for (header in extra) head.append(header).append("\r\n")
        head.append("Connection: close\r\n\r\n")
        out.write(head.toString().toByteArray())
    }

    private fun download(
        origin: String,
        onChunk: ((ByteArray) -> Unit)? = null,
        onRecovery: (Boolean) -> Unit = {},
    ): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        runBlocking {
            client(origin).downloadBlob(
                StoredLink.of("abc123", key)!!,
                manifest,
                onRecovery = onRecovery,
            ) { chunk ->
                onChunk?.invoke(chunk)
                out.write(chunk)
            }
        }
        return out.toByteArray()
    }

    // ── recovery that must work ─────────────────────────────────────────────

    @Test
    fun `a body cut mid-frame resumes from the last authenticated boundary`() {
        // Inside the SECOND frame, so one frame has authenticated and the
        // decryptor is holding a partial tail whose authenticity is unknown.
        // The resume must drop that tail and restart at the boundary — not
        // after the bytes it was holding.
        host(cuts = listOf(firstFrame + 40, null)).use { server ->
            val states = ArrayList<Boolean>()
            assertArrayEquals(plaintext, download(server.origin, onRecovery = states::add))
            assertEquals("one resume", 2, server.received.size)
            assertEquals(
                "resumed from the last authenticated boundary",
                "bytes=$firstFrame-",
                server.received.last().header("Range"),
            )
            assertEquals("the recovery window is reported and then closed", listOf(true, false), states)
        }
    }

    @Test
    fun `a body cut exactly on a frame boundary resumes from that boundary`() {
        // Every delivered frame is perfectly authentic here, so nothing but the
        // declared total says the stream is incomplete. This is the case a
        // truncation attack produces and the one a naive "did it throw?" retry
        // would miss entirely.
        host(cuts = listOf(firstFrame, null)).use { server ->
            assertArrayEquals(plaintext, download(server.origin))
            assertEquals(2, server.received.size)
            assertEquals("bytes=$firstFrame-", server.received.last().header("Range"))
        }
    }

    @Test
    fun `two separate interruptions still produce the exact file`() {
        host(cuts = listOf(firstFrame / 2, firstFrame + 8, null)).use { server ->
            assertArrayEquals(plaintext, download(server.origin))
            assertEquals(3, server.received.size)
        }
    }

    @Test
    fun `a resumed download writes every plaintext byte exactly once`() {
        // The specific corruption a bad resume produces is a DUPLICATE: the
        // frame that was in flight when the connection broke, delivered twice.
        // Counting the bytes handed to the sink is how that is caught even when
        // the final comparison happens to line up.
        var delivered = 0L
        host(cuts = listOf(firstFrame + 40, null)).use { server ->
            val saved = download(server.origin, onChunk = { delivered += it.size })
            assertEquals(plaintext.size.toLong(), delivered)
            assertArrayEquals(plaintext, saved)
        }
    }

    // ── answers that are not continuations ──────────────────────────────────

    @Test
    fun `a full body in answer to a resume is refused, never spliced`() {
        host(cuts = listOf(firstFrame + 40, null), rangeAnswer = RangeAnswer.IGNORE).use { server ->
            // A typed SERVICE answer carrying the status it actually gave:
            // "answered 200 to a Range request" is a fact about the server, and
            // the code is the only diagnostic a report of it would have.
            val refusal = failure { download(server.origin) }
            assertEquals(CloudFailure.Kind.DOWNLOAD_UNAVAILABLE, refusal.kind)
            assertEquals(200, refusal.status)
            assertEquals("it did not keep retrying a server that ignores Range", 2, server.received.size)
        }
    }

    @Test
    fun `a 206 starting somewhere else is refused`() {
        host(cuts = listOf(firstFrame + 40, null), rangeAnswer = RangeAnswer.WRONG_START).use { server ->
            assertEquals(
                CloudFailure.Kind.DOWNLOAD_UNAVAILABLE,
                failure { download(server.origin) }.kind,
            )
        }
    }

    @Test
    fun `a 206 describing an object of a different size is refused`() {
        host(cuts = listOf(firstFrame + 40, null), rangeAnswer = RangeAnswer.CHANGED_TOTAL).use { server ->
            assertEquals(
                CloudFailure.Kind.DOWNLOAD_UNAVAILABLE,
                failure { download(server.origin) }.kind,
            )
        }
    }

    @Test
    fun `a refused continuation writes nothing from the body it refused`() {
        var delivered = 0L
        host(cuts = listOf(firstFrame, null), rangeAnswer = RangeAnswer.IGNORE).use { server ->
            failure { download(server.origin, onChunk = { delivered += it.size }) }
            // Exactly the bytes the FIRST attempt authenticated. The refused
            // 200 carried the whole object and none of it was fed.
            assertEquals(STORE_CHUNK_SIZE.toLong(), delivered)
        }
    }

    // ── what must never be replayed ─────────────────────────────────────────

    @Test
    fun `an object that does not advertise ranges is fetched exactly once`() {
        // This is the burn-after-read and download-limited rule. Central omits
        // `Accept-Ranges` for those objects precisely because a second GET
        // spends a download slot, so a client that retried anyway would consume
        // somebody's one-shot link on a network hiccup.
        host(cuts = listOf(firstFrame, null), acceptRanges = false).use { server ->
            // NETWORK because the connection really did drop mid-body, which is
            // what this reported before recovery existed and still reports now.
            // The assertion that matters is the COUNT: the object was fetched
            // once, so no download slot was spent twice and no burn was
            // consumed by a retry.
            assertEquals(CloudFailure.Kind.NETWORK, failure { download(server.origin) }.kind)
            assertEquals("a limited object is never re-requested", 1, server.received.size)
            assertNull(server.received.single().header("Range"))
        }
    }

    @Test
    fun `a server that declares no length is never resumed`() {
        // `Accept-Ranges` with nothing to compare a continuation against is not
        // a capability this client can verify, so it is not one it uses.
        val attempt = AtomicInteger(0)
        RecordingHttpServer { _, out ->
            attempt.incrementAndGet()
            out.write(
                ("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n" +
                    "Accept-Ranges: bytes\r\nConnection: close\r\n\r\n").toByteArray(),
            )
            out.write(cipher.copyOfRange(0, firstFrame))
            out.flush()
        }.use { server ->
            assertEquals(CloudFailure.Kind.DAMAGED, failure { download(server.origin) }.kind)
            assertEquals(1, attempt.get())
        }
    }

    @Test
    fun `an altered ciphertext byte is terminal and is never retried`() {
        val corrupted = cipher.copyOf()
        corrupted[9] = (corrupted[9].toInt() xor 0x01).toByte()
        RecordingHttpServer { _, out ->
            writeHead(out, "200 OK", corrupted.size.toLong(), listOf("Accept-Ranges: bytes"))
            out.write(corrupted)
            out.flush()
        }.use { server ->
            assertEquals(CloudFailure.Kind.DAMAGED, failure { download(server.origin) }.kind)
            assertEquals("a decryption failure is not a transport failure", 1, server.received.size)
        }
    }

    @Test
    fun `a sink that throws an IOException ends the download as itself`() {
        // The trap this pins: the sink callback runs INSIDE the body read, so
        // an `IOException` from a document provider would otherwise be caught by
        // the arm that means "the network dropped" — reported as a network
        // failure, and now retried from an offset the sink never received,
        // silently skipping the plaintext it failed to write.
        host(cuts = listOf(null), acceptRanges = true).use { server ->
            val caught = try {
                download(server.origin, onChunk = { throw IOException("the provider went away") })
                throw AssertionError("expected the sink's own exception")
            } catch (e: IOException) {
                e
            }
            // The caller's own exception, not a classified transport one.
            // (Identity is not asserted: kotlinx.coroutines copies an exception
            // crossing a coroutine boundary to recover its stack trace, so the
            // contract is the type and the message it was thrown with.)
            assertFalse("never laundered into a cloud failure", caught is CloudException)
            assertEquals("the provider went away", caught.message)
            assertEquals("a sink failure is never resumed", 1, server.received.size)
        }
    }

    @Test
    fun `a sink failure is not retried even when the server advertises ranges`() {
        var seen = 0
        host(cuts = listOf(firstFrame + 40, null)).use { server ->
            try {
                download(
                    server.origin,
                    onChunk = {
                        seen += 1
                        if (seen == 1) throw IOException("provider write failed")
                    },
                )
                throw AssertionError("expected the sink's own exception")
            } catch (_: IOException) {
                // expected
            }
            assertEquals("the resume budget is not spent on a sink failure", 1, server.received.size)
        }
    }

    // ── bounds ──────────────────────────────────────────────────────────────

    @Test
    fun `a connection that keeps breaking fails instead of retrying forever`() {
        // Every attempt is cut at the same boundary, so each one makes progress
        // and would justify "one more try" indefinitely under a per-offset
        // budget. The budget is global for exactly this shape.
        val cuts = List(12) { firstFrame }
        host(cuts = cuts).use { server ->
            // NETWORK, not DAMAGED: the connection kept stopping early and
            // nothing failed to authenticate. Telling a user their file is
            // damaged when the network broke sends them to look at the wrong
            // thing. `DAMAGED` stays the integrity verdict `end` gives.
            assertEquals(CloudFailure.Kind.NETWORK, failure { download(server.origin) }.kind)
            assertTrue(
                "bounded, got ${server.received.size} requests",
                server.received.size in 2..6,
            )
        }
    }

    // ── cancellation ────────────────────────────────────────────────────────

    @Test
    fun `cancelling during the backoff stops without issuing the resume`() {
        host(cuts = listOf(firstFrame, null)).use { server ->
            runBlocking {
                val job = launch(Dispatchers.IO) {
                    // Driven directly rather than through the `download`
                    // helper: that helper opens its own `runBlocking`, whose
                    // coroutine is not a child of this job, so cancelling the
                    // job would never reach the transport at all.
                    client(server.origin).downloadBlob(
                        StoredLink.of("abc123", key)!!,
                        manifest,
                    ) { }
                }
                // Long enough for the first attempt to fail and the wait to
                // begin, short enough to land inside the first backoff step.
                delay(120)
                job.cancelAndJoin()
            }
            assertEquals("no resume was issued", 1, server.received.size)
        }
    }

    @Test
    fun `cancelling between two plaintext chunks of one read stops at once`() {
        // One socket read can complete more than one frame, and the drain
        // between them blocks on nothing — so without a cancellation check per
        // chunk a cancelled download keeps handing plaintext to a sink the user
        // has already left.
        val delivered = AtomicInteger(0)
        host(cuts = listOf(null)).use { server ->
            runBlocking {
                val job = launch(Dispatchers.IO) {
                    client(server.origin).downloadBlob(
                        StoredLink.of("abc123", key)!!,
                        manifest,
                    ) {
                        delivered.incrementAndGet()
                        // Block the drain so the cancellation lands between two
                        // chunks rather than inside a socket read.
                        Thread.sleep(400)
                    }
                }
                delay(300)
                job.cancelAndJoin()
            }
            assertEquals("the drain stopped at the cancelled chunk", 1, delivered.get())
        }
    }

    @Test
    fun `a cancelled resume never reports the transfer as complete`() {
        host(cuts = listOf(firstFrame, null)).use { server ->
            var completed = false
            runBlocking {
                val job = launch(Dispatchers.IO) {
                    client(server.origin).downloadBlob(
                        StoredLink.of("abc123", key)!!,
                        manifest,
                    ) { }
                    completed = true
                }
                delay(120)
                job.cancelAndJoin()
            }
            assertFalse("a cancelled download never reaches its end", completed)
        }
    }

    // ── the redirect boundary is unchanged ──────────────────────────────────

    @Test
    fun `a resume re-enters at this app's own origin, never at the node it was sent to`() {
        // A fleet or BYO redirect target carries a single-use download token, so
        // a client that re-requested the node URL would be refused and would
        // also be widening where a resume may point. Central is where a fresh
        // hop comes from, and the redirect policy runs again on it.
        lateinit var nodeOrigin: String
        val nodeAttempt = AtomicInteger(0)
        RecordingHttpServer { request, out ->
            val n = nodeAttempt.getAndIncrement()
            val range = request.header("Range")
            val start = range?.removePrefix("bytes=")?.removeSuffix("-")?.toLongOrNull() ?: 0L
            if (start == 0L) {
                writeHead(out, "200 OK", cipher.size.toLong(), listOf("Accept-Ranges: bytes"))
                out.write(cipher.copyOfRange(0, firstFrame))
            } else {
                writeHead(
                    out,
                    "206 Partial Content",
                    cipher.size - start,
                    listOf("Content-Range: bytes $start-${cipher.size - 1}/${cipher.size}"),
                )
                out.write(cipher.copyOfRange(start.toInt(), cipher.size))
            }
            out.flush()
            assertTrue("hop $n", true)
        }.use { node ->
            nodeOrigin = node.origin
            RecordingHttpServer { _, out ->
                RecordingHttpServer.redirect(out, "$nodeOrigin/dl/blobkey?t=fresh")
            }.use { central ->
                assertArrayEquals(plaintext, download(central.origin))
                // Two central entries, because the resume starts over at
                // central and is redirected again — never a direct second call
                // on the node's own URL.
                assertEquals(2, central.received.size)
                assertEquals(2, node.received.size)
                assertEquals("bytes=$firstFrame-", node.received.last().header("Range"))
                assertEquals("bytes=$firstFrame-", central.received.last().header("Range"))
                // The invariant the redirect policy exists for, restated on the
                // resumed hop: no credential crosses to the other host.
                for (hop in node.received) {
                    assertNull(hop.header("Authorization"))
                    assertNull(hop.header("Cookie"))
                }
            }
        }
    }

    @Test
    fun `a redirect this client will not follow is still refused on a resume`() {
        val attempt = AtomicInteger(0)
        RecordingHttpServer { _, out ->
            if (attempt.getAndIncrement() == 0) {
                writeHead(out, "200 OK", cipher.size.toLong(), listOf("Accept-Ranges: bytes"))
                out.write(cipher.copyOfRange(0, firstFrame))
                out.flush()
            } else {
                // The resume is answered with a target carrying a fragment —
                // where a KEY lives in this product. Refused, as it is on a
                // first attempt.
                RecordingHttpServer.redirect(out, "https://node.example/dl/x#k=leak")
            }
        }.use { server ->
            assertEquals(
                CloudFailure.Kind.UNTRUSTED_REDIRECT,
                failure { download(server.origin) }.kind,
            )
        }
    }

    // ── classified answers are never replayed ───────────────────────────────

    @Test
    fun `a resume answered 404 reports the object as gone, and stops`() {
        val attempt = AtomicInteger(0)
        RecordingHttpServer { _, out ->
            if (attempt.getAndIncrement() == 0) {
                writeHead(out, "200 OK", cipher.size.toLong(), listOf("Accept-Ranges: bytes"))
                out.write(cipher.copyOfRange(0, firstFrame))
            } else {
                RecordingHttpServer.respond(out, status = "404 Not Found")
            }
            out.flush()
        }.use { server ->
            assertEquals(CloudFailure.Kind.NOT_FOUND, failure { download(server.origin) }.kind)
            assertEquals(2, server.received.size)
        }
    }

    @Test
    fun `a resume answered 429 is not retried against the limit`() {
        val attempt = AtomicInteger(0)
        RecordingHttpServer { _, out ->
            if (attempt.getAndIncrement() == 0) {
                writeHead(out, "200 OK", cipher.size.toLong(), listOf("Accept-Ranges: bytes"))
                out.write(cipher.copyOfRange(0, firstFrame))
            } else {
                RecordingHttpServer.respond(out, status = "429 Too Many Requests")
            }
            out.flush()
        }.use { server ->
            assertEquals(CloudFailure.Kind.DOWNLOAD_LIMITED, failure { download(server.origin) }.kind)
            assertEquals(2, server.received.size)
        }
    }

    // ── the unchanged completeness proof ────────────────────────────────────

    @Test
    fun `a body whose final frame is cut is terminal, and is never re-fetched`() {
        // Every byte the server ADVERTISED arrives; the last frame's length
        // prefix promises more than the object holds, so `consumedCipher` stays
        // short while the transport is complete. Measuring completeness on
        // authenticated bytes confused this with a network short read and
        // re-fetched a body that fails identically every time.
        val truncated = cipher.copyOfRange(0, firstFrame + 10)
        RecordingHttpServer { _, out ->
            writeHead(out, "200 OK", truncated.size.toLong(), listOf("Accept-Ranges: bytes"))
            out.write(truncated)
            out.flush()
        }.use { server ->
            assertEquals(CloudFailure.Kind.DAMAGED, failure { download(server.origin) }.kind)
            assertEquals("a complete body is not a network failure", 1, server.received.size)
        }
    }

    @Test
    fun `a drop before the first complete frame restarts and still saves exactly`() {
        // 77 bytes is inside the first frame's ciphertext, so NOTHING has
        // authenticated and there is no boundary to resume from: the recovery
        // is a fresh full GET. The partial tail must be dropped first — gating
        // the reset on a non-zero offset left those 77 bytes in the buffer, and
        // the full body was then appended to them, corrupting a download that
        // would otherwise have succeeded.
        host(cuts = listOf(77, null)).use { server ->
            assertArrayEquals(plaintext, download(server.origin))
            assertEquals(2, server.received.size)
            assertNull("a restart carries no Range", server.received.last().header("Range"))
        }
    }

    @Test
    fun `a restart that describes a different object is refused`() {
        // The zero-offset recovery still has to be answering about the same
        // object. Taking the second response's total as the capability would
        // let a server resize the thing mid-download.
        val attempt = AtomicInteger(0)
        RecordingHttpServer { _, out ->
            if (attempt.getAndIncrement() == 0) {
                writeHead(out, "200 OK", cipher.size.toLong(), listOf("Accept-Ranges: bytes"))
                out.write(cipher.copyOfRange(0, 77))
            } else {
                writeHead(out, "200 OK", cipher.size.toLong() + 1, listOf("Accept-Ranges: bytes"))
                out.write(cipher + byteArrayOf(0))
            }
            out.flush()
        }.use { server ->
            val refusal = failure { download(server.origin) }
            assertEquals(CloudFailure.Kind.DOWNLOAD_UNAVAILABLE, refusal.kind)
            assertEquals(2, server.received.size)
        }
    }

    @Test
    fun `a continuation with no declared length is refused`() {
        // Without it there is no independent statement of how much is coming,
        // so nothing bounds the body against the object it claims to continue.
        val attempt = AtomicInteger(0)
        RecordingHttpServer { _, out ->
            if (attempt.getAndIncrement() == 0) {
                writeHead(out, "200 OK", cipher.size.toLong(), listOf("Accept-Ranges: bytes"))
                out.write(cipher.copyOfRange(0, firstFrame))
            } else {
                out.write(
                    ("HTTP/1.1 206 Partial Content\r\n" +
                        "Content-Type: application/octet-stream\r\n" +
                        "Content-Range: bytes $firstFrame-${cipher.size - 1}/${cipher.size}\r\n" +
                        "Connection: close\r\n\r\n").toByteArray(),
                )
                out.write(cipher.copyOfRange(firstFrame, cipher.size))
            }
            out.flush()
        }.use { server ->
            assertEquals(
                CloudFailure.Kind.DOWNLOAD_UNAVAILABLE,
                failure { download(server.origin) }.kind,
            )
        }
    }

    @Test
    fun `the blob request refuses a content coding`() {
        // A byte counted at an offset must BE the byte at that offset in the
        // object, so the request asks for no encoding at all.
        host(cuts = listOf(null)).use { server ->
            download(server.origin)
            assertEquals("identity", server.received.single().header("Accept-Encoding"))
        }
    }

    @Test
    fun `an encoded body is never treated as resumable`() {
        val attempt = AtomicInteger(0)
        RecordingHttpServer { _, out ->
            attempt.incrementAndGet()
            writeHead(
                out,
                "200 OK",
                cipher.size.toLong(),
                listOf("Accept-Ranges: bytes", "Content-Encoding: br"),
            )
            out.write(cipher.copyOfRange(0, firstFrame))
            out.flush()
        }.use { server ->
            assertEquals(CloudFailure.Kind.NETWORK, failure { download(server.origin) }.kind)
            assertEquals("no capability, so no replay", 1, attempt.get())
        }
    }

    @Test
    fun `an uninterrupted download issues one request and carries no Range`() {
        host(cuts = listOf(null)).use { server ->
            assertArrayEquals(plaintext, download(server.origin))
            assertEquals(1, server.received.size)
            assertNull(server.received.single().header("Range"))
        }
    }
}
