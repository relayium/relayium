package com.relayium.android.nearby

import com.relayium.android.TransferController
import com.relayium.android.storage.ProviderOps
import com.relayium.android.storage.ReceiveStore
import com.relayium.android.transport.IceConfig
import com.relayium.android.transport.LinkTransport
import com.relayium.android.transport.PeerScopedSignaling
import com.relayium.android.transport.SignalingClient
import com.relayium.android.transport.SignalingHandle
import com.relayium.android.transport.TransportHandle
import com.relayium.protocol.Crypto
import com.relayium.protocol.Envelope
import com.relayium.protocol.Json
import com.relayium.protocol.LinkProtocol
import com.relayium.protocol.RealtimeFrame
import com.relayium.protocol.Signal
import com.relayium.protocol.legacy.LegacyProtocol
import com.relayium.protocol.legacy.WireProfile
import java.io.File
import java.io.OutputStream
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The REAL [TransferController] in a room where nothing may establish without a
 * person — one controller, several peers, and every way that can go wrong.
 *
 * The seams are the production ones: the same signalling handle the OkHttp
 * client and the local Bonjour channel both implement, the same transport
 * factory the WebRTC transport is built through, the same storage seam. Nothing
 * here re-implements an admission rule in order to assert it.
 */
class NearbyControllerTest {

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

    private class FakeSignaling : SignalingHandle, PeerScopedSignaling {
        lateinit var events: SignalingClient.Events
        val sent = ConcurrentLinkedQueue<Pair<String, Json>>()
        val retired = ConcurrentLinkedQueue<String>()
        @Volatile var closed = false
        override fun connect() = Unit
        override fun sendSignal(to: String, data: Json) { sent.add(to to data) }
        override fun close() { closed = true }
        override fun retirePeer(peerId: String) { retired.add(peerId) }
        fun busyTo(): List<String> =
            sent.filter { Signal.fromJson(it.second)?.busy == true }.map { it.first }
    }

    private class FakeTransport(
        val profile: WireProfile,
        val events: LinkTransport.Events,
    ) : TransportHandle {
        val signals = ConcurrentLinkedQueue<Json>()
        @Volatile var closedReason: String? = null
        @Volatile var leaveSent = false
        override fun start() = Unit
        override fun onSignal(raw: Json) { signals.add(raw) }
        override fun sendFile(frame: ByteArray) = true
        override fun sendText(frame: ByteArray) = true
        override fun fileBufferedAmount() = 0L
        override fun textBufferedAmount() = 0L
        override fun leaveAndClose(leave: Signal?) { leaveSent = true; closedReason = "local-leave" }
        override fun close(reason: String) { closedReason = reason }
    }

    private class NoOps : ProviderOps {
        override fun findChild(parent: ProviderOps.Node, name: String): ProviderOps.Node? = null
        override fun createDirectory(parent: ProviderOps.Node, name: String): ProviderOps.Node? = null
        override fun createFile(parent: ProviderOps.Node, name: String): ProviderOps.Node? = null
    }

    private class Rig(
        val controller: TransferController,
        val signaling: FakeSignaling,
        val transports: ConcurrentLinkedQueue<FakeTransport>,
        val iceCalls: AtomicInteger,
        val sources: ConcurrentLinkedQueue<ConnectionSource>,
        /** What this rig told the controller its own room id is. Both
         *  rendezvous shapes broadcast the whole room including this device, so
         *  every roster below has to contain it. */
        val selfId: String,
    ) {
        val state get() = controller.state.value
        val nearby get() = state.nearby
        val transport: FakeTransport get() = transports.last() ?: error("no transport")
    }

