package com.relayium.android.cloud

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * A loopback HTTP/1.1 server that RECORDS what it was sent.
 *
 * The sibling `LoopbackHttpServer` answers the update tests, which only ever ask
 * what the client did with a response. These tests ask the opposite question —
 * what did the client PUT ON THE WIRE — and one answer matters more than any
 * other: a redirected ciphertext download must arrive with no `Authorization`
 * and no `Cookie` at all. That cannot be asserted from the client side, where
 * the header is simply not added; it has to be observed by the host that
 * received the request. Hence the capture.
 *
 * Hand-written for the same reason its sibling is: a redirect chain across two
 * ports, a body that stops mid-frame, and a `Content-Length` read back exactly
 * as the client declared it are all easier as raw bytes than as a mock.
 */
class RecordingHttpServer(
    private val respond: (Received, OutputStream) -> Unit,
) : AutoCloseable {

    /** One request, as the server actually saw it. */
    class Received(
        val method: String,
        val target: String,
        val headers: Map<String, String>,
        val body: ByteArray,
    ) {
        /** Header lookup is case-insensitive, because HTTP is. */
        fun header(name: String): String? = headers[name.lowercase()]

        val path: String get() = target.substringBefore('?')
        val query: String get() = target.substringAfter('?', "")
    }

    private val server = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
    private val running = AtomicBoolean(true)
    private val thread: Thread

    /** Every request, in arrival order. */
    val received = ConcurrentLinkedQueue<Received>()

    val port: Int get() = server.localPort
    val origin: String get() = "http://127.0.0.1:$port"

    init {
        thread = Thread {
            while (running.get()) {
                val socket = try {
                    server.accept()
                } catch (_: Exception) {
                    return@Thread
                }
                Thread { serve(socket) }.also { it.isDaemon = true }.start()
            }
        }
        thread.isDaemon = true
        thread.start()
    }

    private fun serve(socket: Socket) {
        socket.use { s ->
            runCatching {
                val input = s.getInputStream()
                val requestLine = readLine(input) ?: return
                val parts = requestLine.split(" ")
                val headers = HashMap<String, String>()
                while (true) {
                    val line = readLine(input) ?: break
                    if (line.isEmpty()) break
                    val name = line.substringBefore(':').trim().lowercase()
                    headers[name] = line.substringAfter(':').trim()
                }
                val length = headers["content-length"]?.toIntOrNull() ?: 0
                val body = ByteArray(length)
                var read = 0
                while (read < length) {
                    val n = input.read(body, read, length - read)
                    if (n <= 0) break
                    read += n
                }
                val request = Received(
                    method = parts.getOrElse(0) { "" },
                    target = parts.getOrElse(1) { "/" },
                    headers = headers,
                    body = if (read == length) body else body.copyOf(read),
                )
                received.add(request)
                respond(request, s.getOutputStream())
                s.getOutputStream().flush()
            }
        }
    }

    private fun readLine(input: InputStream): String? {
        val out = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b == -1) return if (out.size() == 0) null else out.toString("UTF-8")
            if (b == '\n'.code) return out.toString("UTF-8").removeSuffix("\r")
            out.write(b)
        }
    }

    override fun close() {
        running.set(false)
        runCatching { server.close() }
        thread.join(TimeUnit.SECONDS.toMillis(2))
    }

    companion object {

        fun respond(
            out: OutputStream,
            status: String = "200 OK",
            contentType: String = "application/json",
            body: ByteArray = ByteArray(0),
            extraHeaders: List<String> = emptyList(),
            declaredLength: Long? = null,
        ) {
            val head = StringBuilder("HTTP/1.1 $status\r\nContent-Type: $contentType\r\n")
            head.append("Content-Length: ${declaredLength ?: body.size.toLong()}\r\n")
            for (header in extraHeaders) head.append(header).append("\r\n")
            head.append("Connection: close\r\n\r\n")
            out.write(head.toString().toByteArray())
            out.write(body)
        }

        fun redirect(out: OutputStream, location: String) {
            out.write(
                ("HTTP/1.1 302 Found\r\nLocation: $location\r\n" +
                    "Content-Length: 0\r\nConnection: close\r\n\r\n").toByteArray(),
            )
        }
    }
}
