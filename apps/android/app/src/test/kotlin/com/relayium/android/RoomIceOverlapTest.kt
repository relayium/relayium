package com.relayium.android

import com.relayium.android.nearby.ConnectionSource
import com.relayium.android.storage.ProviderOps
import com.relayium.android.storage.ReceiveStore
import com.relayium.android.transport.IceConfig
import com.relayium.android.transport.LinkTransport
import com.relayium.android.transport.SignalingClient
import com.relayium.android.transport.SignalingHandle
import com.relayium.android.transport.TransportHandle
import com.relayium.protocol.Envelope
import com.relayium.protocol.Json
import com.relayium.protocol.LinkProtocol
import com.relayium.protocol.PairCode
import com.relayium.protocol.Signal
import com.relayium.protocol.legacy.WireProfile
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The room's socket and the room's ICE grant are acquired TOGETHER, and exactly
 * one thing waits for the grant.
 *
 * `openRoom` used to `await` the ICE fetch before it created the signalling
 * client at all, so every join paid a full `/api/ice` round trip — up to the
 * fetch's own ten-second deadline on a bad network — before the peer could see
 * this device arrive. The Web has always started both at once.
 *
 * What must NOT move is the `PeerConnection`: built without the grant it is
 * built with no STUN and no relay, and a cross-network pair then gathers host
 * candidates that cannot reach each other. So the tests here are in two halves
 * — the socket must not wait, and the connection must.
 */
class RoomIceOverlapTest {

    @get:Rule
    val temp = TemporaryFolder()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val controllers = ArrayList<TransferController>()

    @After
    fun tearDown() {
        controllers.forEach { it.shutdown() }
        scope.cancel()
    }

    // ── harness ─────────────────────────────────────────────────────────────

    private class FakeSignaling : SignalingHandle {
        @Volatile var events: SignalingClient.Events? = null
        @Volatile var connects = 0
        val sent = ConcurrentLinkedQueue<Pair<String, Json>>()
        override fun connect() { connects++ }
        override fun sendSignal(to: String, data: Json) { sent.add(to to data) }
        override fun close() = Unit
    }

    /** Records the ICE servers it was BUILT with — the whole point of the
     *  gate is that a connection never exists without the room's grant. */
    private class FakeTransport(
        val profile: WireProfile,
        val servers: List<IceConfig.Server>,
        val events: LinkTransport.Events,
    ) : TransportHandle {
        val signals = ConcurrentLinkedQueue<Json>()
        @Volatile var closedReason: String? = null
        /** Fail the link ON the Nth inbound signal, synchronously, the way a
         *  real transport reports a handshake it cannot accept. */
        @Volatile var failOnSignal = 0
        override fun start() = Unit
        override fun onSignal(raw: Json) {
            signals.add(raw)
            if (failOnSignal > 0 && signals.size == failOnSignal) events.onClosed("ice-failed")
        }
        override fun sendFile(frame: ByteArray) = true
        override fun sendText(frame: ByteArray) = true
        override fun fileBufferedAmount() = 0L
        override fun textBufferedAmount() = 0L
        override fun leaveAndClose(leave: Signal?) { closedReason = "local-leave" }
        override fun close(reason: String) { closedReason = reason }
    }

    private class NoOps : ProviderOps {
        override fun findChild(parent: ProviderOps.Node, name: String): ProviderOps.Node? = null
        override fun createDirectory(parent: ProviderOps.Node, name: String): ProviderOps.Node? = null
        override fun createFile(parent: ProviderOps.Node, name: String): ProviderOps.Node? = null
    }

    /**
     * An ICE fetch a test decides the timing of. Each call parks separately, so
     * a second room's fetch is a second, separately settled one.
     *
     * [cooperative] chooses HOW it parks. The default awaits a deferred, which
     * cancellation can stop. `false` parks on a plain `suspendCoroutine`, which
     * has no cancellation path at all: the answer is delivered into the
     * coroutine whatever happened to its job, so the room fence in `openRoom` —
     * not the cancellation — is what has to stop a stale grant. That models the
     * real race in `IceConfig.fetch`, where `call.cancel()` is best effort and
     * a response already in hand has nothing left to abort.
     */
    private class IceGate(private val cooperative: Boolean = true) {
        val calls = ConcurrentLinkedQueue<(IceConfig.Result) -> Unit>()
        val started = AtomicInteger(0)
        @Volatile var throwInstead = false

