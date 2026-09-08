package com.relayium.android.account

import com.relayium.android.LoopbackHttpServer
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The REAL transport, over a real socket.
 *
 * Everything here is a property a fake cannot have. A stub always returns a
 * whole, already-buffered, well-formed body from a cooperative peer; the rules
 * that matter — refusing a redirect that would forward a BEARER, refusing an
 * oversized body rather than truncating it, refusing bytes that are not UTF-8,
 * and surviving a credential the HTTP client itself will not accept — are all
 * about a peer that is none of those things.
 */
class AccountTransportTest {

    private fun transportFor(server: LoopbackHttpServer): OkHttpAccountTransport =
        OkHttpAccountTransport(
            origin = server.url("").removeSuffix("/"),
            client = OkHttpClient.Builder()
                .callTimeout(5, TimeUnit.SECONDS)
                .followRedirects(false)
                .followSslRedirects(false)
                .build(),
            userAgent = "Relayium-Android/test (account)",
        )

    @Test
    fun `an ordinary answer arrives whole`() = runBlocking {
        LoopbackHttpServer.serving(body = """{"ok":true}""").use { server ->
            val result = transportFor(server).send(AccountRequest("GET", "api/me", bearer = "rlm_cli_x"))
            val answered = result as TransportResult.Answered
            assertEquals(200, answered.response.status)
            assertEquals("""{"ok":true}""", answered.response.body)
        }
    }

    /**
     * The single worst thing an HTTP client in this position can do. These
     * requests carry a bearer; following a redirect would forward that
     * credential to whatever host answered. It is reported as a NETWORK failure
     * because nothing the account service said is in it.
     */
    @Test
    fun `a redirect is refused, not followed, so no bearer is forwarded`() = runBlocking {
        LoopbackHttpServer.redirecting(to = "http://evil.example/api/me").use { server ->
            val result = transportFor(server).send(AccountRequest("GET", "api/me", bearer = "rlm_cli_x"))
            assertEquals(TransportResult.Failed(TransportResult.Failure.NETWORK), result)
            assertEquals("the redirect must not have been chased", 1, server.requests.get())
        }
    }

    /** Rejected rather than truncated: a prefix of a JSON document is either
     *  invalid or a SHORTER VALID document saying something the server never
     *  wrote — for these endpoints, a different plan or a different device list. */
    @Test
    fun `a body over the ceiling is refused rather than truncated`() = runBlocking {
        val huge = ByteArray(TransportResult.MAX_BODY_BYTES + 1) { '{'.code.toByte() }
        LoopbackHttpServer.serving(body = huge).use { server ->
            val result = transportFor(server).send(AccountRequest("GET", "api/me", bearer = "t"))
            assertEquals(TransportResult.Failed(TransportResult.Failure.TOO_LARGE), result)
        }
    }

    /**
     * A body with NO declared length at all, framed only by the connection
     * closing.
     *
     * This is the case the `Content-Length` check cannot answer and the stream
     * bound must: `contentLength()` reports -1, so the cheap early refusal does
     * not fire and the read itself has to stop. (A response that UNDER-declares
     * its length is not this test: HTTP framing simply ends the body at the
     * declared byte, so nothing oversized ever belongs to that response.)
     */
    @Test
    fun `an unbounded body is refused by the stream bound, not by a header`() = runBlocking {
        val huge = ByteArray(TransportResult.MAX_BODY_BYTES + 1024) { 'x'.code.toByte() }
        val server = LoopbackHttpServer { _, out, _ ->
            out.write(
                ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
                    "Connection: close\r\n\r\n").toByteArray(),
            )
            out.write(huge)
            out.flush()
        }
        server.use {
            val result = transportFor(server).send(AccountRequest("GET", "api/me", bearer = "t"))
            assertEquals(TransportResult.Failed(TransportResult.Failure.TOO_LARGE), result)
        }
    }

    /** `String(bytes, UTF_8)` would substitute U+FFFD and hand plausible-looking
     *  text to the strict parser. */
    @Test
    fun `bytes that are not UTF-8 are reported rather than substituted`() = runBlocking {
        LoopbackHttpServer.serving(body = byteArrayOf(0x7B, 0xC3.toByte(), 0x28, 0x7D)).use { server ->
            val result = transportFor(server).send(AccountRequest("GET", "api/me", bearer = "t"))
            assertEquals(TransportResult.Failed(TransportResult.Failure.NOT_TEXT), result)
        }
    }

    /**
     * The reproduced crash, at the layer that has to survive it.
     *
     * A bearer containing a newline is refused by OkHttp when it is put into a
     * header — by THROWING, from a value that came off the wire. Before this
     * was classified it was an uncaught `IllegalArgumentException` on whatever
     * dispatcher the request ran on, with the credential quoted in its message.
     * [Bearer] stops such a token being adopted at all; this is the second
     * fence, and it must not crash and must not carry the value.
     */
    @Test
    fun `an unsendable bearer is a classified refusal, not an exception`() = runBlocking {
        LoopbackHttpServer.serving(body = "{}").use { server ->
            val result = transportFor(server).send(AccountRequest("GET", "api/me", bearer = "bad\nheader"))
            assertEquals(TransportResult.Failed(TransportResult.Failure.REQUEST_REJECTED), result)
            assertEquals("nothing may have been sent", 0, server.requests.get())
        }
        // And the client above it turns that into the one failure whose recovery
        // is "drop this credential and sign in again".
        val client = AccountClient { TransportResult.Failed(TransportResult.Failure.REQUEST_REJECTED) }
        val failure = (client.fetchMe("bad\nheader").exceptionOrNull() as AccountException).failure
        assertEquals(AccountFailure.Kind.CREDENTIAL_UNUSABLE, failure.kind)
    }

    /** A response is never printed with its body: a login body is a credential
     *  and a poll body is one too. */
    @Test
    fun `a response does not print its body`() {
        val printed = AccountResponse(200, """{"token":"rlm_cli_secret"}""").toString()
        assertTrue(printed.contains("200"))
        assertTrue(printed.contains("redacted"))
        assertTrue(!printed.contains("rlm_cli_secret"))
    }

    /** An unreachable origin is a network failure with no exception escaping
     *  and nothing about the credential in it. */
    @Test
    fun `an unreachable origin is a classified network failure`() = runBlocking {
        val transport = OkHttpAccountTransport(
            origin = "http://127.0.0.1:1",
            client = OkHttpClient.Builder().callTimeout(2, TimeUnit.SECONDS).build(),
            userAgent = "Relayium-Android/test (account)",
        )
        val result = transport.send(AccountRequest("GET", "api/me", bearer = "rlm_cli_x"))
        assertEquals(TransportResult.Failed(TransportResult.Failure.NETWORK), result)
    }
}
