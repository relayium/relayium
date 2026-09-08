package com.relayium.android

import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * A raw HTTP/1.1 server on loopback, for the update-fetch tests.
 *
 * Hand-written rather than a library on purpose. The interesting cases here are
 * all things a well-behaved mock server makes awkward: headers now and a body
 * ten seconds later, a `Content-Length` that lies, a body that never ends, a
 * connection that stalls forever so cancellation has something to cancel, and
 * bytes that are not valid UTF-8. Writing the response bytes directly is the
 * shortest path to all of them, and it adds no dependency to a build whose
 * version catalog is pinned and audited.
 */
class LoopbackHttpServer(
    private val respond: (path: String, out: OutputStream, closed: AtomicBoolean) -> Unit,
) : AutoCloseable {

    private val server = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
    private val thread: Thread
    private val running = AtomicBoolean(true)

    /** How many requests were accepted. */
    val requests = AtomicInteger(0)

    /** Set when writing the response failed because the peer went away — which
     *  is how a genuinely cancelled call is observed from the server side. */
    val clientDisconnected = AtomicBoolean(false)

    /** Opened when the handler has written the response headers. */
    val headersSent = CountDownLatch(1)

    val port: Int get() = server.localPort

    fun url(path: String): String = "http://127.0.0.1:$port$path"

    init {
        thread = Thread {
            while (running.get()) {
                val socket = try {
                    server.accept()
                } catch (_: Exception) {
                    return@Thread
                }
                requests.incrementAndGet()
                Thread { serve(socket) }.also { it.isDaemon = true }.start()
            }
        }
        thread.isDaemon = true
        thread.start()
    }

    private fun serve(socket: Socket) {
        socket.use { s ->
            try {
                // Read the request line and headers so the client is not left
                // waiting on its own write.
                val reader = BufferedReader(InputStreamReader(s.getInputStream()))
                val requestLine = reader.readLine() ?: return
                val path = requestLine.split(" ").getOrElse(1) { "/" }
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isEmpty()) break
                }
                respond(path, s.getOutputStream(), clientDisconnected)
            } catch (_: Exception) {
                clientDisconnected.set(true)
            }
        }
    }

    override fun close() {
        running.set(false)
        runCatching { server.close() }
        thread.join(TimeUnit.SECONDS.toMillis(2))
    }

    companion object {

        /** Status, headers and a body, all at once. */
        fun serving(
            status: String = "200 OK",
            contentType: String = "application/json",
            body: ByteArray,
            contentLength: Long? = null,
        ): LoopbackHttpServer = LoopbackHttpServer { _, out, _ ->
            val length = contentLength ?: body.size.toLong()
            out.write(
                ("HTTP/1.1 $status\r\nContent-Type: $contentType\r\n" +
                    "Content-Length: $length\r\nConnection: close\r\n\r\n").toByteArray()
            )
            out.write(body)
            out.flush()
        }

        fun serving(
            status: String = "200 OK",
            contentType: String = "application/json",
            body: String,
        ): LoopbackHttpServer = serving(status, contentType, body.toByteArray())

        /** A redirect, which this app must refuse rather than follow. */
        fun redirecting(to: String): LoopbackHttpServer = LoopbackHttpServer { _, out, _ ->
            out.write(
                ("HTTP/1.1 302 Found\r\nLocation: $to\r\nContent-Length: 0\r\n" +
                    "Connection: close\r\n\r\n").toByteArray()
            )
            out.flush()
        }
    }
}