        suspend fun fetch(): IceConfig.Result {
            started.incrementAndGet()
            if (throwInstead) throw IllegalStateException("injected ICE failure")
            if (!cooperative) {
                return suspendCoroutine { continuation ->
                    calls.add { result -> continuation.resume(result) }
                }
            }
            val pending = CompletableDeferred<IceConfig.Result>()
            calls.add { result -> pending.complete(result) }
            return pending.await()
        }

        fun settle(result: IceConfig.Result) {
            val pending = calls.poll() ?: error("no ICE fetch is in flight")
            pending(result)
        }
    }

    private class Rig(
        val controller: TransferController,
        val signaling: FakeSignaling,
        val transports: ConcurrentLinkedQueue<FakeTransport>,
        val ice: IceGate,
        /** Applied to every transport the factory builds from now on, so a
         *  connection created INSIDE a drain can be armed before it exists. */
        val failOnSignalForNew: AtomicInteger,
    ) {
        val state get() = controller.state.value
        val events: SignalingClient.Events get() = signaling.events ?: error("no signalling client")
        val transport: FakeTransport get() = transports.peek() ?: error("no transport was created")
    }

    private val turn = IceConfig.Server(
        listOf("turn:relay.example:3478"), "user", "credential",
    )

    /** Deliberately distinguishable, so a stale answer that leaked into the
     *  next room would be visible in that room's transport rather than merely
     *  absent. */
    private val staleTurn = IceConfig.Server(
        listOf("turn:stale.example:3478"), "stale", "stale",
    )

    private fun rig(
        selfId: String = "aaaaaaaa",
        source: ConnectionSource = ConnectionSource.Pairing(
            PairCode("123456"), TransferController.Intent.JOINER,
        ),
        welcome: Boolean = true,
        cooperativeIce: Boolean = true,
    ): Rig {
        val signaling = FakeSignaling()
        val transports = ConcurrentLinkedQueue<FakeTransport>()
        val ice = IceGate(cooperativeIce)
        val failOnSignalForNew = AtomicInteger(0)
        val deps = TransferController.Deps(
            fetchIce = { ice.fetch() },
            signals = { _, events -> signaling.also { it.events = events } },
            transports = { profile, servers, _, _, events ->
                FakeTransport(profile, servers, events)
                    .also { it.failOnSignal = failOnSignalForNew.get() }
                    .also(transports::add)
            },
            store = ReceiveStore(temp.newFolder("staging-${System.nanoTime()}")),
            providerOps = NoOps(),
            timeouts = quiet(),
        )
        val controller = TransferController(scope, "test-device", deps)
        controllers.add(controller)
        controller.join(source)
        val rig = Rig(controller, signaling, transports, ice, failOnSignalForNew)
        if (welcome) {
            awaitTrue("the signalling client exists") { signaling.events != null }
            rig.events.onSelfId(selfId, "203.0.113.9")
        }
        return rig
    }

    private fun quiet() = TransferController.Timeouts(
        helloRetryMs = 60_000, settleMs = 60_000, requestRetryMs = 60_000,
        requestDeadlineMs = 60_000, consentMs = 60_000, textEndAckMs = 60_000,
        abortBarrierMs = 60_000, textIdleMs = 600_000,
        pendingAdmissionMs = 60_000, roomRetryMs = 60_000,
    )

