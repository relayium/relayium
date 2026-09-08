package com.relayium.android.nearby

import com.relayium.android.transport.SignalingClient
import com.relayium.protocol.Envelope
import com.relayium.protocol.Json
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledThreadPoolExecutor
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The local rendezvous' ordering and admission rules, against a scripted
 * transport.
 *
 * These are the rules an emulator run cannot check: it samples one interleaving
 * of discovery, dialling and inbound streams and reports it as the whole space.
 * Every case below is one this channel must get right on a link where the
 * ordering is chosen by two other devices and the timing by the network.
 */
class LocalPeerSignalingChannelTest {

    private val queues = ArrayList<ScheduledExecutorService>()

    @After
    fun tearDown() {
        queues.forEach { it.shutdownNow() }
    }

    // ── harness ─────────────────────────────────────────────────────────────

    private class ScriptedConnection(val peerLabel: String) : LocalPeerConnection {
        override var onBytes: ((ByteArray, Int) -> Unit)? = null
        override var onClosed: (() -> Unit)? = null
        val sent = ConcurrentLinkedQueue<String>()
        @Volatile var started = false
        @Volatile var cancelled = false

        override fun start() { started = true }
        override fun send(bytes: ByteArray) {
            // Decoded through the REAL reader, so the test asserts against what a
            // peer would actually parse rather than against the bytes we meant.
            sent.addAll(LocalPeerFraming.Reader().append(bytes))
        }
        override fun cancel() { cancelled = true }

        /** Deliver [text] as a properly framed inbound read. */
        fun deliver(text: String) {
            val frame = LocalPeerFraming.encode(text)!!
            onBytes?.invoke(frame, frame.size)
        }

        fun deliverRaw(bytes: ByteArray) { onBytes?.invoke(bytes, bytes.size) }
    }

    private class ScriptedTransport : LocalPeerTransport {
        @Volatile var delegate: LocalPeerTransportDelegate? = null
        @Volatile var advertisement: LocalPeerAdvertisement? = null
        @Volatile var stopped = false
        val dialled = ConcurrentLinkedQueue<String>()
        val outbound = ConcurrentLinkedQueue<ScriptedConnection>()

        override fun start(advertisement: LocalPeerAdvertisement, delegate: LocalPeerTransportDelegate) {
            this.advertisement = advertisement
            this.delegate = delegate
        }

        override fun connect(peer: LocalPeerAdvertisement): LocalPeerConnection {
            dialled.add(peer.identity)
            return ScriptedConnection(peer.identity).also(outbound::add)
        }

        override fun stop() { stopped = true }
    }

    private class Recorder : SignalingClient.Events {
        val selfIds = ConcurrentLinkedQueue<String>()
        val rosters = ConcurrentLinkedQueue<List<Envelope.Peer>>()
        val left = ConcurrentLinkedQueue<String>()
        val signals = ConcurrentLinkedQueue<Pair<String, Json>>()
        val closed = ConcurrentLinkedQueue<Pair<Int, String>>()
        /** Everything, in the order it was delivered, so ORDER is assertable and
         *  not merely membership. */
        val order = ConcurrentLinkedQueue<String>()

        override fun onSelfId(id: String, ip: String) { selfIds.add(id); order.add("self:$id") }
        override fun onPeers(peers: List<Envelope.Peer>) {
            rosters.add(peers); order.add("peers:" + peers.joinToString(",") { it.id })
        }
        override fun onPeerLeft(peerId: String) { left.add(peerId); order.add("left:$peerId") }
        override fun onSignal(from: String, data: Json) {
            signals.add(from to data); order.add("signal:$from")
        }
        override fun onClosed(code: Int, reason: String) { closed.add(code to reason); order.add("closed:$reason") }
        override fun onFailure(error: Throwable) { order.add("failure") }
    }

    private class Rig(
        val channel: LocalPeerSignalingChannel,
        val transport: ScriptedTransport,
        val events: Recorder,
        val self: LocalPeerAdvertisement,
    )

    private fun rig(selfIdentity: String = SELF, graceMs: Long = 200): Rig {
        val queue = ScheduledThreadPoolExecutor(1) { r ->
            Executors.defaultThreadFactory().newThread(r).apply { isDaemon = true }
        }
        queues.add(queue)
        val self = LocalPeerAdvertisement(selfIdentity, "This device", listOf("text/1", "link/1"))
        val transport = ScriptedTransport()
        val events = Recorder()
        val channel = LocalPeerSignalingChannel(
            advertisement = self,
            transport = transport,
            events = events,
            queue = queue,
            ownsQueue = false,
            graceMs = graceMs,
        )
        return Rig(channel, transport, events, self)
    }