    private fun rig(
        source: ConnectionSource = ConnectionSource.Direct,
        selfId: String = SELF,
        timeouts: TransferController.Timeouts = quiet(),
    ): Rig {
        val signaling = FakeSignaling()
        val transports = ConcurrentLinkedQueue<FakeTransport>()
        val iceCalls = AtomicInteger(0)
        val sources = ConcurrentLinkedQueue<ConnectionSource>()
        val deps = TransferController.Deps(
            fetchIce = { iceCalls.incrementAndGet(); IceConfig.Result(emptyList(), "") },
            signals = { s, events ->
                sources.add(s)
                signaling.also { it.events = events }
            },
            transports = { profile, _, _, _, events ->
                FakeTransport(profile, events).also(transports::add)
            },
            store = ReceiveStore(temp.newFolder("staging-${System.nanoTime()}")),
            providerOps = NoOps(),
            timeouts = timeouts,
        )
        val controller = TransferController(scope, "test-device", deps)
        controllers.add(controller)
        controller.join(source)
        awaitTrue("signalling wired") { runCatching { signaling.events }.isSuccess }
        signaling.events.onSelfId(selfId, "")
        return Rig(controller, signaling, transports, iceCalls, sources, selfId)
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

    /** Settle the controller's session executor: post an action and wait for a
     *  state edge it must have produced. Used where the assertion is that
     *  NOTHING happened, which otherwise cannot be distinguished from "not yet". */
    private fun settle(rig: Rig) {
        val before = rig.nearby.devices
        rig.signaling.events.onPeers(rig.roster(before.map { it.id }))
        Thread.sleep(120)
    }

    private fun Rig.roster(ids: List<String>) =
        listOf(Envelope.Peer(selfId, "this device")) + ids.map { Envelope.Peer(it, nameOf(it)) }

    private fun nameOf(id: String) = when (id) {
        PEER_A -> "Alpha"; PEER_B -> "Bravo"; PEER_C -> "Charlie"; else -> "Device"
    }

    private fun caps(vararg values: String): Json =
        Json.obj("caps" to Json.arr(values.map(Json::of)))

    private fun announce(rig: Rig, vararg peers: String) {
        rig.signaling.events.onPeers(rig.roster(peers.toList()))
        for (peer in peers) rig.signaling.events.onSignal(peer, caps("text/1", "link/1"))
        awaitTrue("all peers listed with their announcement") {
            rig.nearby.devices.size == peers.size && rig.nearby.devices.all { it.supportsLink }
        }
    }

    private fun connect(rig: Rig, peer: String): Crypto.SessionKeys {
        rig.controller.connectToPeer(peer, rig.nearby.roomId)
        awaitTrue("a transport for $peer") { rig.transports.isNotEmpty() }
        return ready(rig)
    }

    private fun ready(rig: Rig): Crypto.SessionKeys {
        val a = Crypto.generateKeyPair()
        val b = Crypto.generateKeyPair()
        val local = Crypto.deriveSession(Crypto.Role.INITIATOR, a, b.publicKey)
        val remote = Crypto.deriveSession(Crypto.Role.RESPONDER, b, a.publicKey)
        rig.transport.events.onReady(local, "705955", RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        awaitTrue("connected") { rig.state.phase == TransferController.Phase.CONNECTED }
        return remote
    }

    // ── the direct path makes no network request ────────────────────────────

    /**
     * The whole privacy claim of the local link, asserted at the seam that would
     * carry the request. Not "the URL is empty" — the call is never made.
     */
    @Test
    fun `the direct source never asks the backend for anything`() {
        val rig = rig(source = ConnectionSource.Direct)
        announce(rig, PEER_A, PEER_B)
        connect(rig, PEER_B)
        assertEquals("no ICE fetch on the direct path", 0, rig.iceCalls.get())
        assertEquals(
            "and the rendezvous it opened is the local one",
            listOf<ConnectionSource>(ConnectionSource.Direct),
            rig.sources.toList(),
        )
    }

    @Test
    fun `the hub source does ask, because it has a server to ask`() {
        val rig = rig(source = ConnectionSource.Hub)
        awaitTrue("ICE fetched once") { rig.iceCalls.get() == 1 }
    }

    // ── no implicit peer, ever ──────────────────────────────────────────────

    @Test
    fun `three peers in the room establish nothing at all`() {
        val rig = rig()
        announce(rig, PEER_A, PEER_B, PEER_C)
        settle(rig)
        assertTrue("nothing was dialled", rig.transports.isEmpty())
        assertNull("and nothing was selected", rig.nearby.selectedId)
        assertEquals(TransferController.Phase.WAITING_PEER, rig.state.phase)
        assertEquals(
            "every peer is listed, sorted by name",
            listOf("Alpha", "Bravo", "Charlie"),
            rig.nearby.devices.map { it.name },
        )
    }

    @Test
    fun `the user's choice is the peer that gets dialled, not the first to arrive`() {
        val rig = rig()
        announce(rig, PEER_A, PEER_B, PEER_C)
        connect(rig, PEER_C)
        assertEquals(1, rig.transports.size)
        assertEquals(PEER_C, rig.nearby.selectedId)
        // Every signal this side sent went to the chosen peer or was a hello.
        val establishment = rig.signaling.sent.filter {
            Signal.fromJson(it.second)?.let { s -> s.linkRequest || s.sdpType != null } == true
        }
        assertTrue(
            "no establishment frame went anywhere but the chosen device: $establishment",
            establishment.all { it.first == PEER_C },
        )
    }

    /** The list is not a queue and the newest arrival is not a choice. */
    @Test
    fun `a peer arriving while the user is deciding does not become the peer`() {
        val rig = rig()
        announce(rig, PEER_A)
        rig.signaling.events.onPeers(rig.roster(listOf(PEER_A, PEER_B)))
        rig.signaling.events.onSignal(PEER_B, caps("link/1"))
        awaitTrue("both listed") { rig.nearby.devices.size == 2 }
        settle(rig)
        assertTrue(rig.transports.isEmpty())
        connect(rig, PEER_A)
        assertEquals(PEER_A, rig.nearby.selectedId)
    }

    // ── inbound consent ─────────────────────────────────────────────────────

    @Test
    fun `an inbound link offer raises a prompt and connects nothing`() {
        val rig = rig(selfId = SELF_HIGH)
        announce(rig, PEER_A)
        rig.signaling.events.onSignal(PEER_A, offerFrom())
        awaitTrue("a prompt naming the asker") { rig.nearby.incomingId == PEER_A }
        assertTrue("still nothing dialled", rig.transports.isEmpty())
        assertEquals(TransferController.Phase.WAITING_PEER, rig.state.phase)
    }

    @Test
    fun `accepting replays the offer into a transport that exists`() {
        val rig = rig(selfId = SELF_HIGH)
        announce(rig, PEER_A)
        rig.signaling.events.onSignal(PEER_A, offerFrom())
        awaitTrue("prompted") { rig.nearby.incomingId == PEER_A }
        rig.controller.admitPeer(PEER_A, rig.nearby.incomingPromptId)
        awaitTrue("a transport") { rig.transports.isNotEmpty() }
        assertEquals(
            "answering, because the peer offered",
            LinkProtocol.Role.RESPONDER,
            rig.transport.profile.role,
        )
        awaitTrue("the offer reached it, sdp intact") {
            rig.transport.signals.any { Signal.fromJson(it)?.sdpType == "offer" }
        }
        assertNull("and the prompt is gone", rig.nearby.incomingId)
    }

    @Test
    fun `refusing tells the peer and keeps the room`() {
        val rig = rig(selfId = SELF_HIGH)
        announce(rig, PEER_A, PEER_B)
        rig.signaling.events.onSignal(PEER_A, offerFrom())
        awaitTrue("prompted") { rig.nearby.incomingId == PEER_A }
        rig.controller.rejectPeer(PEER_A, rig.nearby.incomingPromptId)
        awaitTrue("the question is withdrawn") { rig.nearby.incomingId == null }
        awaitTrue("and the asker was told") { rig.signaling.busyTo().contains(PEER_A) }
        assertTrue("nothing was built", rig.transports.isEmpty())
        assertEquals("and both devices are still listed", 2, rig.nearby.devices.size)
        assertEquals(TransferController.Phase.WAITING_PEER, rig.state.phase)
    }

    /**
     * The exact frames that must NOT be able to put a question in front of the
     * user, or open a buffer in this process. Anything in the room can send
     * these; only an ask may raise a prompt.
     */
    @Test
    fun `a candidate, a reveal or a bare hello raises no prompt`() {
        val rig = rig(selfId = SELF_HIGH)
        announce(rig, PEER_A)
        rig.signaling.events.onSignal(PEER_A, Signal.candidate("candidate:1 1 udp", "0", 0).toJson())
        rig.signaling.events.onSignal(PEER_A, Signal.reveal("a".repeat(44), "b".repeat(24)).toJson())
        rig.signaling.events.onSignal(PEER_A, caps("link/1"))
        settle(rig)
        assertNull("no prompt", rig.nearby.incomingId)
        assertTrue("and nothing dialled", rig.transports.isEmpty())
    }

    /** The bypass a legacy peer would otherwise have: an older offer carries no
     *  `link` tag, and the intent a Nearby room defaults to is exactly the one
     *  the legacy path used to read as permission to answer. */
    @Test
    fun `a legacy offer needs consent just as a link offer does`() {
        val rig = rig(selfId = SELF_HIGH)
        rig.signaling.events.onPeers(rig.roster(listOf(PEER_A)))
        rig.signaling.events.onSignal(PEER_A, caps("text/1"))
        awaitTrue("listed as a legacy peer") {
            rig.nearby.devices.singleOrNull()?.announcesText == true
        }
        rig.signaling.events.onSignal(PEER_A, legacyTextOffer())
        awaitTrue("it asks rather than establishes") { rig.nearby.incomingId == PEER_A }
        assertTrue("nothing was built without an answer", rig.transports.isEmpty())

        rig.controller.admitPeer(PEER_A, rig.nearby.incomingPromptId)
        awaitTrue("accepted") { rig.transports.isNotEmpty() }
        val profile = rig.transport.profile
        assertTrue("on the wire the user was asked about", profile is WireProfile.Legacy)
        assertEquals(
            LegacyProtocol.Lane.TEXT,
            (profile as WireProfile.Legacy).lane,
        )
        assertEquals(LinkProtocol.Role.RESPONDER, profile.role)
    }

    @Test
    fun `a legacy offer from a device the roster has not delivered is ignored`() {
        val rig = rig(selfId = SELF_HIGH)
        announce(rig, PEER_A)
        rig.signaling.events.onSignal(PEER_C, legacyTextOffer())
        settle(rig)
        assertNull("a device the user cannot see cannot interrupt them", rig.nearby.incomingId)
        assertTrue(rig.transports.isEmpty())
    }

    @Test
    fun `a third device asking while a prompt is up is refused, and the prompt stands`() {
        val rig = rig(selfId = SELF_HIGH)
        announce(rig, PEER_A, PEER_B, PEER_C)
        rig.signaling.events.onSignal(PEER_A, offerFrom())
        awaitTrue("prompted by A") { rig.nearby.incomingId == PEER_A }
        val prompt = rig.nearby.incomingPromptId
        rig.signaling.events.onSignal(PEER_C, offerFrom())
        awaitTrue("C was told") { rig.signaling.busyTo().contains(PEER_C) }
        assertEquals("the question the user is reading did not change", PEER_A, rig.nearby.incomingId)
        assertEquals(prompt, rig.nearby.incomingPromptId)
    }

    @Test
    fun `an unrelated device cannot reach an established session`() {
        val rig = rig()
        announce(rig, PEER_A, PEER_B)
        connect(rig, PEER_A)
        rig.signaling.events.onSignal(PEER_B, offerFrom())
        awaitTrue("refused in band") { rig.signaling.busyTo().contains(PEER_B) }
        assertEquals("one connection, still A's", 1, rig.transports.size)
        assertEquals(TransferController.Phase.CONNECTED, rig.state.phase)
    }

    @Test
    fun `a peer that leaves takes its prompt with it`() {
        val rig = rig(selfId = SELF_HIGH)
        announce(rig, PEER_A, PEER_B)
        rig.signaling.events.onSignal(PEER_A, offerFrom())
        awaitTrue("prompted") { rig.nearby.incomingId == PEER_A }
        rig.signaling.events.onPeers(rig.roster(listOf(PEER_B)))
        awaitTrue("the question went with the device") { rig.nearby.incomingId == null }
    }

    @Test
    fun `chasing frames past the bound retire the whole admission rather than growing it`() {
        val rig = rig(selfId = SELF_HIGH)
        announce(rig, PEER_A)
        rig.signaling.events.onSignal(PEER_A, offerFrom())
        awaitTrue("prompted") { rig.nearby.incomingId == PEER_A }
        repeat(LinkProtocol.HELD_SIGNAL_MAX + 4) {
            rig.signaling.events.onSignal(
                PEER_A, Signal.candidate("candidate:$it 1 udp", "0", 0).toJson(),
            )
        }
        awaitTrue("the admission was dropped") { rig.nearby.incomingId == null }
        assertTrue("and the peer was told", rig.signaling.busyTo().contains(PEER_A))
        assertTrue(rig.transports.isEmpty())
    }

    // ── the peer the user already chose ─────────────────────────────────────

    /**
     * The half of an explicit selection that is NOT an inbound request.
     *
     * `linkRole` gives the offer to the smaller id, and the user's choice has
     * nothing to do with which id is smaller. So a device that picks a peer with
     * a smaller id sends a content-free link REQUEST and waits to be offered —
     * and the offer that comes back is the answer to a question this device
     * asked, not a stranger arriving. Treating it as a new ask puts a second
     * consent prompt in front of the user for the device they just tapped
     * Connect on, nobody answers it, and both sides sit until their deadlines.
     *
     * Observed on two real emulators: the chosen peer's id sorted above this
     * one, the request went out, the peer accepted and offered, and this side
     * raised a prompt at its own establishment instead of answering.
     */
    @Test
    fun `the peer the user chose may answer without asking again`() {
        // Larger than the peer, so this side is the RESPONDER and must ask.
        val rig = rig(selfId = SELF_HIGH)
        announce(rig, PEER_A)
        rig.controller.connectToPeer(PEER_A, rig.nearby.roomId)
        awaitTrue("this side asked for a link") {
            rig.signaling.sent.any {
                it.first == PEER_A && Signal.fromJson(it.second)?.isLinkRequest == true
            }
        }
        assertTrue("and built nothing yet", rig.transports.isEmpty())

        // The chosen peer accepts and offers, exactly as the other half does.
        rig.signaling.events.onSignal(PEER_A, offerFrom())

        awaitTrue("the answer to our own request is answered, not re-asked") {
            rig.transports.isNotEmpty()
        }
        assertNull(
            "no second consent prompt for the device the user just chose",
            rig.nearby.incomingId,
        )
        assertEquals(
            "answering, because the peer offered",
            LinkProtocol.Role.RESPONDER, rig.transport.profile.role,
        )
        awaitTrue("and the offer reached the transport, sdp intact") {
            rig.transport.signals.any { Signal.fromJson(it)?.sdpType == "offer" }
        }
    }

    /** The exception is for the ONE peer the user chose and nobody else. */
    @Test
    fun `a third device offering while we await our own choice still asks`() {
        val rig = rig(selfId = SELF_HIGH)
        announce(rig, PEER_A, PEER_B)
        rig.controller.connectToPeer(PEER_A, rig.nearby.roomId)
        awaitTrue("asked") {
            rig.signaling.sent.any {
                it.first == PEER_A && Signal.fromJson(it.second)?.isLinkRequest == true
            }
        }
        rig.signaling.events.onSignal(PEER_B, offerFrom())
        awaitTrue("the uninvited device raises a prompt") { rig.nearby.incomingId == PEER_B }
        assertTrue("and builds nothing on its own", rig.transports.isEmpty())
    }

    /** And it is not a standing grant: an offer that arrives after the chosen
     *  peer's session ended is a NEW ask, from a device that is merely familiar. */
    @Test
    fun `an offer after the chosen session ended asks again`() {
        val rig = rig(selfId = SELF_HIGH)
        announce(rig, PEER_A)
        rig.controller.connectToPeer(PEER_A, rig.nearby.roomId)
        awaitTrue("asked") { rig.signaling.sent.isNotEmpty() }
        rig.signaling.events.onSignal(PEER_A, offerFrom())
        awaitTrue("established") { rig.transports.isNotEmpty() }
        ready(rig)

        rig.controller.disconnect()
        awaitTrue("back to the list") { rig.state.phase == TransferController.Phase.WAITING_PEER }

        rig.signaling.events.onSignal(PEER_A, offerFrom())
        awaitTrue("the same device has to ask again") { rig.nearby.incomingId == PEER_A }
        assertEquals("and nothing was built from the old consent", 1, rig.transports.size)
    }

    /** An offer from a peer nobody selected is still an ask, even when this side
     *  is idle and would happily have connected. */
    @Test
    fun `an unsolicited offer from a device nobody chose still asks`() {
        val rig = rig(selfId = SELF_HIGH)
        announce(rig, PEER_A, PEER_B)
        rig.signaling.events.onSignal(PEER_B, offerFrom())
        awaitTrue("prompted") { rig.nearby.incomingId == PEER_B }
        assertTrue(rig.transports.isEmpty())
    }

    // ── the authority a user action carries ─────────────────────────────────

    /** A tap composed against a question that has since been withdrawn and
     *  replaced. The peer id matches — on the local link an identity is stable
     *  while a device keeps advertising — and it must still not authorise. */
    @Test
    fun `a stale prompt id cannot accept the question that replaced it`() {
        val rig = rig(selfId = SELF_HIGH)
        announce(rig, PEER_A, PEER_B)
        rig.signaling.events.onSignal(PEER_A, offerFrom())
        awaitTrue("first prompt") { rig.nearby.incomingId == PEER_A }
        val stale = rig.nearby.incomingPromptId
        rig.controller.rejectPeer(PEER_A, stale)
        awaitTrue("withdrawn") { rig.nearby.incomingId == null }
        rig.signaling.events.onSignal(PEER_A, offerFrom())
        awaitTrue("a NEW question from the same device") { rig.nearby.incomingId == PEER_A }
        assertNotEquals(stale, rig.nearby.incomingPromptId)

        rig.controller.admitPeer(PEER_A, stale)
        settle(rig)
        assertTrue("the stale tap authorised nothing", rig.transports.isEmpty())
        assertEquals("and the real question still stands", PEER_A, rig.nearby.incomingId)
    }

    @Test
    fun `a tap rendered against a room that has been replaced cannot dial in the new one`() {
        val rig = rig()
        announce(rig, PEER_A, PEER_B)
        val staleRoom = rig.nearby.roomId
        rig.controller.connectToPeer(PEER_A, staleRoom + 1)
        settle(rig)
        assertTrue("a room id that is not this room authorises nothing", rig.transports.isEmpty())
        rig.controller.connectToPeer(PEER_A, staleRoom)
        awaitTrue("the current one does") { rig.transports.isNotEmpty() }
    }

    // ── one connection at a time, and a fresh one after ─────────────────────

    @Test
    fun `a live session is never replaced by tapping another device`() {
        val rig = rig()
        announce(rig, PEER_A, PEER_B)
        connect(rig, PEER_A)
        rig.controller.connectToPeer(PEER_B, rig.nearby.roomId)
        settle(rig)
        assertEquals("still exactly one connection", 1, rig.transports.size)
        assertEquals(TransferController.Phase.CONNECTED, rig.state.phase)
    }

    @Test
    fun `finishing with one device returns to the list and connects freshly to another`() {
        val rig = rig()
        announce(rig, PEER_A, PEER_B, PEER_C)
        connect(rig, PEER_A)
        val firstLink = rig.state.linkId
        val first = rig.transport

        rig.controller.disconnect()
        awaitTrue("back to the list") { rig.state.phase == TransferController.Phase.WAITING_PEER }
        assertEquals("the finished stream was closed, by peer", listOf(PEER_A), rig.signaling.retired.toList())
        assertEquals("and the room still lists everything", 3, rig.nearby.devices.size)
        assertNull(rig.nearby.selectedId)
        assertEquals("the room itself was NOT torn down", false, rig.signaling.closed)

        connect(rig, PEER_C)
        assertEquals(2, rig.transports.size)
        assertNotEquals(
            "a fresh connection is a fresh link identity, so nothing picked for the first can reach it",
            firstLink, rig.state.linkId,
        )
        assertEquals(PEER_C, rig.nearby.selectedId)
        assertEquals("local-close", first.closedReason)
    }

    /**
     * The generation split's whole risk, driven directly: the retired
     * connection's own callbacks, arriving after another peer's session is live.
     */
    @Test
    fun `a late callback from the finished peer cannot end or alter the next one`() {
        val rig = rig()
        announce(rig, PEER_A, PEER_B)
        connect(rig, PEER_A)
        val stale = rig.transport
        rig.controller.disconnect()
        awaitTrue("browsing") { rig.state.phase == TransferController.Phase.WAITING_PEER }
        connect(rig, PEER_B)
        val liveLink = rig.state.linkId

        // Everything the old transport could still say.
        stale.events.onClosed("ice-failed")
        stale.events.onFileFrame(ByteArray(64) { 7 })
        stale.events.onTextFrame(ByteArray(16) { 3 })
        stale.events.onReady(
            Crypto.deriveSession(
                Crypto.Role.INITIATOR, Crypto.generateKeyPair(), Crypto.generateKeyPair().publicKey,
            ),
            "000000", RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES,
        )
        settle(rig)

        assertEquals("the live session is untouched", TransferController.Phase.CONNECTED, rig.state.phase)
        assertEquals(liveLink, rig.state.linkId)
        assertEquals("705955", rig.state.sas)
        assertNull(rig.state.errorKey)
    }

    /** The same device, twice, inside one room — where a stale establishment
     *  frame is most likely and most damaging. */
    @Test
    fun `reconnecting to the same device in the same room builds a genuinely new link`() {
        val rig = rig()
        announce(rig, PEER_A, PEER_B)
        connect(rig, PEER_A)
        val firstLink = rig.state.linkId
        rig.controller.disconnect()
        awaitTrue("browsing") { rig.state.phase == TransferController.Phase.WAITING_PEER }

        connect(rig, PEER_A)
        assertNotEquals(firstLink, rig.state.linkId)
        assertEquals(2, rig.transports.size)
        assertEquals(
            "the stream that carried the first establishment was closed",
            listOf(PEER_A), rig.signaling.retired.toList(),
        )
    }

    /**
     * The stale-offer case the role rule answers: this side offered, so an
     * inbound offer is not this connection's and must not reach the handshake
     * as a replaced commitment.
     */
    @Test
    fun `an inbound offer never reaches the transport that already offered`() {
        val rig = rig(selfId = SELF) // the smaller id: this side offers
        announce(rig, PEER_A)
        connect(rig, PEER_A)
        assertEquals(LinkProtocol.Role.INITIATOR, rig.transport.profile.role)
        rig.signaling.events.onSignal(PEER_A, offerFrom())
        // A candidate on the same generation still routes, which is what proves
        // the offer was refused specifically rather than the peer being muted.
        rig.signaling.events.onSignal(PEER_A, Signal.candidate("candidate:9 1 udp", "0", 0).toJson())
        awaitTrue("the candidate got through") {
            rig.transport.signals.any { Signal.fromJson(it)?.candidate != null }
        }
        assertEquals(
            "a second offer is not routed into an initiator's handshake",
            0,
            rig.transport.signals.count { Signal.fromJson(it)?.sdpType == "offer" },
        )
        assertEquals(TransferController.Phase.CONNECTED, rig.state.phase)
    }

    // ── lifecycle off ───────────────────────────────────────────────────────

    @Test
    fun `stopping closes the rendezvous and ends the session`() {
        val rig = rig()
        announce(rig, PEER_A)
        connect(rig, PEER_A)
        rig.controller.stopNearby()
        awaitTrue("ended") { rig.state.phase == TransferController.Phase.ENDED }
        awaitTrue("the rendezvous was closed") { rig.signaling.closed }
        assertEquals("and nothing is listed", 0, rig.nearby.devices.size)
        assertFalse("the surface is off", rig.nearby.active)
        assertTrue("the peer was told before the room went", rig.transport.leaveSent)
    }

    @Test
    fun `a prompt does not survive stopping`() {
        val rig = rig(selfId = SELF_HIGH)
        announce(rig, PEER_A)
        rig.signaling.events.onSignal(PEER_A, offerFrom())
        awaitTrue("prompted") { rig.nearby.incomingId == PEER_A }
        rig.controller.stopNearby()
        awaitTrue("ended") { rig.state.phase == TransferController.Phase.ENDED }
        assertNull(rig.nearby.incomingId)
    }

    // ── fixtures ────────────────────────────────────────────────────────────

    private fun offerFrom(): Json =
        Signal.offer("v=0\r\n", "Y29tbWl0", listOf("link/1")).toJson()

    /**
     * What a shipped older peer's message-generation offer actually looks like:
     * no `link` tag, a `text` tag, an SDP, and the `text/1` capability riding
     * along — which `LegacyProtocol.inboundOfferLane` requires before it will
     * call a text-generation offer a text-lane offer at all.
     */
    private fun legacyTextOffer(): Json = Json.obj(
        "sdp" to Json.obj("type" to Json.of("offer"), "sdp" to Json.of("v=0\r\n")),
        "commit" to Json.of("Y29tbWl0"),
        "caps" to Json.arr(listOf(Json.of("text/1"))),
        "text" to Json.of(true),
    )

    private companion object {
        /** Lexicographically below every peer here: this side offers. */
        const val SELF = "0000000000000000000000000000aaaa"
        /** Above every peer here: the peer offers, so an inbound offer is the
         *  ordinary case rather than a glare. */
        const val SELF_HIGH = "ffffffffffffffffffffffffffffffff"
        const val PEER_A = "1111111111111111111111111111111a"
        const val PEER_B = "2222222222222222222222222222222b"
        const val PEER_C = "3333333333333333333333333333333c"
    }
}
