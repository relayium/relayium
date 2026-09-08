package com.relayium.android

import com.relayium.android.update.Failure
import com.relayium.android.update.FetchResult
import com.relayium.android.update.UpdateFeed
import com.relayium.android.update.UpdateSource
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.ResponseBody.Companion.asResponseBody
import okio.Buffer
import okio.ForwardingSource
import okio.Source
import okio.buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The transport half, against a real socket.
 *
 * Everything here uses an actual HTTP server on loopback rather than a stubbed
 * `FeedSource`, because the properties being asserted — that the body is
 * genuinely bounded, that a redirect is not followed, that a read never lands
 * on the caller's thread — are properties of the real client and are exactly
 * the ones a stub cannot have.
 */
class UpdateSourceTest {

    private fun source(client: OkHttpClient = UpdateSource.defaultClient()) =
        UpdateSource(client = client, userAgent = "Relayium-Android/test (update-check)")

    private fun fetch(server: LoopbackHttpServer, path: String = "/update.json"): FetchResult =
        runBlocking { source().fetch(server.url(path)) }

    // ── the ordinary path ───────────────────────────────────────────────────

    @Test
    fun `reads a small document`() {
        LoopbackHttpServer.serving(body = """{"schema":1}""").use { server ->
            val result = fetch(server)
            assertEquals(FetchResult.Body("""{"schema":1}"""), result)
        }
    }