    private fun start(rig: Rig, vararg peers: LocalPeerAdvertisement) {
        rig.channel.connect()
        awaitTrue("the transport was armed") { rig.transport.delegate != null }
        rig.transport.delegate!!.localPeerTransportDidStart()
        // BOTH edges: the welcome and the roster behind it are two separate
        // emissions on the channel's queue, and reading state between them is
        // how this helper would sample a half-joined room.
        awaitTrue("welcome") { rig.events.selfIds.isNotEmpty() }
        awaitTrue("the first roster") { rig.events.rosters.isNotEmpty() }
        if (peers.isNotEmpty()) discover(rig, *peers)
    }

    private fun discover(rig: Rig, vararg peers: LocalPeerAdvertisement) {
        rig.transport.delegate!!.localPeerTransportDidDiscover(peers.toList())
        awaitTrue("roster names them") {
            rig.events.rosters.lastOrNull()?.map { it.id }?.containsAll(peers.map { it.identity }) == true
        }
    }

    private fun awaitTrue(what: String, timeoutMs: Long = 4_000, predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return
            Thread.sleep(5)
        }
        throw AssertionError("timed out waiting for: $what")
    }

    private fun settle() = Thread.sleep(120)

    private fun peer(identity: String, name: String = "Peer", caps: List<String> = listOf("link/1")) =
        LocalPeerAdvertisement(identity, name, caps)

    private fun envelope(from: String, to: String, data: Json): String = Json.stringify(
        Json.obj(
            "type" to Json.of("signal"),
            "from" to Json.of(from),
            "to" to Json.of(to),
            "data" to data,
        ),
    )

    private fun offer(): Json = Json.obj(
        "sdp" to Json.obj("type" to Json.of("offer"), "sdp" to Json.of("v=0\r\n")),
        "commit" to Json.of("Y29tbWl0"),
        "link" to Json.of(true),
    )

    private fun capsOnly(): Json = Json.obj("caps" to Json.arr(listOf(Json.of("link/1"))))

    // ── joining ─────────────────────────────────────────────────────────────

    @Test
    fun `the identity is this room's self id, and it lands before any roster`() {
        val rig = rig()
        start(rig)
        assertEquals(listOf(SELF), rig.events.selfIds.toList())
        assertTrue(
            "welcome precedes the first roster: a roster that cannot exclude this " +
                "device would offer the user their own phone",
            rig.events.order.first().startsWith("self:"),
        )
        assertEquals(
            "and this device is in its own roster, exactly as the hub's is",
            listOf(SELF),
            rig.events.rosters.last().map { it.id },
        )
    }

    /**
     * The ordering the whole feature rests on. On the hub a peer announces in a
     * roster hello that lands before anybody dials; here the advertisement IS
     * that hello, so it must be delivered as one BEFORE the roster frame — or a
     * device is offered as selectable before what it can speak is known.
     */
    @Test
    fun `a peer's own capabilities are credited before the roster that lists it`() {
        val rig = rig()
        start(rig)
        val before = rig.events.order.size
        discover(rig, peer(PEER_A, caps = listOf("text/1", "link/1")))
        val after = rig.events.order.toList().drop(before)
        assertEquals(listOf("signal:$PEER_A", "peers:$SELF,$PEER_A"), after)
        val credited = rig.events.signals.last()
        assertEquals(PEER_A, credited.first)
        assertEquals(
            "credited with what THAT peer advertised, never with this build's list",
            """{"caps":["text/1","link/1"]}""",
            Json.stringify(credited.second),
        )
    }

    @Test
    fun `the roster is self first then peers by identity, whatever order they were browsed in`() {
        val rig = rig()
        start(rig)
        discover(rig, peer(PEER_C), peer(PEER_A), peer(PEER_B))
        assertEquals(
            listOf(SELF, PEER_A, PEER_B, PEER_C),
            rig.events.rosters.last().map { it.id },
        )
    }

    @Test
    fun `this device never appears in its own browse results as a peer`() {
        val rig = rig()
        start(rig)
        discover(rig, peer(PEER_A))
        rig.transport.delegate!!.localPeerTransportDidDiscover(
            listOf(rig.self, peer(PEER_A)),
        )
        settle()
        assertEquals(listOf(SELF, PEER_A), rig.events.rosters.last().map { it.id })
    }

    // ── browsing lists; only selection dials ────────────────────────────────

    /**
     * The property that keeps this transport honest. On the hub a roster hello
     * costs a relay hop; here it would be a TCP connection to a device the user
     * has not chosen.
     */
    @Test
    fun `a roster capability announcement never opens a stream`() {
        val rig = rig()
        start(rig, peer(PEER_A))
        rig.channel.sendSignal(PEER_A, capsOnly())
        settle()
        assertTrue("nothing was dialled", rig.transport.dialled.isEmpty())
    }

    @Test
    fun `an addressed establishment frame does dial, once`() {
        val rig = rig()
        start(rig, peer(PEER_A))
        rig.channel.sendSignal(PEER_A, offer())
        awaitTrue("dialled") { rig.transport.dialled.isNotEmpty() }
        rig.channel.sendSignal(PEER_A, offer())
        settle()
        assertEquals("one stream per peer", listOf(PEER_A), rig.transport.dialled.toList())
        val stream = rig.transport.outbound.first()
        assertTrue("and it was started", stream.started)
        awaitTrue("both frames went down it") { stream.sent.size == 2 }
        val parsed = Json.parseOrNull(stream.sent.first()) as Json.Obj
        assertEquals("signal", (parsed["type"] as Json.Str).value)
        assertEquals("the sender stamps its own id: there is no server to do it",
            SELF, (parsed["from"] as Json.Str).value)
        assertEquals(PEER_A, (parsed["to"] as Json.Str).value)
    }

    @Test
    fun `a greeting still travels on a stream the user's choice already opened`() {
        val rig = rig()
        start(rig, peer(PEER_A))
        rig.channel.sendSignal(PEER_A, offer())
        awaitTrue("dialled") { rig.transport.outbound.isNotEmpty() }
        rig.channel.sendSignal(PEER_A, capsOnly())
        val stream = rig.transport.outbound.first()
        awaitTrue("the hello rode the existing stream") { stream.sent.size == 2 }
    }

    @Test
    fun `an unknown, malformed or self-addressed target is never dialled`() {
        val rig = rig()
        start(rig, peer(PEER_A))
        rig.channel.sendSignal(PEER_B, offer())          // not discovered
        rig.channel.sendSignal("nope", offer())          // not an identity
        rig.channel.sendSignal(SELF, offer())            // ourselves
        settle()
        assertTrue(rig.transport.dialled.isEmpty())
    }

    // ── inbound routing ─────────────────────────────────────────────────────

    private fun accept(rig: Rig): ScriptedConnection {
        val connection = ScriptedConnection("inbound")
        rig.transport.delegate!!.localPeerTransportDidAccept(connection)
        awaitTrue("started") { connection.started }
        return connection
    }

    @Test
    fun `an inbound signal from a discovered peer is delivered`() {
        val rig = rig()
        start(rig, peer(PEER_A))
        val stream = accept(rig)
        stream.deliver(envelope(PEER_A, SELF, offer()))
        awaitTrue("delivered") { rig.events.signals.any { it.first == PEER_A && it.second == offer() } }
    }

    @Test
    fun `a frame addressed to somebody else is dropped`() {
        val rig = rig()
        start(rig, peer(PEER_A))
        val stream = accept(rig)
        stream.deliver(envelope(PEER_A, PEER_B, offer()))
        settle()
        assertTrue(rig.events.signals.none { it.second == offer() })
    }

    /** A device claiming to BE this one. Never a shipped loopback, and never a
     *  peer worth answering. */
    @Test
    fun `a stream that claims this device's own identity is dropped in silence`() {
        val rig = rig()
        start(rig, peer(PEER_A))
        val stream = accept(rig)
        stream.deliver(envelope(SELF, SELF, offer()))
        awaitTrue("cancelled") { stream.cancelled }
        assertTrue("and no departure was invented", rig.events.left.isEmpty())
    }

    /** One stream carries ONE peer. A second identity on a bound stream is a
     *  device speaking for another. */
    @Test
    fun `a second identity on a bound stream drops it`() {
        val rig = rig()
        start(rig, peer(PEER_A), peer(PEER_B))
        val stream = accept(rig)
        stream.deliver(envelope(PEER_A, SELF, offer()))
        awaitTrue("bound to A") { rig.events.signals.any { it.first == PEER_A } }
        stream.deliver(envelope(PEER_B, SELF, offer()))
        awaitTrue("dropped") { stream.cancelled }
        assertEquals(listOf(PEER_A), rig.events.left.toList())
        assertTrue(
            "B's establishment frame was never delivered — only the capability " +
                "credit browsing produced for it",
            rig.events.signals.none { it.first == PEER_B && it.second == offer() },
        )
    }

    @Test
    fun `a malformed stream is dropped rather than resynchronised`() {
        val rig = rig()
        start(rig, peer(PEER_A))
        val stream = accept(rig)
        stream.deliver(envelope(PEER_A, SELF, offer()))
        awaitTrue("bound") { rig.events.signals.any { it.first == PEER_A } }
        stream.deliverRaw(byteArrayOf(0, 0, 0, 0, 9, 9)) // a zero-length declaration
        awaitTrue("dropped") { stream.cancelled }
        assertEquals(listOf(PEER_A), rig.events.left.toList())
    }

    // ── discovery ordering ──────────────────────────────────────────────────

    /** TCP can beat the browse update. The ordinary case, not an attack. */
    @Test
    fun `frames from a peer the browser has not reported yet are held and then delivered in order`() {
        val rig = rig()
        start(rig)
        val stream = accept(rig)
        stream.deliver(envelope(PEER_A, SELF, Json.obj("n" to Json.of(1))))
        stream.deliver(envelope(PEER_A, SELF, Json.obj("n" to Json.of(2))))
        settle()
        assertTrue("nothing delivered before the peer was credited", rig.events.signals.isEmpty())
        discover(rig, peer(PEER_A))
        awaitTrue("both arrived") { rig.events.signals.size >= 3 }
        val fromA = rig.events.signals.filter { it.first == PEER_A }.map { Json.stringify(it.second) }
        assertEquals(
            "the capability credit first, then the held frames in wire order",
            listOf("""{"caps":["link/1"]}""", """{"n":1}""", """{"n":2}"""),
            fromA,
        )
    }

    @Test
    fun `a peer that holds more than the grace bound is dropped`() {
        val rig = rig(graceMs = 60_000)
        start(rig)
        val stream = accept(rig)
        repeat(LocalPeerSignalingChannel.MAX_GRACE_FRAMES + 1) {
            stream.deliver(envelope(PEER_A, SELF, Json.obj("n" to Json.of(it))))
        }
        awaitTrue("dropped") { stream.cancelled }
        assertEquals(listOf(PEER_A), rig.events.left.toList())
    }

    /** An unclaimed stream is dropped WITHOUT a departure: it was never bound to
     *  a listed device, so reporting one would remove a peer that is still there. */
    @Test
    fun `an inbound stream nobody claims is dropped after the grace period, silently`() {
        val rig = rig(graceMs = 120)
        start(rig, peer(PEER_A))
        val stream = accept(rig)
        awaitTrue("the grace period closed on it") { stream.cancelled }
        assertTrue(rig.events.left.isEmpty())
        assertEquals("and the peer stays listed", listOf(SELF, PEER_A), rig.events.rosters.last().map { it.id })
    }

    // ── two devices dialling at once ────────────────────────────────────────

    /**
     * Both sides may dial in the same instant. The tiebreak is the SAME
     * lexicographic comparison the link role uses, so the two devices choose the
     * same survivor without exchanging anything — and only the losing socket is
     * closed, with no departure, because the peer did not leave.
     */
    @Test
    fun `the smaller identity keeps its outbound stream`() {
        val rig = rig(selfIdentity = SELF) // SELF < PEER_A
        start(rig, peer(PEER_A))
        rig.channel.sendSignal(PEER_A, offer())
        awaitTrue("we dialled") { rig.transport.outbound.isNotEmpty() }
        val ours = rig.transport.outbound.first()
        val theirs = accept(rig)
        theirs.deliver(envelope(PEER_A, SELF, offer()))
        awaitTrue("their inbound stream lost") { theirs.cancelled }
        assertFalse("ours survives", ours.cancelled)
        assertTrue("and nobody was reported as leaving", rig.events.left.isEmpty())
    }

    @Test
    fun `the larger identity keeps the inbound stream instead`() {
        val rig = rig(selfIdentity = SELF_HIGH) // SELF_HIGH > PEER_A
        start(rig, peer(PEER_A))
        rig.channel.sendSignal(PEER_A, offer())
        awaitTrue("we dialled") { rig.transport.outbound.isNotEmpty() }
        val ours = rig.transport.outbound.first()
        val theirs = accept(rig)
        theirs.deliver(envelope(PEER_A, SELF_HIGH, offer()))
        awaitTrue("our outbound stream lost") { ours.cancelled }
        assertFalse(theirs.cancelled)
        assertTrue(rig.events.left.isEmpty())
    }

    // ── retirement and teardown ─────────────────────────────────────────────

    @Test
    fun `retiring a peer closes its stream without reporting a departure`() {
        val rig = rig()
        start(rig, peer(PEER_A))
        rig.channel.sendSignal(PEER_A, offer())
        awaitTrue("dialled") { rig.transport.outbound.isNotEmpty() }
        val stream = rig.transport.outbound.first()
        rig.channel.retirePeer(PEER_A)
        awaitTrue("closed") { stream.cancelled }
        assertTrue("the device did not leave", rig.events.left.isEmpty())
        assertEquals("and is still listed", listOf(SELF, PEER_A), rig.events.rosters.last().map { it.id })
    }

    @Test
    fun `a retired stream's late bytes reach nothing`() {
        val rig = rig()
        start(rig, peer(PEER_A))
        rig.channel.sendSignal(PEER_A, offer())
        awaitTrue("dialled") { rig.transport.outbound.isNotEmpty() }
        val stream = rig.transport.outbound.first()
        rig.channel.retirePeer(PEER_A)
        awaitTrue("closed") { stream.cancelled }
        val before = rig.events.signals.size
        stream.deliver(envelope(PEER_A, SELF, offer()))
        settle()
        assertEquals("a disowned stream cannot resurrect a peer", before, rig.events.signals.size)
    }

    @Test
    fun `closing stops the transport, cancels every stream and says so once`() {
        val rig = rig()
        start(rig, peer(PEER_A))
        rig.channel.sendSignal(PEER_A, offer())
        awaitTrue("dialled") { rig.transport.outbound.isNotEmpty() }
        val stream = rig.transport.outbound.first()
        rig.channel.close()
        awaitTrue("closed once") { rig.events.closed.size == 1 }
        assertTrue(rig.transport.stopped)
        assertTrue(stream.cancelled)
        rig.channel.close()
        settle()
        assertEquals("and only once", 1, rig.events.closed.size)
    }

    @Test
    fun `a transport failure closes the channel with its reason`() {
        val rig = rig()
        start(rig)
        rig.transport.delegate!!.localPeerTransportDidFail(LocalPeerFailure.UNAVAILABLE)
        awaitTrue("reported") { rig.events.closed.isNotEmpty() }
        val (code, reason) = rig.events.closed.first()
        assertEquals(LocalPeerSignalingChannel.CLOSE_FAILURE, code)
        assertEquals(LocalPeerFailure.UNAVAILABLE.name, reason)
    }

    @Test
    fun `discovery arriving after a close publishes nothing`() {
        val rig = rig()
        start(rig, peer(PEER_A))
        rig.channel.close()
        awaitTrue("closed") { rig.events.closed.isNotEmpty() }
        val before = rig.events.order.size
        rig.transport.delegate!!.localPeerTransportDidDiscover(listOf(peer(PEER_B)))
        rig.transport.delegate!!.localPeerTransportDidAccept(ScriptedConnection("late"))
        settle()
        assertEquals("a stopped room says nothing more", before, rig.events.order.size)
    }

    @Test
    fun `a peer that stops advertising leaves the roster`() {
        val rig = rig()
        start(rig, peer(PEER_A), peer(PEER_B))
        rig.transport.delegate!!.localPeerTransportDidDiscover(listOf(peer(PEER_B)))
        awaitTrue("gone") { rig.events.rosters.last().map { it.id } == listOf(SELF, PEER_B) }
    }

    private companion object {
        const val SELF = "0000000000000000000000000000aaaa"
        const val SELF_HIGH = "ffffffffffffffffffffffffffffffff"
        const val PEER_A = "1111111111111111111111111111111a"
        const val PEER_B = "2222222222222222222222222222222b"
        const val PEER_C = "3333333333333333333333333333333c"
    }
}