    private fun awaitTrue(what: String, timeoutMs: Long = 5_000, predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return
            Thread.sleep(5)
        }
        throw AssertionError("timed out waiting for: $what")
    }

    /** Let the session executor drain far enough that "nothing happened" means
     *  it, rather than "not yet". */
    private fun quiesce() = Thread.sleep(250)

    private fun capsHello(): Json = Json.obj("caps" to Json.arr(listOf(Json.of("link/1"))))

    private fun offerFrom() = Signal.offer("v=0\r\n", "Y29tbWl0", listOf("link/1")).toJson()

    /** A REBUILD offer. Well-formed, carries an SDP, and is refused in silence
     *  by this stage on every path — `Signal.Generation.RESUME`. */
    private fun resumeOfferFrom() = Signal(
        resume = true, link = true, sdpType = "offer", sdp = "v=0\r\n", commit = "Y29tbWl0",
    ).toJson()

    private fun candidateFrom(n: Int) =
        Signal.candidate("candidate:$n 1 udp 1 10.0.0.1 1 typ host", "0", 0).toJson()

    // ── the socket must not wait ────────────────────────────────────────────

    @Test
    fun `the rendezvous socket opens while the ICE grant is still in flight`() {
        val rig = rig(welcome = false)
        awaitTrue("the signalling client is built before any ICE answer") {
            rig.signaling.events != null
        }
        assertEquals("and it is actually dialled", 1, rig.signaling.connects)
        // The fetch is dispatched onto the session executor behind the socket:
        // it has not even STARTED when the client is already wired, which is
        // the whole of the change — the join no longer waits on `/api/ice`.
        awaitTrue("the fetch is genuinely outstanding") { rig.ice.started.get() == 1 }
        assertTrue("and no fetch has answered", rig.ice.calls.isNotEmpty())
        assertEquals(0, rig.transports.size)
        // The welcome and the roster land on a room that joined without waiting.
        rig.events.onSelfId("aaaaaaaa", "203.0.113.9")
        rig.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        awaitTrue("this device greeted the peer before the grant arrived") {
            rig.signaling.sent.any { (to, _) -> to == "bbbbbbbb" }
        }
        rig.ice.settle(IceConfig.Result(listOf(turn), ""))
    }

    @Test
    fun `a backend-free source asks for no grant and gates nothing`() {
        val rig = rig(source = ConnectionSource.Direct)
        rig.events.onPeers(listOf(Envelope.Peer("aaaaaaaa", "this"), Envelope.Peer("bbbbbbbb", "peer")))
        rig.events.onSignal("bbbbbbbb", capsHello())
        awaitTrue("the peer is listed") { rig.state.nearby.devices.size == 1 }
        assertEquals(
            "the direct path must make no ICE request, ever",
            0, rig.ice.started.get(),
        )
        rig.controller.connectToPeer("bbbbbbbb", rig.state.nearby.roomId)
        awaitTrue("and still establishes immediately") { rig.transports.isNotEmpty() }
        assertEquals(emptyList<IceConfig.Server>(), rig.transport.servers)
    }

    // ── the connection must wait ────────────────────────────────────────────

    @Test
    fun `no PeerConnection is built before the room's grant lands`() {
        // Smaller id: this device is the initiator and would offer at once.
        val rig = rig(selfId = "aaaaaaaa")
        rig.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        rig.events.onSignal("bbbbbbbb", capsHello())
        quiesce()
        assertTrue(
            "a connection built now would have no STUN and no relay",
            rig.transports.isEmpty(),
        )
        rig.ice.settle(IceConfig.Result(listOf(turn), ""))
        awaitTrue("the held decision runs on the grant") { rig.transports.isNotEmpty() }
        assertEquals(
            "and it is built with the grant this room was issued",
            listOf(turn), rig.transport.servers,
        )
    }

    @Test
    fun `an offer held for the grant reaches the transport, in arrival order`() {
        // Larger id: the peer offers, so the inbound frame is what establishes.
        val rig = rig(selfId = "zzzzzzzz")
        rig.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        rig.events.onSignal("bbbbbbbb", offerFrom())
        rig.events.onSignal("bbbbbbbb", Signal.candidate("candidate:1 1 udp 1 10.0.0.1 1 typ host", "0", 0).toJson())
        quiesce()
        assertTrue("held, not acted on", rig.transports.isEmpty())
        rig.ice.settle(IceConfig.Result(listOf(turn), ""))
        awaitTrue("the offer establishes once the grant is in") { rig.transports.isNotEmpty() }
        awaitTrue("and both frames reached it") { rig.transport.signals.size == 2 }
        val kinds = rig.transport.signals.map { Signal.fromJson(it) }
        assertEquals(
            "the offer must still precede the candidate that chased it",
            listOf("offer", null), kinds.map { it?.sdpType },
        )
        assertTrue("the candidate is the second", kinds[1]?.candidate != null)
        assertEquals(listOf(turn), rig.transport.servers)
    }

    @Test
    fun `explicit consent is unchanged by the gate, and still the only way in`() {
        val rig = rig(selfId = "zzzzzzzz", source = ConnectionSource.Hub)
        rig.events.onPeers(listOf(Envelope.Peer("zzzzzzzz", "this"), Envelope.Peer("bbbbbbbb", "peer")))
        rig.events.onSignal("bbbbbbbb", offerFrom())
        quiesce()
        assertNull("a held frame raises nothing yet", rig.state.nearby.incomingId)
        rig.ice.settle(IceConfig.Result(listOf(turn), ""))
        awaitTrue("the replayed ask raises the prompt") {
            rig.state.nearby.incomingId == "bbbbbbbb"
        }
        quiesce()
        assertTrue(
            "and the grant landing is NOT consent: nothing establishes without a person",
            rig.transports.isEmpty(),
        )
        rig.controller.admitPeer("bbbbbbbb", rig.state.nearby.incomingPromptId)
        awaitTrue("the consented connection is built") { rig.transports.isNotEmpty() }
        awaitTrue("carrying the offer the user was asked about") {
            rig.transport.signals.any { Signal.fromJson(it)?.sdpType == "offer" }
        }
        assertEquals(listOf(turn), rig.transport.servers)
    }

    @Test
    fun `a room retry drops the old grant, asks again, and keeps a consented offer`() {
        val rig = rig(selfId = "zzzzzzzz", source = ConnectionSource.Hub)
        assertEquals(1, rig.ice.started.get())
        // The room drops before its grant ever landed. Retrying must not leave
        // the first fetch owning the gate of the room that replaced it.
        rig.events.onClosed(1006, "dropped")
        rig.controller.retryNearby()
        awaitTrue("the retry asks for its own grant") { rig.ice.started.get() == 2 }
        rig.ice.calls.poll()!!.invoke(IceConfig.Result(emptyList(), ""))
        quiesce()

        rig.events.onSelfId("zzzzzzzz", "203.0.113.9")
        rig.events.onPeers(listOf(Envelope.Peer("zzzzzzzz", "this"), Envelope.Peer("bbbbbbbb", "peer")))
        rig.events.onSignal("bbbbbbbb", offerFrom())
        quiesce()
        assertTrue(
            "the stale grant must not have opened this room's gate",
            rig.transports.isEmpty(),
        )
        assertNull("nor raised its prompt", rig.state.nearby.incomingId)

        rig.ice.settle(IceConfig.Result(listOf(turn), ""))
        awaitTrue("this room's own grant releases the held ask") {
            rig.state.nearby.incomingId == "bbbbbbbb"
        }
        rig.controller.admitPeer("bbbbbbbb", rig.state.nearby.incomingPromptId)
        awaitTrue("established on consent") { rig.transports.isNotEmpty() }
        awaitTrue("with the offer the peer will not repeat") {
            rig.transport.signals.any { Signal.fromJson(it)?.sdpType == "offer" }
        }
        assertEquals(listOf(turn), rig.transport.servers)
    }

    // ── cancellation and failure ────────────────────────────────────────────

    @Test
    fun `a grant for a room the user left never drains into the next one`() {
        // NON-cooperative: this fetch has no cancellation path, so the stale
        // answer really is delivered into the coroutine after the room changed.
        // The room fence has to be what stops it.
        val rig = rig(selfId = "zzzzzzzz", cooperativeIce = false)
        rig.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        rig.events.onSignal("bbbbbbbb", offerFrom())
        quiesce()
        val stale = rig.ice.calls.poll() ?: error("no fetch in flight")
        // The user leaves and joins a different code. The old room's frames
        // belong to a room identity that no longer exists.
        rig.controller.join(PairCode("654321"), TransferController.Intent.JOINER)
        awaitTrue("the new room asks for its own grant") { rig.ice.started.get() == 2 }
        stale(IceConfig.Result(listOf(staleTurn), "quota"))
        quiesce()
        assertTrue(
            "the previous room's offer must not build a connection in this one",
            rig.transports.isEmpty(),
        )
        assertNull(
            "and the old room's answer must not write into the new room's state",
            rig.state.relayNote,
        )
        assertFalse(
            "and nothing is left claiming to be connected",
            rig.state.phase == TransferController.Phase.CONNECTED,
        )
        // The NEW room is unaffected by the stale answer: its own grant opens
        // its own gate, and the servers a connection is built with are that
        // room's, never the previous room's.
        rig.events.onSelfId("zzzzzzzz", "203.0.113.9")
        rig.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        rig.events.onSignal("bbbbbbbb", offerFrom())
        quiesce()
        assertTrue("still held — this room has no grant yet", rig.transports.isEmpty())
        rig.ice.settle(IceConfig.Result(listOf(turn), ""))
        awaitTrue("this room's own grant establishes") { rig.transports.isNotEmpty() }
        assertEquals(listOf(turn), rig.transport.servers)
    }

    /** Anti-vacuity for the test above: the SAME non-cooperative fetch, with no
     *  room change, must be observed by production all the way through — gate
     *  opened, servers adopted, relay note published. Without this, "nothing
     *  happened" above could merely mean the answer was never delivered. */
    @Test
    fun `a non-cooperative fetch is observed in full when its room is still live`() {
        val rig = rig(selfId = "zzzzzzzz", cooperativeIce = false)
        rig.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        rig.events.onSignal("bbbbbbbb", offerFrom())
        quiesce()
        assertTrue(rig.transports.isEmpty())
        rig.ice.settle(IceConfig.Result(listOf(staleTurn), "quota"))
        awaitTrue("the answer reached the room") { rig.transports.isNotEmpty() }
        assertEquals(listOf(staleTurn), rig.transport.servers)
        assertEquals("quota", rig.state.relayNote)
    }

    @Test
    fun `a throwing ICE fetch degrades to host candidates instead of wedging`() {
        val signaling = FakeSignaling()
        val transports = ConcurrentLinkedQueue<FakeTransport>()
        val ice = IceGate().also { it.throwInstead = true }
        val deps = TransferController.Deps(
            fetchIce = { ice.fetch() },
            signals = { _, events -> signaling.also { it.events = events } },
            transports = { profile, servers, _, _, events ->
                FakeTransport(profile, servers, events).also(transports::add)
            },
            store = ReceiveStore(temp.newFolder("staging-${System.nanoTime()}")),
            providerOps = NoOps(),
            timeouts = quiet(),
        )
        val controller = TransferController(scope, "test-device", deps)
        controllers.add(controller)
        controller.join(PairCode("123456"), TransferController.Intent.JOINER)
        awaitTrue("signalling wired") { signaling.events != null }
        signaling.events!!.onSelfId("aaaaaaaa", "")
        signaling.events!!.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        signaling.events!!.onSignal("bbbbbbbb", capsHello())
        awaitTrue("the room still establishes") { transports.isNotEmpty() }
        assertEquals(
            "a failed grant is an EMPTY list — never an invented third-party default",
            emptyList<IceConfig.Server>(), transports.peek()!!.servers,
        )
    }

    @Test
    fun `the held-frame buffer is bounded and fails closed`() {
        val rig = rig(selfId = "zzzzzzzz")
        rig.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        // REAL asks, every one of which would build a connection on replay.
        repeat(LinkProtocol.HELD_SIGNAL_MAX + 1) { rig.events.onSignal("bbbbbbbb", offerFrom()) }
        awaitTrue("the flood ends the session rather than growing the buffer") {
            rig.state.phase == TransferController.Phase.ENDED
        }
        assertEquals("error_connection_lost", rig.state.errorKey)
        rig.ice.settle(IceConfig.Result(listOf(turn), ""))
        quiesce()
        assertTrue("and nothing is replayed afterwards", rig.transports.isEmpty())
    }

    @Test
    fun `traffic this client ignores can neither fill the hold nor end a session`() {
        val rig = rig(selfId = "zzzzzzzz")
        rig.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        // Far past the bound, in the two shapes that reach the hold but would
        // be discarded the moment they were acted on: the resume generation,
        // which this stage refuses in silence on every path, and candidates
        // from a peer with no ask in flight, which have no offer to belong to.
        repeat(4 * LinkProtocol.HELD_SIGNAL_MAX) {
            rig.events.onSignal("bbbbbbbb", resumeOfferFrom())
            rig.events.onSignal(
                "cccccccc",
                Signal.candidate("candidate:$it 1 udp 1 10.0.0.1 1 typ host", "0", 0).toJson(),
            )
        }
        quiesce()
        assertEquals(
            "ignored traffic must not be able to end a session",
            TransferController.Phase.CONNECTING, rig.state.phase,
        )
        assertNull(rig.state.errorKey)
        // …and the hold is still free for the ask that matters.
        rig.events.onSignal("bbbbbbbb", offerFrom())
        rig.ice.settle(IceConfig.Result(listOf(turn), ""))
        awaitTrue("the real offer still establishes") { rig.transports.isNotEmpty() }
        assertEquals(listOf(turn), rig.transport.servers)
        awaitTrue("carrying only the frame that mattered") {
            rig.transport.signals.size == 1
        }
        assertEquals("offer", Signal.fromJson(rig.transport.signals.peek())?.sdpType)
    }

    @Test
    fun `a candidate chasing a held ask keeps its place in the queue`() {
        val rig = rig(selfId = "zzzzzzzz")
        rig.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        // A bare candidate BEFORE any ask is dropped — it belongs to no offer,
        // exactly as it is dropped today when the grant is already in hand.
        rig.events.onSignal("bbbbbbbb", candidateFrom(1))
        rig.events.onSignal("bbbbbbbb", offerFrom())
        rig.events.onSignal("bbbbbbbb", candidateFrom(2))
        rig.ice.settle(IceConfig.Result(listOf(turn), ""))
        awaitTrue("established") { rig.transports.isNotEmpty() }
        awaitTrue("two frames reached it") { rig.transport.signals.size == 2 }
        quiesce()
        val kinds = rig.transport.signals.map { Signal.fromJson(it) }
        assertEquals(listOf("offer", null), kinds.map { it?.sdpType })
        assertEquals(
            "the candidate that chased the ask, and only that one",
            "candidate:2 1 udp 1 10.0.0.1 1 typ host", kinds[1]?.candidate,
        )
    }

    @Test
    fun `a flood that fails the buffer closed does not wedge a Nearby room`() {
        val rig = rig(selfId = "zzzzzzzz", source = ConnectionSource.Hub)
        rig.events.onPeers(listOf(Envelope.Peer("zzzzzzzz", "this"), Envelope.Peer("bbbbbbbb", "peer")))
        repeat(LinkProtocol.HELD_SIGNAL_MAX + 1) { rig.events.onSignal("bbbbbbbb", offerFrom()) }
        awaitTrue("the flood retires the establishment, not the room") {
            rig.state.phase == TransferController.Phase.WAITING_PEER
        }
        assertTrue("the room is still live", rig.state.nearby.active)
        // The grant this room asked for must still be able to land. Cancelling
        // it with the buffer would leave the gate shut for the room's whole
        // life: every later establishment would be held and never replayed.
        rig.ice.settle(IceConfig.Result(listOf(turn), ""))
        rig.events.onSignal("bbbbbbbb", capsHello())
        rig.events.onSignal("bbbbbbbb", offerFrom())
        awaitTrue("a later ask still reaches the user") {
            rig.state.nearby.incomingId == "bbbbbbbb"
        }
        rig.controller.admitPeer("bbbbbbbb", rig.state.nearby.incomingPromptId)
        awaitTrue("and still establishes, with the grant") { rig.transports.isNotEmpty() }
        assertEquals(listOf(turn), rig.transport.servers)
    }

    // ── the pre-handshake departure (D × E) ─────────────────────────────────

    @Test
    fun `a peer that leaves while its offer is held never gets a connection`() {
        // The shape the review named: the roster carries the peer but no
        // standalone hello, so the ONLY announcement is the one embedded in its
        // offer — and that offer is held for the grant, which means nothing has
        // been established and `peerId` is still empty when the peer departs.
        val rig = rig(selfId = "zzzzzzzz")
        rig.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        rig.events.onSignal("bbbbbbbb", offerFrom())
        rig.events.onSignal("bbbbbbbb", candidateFrom(1))
        quiesce()
        assertTrue("held, nothing established", rig.transports.isEmpty())

        rig.events.onPeerLeft("bbbbbbbb")
        rig.events.onPeers(emptyList())
        quiesce()
        rig.ice.settle(IceConfig.Result(listOf(turn), ""))
        quiesce()
        assertTrue(
            "the grant must not build a PeerConnection to a device that left",
            rig.transports.isEmpty(),
        )
        assertFalse(
            "and the session is not claimed to be connecting to it",
            rig.state.phase == TransferController.Phase.CONNECTED,
        )
        // Only the DEPARTED peer's work is dropped: the room still works.
        rig.events.onPeers(listOf(Envelope.Peer("cccccccc", "other")))
        rig.events.onSignal("cccccccc", offerFrom())
        awaitTrue("another peer still establishes") { rig.transports.isNotEmpty() }
        assertEquals(listOf(turn), rig.transport.servers)
    }

    @Test
    fun `a peer that leaves while its connection decision is held gets none either`() {
        // The other half: this device is the INITIATOR, so the roster alone
        // decided to build — and that decision is what the grant is holding.
        //
        // Every caller of `startTransport` sets `peerId` before it defers, so
        // this case is ALREADY covered by the link fence inside the held
        // decision: the departure ends the session, the epoch moves, and the
        // decision drops itself. The explicit invalidation in
        // `forgetHeldRoomWork` is belt and braces for it. The test is here so
        // that stays true, not because it is what fixed this path.
        val rig = rig(selfId = "aaaaaaaa")
        rig.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        rig.events.onSignal("bbbbbbbb", capsHello())
        quiesce()
        assertTrue("the decision is held, not acted on", rig.transports.isEmpty())
        rig.events.onPeerLeft("bbbbbbbb")
        quiesce()
        rig.ice.settle(IceConfig.Result(listOf(turn), ""))
        quiesce()
        assertTrue(
            "a held decision for a departed peer is not a connection to build",
            rig.transports.isEmpty(),
        )
    }

    // ── the drain's own fences ──────────────────────────────────────────────

    @Test
    fun `a link retired mid-drain does not let the rest replay into the next one`() {
        // A Nearby room OUTLIVES its connection, so the room fence alone does
        // not cover this: a held frame can fail the link and leave the room
        // standing, and everything behind it was captured against the link that
        // just went away.
        val rig = rig(selfId = "aaaaaaaa", source = ConnectionSource.Hub)
        rig.events.onPeers(listOf(Envelope.Peer("aaaaaaaa", "this"), Envelope.Peer("bbbbbbbb", "peer")))
        rig.events.onSignal("bbbbbbbb", capsHello())
        awaitTrue("listed") { rig.state.nearby.devices.size == 1 }
        rig.controller.connectToPeer("bbbbbbbb", rig.state.nearby.roomId)
        quiesce()
        assertTrue("the consented connection is held for the grant", rig.transports.isEmpty())
        // Two frames chase the peer this device committed to. The first one
        // reaches the transport and the transport fails on it; the second must
        // not be replayed into the room that survives.
        rig.events.onSignal("bbbbbbbb", candidateFrom(1))
        rig.events.onSignal("bbbbbbbb", offerFrom())
        rig.failOnSignalForNew.set(1)

        rig.ice.settle(IceConfig.Result(listOf(turn), ""))
        awaitTrue("the held decision built the connection") { rig.transports.isNotEmpty() }
        awaitTrue("and the first held frame failed it") {
            rig.state.phase == TransferController.Phase.WAITING_PEER
        }
        quiesce()
        assertTrue("the room itself survives", rig.state.nearby.active)
        assertNull(
            "the frame behind it must not raise a prompt under a fresh link",
            rig.state.nearby.incomingId,
        )
        assertEquals("and no second connection is built", 1, rig.transports.size)
    }

    @Test
    fun `a capability announcement is not held behind the grant`() {
        val rig = rig(selfId = "zzzzzzzz", source = ConnectionSource.Hub)
        rig.events.onPeers(listOf(Envelope.Peer("zzzzzzzz", "this"), Envelope.Peer("bbbbbbbb", "peer")))
        rig.events.onSignal("bbbbbbbb", capsHello())
        awaitTrue("the list the user reads must not wait on an HTTP round trip") {
            rig.state.nearby.devices.singleOrNull()?.supportsLink == true
        }
        assertNull(rig.transports.peek())
        rig.ice.settle(IceConfig.Result(listOf(turn), ""))
    }
}