    @Test
    fun `sends an attributable user agent and asks for json`() {
        val seen = AtomicReference<String>()
        LoopbackHttpServer { _, out, _ ->
            out.write(
                ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
                    "Content-Length: 2\r\nConnection: close\r\n\r\n{}").toByteArray()
            )
            out.flush()
        }.use { server ->
            // Capture through an interceptor: the request headers are what the
            // origin's edge sees, and a generic agent is the shape that gets
            // challenged rather than served.
            val client = UpdateSource.defaultClient().newBuilder()
                .addInterceptor { chain ->
                    seen.set(chain.request().header("User-Agent"))
                    chain.proceed(chain.request())
                }
                .build()
            runBlocking { source(client).fetch(server.url("/update.json")) }
            assertTrue("agent was ${seen.get()}", seen.get().orEmpty().startsWith("Relayium-Android/"))
        }
    }

    // ── status ──────────────────────────────────────────────────────────────

    @Test
    fun `refuses every status that is not 200`() {
        for (status in listOf("404 Not Found", "500 Internal Server Error", "403 Forbidden", "503 Service Unavailable")) {
            LoopbackHttpServer.serving(status = status, body = """{"schema":1}""").use { server ->
                assertEquals(status, FetchResult.Failed(Failure.STATUS), fetch(server))
            }
        }
    }

    /** Production's own nginx answers a missing file with 404 AND an HTML body;
     *  the status check means that HTML never reaches the parser. */
    @Test
    fun `refuses the html 404 production actually serves`() {
        LoopbackHttpServer.serving(
            status = "404 Not Found",
            contentType = "text/html",
            body = "<!doctype html><html><body>Not Found</body></html>",
        ).use { server ->
            assertEquals(FetchResult.Failed(Failure.STATUS), fetch(server))
        }
    }

    /** An HTML page served with 200 — a captive portal, or a misconfigured
     *  rewrite — passes the transport and must die at the parser instead. */
    @Test
    fun `passes html served with 200 to the parser, which refuses it`() {
        val html = "<!doctype html><html><body>hello</body></html>"
        LoopbackHttpServer.serving(contentType = "text/html", body = html).use { server ->
            assertEquals(FetchResult.Body(html), fetch(server))
            assertEquals(
                UpdateFeed.Rejection.NOT_JSON,
                (UpdateFeed.parse(html) as UpdateFeed.Parsed.Refused).why,
            )
        }
    }

    @Test
    fun `does not follow a redirect`() {
        LoopbackHttpServer.redirecting(to = "https://evil.example/update.json").use { server ->
            assertEquals(FetchResult.Failed(Failure.STATUS), fetch(server))
            // One request: it stopped, it did not chase.
            assertEquals(1, server.requests.get())
        }
    }

    // ── the body bound ──────────────────────────────────────────────────────

    @Test
    fun `accepts a body exactly at the limit`() {
        val body = "{\"pad\":\"" + "x".repeat(UpdateFeed.MAX_BODY_BYTES - 10) + "\"}"
        assertEquals(UpdateFeed.MAX_BODY_BYTES, body.length)
        LoopbackHttpServer.serving(body = body).use { server ->
            assertEquals(FetchResult.Body(body), fetch(server))
        }
    }

    /**
     * REJECTED, not truncated.
     *
     * A prefix of a JSON document is either invalid — in which case truncating
     * only changes the error — or it is a shorter VALID document saying
     * something the publisher never wrote. The assertion is therefore that the
     * result is a failure, and specifically NOT a `Body` holding a prefix.
     */
    @Test
    fun `rejects an oversize body rather than truncating it`() {
        val body = "{\"pad\":\"" + "x".repeat(UpdateFeed.MAX_BODY_BYTES) + "\"}"
        LoopbackHttpServer.serving(body = body).use { server ->
            val result = fetch(server)
            assertEquals(FetchResult.Failed(Failure.TOO_LARGE), result)
            assertTrue("a prefix was returned: $result", result !is FetchResult.Body)
        }
    }

    /**
     * A body that UNDERSTATES its own length is framed by that length, and that
     * is HTTP working correctly rather than a truncation this code performs:
     * the message ends where `Content-Length` says it ends, and the extra bytes
     * on the socket are not part of it. So the transport hands over exactly the
     * framed bytes, and the strict parser is what refuses the result.
     *
     * Worth pinning precisely because the reasoning could go the other way. The
     * document is refused either way; what this asserts is WHICH layer refuses
     * it, so nobody later "fixes" the transport to second-guess HTTP framing.
     */
    @Test
    fun `takes the framed body when content length understates it, and the parser refuses`() {
        val body = ("{\"pad\":\"" + "x".repeat(UpdateFeed.MAX_BODY_BYTES * 2) + "\"}").toByteArray()
        LoopbackHttpServer.serving(body = body, contentLength = 10).use { server ->
            val result = fetch(server)
            assertTrue("expected the framed prefix, got $result", result is FetchResult.Body)
            val text = (result as FetchResult.Body).text
            assertEquals(10, text.length)
            assertEquals(
                UpdateFeed.Rejection.NOT_JSON,
                (UpdateFeed.parse(text) as UpdateFeed.Parsed.Refused).why,
            )
        }
    }

    @Test
    fun `rejects an oversize body declared by content length alone`() {
        // Declared over the limit: refused early, before the bytes are read.
        LoopbackHttpServer { _, out, _ ->
            out.write(
                ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
                    "Content-Length: ${UpdateFeed.MAX_BODY_BYTES * 4}\r\nConnection: close\r\n\r\n").toByteArray()
            )
            out.flush()
            repeat(4) { out.write(ByteArray(UpdateFeed.MAX_BODY_BYTES) { 'x'.code.toByte() }) }
            out.flush()
        }.use { server ->
            assertEquals(FetchResult.Failed(Failure.TOO_LARGE), fetch(server))
        }
    }

    @Test
    fun `refuses bytes that are not valid utf8`() {
        // A lone 0x80 continuation byte: `String(bytes, UTF_8)` would silently
        // turn this into U+FFFD and hand plausible text to the parser.
        val bad = byteArrayOf('{'.code.toByte(), 0x80.toByte(), '}'.code.toByte())
        LoopbackHttpServer.serving(body = bad).use { server ->
            assertEquals(FetchResult.Failed(Failure.NOT_TEXT), fetch(server))
        }
    }

    // ── failures ────────────────────────────────────────────────────────────

    @Test
    fun `reports a refused connection as a network failure, never as up to date`() {
        val port = LoopbackHttpServer.serving(body = "{}").use { it.port } // closed on exit
        val result = runBlocking { source().fetch("http://127.0.0.1:$port/update.json") }
        assertEquals(FetchResult.Failed(Failure.NETWORK), result)
    }

    @Test
    fun `reports a stalled body as a timeout`() {
        val client = UpdateSource.defaultClient().newBuilder()
            .readTimeout(300, TimeUnit.MILLISECONDS)
            .callTimeout(2, TimeUnit.SECONDS)
            .build()
        LoopbackHttpServer { _, out, _ ->
            out.write(
                ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
                    "Content-Length: 100\r\nConnection: close\r\n\r\n").toByteArray()
            )
            out.flush()
            Thread.sleep(5_000) // headers, then nothing
        }.use { server ->
            val result = runBlocking { source(client).fetch(server.url("/update.json")) }
            assertEquals(FetchResult.Failed(Failure.TIMEOUT), result)
        }
    }

    // ── R3: where the body is read ──────────────────────────────────────────

    /**
     * REGRESSION, and the important one in this file.
     *
     * The original implementation resumed the coroutine with the `Response` and
     * read the body AFTER the suspension point — which runs the read on the
     * CALLER's dispatcher. In production that caller is `viewModelScope`, i.e.
     * the main thread, so a body still on the wire meant socket I/O on the UI
     * thread: a freeze, and `NetworkOnMainThreadException` on a real device.
     *
     * A small body that arrives with the headers hides this entirely, so this
     * test DELAYS the body and compares thread IDENTITY (not name — coroutine
     * debug mode rewrites thread names and made a name-based probe pass while
     * the defect was present).
     */
    @Test
    fun `reads the body off the calling dispatcher`() {
        val callerThread = AtomicReference<Thread>()
        val readerThread = AtomicReference<Thread>()
        val ui = Executors.newSingleThreadExecutor { r -> Thread(r, "fake-main") }

        LoopbackHttpServer { _, out, _ ->
            out.write(
                ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
                    "Content-Length: 12\r\nConnection: close\r\n\r\n").toByteArray()
            )
            out.flush()
            Thread.sleep(400) // the body is NOT available when onResponse fires
            out.write("""{"schema":1}""".toByteArray())
            out.flush()
        }.use { server ->
            val client = UpdateSource.defaultClient().newBuilder()
                .addNetworkInterceptor(recordingBodyReadThread(readerThread))
                .build()
            try {
                val dispatcher = ui.asCoroutineDispatcher()
                val result = runBlocking {
                    withContext(dispatcher) {
                        callerThread.set(Thread.currentThread())
                        source(client).fetch(server.url("/update.json"))
                    }
                }
                assertEquals(FetchResult.Body("""{"schema":1}"""), result)
                assertTrue("the body was never read", readerThread.get() != null)
                assertNotEquals(
                    "the response body was read on the CALLING thread — on a device that is the UI thread",
                    callerThread.get(),
                    readerThread.get(),
                )
            } finally {
                ui.shutdownNow()
            }
        }
    }

    /**
     * The same defect stated as the user-visible property: while a slow body is
     * being read, the caller's single-threaded dispatcher must keep running
     * other work. On a device that dispatcher draws the screen.
     */
    @Test
    fun `does not block the calling dispatcher while the body arrives`() {
        val ui = Executors.newSingleThreadExecutor { r -> Thread(r, "fake-main") }
        val beats = AtomicInteger(0)

        LoopbackHttpServer { _, out, _ ->
            out.write(
                ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
                    "Content-Length: 12\r\nConnection: close\r\n\r\n").toByteArray()
            )
            out.flush()
            Thread.sleep(700)
            out.write("""{"schema":1}""".toByteArray())
            out.flush()
        }.use { server ->
            try {
                val dispatcher = ui.asCoroutineDispatcher()
                runBlocking {
                    val scope = CoroutineScope(dispatcher)
                    val heartbeat = scope.launch {
                        while (isActive) {
                            beats.incrementAndGet()
                            delay(20)
                        }
                    }
                    val result = withContext(dispatcher) { source().fetch(server.url("/update.json")) }
                    heartbeat.cancelAndJoin()
                    assertEquals(FetchResult.Body("""{"schema":1}"""), result)
                }
                // A blocked dispatcher yields ~1 beat; a free one yields many.
                assertTrue(
                    "the calling dispatcher was blocked during the body read (${beats.get()} beats)",
                    beats.get() > 5,
                )
            } finally {
                ui.shutdownNow()
            }
        }
    }

    /**
     * Cancellation must reach the socket DURING the body, not only while
     * waiting for headers. Resuming the continuation early detaches
     * `invokeOnCancellation`, and the request would then run to completion with
     * nobody waiting for it.
     */
    @Test
    fun `cancels the call while the body is still arriving`() {
        val started = CountDownLatch(1)
        LoopbackHttpServer { _, out, disconnected ->
            out.write(
                ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
                    "Content-Length: 64\r\nConnection: close\r\n\r\n").toByteArray()
            )
            out.flush()
            started.countDown()
            try {
                // Dribble, so the write eventually notices the closed peer.
                repeat(60) {
                    out.write("x".toByteArray())
                    out.flush()
                    Thread.sleep(100)
                }
            } catch (_: Exception) {
                disconnected.set(true)
            }
        }.use { server ->
            runBlocking {
                val scope = CoroutineScope(kotlinx.coroutines.Dispatchers.Default)
                val result = AtomicReference<FetchResult>()
                val job = scope.launch { result.set(source().fetch(server.url("/update.json"))) }
                assertTrue(started.await(5, TimeUnit.SECONDS))
                delay(200)
                job.cancelAndJoin()
                // A cancelled check publishes nothing at all.
                assertNull("a cancelled fetch produced a result", result.get())
                val gone = withTimeoutOrNull(5.seconds) {
                    while (!server.clientDisconnected.get()) delay(50)
                    true
                }
                assertTrue("the socket was still open after cancellation", gone == true)
            }
        }
    }

    /**
     * An interceptor that records which thread first READS the response body.
     * Thread identity, not name: coroutine debug mode renames threads, which is
     * how a name-based probe reported a false pass.
     */
    private fun recordingBodyReadThread(into: AtomicReference<Thread>) = Interceptor { chain ->
        val response = chain.proceed(chain.request())
        val original = response.body
        val recording = object : ForwardingSource(original.source()) {
            override fun read(sink: Buffer, byteCount: Long): Long {
                into.compareAndSet(null, Thread.currentThread())
                return super.read(sink, byteCount)
            }
        }
        response.newBuilder()
            .body((recording as Source).buffer().asResponseBody(original.contentType(), original.contentLength()))
            .build()
    }
}
