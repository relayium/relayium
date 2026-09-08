package com.relayium.android.update

import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/**
 * Fetching the update document, and nothing else.
 *
 * Split from [UpdateFeed] (what a document MEANS) and [UpdateChecker] (what the
 * UI shows) so the strict-parsing rules can be unit-tested with no sockets and
 * the transport rules can be tested against a real server with no UI.
 */
sealed interface FetchResult {

    /** The COMPLETE body, decoded. Never a prefix — see [UpdateSource]. */
    data class Body(val text: String) : FetchResult

    data class Failed(val why: Failure) : FetchResult
}

/** Why a fetch produced no document. Every one of these renders as an error and
 *  NONE of them ever renders as "up to date" — a check that could not reach the
 *  publisher has learned nothing about whether an update exists. */
enum class Failure {
    /** DNS, connection refused, TLS failure, connection reset. */
    NETWORK,

    /** Connect/read/call deadline elapsed. */
    TIMEOUT,

    /**
     * Anything that is not `200 OK`.
     *
     * Deliberately includes the 3xx range. Redirects are NOT followed: the feed
     * lives at one fixed URL, and a redirect means something between this app
     * and the publisher wants it to read a different document. That is exactly
     * the case to refuse rather than chase. It also covers the shape production
     * actually produces for a missing feed — nginx answers 404 with an HTML
     * body — so the HTML never even reaches the parser.
     */
    STATUS,

    /** The body exceeded [UpdateFeed.MAX_BODY_BYTES]. Rejected, not truncated. */
    TOO_LARGE,

    /** The bytes are not valid UTF-8. */
    NOT_TEXT,
}

/** The seam the checker consumes, so its state machine can be driven from unit
 *  tests with no network at all. */
fun interface FeedSource {
    suspend fun fetch(url: String): FetchResult
}

/**
 * The real one.
 *
 * ## Why this does not reuse the signalling client
 *
 * `SignalingClient.httpClient()` is built for a WebSocket: `readTimeout(0)`,
 * meaning no read deadline at all. Reusing it here would make a silent origin
 * hang the update check forever. This client has its own, short deadlines and
 * follows no redirects.
 */
