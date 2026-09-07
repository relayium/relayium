package com.relayium.android

import com.relayium.android.transport.IceConfig
import java.net.ServerSocket
import kotlin.concurrent.thread
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The bounded ICE exchange (R7): a server that accepts and never answers must
 * resolve inside the call's own deadline, on a REAL socket — not a mock of the
 * failure this test exists to provoke.
 */
class IceConfigTest {

    @Test
    fun `parse reads servers, credentials and the refusal reason`() {
        val result = IceConfig.parse(
            """
            {"iceServers":[
              {"urls":"stun:stun.example.com:3478"},
              {"urls":["turn:turn.example.com:3478?transport=udp","turn:turn.example.com:443?transport=tcp"],
               "username":"user","credential":"secret"}
            ],"relayDenied":""}
            """.trimIndent(),
        )
        assertEquals(2, result.servers.size)
        assertEquals(listOf("stun:stun.example.com:3478"), result.servers[0].urls)
        assertEquals("user", result.servers[1].username)
        assertEquals("secret", result.servers[1].credential)
        assertEquals("", result.relayDenied)
    }

    @Test
    fun `a refusal reason survives with no servers`() {
        val result = IceConfig.parse("""{"iceServers":[],"relayDenied":"unverified"}""")
        assertTrue(result.servers.isEmpty())
        assertEquals("unverified", result.relayDenied)
    }

    @Test
    fun `garbage parses to the empty fallback, never a default STUN`() {
        for (body in listOf("", "not json", "[]", """{"iceServers":"nope"}""")) {
            assertTrue(IceConfig.parse(body).servers.isEmpty())
        }
    }

    @Test
    fun `a server that accepts and never answers is bounded by the call deadline`() {
        // A real listening socket that reads the request and then goes silent.
        val server = ServerSocket(0)
        val stall = thread(isDaemon = true) {
            runCatching {
                val socket = server.accept()
                socket.getInputStream().read(ByteArray(1024))
                Thread.sleep(60_000)
                socket.close()
            }
        }
        try {
            val started = System.nanoTime()
            val result = runBlocking {
                // The OUTER timeout is the test's own failure detector; the
                // fetch must come back well inside it through its OWN deadline.
                withTimeout(8_000) {
                    IceConfig.fetch(
                        SignalingClientTestSeam.plainClient(),
                        "http://127.0.0.1:${server.localPort}",
                        com.relayium.protocol.PairCode("123456"),
                        timeoutSeconds = 1,
                    )
                }
            }
            val elapsedMs = (System.nanoTime() - started) / 1_000_000
            assertTrue(result.servers.isEmpty())
            assertTrue("resolved by the call's own deadline, took ${elapsedMs}ms", elapsedMs < 6_000)
        } finally {
            runCatching { server.close() }
            stall.interrupt()
        }
    }
}

/** The shared client shape without touching Android-only setup. */
private object SignalingClientTestSeam {
    fun plainClient() = okhttp3.OkHttpClient.Builder().build()
}
