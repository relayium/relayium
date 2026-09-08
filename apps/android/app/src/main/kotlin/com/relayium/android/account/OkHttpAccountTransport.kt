package com.relayium.android.account

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
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * The real account transport.
 *
 * ## Where the body is read, and why it matters
 *
 * Everything — the status, the bounded body read, the close — happens inside
 * OkHttp's `onResponse`, on OkHttp's own dispatcher thread, while the coroutine
 * is still suspended; only the finished [TransportResult] is resumed. This is
 * the same shape (and the same reasoning) as
 * [com.relayium.android.update.UpdateSource]: `onResponse` fires once the
 * HEADERS are in, so resuming with the `Response` and reading it afterwards
 * would run socket I/O on the CALLER's dispatcher — which for this app is the
 * main thread, freezing the UI and risking `NetworkOnMainThreadException`. A
 * small body that happens to arrive with the headers hides that completely.
 *
 * Keeping the continuation suspended also keeps `invokeOnCancellation`
 * attached for the whole read, so cancelling a sign-in really cancels the call
 * rather than leaving it to complete unobserved.
 *
 * ## What it refuses
 *
 *  * **Redirects.** Every one of these endpoints lives at a fixed path on the
 *    app's own origin, and requests carry a BEARER. Following a redirect would
 *    forward that credential to whatever host answered — the single worst thing
 *    an HTTP client in this position can do — so a 3xx is reported as a network
 *    failure and the credential goes nowhere.
 *  * **A body over [TransportResult.MAX_BODY_BYTES]**, rejected rather than
 *    truncated.
 *  * **Bytes that are not valid UTF-8**, reported rather than substituted:
 *    `String(bytes, UTF_8)` turns malformed input into U+FFFD, which would let
 *    a mangled document reach the strict parser looking like plausible text.
 *
 * ## What never appears anywhere
 *
 * The bearer is a header and the password is a body; neither is ever placed in
 * a URL. Nothing here logs, and no failure value carries a request, a body or a
 * token — [TransportResult.Failed] is an enum, and OkHttp's own exceptions are
 * classified into it rather than surfaced, so an exception message cannot carry
 * a credential into a crash report.
 */
class OkHttpAccountTransport(
    private val origin: String,
    private val client: OkHttpClient = defaultClient(),
    private val userAgent: String,
) : AccountTransport {

    override suspend fun send(request: AccountRequest): TransportResult {
        // BUILDING the request can throw, and on input that came off the wire:
        // OkHttp validates a header value and refuses anything outside
        // printable ASCII, so a bearer carrying a newline — a server response
        // this client should never have adopted, but must survive — raises
        // IllegalArgumentException here rather than at some later, unrelated
        // point. It is turned into a classified refusal, and the exception is
        // DROPPED rather than attached: its message quotes the header value,
        // which is the credential itself.
        val call = try {
            client.newCall(build(request))
        } catch (_: IllegalArgumentException) {
            return TransportResult.Failed(TransportResult.Failure.REQUEST_REJECTED)
        }
        return suspendCancellableCoroutine { cont ->
            cont.invokeOnCancellation { runCatching { call.cancel() } }
            call.enqueue(object : Callback {
                override fun onResponse(call: Call, response: Response) {
                    val result = try {
                        response.use { readBounded(it) }
                    } catch (e: IOException) {
                        classify(e)
                    }
                    if (cont.isActive) cont.resume(result)
                }

                override fun onFailure(call: Call, e: IOException) {
                    // A cancelled call also arrives here as IOException
                    // "Canceled"; the continuation is no longer active and the
                    // result is dropped.
                    if (cont.isActive) cont.resume(classify(e))
                }
            })
        }
    }

    private fun build(request: AccountRequest): Request {
        val builder = Request.Builder()
            .url("$origin/${request.path}")
            .header("Accept", "application/json")
            .header("User-Agent", userAgent)
        request.bearer?.let { builder.header("Authorization", "Bearer $it") }
        val body = request.json?.toRequestBody(JSON)
        when (request.method) {
            "GET" -> builder.get()
            "POST" -> builder.post(body ?: EMPTY)
            "DELETE" -> builder.delete(body)
            else -> throw IllegalArgumentException("unsupported method")
        }
        return builder.build()
    }

    private fun classify(e: IOException): TransportResult = when {
        e is java.net.SocketTimeoutException -> TransportResult.Failed(TransportResult.Failure.TIMEOUT)
        // OkHttp reports a call-timeout as a plain InterruptedIOException.
        e is java.io.InterruptedIOException &&
            e.message?.contains("timeout", ignoreCase = true) == true ->
            TransportResult.Failed(TransportResult.Failure.TIMEOUT)

        else -> TransportResult.Failed(TransportResult.Failure.NETWORK)
    }

    /**
     * Read at most [TransportResult.MAX_BODY_BYTES], and REFUSE anything longer.
     *
     * The bound is enforced by asking the stream for ONE BYTE MORE than the
     * limit: `request(n)` returns true only if it could buffer that many, so a
     * true here means the body is over the limit. A declared `Content-Length`
     * is checked first as a cheap early refusal but is not trusted as the
     * answer — a body can lie about its length or send none at all.
     */
    private fun readBounded(response: Response): TransportResult {
        // A redirect is refused here rather than followed by the client (which
        // is also configured not to). Reported as NETWORK, not as a server
        // status, because nothing the ACCOUNT service said is in it.
        if (response.code in 300..399) return TransportResult.Failed(TransportResult.Failure.NETWORK)
        val body = response.body
        val limit = TransportResult.MAX_BODY_BYTES
        if (body.contentLength() > limit) return TransportResult.Failed(TransportResult.Failure.TOO_LARGE)
        val source = body.source()
        if (source.request(limit.toLong() + 1L)) {
            return TransportResult.Failed(TransportResult.Failure.TOO_LARGE)
        }
        val bytes = source.readByteArray()
        if (bytes.size > limit) return TransportResult.Failed(TransportResult.Failure.TOO_LARGE)
        val text = decodeStrictUtf8(bytes)
            ?: return TransportResult.Failed(TransportResult.Failure.NOT_TEXT)
        return TransportResult.Answered(AccountResponse(response.code, text))
    }

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

        private val JSON = "application/json; charset=utf-8".toMediaType()
        private val EMPTY = ByteArray(0).toRequestBody(null)

        /**
         * Its own client, NOT the signalling one: `SignalingClient.httpClient()`
         * is built for a WebSocket and carries `readTimeout(0)`, so an origin
         * that accepted the connection and then said nothing would hang a
         * sign-in with no deadline at all.
         */
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            // A hard ceiling on the WHOLE call, so a server that dribbles a byte
            // before every read deadline cannot hold a request open.
            .callTimeout(30, TimeUnit.SECONDS)
            // See the class comment: these requests carry a bearer.
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .build()
    }
}
