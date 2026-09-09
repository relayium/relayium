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

    // ── the relay pool ──────────────────────────────────────────────────────

    /**
     * **The room whose credential is issued ONLY in the pool.**
     *
     * `server/account/turn.go` withholds the top-level TURN entry for a strict
     * ("only my nodes") owner and offers that owner's own node in `relays`
     * instead. Reading the top level alone resolved STUN-only for exactly those
     * rooms, so the issued endpoint, username and credential were dropped on
     * the floor while the Apple peer folded the same pool in and built
     * relay-only against it.
     */
    @Test
    fun `a pool-only room keeps the TURN endpoint, username and credential`() {
        val result = IceConfig.parse(
            """
            {"iceServers":[{"urls":["stun:stun.example.com:3478"]}],
             "relays":[{"id":"own-1","region":"eu",
                        "iceServers":[{"urls":["turn:node.example.com:3478?transport=udp"],
                                       "username":"1799999999.own","credential":"poolsecret"}]}],
             "relayDenied":""}
            """.trimIndent(),
        )
        assertEquals(2, result.servers.size)
        assertEquals(listOf("stun:stun.example.com:3478"), result.servers[0].urls)
        val turn = result.servers[1]
        assertEquals(listOf("turn:node.example.com:3478?transport=udp"), turn.urls)
        assertEquals("1799999999.own", turn.username)
        assertEquals("poolsecret", turn.credential)
    }

    /** A pool answer with no readable top level at all is still an answer. */
    @Test
    fun `a pool survives an absent top-level list`() {
        for (top in listOf("""{"relays":""", """{"iceServers":null,"relays":""")) {
            val result = IceConfig.parse(
                top + """[{"id":"own-1","iceServers":[{"urls":["turn:node.example.com:3478"],
                          "username":"u","credential":"c"}]}]}""",
            )
            assertEquals(listOf("turn:node.example.com:3478"), result.servers.single().urls)
            assertEquals("c", result.servers.single().credential)
        }
    }

    /**
     * The non-strict shape: legacy top-level TURN AND a fleet pool. Both are
     * offered, top level first, exactly as `RelaySelection.resolve` orders them
     * with no choice made.
     */
    @Test
    fun `a mixed legacy and pool room offers both, top level first`() {
        val result = IceConfig.parse(
            """
            {"iceServers":[{"urls":["stun:stun.example.com:3478"]},
                           {"urls":["turn:legacy.example.com:3478"],"username":"lu","credential":"lc"}],
             "relays":[{"id":"a","iceServers":[{"urls":["turn:a.example.com:3478"],
                                                "username":"au","credential":"ac"}]},
                       {"id":"b","iceServers":[{"urls":["turn:b.example.com:3478"],
                                                "username":"bu","credential":"bc"}]}]}
            """.trimIndent(),
        )
        assertEquals(
            listOf("stun:stun.example.com:3478", "turn:legacy.example.com:3478",
                   "turn:a.example.com:3478", "turn:b.example.com:3478"),
            result.servers.map { it.urls.single() },
        )
        assertEquals(listOf(null, "lu", "au", "bu"), result.servers.map { it.username })
    }

    /** Bounded: a padded pool cannot make this client open unbounded TURN
     *  allocations, and the cap is positional so entry nine stays unreachable. */
    @Test
    fun `the pool is capped at the first eight entries`() {
        val relays = (1..12).joinToString(",") {
            """{"id":"r$it","iceServers":[{"urls":["turn:r$it.example.com:3478"],
               "username":"u$it","credential":"c$it"}]}"""
        }
        val result = IceConfig.parse("""{"iceServers":[],"relays":[$relays]}""")
        assertEquals(8, result.servers.size)
        assertEquals("turn:r1.example.com:3478", result.servers.first().urls.single())
        assertEquals("turn:r8.example.com:3478", result.servers.last().urls.single())
    }

    /**
     * **The cap is positional, so padding cannot buy reach.**
     *
     * Eight malformed entries ahead of two real ones: a cap applied AFTER
     * filtering would skip the padding and fold both real relays, which is a
     * response deciding how many allocations this client opens. The bound is on
     * what the server sent, not on what survived parsing, so the real entries
     * stay out of reach and the valid top level is untouched.
     */
    @Test
    fun `malformed padding cannot promote entries past the cap`() {
        val padding = (1..8).joinToString(",") { """{"id":"bad$it"}""" }
        val real = (9..10).joinToString(",") {
            """{"id":"r$it","iceServers":[{"urls":["turn:r$it.example.com:3478"],
               "username":"u$it","credential":"c$it"}]}"""
        }
        val result = IceConfig.parse("""{"iceServers":[$TOP],"relays":[$padding,$real]}""")
        assertEquals(listOf("turn:legacy.example.com:3478"), result.servers.single().urls)
        assertEquals("lc", result.servers.single().credential)
    }

    /** One machine offered under two ids is one credential to probe. Exact
     *  tuples only, and the top-level occurrence is the one kept. */
    @Test
    fun `an exact duplicate of a top-level entry is folded once`() {
        val entry = """{"urls":["turn:same.example.com:3478"],"username":"u","credential":"c"}"""
        val result = IceConfig.parse(
            """{"iceServers":[$entry],
                "relays":[{"id":"a","iceServers":[$entry]},
                          {"id":"b","iceServers":[{"urls":["turn:same.example.com:3478"],
                                                   "username":"u","credential":"different"}]}]}""",
        )
        // The differing credential is a DIFFERENT tuple and is kept.
        assertEquals(2, result.servers.size)
        assertEquals(listOf("c", "different"), result.servers.map { it.credential })
    }

    /**
     * Malformed pool data is skipped entry by entry and never costs the caller
     * a valid top-level credential — the one property this parser must not
     * trade away for strictness.
     */
    @Test
    fun `malformed pool data never drops the valid top level`() {
        val bodies = listOf(
            """{"iceServers":[$TOP],"relays":"nope"}""",
            """{"iceServers":[$TOP],"relays":[1,"x",null]}""",
            """{"iceServers":[$TOP],"relays":[{"id":"a"}]}""",
            """{"iceServers":[$TOP],"relays":[{"id":"a","iceServers":"nope"}]}""",
            """{"iceServers":[$TOP],"relays":[{"id":"a","iceServers":[{"username":"u"}]}]}""",
            """{"iceServers":[$TOP],"relays":[{"id":"a","iceServers":[{"urls":[]}]}]}""",
        )
        for (body in bodies) {
            val result = IceConfig.parse(body)
            assertEquals(body, listOf("turn:legacy.example.com:3478"), result.servers.single().urls)
            assertEquals(body, "lc", result.servers.single().credential)
        }
    }

    /** A good entry beside a bad one in the SAME pool row still travels. */
    @Test
    fun `a malformed pool entry does not suppress a valid sibling`() {
        val result = IceConfig.parse(
            """{"iceServers":[],
                "relays":[{"id":"bad"},
                          {"id":"good","iceServers":[{"urls":"turn:good.example.com:3478",
                                                      "username":"u","credential":"c"}]}]}""",
        )
        assertEquals(listOf("turn:good.example.com:3478"), result.servers.single().urls)
    }

    /** Nothing readable anywhere is still the empty list — never a public STUN
     *  default this client invented, and never a peer-supplied address. */
    @Test
    fun `an unreadable pool falls back to empty, never an invented server`() {
        for (body in listOf(
            """{"relays":"nope"}""",
            """{"iceServers":"nope","relays":[]}""",
            """{"iceServers":[],"relays":[{"id":"a","iceServers":[]}],"relayDenied":"quota"}""",
        )) {
            assertTrue(body, IceConfig.parse(body).servers.isEmpty())
        }
        assertEquals(
            "quota",
            IceConfig.parse("""{"iceServers":[],"relays":[],"relayDenied":"quota"}""").relayDenied,
        )
    }
}

/** The non-strict legacy top-level TURN entry, reused by the malformed-pool table. */
private const val TOP =
    """{"urls":["turn:legacy.example.com:3478"],"username":"lu","credential":"lc"}"""

/** The shared client shape without touching Android-only setup. */
private object SignalingClientTestSeam {
    fun plainClient() = okhttp3.OkHttpClient.Builder().build()
}