class UpdateSource(
    private val client: OkHttpClient = defaultClient(),
    private val userAgent: String,
) : FeedSource {

    /**
     * ## Where the body is read, and why it matters
     *
     * Everything — status, the bounded body read, and the close — happens
     * inside OkHttp's `onResponse`, on OkHttp's own dispatcher thread, while
     * the coroutine is still suspended. Only the finished [FetchResult] is
     * resumed.
     *
     * The obvious shape is wrong in a way that does not show up in a test that
     * uses a small, already-buffered body. Resuming with the `Response` and
     * reading it after the suspension point runs the read on the CALLER's
     * dispatcher — and the caller is `viewModelScope`, i.e.
     * `Dispatchers.Main`. `onResponse` fires once the HEADERS are in, so the
     * body may still be on the wire: the blocking `request`/`readByteArray`
     * below would then do socket I/O on the UI thread, freezing it and risking
     * `NetworkOnMainThreadException`. A body that happened to arrive with the
     * headers hides this completely, which is why `UpdateSourceTest` uses a
     * server that delays the body and asserts against thread IDENTITY.
     *
     * Keeping the continuation suspended has a second, equally load-bearing
     * effect: `invokeOnCancellation` stays attached for the whole read, so
     * cancelling the check really cancels the [Call] mid-body. Resuming early
     * detaches that handler, and a user who pressed Cancel would keep paying
     * for the transfer. It also removes the ownership race entirely — this
     * function never hands out a `Response` that someone else has to close.
     */
    override suspend fun fetch(url: String): FetchResult {
        val request = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            // An explicit, attributable agent. The default OkHttp string is
            // indistinguishable from any other client and is exactly the kind
            // of generic agent an edge can decide to challenge; naming the
            // product and its version makes the request identifiable to the
            // origin and to us in a log.
            .header("User-Agent", userAgent)
            .header("Cache-Control", "no-cache")
            .get()
            .build()
        val call = client.newCall(request)
        return suspendCancellableCoroutine { cont ->
            cont.invokeOnCancellation { runCatching { call.cancel() } }
            call.enqueue(object : Callback {
                override fun onResponse(call: Call, response: Response) {
                    // `use` closes the response on every path, including the
                    // one where readBounded throws.
                    val result = try {
                        response.use { readBounded(it) }
                    } catch (e: IOException) {
                        classify(e)
                    }
                    // Dropping the result of a cancelled check is safe: the
                    // response is already closed by the line above.
                    if (cont.isActive) cont.resume(result)
                }

                override fun onFailure(call: Call, e: IOException) {
                    // A cancelled call also arrives here, as IOException
                    // "Canceled"; the continuation is no longer active and the
                    // result is dropped.
                    if (cont.isActive) cont.resume(classify(e))
                }
            })
        }
    }

    private fun classify(e: IOException): FetchResult = when {
        e is java.net.SocketTimeoutException -> FetchResult.Failed(Failure.TIMEOUT)
        // OkHttp reports a call-timeout as a plain InterruptedIOException.
        e is java.io.InterruptedIOException &&
            e.message?.contains("timeout", ignoreCase = true) == true ->
            FetchResult.Failed(Failure.TIMEOUT)

        else -> FetchResult.Failed(Failure.NETWORK)
    }

    /**
     * Read at most [UpdateFeed.MAX_BODY_BYTES], and REFUSE anything longer.
     *
     * The bound is enforced by asking the stream for ONE BYTE MORE than the
     * limit: `request(n)` returns true only if it could buffer that many, so a
     * true here means the body is over the limit and the call fails. Reading a
     * truncated prefix instead would be worse than useless — a prefix of a JSON
     * document is either invalid, in which case only the error message changes,
     * or it is a shorter VALID document that says something the publisher never
     * wrote. A declared `Content-Length` is checked first as a cheap early
     * refusal, but it is not trusted as the answer: a body can lie about its
     * length or send none at all, so the stream bound is what actually decides.
     */
    private fun readBounded(response: Response): FetchResult {
        if (response.code != 200) return FetchResult.Failed(Failure.STATUS)
        val body = response.body
        val declared = body.contentLength()
        if (declared > UpdateFeed.MAX_BODY_BYTES) return FetchResult.Failed(Failure.TOO_LARGE)
        val source = body.source()
        if (source.request(UpdateFeed.MAX_BODY_BYTES.toLong() + 1L)) {
            return FetchResult.Failed(Failure.TOO_LARGE)
        }
        val bytes = source.readByteArray()
        if (bytes.size > UpdateFeed.MAX_BODY_BYTES) return FetchResult.Failed(Failure.TOO_LARGE)
        val text = decodeStrictUtf8(bytes) ?: return FetchResult.Failed(Failure.NOT_TEXT)
        return FetchResult.Body(text)
    }

    /**
     * UTF-8, reporting errors rather than substituting them.
     *
     * `String(bytes, UTF_8)` silently turns malformed input into U+FFFD, which
     * would let a mangled or wrongly-encoded document reach the parser as
     * plausible-looking text. This is metadata that decides what the user is
     * asked to install; "close enough" is not a property it should have.
     */
    private fun decodeStrictUtf8(bytes: ByteArray): String? = try {
        StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (_: CharacterCodingException) {
        null
    }

    companion object {

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .writeTimeout(10, TimeUnit.SECONDS)
            // A hard ceiling on the WHOLE call, so a server that dribbles a
            // byte before every read deadline still cannot hold the check open.
            .callTimeout(20, TimeUnit.SECONDS)
            // The feed is at one fixed URL. See [Failure.STATUS].
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .build()
    }
}
