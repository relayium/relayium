package com.relayium.android

import com.relayium.android.storage.ProviderOps
import com.relayium.android.storage.ReceiveStore
import com.relayium.android.transport.IceConfig
import com.relayium.android.transport.LinkTransport
import com.relayium.android.transport.RelayRenewEngine
import com.relayium.android.transport.RenewTransport
import com.relayium.android.transport.SignalingClient
import com.relayium.android.transport.SignalingHandle
import com.relayium.android.transport.TransportHandle
import com.relayium.protocol.Crypto
import com.relayium.protocol.Envelope
import com.relayium.protocol.Json
import com.relayium.protocol.PairCode
import com.relayium.protocol.RealtimeFrame
import com.relayium.protocol.RelayRenewProbe
import com.relayium.protocol.RelayRenewSdp
import com.relayium.protocol.RelayRenewWire
import com.relayium.protocol.Signal
import com.relayium.protocol.TextLaneSession
import com.relayium.protocol.TextSessionLimits
import com.relayium.protocol.TextWire
import java.io.File
import java.io.OutputStream
import java.util.concurrent.ConcurrentLinkedQueue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Renewal as the SHIPPED controller runs it: the real routing, the real front
 * demux, the real activity clock and the real teardown, through the same seams
 * the app wires to OkHttp, WebRTC and SAF.
 *
 * The epoch machine has its own suite against a wired pair of engines
 * (`transport/RelayRenewEngineTest`). What only this level can answer is
 * whether the controller HANDS it the right things and keeps the rest of the
 * session intact while it does — which is where a renewal feature does its
 * damage if it is wrong: a control frame that reaches the text lane fails that
 * lane on a rate bound, a control frame counted as activity keeps a dead link
 * alive, and a renewal envelope routed one line too late is an unauthenticated
 * renegotiation against a live PeerConnection.
 */
class RelayRenewControllerTest {

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

    private class FakeSignaling(private val hasServer: Boolean) : SignalingHandle {
        lateinit var events: SignalingClient.Events
        val sent = ConcurrentLinkedQueue<Pair<String, Json>>()
        val renewRequests = ConcurrentLinkedQueue<Pair<Long, Long>>()
        override fun connect() = Unit
        override fun sendSignal(to: String, data: Json) { sent.add(to to data) }
        override fun requestIceRenew(round: Long, rid: Long): Boolean {
            if (!hasServer) return false
            renewRequests.add(round to rid)
            return true
        }
        override fun close() = Unit
    }

    /**
     * The renewal half of the transport: a recorder that behaves.
     *
     * It really does restart ICE — each offer or answer names a NEW generation
     * — so a commit driven through this has to satisfy the same ufrag binding
     * the real stack imposes. Nothing here fakes a success an assertion
     * depends on; the pin, the generation and the probe are all real values the
     * controller has to line up.
     */
    private class FakeRenew : RenewTransport {
        val control = ConcurrentLinkedQueue<ByteArray>()
        val applied = ConcurrentLinkedQueue<List<IceConfig.Server>>()
        @Volatile var selectedSink: ((RenewTransport.SelectedPair) -> Unit)? = null
        @Volatile var candidateSink: ((RenewTransport.Candidate) -> Unit)? = null
        @Volatile var locked = false
        @Volatile var generation = 0
        @Volatile var localUfrag = ""
        /** Replayed to a subscriber that attaches later, as the real transport
         *  does — this test's own copy of the rule the cache enforces. */
        @Volatile var pending: RenewTransport.SelectedPair? = null

        override fun applyConfiguration(servers: List<IceConfig.Server>): Boolean {
            applied.add(servers)
            return true
        }
        override fun createRenewOffer(onResult: (RenewTransport.LocalSdp?) -> Unit) {
            generation++
            localUfrag = "renew$generation"
            onResult(RenewTransport.LocalSdp(sdpWith(localUfrag, "actpass"), localUfrag))
        }
        override fun createRenewAnswer(onResult: (RenewTransport.LocalSdp?) -> Unit) =
            createRenewOffer(onResult)
        override fun applyRemoteSdp(sdpType: String, sdp: String, onResult: (Boolean) -> Unit) =
            onResult(true)
        override fun addCandidate(candidate: RenewTransport.Candidate) = true
        override fun onCandidate(cb: ((RenewTransport.Candidate) -> Unit)?) { candidateSink = cb }
        override fun onSelectedPair(cb: ((RenewTransport.SelectedPair) -> Unit)?) {
            selectedSink = cb
            if (cb != null) pending?.let(cb)
        }
        override fun baselinePin(): RelayRenewSdp.Pin = RelayRenewSdp.pin(sdpWith("base", "actpass"))
        override fun sendControlFrame(frame: ByteArray): Boolean { control.add(frame); return true }
        override fun lockUnsignedSdp() { locked = true }

        companion object {
            /** A bundled data-only description, pinned on fingerprint, mid and
             *  role exactly as the real one is. */
            fun sdpWith(ufrag: String, setup: String): String = (
                "v=0\n" +
                    "a=group:BUNDLE 0\n" +
                    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\n" +
                    "a=ice-ufrag:" + ufrag + "\n" +
                    "a=fingerprint:sha-256 AB:CD:EF:01\n" +
                    "a=setup:" + setup + "\n" +
                    "a=mid:0\n"
                ).replace("\n", "\r\n")
        }
    }

    private class FakeTransport(
        val events: LinkTransport.Events,
    ) : TransportHandle {
        val fileFrames = ConcurrentLinkedQueue<ByteArray>()
        val textFrames = ConcurrentLinkedQueue<ByteArray>()
        val signals = ConcurrentLinkedQueue<Json>()
        val renewal = FakeRenew()
        @Volatile var closedReason: String? = null
        override fun start() = Unit
        override fun onSignal(raw: Json) { signals.add(raw) }
        override fun sendFile(frame: ByteArray) = fileFrames.add(frame)
        override fun sendText(frame: ByteArray) = textFrames.add(frame)
        override fun fileBufferedAmount() = 0L
        override fun textBufferedAmount() = 0L
        override fun leaveAndClose(leave: Signal?) { closedReason = "local-leave" }
        override fun close(reason: String) { closedReason = reason }
        override fun renew(): RenewTransport = renewal
    }

    private class FileOps : ProviderOps {
        inner class FileNode(val file: File) : ProviderOps.Node {
            override val name: String get() = file.name
            override val isDirectory: Boolean get() = file.isDirectory
            override fun delete(): Boolean = file.delete()
            override fun openOut(): OutputStream = file.outputStream()
        }
        override fun findChild(parent: ProviderOps.Node, name: String) =
            File((parent as FileNode).file, name).takeIf { it.exists() }?.let { FileNode(it) }
        override fun createDirectory(parent: ProviderOps.Node, name: String) =
            File((parent as FileNode).file, name).takeIf { it.mkdir() }?.let { FileNode(it) }
        override fun createFile(parent: ProviderOps.Node, name: String) =
            File((parent as FileNode).file, name).takeIf { it.createNewFile() }?.let { FileNode(it) }
    }

    private class Rig(
        val controller: TransferController,
        val signaling: FakeSignaling,
        val transports: ConcurrentLinkedQueue<FakeTransport>,
    ) {
        val transport: FakeTransport get() = transports.peek() ?: error("no transport was created")
        lateinit var peerKeys: Crypto.SessionKeys
    }

    /**
     * A joined, connected `link/1` session with REAL derived keys on both
     * sides.
     *
     * [turnTtlSeconds] is what `/api/ice` is made to answer with. Null means a
     * STUN-only room — the Nearby and LAN shape — where nothing can hold an
     * allocation and so nothing is bounded.
     */
    private fun rig(
        selfId: String = "aaaaaaaa",
        peer: String = "bbbbbbbb",
        turnTtlSeconds: Long? = 3600,
        hasServer: Boolean = true,
        textIdleMs: Long = 600_000,
        /** Runs after the transport exists and BEFORE the link is ready —
         *  the window in which ICE routinely settles. */
        beforeReady: (FakeTransport) -> Unit = {},
    ): Rig {
        val signaling = FakeSignaling(hasServer)
        val transports = ConcurrentLinkedQueue<FakeTransport>()
        val servers = if (turnTtlSeconds == null) {
            listOf(IceConfig.Server(listOf("stun:stun.example:3478"), null, null))
        } else {
            val expiry = System.currentTimeMillis() / 1000 + turnTtlSeconds
            listOf(IceConfig.Server(listOf("turn:relay.example:3478"), "$expiry:abc", "zzz"))
        }
        val deps = TransferController.Deps(
            fetchIce = { IceConfig.Result(servers, "") },
            signals = { _, events -> signaling.also { it.events = events } },
            transports = { _, _, _, _, events -> FakeTransport(events).also(transports::add) },
            store = ReceiveStore(temp.newFolder("staging-${System.nanoTime()}")),
            providerOps = FileOps(),
            timeouts = TransferController.Timeouts(
                helloRetryMs = 60_000, settleMs = 60_000, requestRetryMs = 60_000,
                requestDeadlineMs = 60_000, consentMs = 60_000, textEndAckMs = 60_000,
                abortBarrierMs = 60_000, textIdleMs = textIdleMs,
            ),
        )
        val controller = TransferController(scope, "test-device", deps)
        controllers.add(controller)
        controller.join(PairCode("123456"), TransferController.Intent.JOINER)
        awaitTrue("signalling wired") { runCatching { signaling.events }.isSuccess }
        signaling.events.onSelfId(selfId, "")

        signaling.events.onPeers(listOf(Envelope.Peer(peer, "peer")))
        signaling.events.onSignal(
            peer,
            Json.obj(
                "caps" to Json.arr(
                    listOf(Json.of("link/1"), Json.of(RelayRenewWire.CAPABILITY)),
                ),
            ),
        )
        awaitTrue("transport created") { transports.isNotEmpty() }
        val mine = Crypto.generateKeyPair()
        val theirs = Crypto.generateKeyPair()
        val local = Crypto.deriveSession(Crypto.Role.INITIATOR, mine, theirs.publicKey)
        val remote = Crypto.deriveSession(Crypto.Role.RESPONDER, theirs, mine.publicKey)
        val rig = Rig(controller, signaling, transports)
        rig.peerKeys = remote
        beforeReady(transports.peek()!!)
        transports.peek()!!.events.onReady(
            local, "705955", RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES,
        )
        awaitTrue("connected") {
            controller.state.value.phase == TransferController.Phase.CONNECTED
        }
        return rig
    }

    /** The ICE agent reports a relayed pair, which is what bounds the link. */
    private fun observeRelay(rig: Rig) {
        awaitTrue("the owner subscribed to selected pairs") {
            rig.transport.renewal.selectedSink != null
        }
        rig.transport.renewal.selectedSink!!(
            RenewTransport.SelectedPair(
                local = "candidate:1 1 udp 100 203.0.113.9 54321 typ relay generation 0 ufrag aaa",
                remote = "candidate:2 1 udp 100 203.0.113.10 54322 typ relay generation 0",
            ),
        )
    }

    private fun observeDirect(rig: Rig) {
        rig.transport.renewal.selectedSink!!(
            RenewTransport.SelectedPair(
                local = "candidate:1 1 udp 100 192.168.1.5 54321 typ host generation 0 ufrag aaa",
                remote = "candidate:2 1 udp 100 192.168.1.6 54322 typ host generation 0",
            ),
        )
    }

    private fun awaitTrue(what: String, timeoutMs: Long = 5_000, predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return
            Thread.sleep(5)
        }
        throw AssertionError("timed out waiting for: $what")
    }

    private fun quiesce() = Thread.sleep(150)

    /**
     * A credential whose renewal margin opens a few seconds in.
     *
     * The margin is two thirds of the grant's lifetime by construction, and the
     * lifetime is the TTL less the sixty-second clock-skew margin — so a
     * sixty-eight-second credential is bounded about eight seconds out and
     * becomes renewable about five seconds in. Short enough for a test's
     * patience, long enough that the exchange it triggers is not racing its own
     * expiry, and the production clock margin is untouched.
     */
    private val GATE_TTL_SECONDS = 68L

    /** Long enough to cover the margin above with room to spare. */
    private val GATE_WAIT_MS = 9_000L

    /**
     * Past the margin, and still comfortably INSIDE the boundary.
     *
     * A negative assertion has to be made while the link is still alive:
     * waiting past the credential's own expiry would prove only that a session
     * which had already ended truthfully asked for nothing, which is not the
     * claim. With the TTL above the margin opens by about 5.7 s and the
     * boundary is at least 7.0 s out, so this sits between the two.
     */
    private val GATE_MARGIN_ONLY_WAIT_MS = 6_500L

    // ── the front demux ─────────────────────────────────────────────────────

    /**
     * A renewal control frame is CONSUMED before the text session sees it.
     *
     * Delivered through the transport's own event, which is also the path
     * pre-attachment captured frames are replayed on, so the demux covers both
     * without a second code path.
     */
    @Test
    fun `a control frame never reaches the text lane's rate budget`() {
        val rig = rig()
        // Far more frames than the inbound token bucket holds. If any of them
        // reached TextLaneSession.onFrame, it would take a token, run out, and
        // fail the lane on BOUNDS — a whole conversation lost to renewal
        // traffic the user never sent.
        val probe = RelayRenewProbe.sign(
            rig.peerKeys, RelayRenewProbe.TYPE_PROBE, "bbbbbbbb", "aaaaaaaa", 1, 1, ByteArray(16),
        )!!
        repeat(TextSessionLimits.BURST * 4) { rig.transport.events.onTextFrame(probe) }
        quiesce()
        assertEquals(
            "the text lane is untouched",
            TextLaneSession.State.IDLE,
            rig.controller.state.value.textState,
        )
        assertNull(rig.controller.state.value.errorKey)
        assertNull("the link is still up", rig.transport.closedReason)
    }

    @Test
    fun `a malformed frame that claims the renewal kind is still consumed`() {
        val rig = rig()
        // 58 bytes, right kind byte. It cannot be a valid probe, and it must
        // still not spend a text-lane token or reset the idle clock — the
        // demux is by KIND, and validity is the engine's answer, not the text
        // session's.
        val truncated = ByteArray(RelayRenewProbe.FRAME_BYTES - 1)
            .also { it[0] = RelayRenewProbe.KIND.toByte() }
        repeat(TextSessionLimits.BURST * 4) { rig.transport.events.onTextFrame(truncated) }
        quiesce()
        assertEquals(TextLaneSession.State.IDLE, rig.controller.state.value.textState)
        assertNull(rig.controller.state.value.errorKey)
    }

    /**
     * The case the spec names: a transport gap where the buffer holds only
     * control frames and no protected frame.
     *
     * A demux that consumed a control frame by feeding it to the codec — or
     * that left it in a shared buffer — would desynchronise the text receive
     * sequence, and the next real message would fail authentication at a number
     * this side no longer expects.
     */
    @Test
    fun `control frames between real messages do not poison the text codec`() {
        val rig = rig()
        val peerText = TextLaneSession(rig.peerKeys, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        peerText.attachReceiver()

        // The peer opens a conversation; this side auto-admits on `link/1`.
        for (action in peerText.request()) {
            if (action is TextLaneSession.Action.Send) {
                rig.transport.events.onTextFrame(action.frame)
            }
        }
        awaitTrue("the conversation opened") {
            rig.controller.state.value.textState == TextLaneSession.State.OPEN
        }
        // Feed the peer whatever this side answered, so its own state machine
        // keeps up with ours.
        drainTextTo(rig, peerText)

        val probe = RelayRenewProbe.sign(
            rig.peerKeys, RelayRenewProbe.TYPE_PROBE, "bbbbbbbb", "aaaaaaaa", 1, 1, ByteArray(16),
        )!!
        rig.transport.events.onTextFrame(probe)
        sendPeerText(rig, peerText, "first")
        rig.transport.events.onTextFrame(probe)
        rig.transport.events.onTextFrame(probe)
        sendPeerText(rig, peerText, "second")

        awaitTrue("both messages arrived, in order, decrypted") {
            rig.controller.state.value.messages.map { it.body } == listOf("first", "second")
        }
    }

    private fun drainTextTo(rig: Rig, peer: TextLaneSession) {
        while (true) {
            val frame = rig.transport.textFrames.poll() ?: return
            peer.onFrame(frame)
        }
    }

    private fun sendPeerText(rig: Rig, peer: TextLaneSession, body: String) {
        for (action in peer.send(body)) {
            if (action is TextLaneSession.Action.Send) {
                rig.transport.events.onTextFrame(action.frame)
            }
        }
    }

    // ── what bounds a link, and what does not ───────────────────────────────

    @Test
    fun `a link is bounded only once a relayed path is actually observed`() {
        val rig = rig()
        quiesce()
        // Connected, with a TURN credential in hand — and NOT bounded. Nothing
        // has said this link is using the relay, and a boundary imposed on a
        // link that turns out to be direct would end a healthy connection.
        assertNull(rig.controller.state.value.relayExpiresAt)

        observeRelay(rig)
        awaitTrue("bounded by the credential the server issued") {
            rig.controller.state.value.relayExpiresAt != null
        }
    }

    @Test
    fun `a path that classifies direct releases the boundary`() {
        val rig = rig()
        observeRelay(rig)
        awaitTrue("bounded") { rig.controller.state.value.relayExpiresAt != null }
        observeDirect(rig)
        awaitTrue("a direct path has no credential to lose") {
            rig.controller.state.value.relayExpiresAt == null
        }
    }

    @Test
    fun `a STUN-only room is never bounded and never asks a server`() {
        // The Nearby and LAN shape: nothing in the configuration can hold an
        // allocation, so there is nothing to bound and nothing to renew.
        val rig = rig(turnTtlSeconds = null)
        observeRelay(rig)
        quiesce()
        assertNull(rig.controller.state.value.relayExpiresAt)
        assertTrue(rig.signaling.renewRequests.isEmpty())
    }

    @Test
    fun `a rendezvous with no server makes no backend call`() {
        // The local, backend-free rendezvous answers false, structurally.
        val rig = rig(hasServer = false, turnTtlSeconds = GATE_TTL_SECONDS)
        observeRelay(rig)
        markUserActive(rig)
        quiesce()
        assertTrue(rig.signaling.renewRequests.isEmpty())
    }

    /**
     * A relayed link whose credential runs out ends TRUTHFULLY, and says why.
     *
     * Without this it stays `connected` and silently stops moving bytes until
     * the disconnect grace gives up with a generic "connection lost" — which
     * tells the person using it nothing about what happened or what to do.
     */
    @Test
    fun `a relayed link ends on its boundary with a named reason`() {
        // 61 seconds, against a 60-second clock-skew margin: a boundary about a
        // second out.
        val rig = rig(turnTtlSeconds = 61)
        observeRelay(rig)
        awaitTrue("bounded") { rig.controller.state.value.relayExpiresAt != null }
        assertTrue(
            "and warning already, because the whole grant is inside the warning window",
            rig.controller.state.value.relayExpiryWarning,
        )
        awaitTrue("ended on its own boundary", timeoutMs = 8_000) {
            rig.controller.state.value.errorKey == "error_relay_expired"
        }
        assertEquals(TransferController.Phase.ENDED, rig.controller.state.value.phase)
    }

    // ── the consent gate, as the controller feeds it ────────────────────────

    /** Real authenticated user text from the peer, which is real activity. */
    private fun markUserActive(rig: Rig) {
        val peerText = TextLaneSession(rig.peerKeys, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        peerText.attachReceiver()
        for (action in peerText.request()) {
            if (action is TextLaneSession.Action.Send) rig.transport.events.onTextFrame(action.frame)
        }
        awaitTrue("open") {
            rig.controller.state.value.textState == TextLaneSession.State.OPEN
        }
        drainTextTo(rig, peerText)
        sendPeerText(rig, peerText, "still here")
        awaitTrue("the message landed") {
            rig.controller.state.value.messages.any { it.body == "still here" }
        }
    }

    @Test
    fun `an idle relayed link inside its margin asks for nothing`() {
        // 70 seconds: bounded ten seconds out, so the margin is open at once.
        val rig = rig(turnTtlSeconds = GATE_TTL_SECONDS)
        observeRelay(rig)
        quiesce()
        // No user data has ever moved on this link. Renewal control traffic is
        // explicitly not activity, so feeding probes changes nothing.
        val probe = RelayRenewProbe.sign(
            rig.peerKeys, RelayRenewProbe.TYPE_PROBE, "bbbbbbbb", "aaaaaaaa", 1, 1, ByteArray(16),
        )!!
        repeat(20) { rig.transport.events.onTextFrame(probe) }
        // Wait past the margin, so "nothing happened" means the trigger really
        // did decline rather than simply not having fired yet — and stop short
        // of the boundary, so the link is still live when it declines.
        Thread.sleep(GATE_MARGIN_ONLY_WAIT_MS)
        assertNull("the link is still live", rig.controller.state.value.errorKey)
        assertTrue(
            "an idle link still dies on schedule",
            rig.signaling.renewRequests.isEmpty(),
        )
    }

    @Test
    fun `real user text opens the gate and a round is asked for`() {
        val rig = rig(turnTtlSeconds = GATE_TTL_SECONDS)
        observeRelay(rig)
        markUserActive(rig)
        awaitTrue("the round exchange began", GATE_WAIT_MS) {
            rig.signaling.renewRequests.isNotEmpty()
        }
        val (round, _) = rig.signaling.renewRequests.first()
        assertEquals("round 0 is the original grant; the first renewal asks for 1", 1L, round)
        assertEquals(
            RelayRenewEngine.State.RENEWING,
            rig.controller.state.value.renewState,
        )
    }

    @Test
    fun `a consent lifecycle byte is not user data`() {
        val rig = rig(turnTtlSeconds = GATE_TTL_SECONDS)
        observeRelay(rig)
        // A REQUEST and this side's own ACCEPT are consent, not content. A
        // conversation that opens and carries nothing is not a reason to renew.
        val peerText = TextLaneSession(rig.peerKeys, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        peerText.attachReceiver()
        for (action in peerText.request()) {
            if (action is TextLaneSession.Action.Send) rig.transport.events.onTextFrame(action.frame)
        }
        awaitTrue("open") {
            rig.controller.state.value.textState == TextLaneSession.State.OPEN
        }
        Thread.sleep(GATE_MARGIN_ONLY_WAIT_MS)
        assertNull("the link is still live", rig.controller.state.value.errorKey)
        assertTrue(
            "an open, silent conversation asks for nothing",
            rig.signaling.renewRequests.isEmpty(),
        )
        // The positive twin — real content DOES open the gate — is
        // `real user text opens the gate and a round is asked for`. It is a
        // separate session deliberately: this one has spent its margin proving
        // the negative, and asserting the positive on the same credential would
        // be racing its boundary.
    }

    // ── routing ─────────────────────────────────────────────────────────────

    /**
     * A renewal envelope is consumed by the router and never reaches the
     * transport.
     *
     * That is the whole reason SDP and ICE are nested inside `renew`: the
     * `link` generation is shared with establishment, and a frame that reached
     * the transport could be applied as a real, unauthenticated renegotiation.
     */
    @Test
    fun `a renewal envelope never reaches the transport`() {
        val rig = rig()
        rig.transport.signals.clear()
        val message = RelayRenewWire.Message.Prepare(1)
        val payload = RelayRenewWire.payload("bbbbbbbb", "aaaaaaaa", message)
        val envelope = RelayRenewWire.envelopeJson(
            message, Crypto.signAuth(rig.peerKeys, payload),
        )
        rig.signaling.events.onSignal("bbbbbbbb", envelope)
        quiesce()
        assertTrue("consumed by the router", rig.transport.signals.isEmpty())
        // …and it WAS acted on: verifying a peer's renewal signal locks
        // unsigned SDP for the remainder of this PeerConnection.
        assertTrue(rig.transport.renewal.locked)
    }

    @Test
    fun `a renewal envelope from anyone but the established peer is dropped`() {
        val rig = rig()
        rig.transport.signals.clear()
        val message = RelayRenewWire.Message.Prepare(1)
        val payload = RelayRenewWire.payload("cccccccc", "aaaaaaaa", message)
        val envelope = RelayRenewWire.envelopeJson(
            message, Crypto.signAuth(rig.peerKeys, payload),
        )
        rig.signaling.events.onSignal("cccccccc", envelope)
        quiesce()
        assertFalse(rig.transport.renewal.locked)
        assertTrue(rig.transport.signals.isEmpty())
    }

    @Test
    fun `an ice-grant for a request nobody made changes nothing`() {
        val rig = rig(turnTtlSeconds = GATE_TTL_SECONDS)
        observeRelay(rig)
        quiesce()
        rig.signaling.events.onIceGrant(
            Json.obj(
                "status" to Json.of("granted"),
                "round" to Json.of(1L),
                "rid" to Json.of(4242L),
                "iceServers" to Json.arr(emptyList()),
            ),
        )
        quiesce()
        assertNull(rig.controller.state.value.relayExpiresAt?.let { null })
        assertEquals(RelayRenewEngine.State.IDLE, rig.controller.state.value.renewState)
    }

    // ── teardown ────────────────────────────────────────────────────────────

    @Test
    fun `ending a session clears the boundary and the renewal state`() {
        val rig = rig(turnTtlSeconds = 3600)
        observeRelay(rig)
        awaitTrue("bounded") { rig.controller.state.value.relayExpiresAt != null }
        rig.controller.disconnect()
        awaitTrue("ended") {
            rig.controller.state.value.phase == TransferController.Phase.ENDED
        }
        val state = rig.controller.state.value
        assertNull("a stale expiry must not count down over a dead session", state.relayExpiresAt)
        assertFalse(state.relayExpiryWarning)
        assertEquals(RelayRenewEngine.State.IDLE, state.renewState)
    }

    @Test
    fun `nothing the peer sends after a teardown can restart a renewal`() {
        val rig = rig(turnTtlSeconds = GATE_TTL_SECONDS)
        observeRelay(rig)
        markUserActive(rig)
        awaitTrue("asked", GATE_WAIT_MS) { rig.signaling.renewRequests.isNotEmpty() }
        val asked = rig.signaling.renewRequests.size
        rig.controller.disconnect()
        awaitTrue("ended") {
            rig.controller.state.value.phase == TransferController.Phase.ENDED
        }
        val message = RelayRenewWire.Message.Prepare(9)
        val payload = RelayRenewWire.payload("bbbbbbbb", "aaaaaaaa", message)
        rig.signaling.events.onSignal(
            "bbbbbbbb",
            RelayRenewWire.envelopeJson(message, Crypto.signAuth(rig.peerKeys, payload)),
        )
        quiesce()
        assertEquals(asked, rig.signaling.renewRequests.size)
    }

    // ── the capability ──────────────────────────────────────────────────────

    @Test
    fun `a peer that never announced renewal is never asked`() {
        val rig = rig(turnTtlSeconds = GATE_TTL_SECONDS, peer = "bbbbbbbb")
        // Replace the announcement with one that does NOT carry the renewal
        // capability. A snapshot revokes, so this is the truthful shape of an
        // older peer.
        rig.signaling.events.onSignal(
            "bbbbbbbb",
            Json.obj("caps" to Json.arr(listOf(Json.of("link/1")))),
        )
        observeRelay(rig)
        markUserActive(rig)
        Thread.sleep(GATE_MARGIN_ONLY_WAIT_MS)
        assertTrue(
            "a prepare into silence is not worth an epoch",
            rig.signaling.renewRequests.isEmpty(),
        )
    }

    @Test
    fun `this build announces the capability it now implements`() {
        val rig = rig()
        val hello = rig.signaling.sent.map { it.second }
            .mapNotNull { (it as? Json.Obj)?.get("caps") as? Json.Arr }
            .firstOrNull()
        assertNotNull("a roster hello went out", hello)
        val caps = hello!!.items.mapNotNull { (it as? Json.Str)?.value }
        assertTrue(caps.contains(RelayRenewWire.CAPABILITY))
        assertTrue(caps.contains("link/1"))
    }

    // ── the observation that arrives too early (D1) ─────────────────────────

    /**
     * ICE settles before the handshake does, and the link must still be
     * bounded.
     *
     * The owner cannot subscribe until the link is ready — there is no session
     * to bound before that — so the selection that says "this link is relayed"
     * routinely lands with nobody listening. When it was dropped the link was
     * never bounded at all: no expiry timer, no warning, no renewal, and a
     * connection running past its credential's authority with neither end
     * accounting for it.
     */
    @Test
    fun `a relayed pair selected before the link was ready still bounds it`() {
        val rig = rig(
            beforeReady = { transport ->
                transport.renewal.pending = RenewTransport.SelectedPair(
                    local = "candidate:1 1 udp 100 203.0.113.9 54321 typ relay generation 0 ufrag e0",
                    remote = "candidate:2 1 udp 100 203.0.113.10 54322 typ relay generation 0",
                )
            },
        )
        awaitTrue("bounded from the observation made before anyone subscribed") {
            rig.controller.state.value.relayExpiresAt != null
        }
    }

    @Test
    fun `a direct pair selected before the link was ready leaves it unbounded`() {
        // The same path, and the opposite classification: a LAN hop has no
        // credential to lose, so an early observation of one must not invent a
        // boundary either.
        val rig = rig(
            beforeReady = { transport ->
                transport.renewal.pending = RenewTransport.SelectedPair(
                    local = "candidate:1 1 udp 100 192.168.1.5 54321 typ host generation 0 ufrag e0",
                    remote = "candidate:2 1 udp 100 192.168.1.6 54322 typ host generation 0",
                )
            },
        )
        quiesce()
        assertNull(rig.controller.state.value.relayExpiresAt)
    }

    // ── a committed migration, through the real controller (D3) ─────────────

    /** One signed renewal envelope, as the peer would compose it. */
    private fun peerSignal(rig: Rig, message: RelayRenewWire.Message): Json {
        val payload = RelayRenewWire.payload("bbbbbbbb", "aaaaaaaa", message)
        return RelayRenewWire.envelopeJson(message, Crypto.signAuth(rig.peerKeys, payload))
    }

    private fun relayCandidate(ufrag: String, port: Int) =
        "candidate:1 1 udp 100 203.0.113.9 $port typ relay generation 0 ufrag $ufrag"

    /**
     * Drive one complete migration: prepare, grant, ready, offer/answer,
     * observation, probe and ack — through the shipped controller, with real
     * signatures on every message and a real 59-byte frame.
     *
     * Returns the unix-second expiry the granted configuration stated.
     */
    private fun driveCommit(rig: Rig, grantTtlSeconds: Long): Long {
        markUserActive(rig)
        // The peer's margin opened first, which is the ordinary asymmetric
        // case: its prepare is what starts this side's epoch.
        rig.signaling.events.onSignal(
            "bbbbbbbb",
            peerSignal(rig, RelayRenewWire.Message.Prepare(1)),
        )
        awaitTrue("a round was asked for") { rig.signaling.renewRequests.isNotEmpty() }
        val (round, rid) = rig.signaling.renewRequests.first()

        val expiry = System.currentTimeMillis() / 1000 + grantTtlSeconds
        rig.signaling.events.onIceGrant(
            Json.obj(
                "status" to Json.of("granted"),
                "round" to Json.of(round),
                "rid" to Json.of(rid),
                "iceServers" to Json.arr(
                    listOf(
                        Json.obj(
                            "urls" to Json.arr(listOf(Json.of("turn:renewed.example:3478"))),
                            "username" to Json.of("$expiry:def"),
                            "credential" to Json.of("yyy"),
                        ),
                    ),
                ),
            ),
        )
        awaitTrue("the configuration was applied to the live connection") {
            rig.transport.renewal.applied.isNotEmpty()
        }

        rig.signaling.events.onSignal(
            "bbbbbbbb",
            peerSignal(rig, RelayRenewWire.Message.Ready(1, round)),
        )
        awaitTrue("this side, the established initiator, offered") {
            rig.transport.renewal.localUfrag.isNotEmpty()
        }
        val peerUfrag = "peerGen1"
        rig.signaling.events.onSignal(
            "bbbbbbbb",
            peerSignal(
                rig,
                RelayRenewWire.Message.Sdp(1, round, "answer", FakeRenew.sdpWith(peerUfrag, "actpass")),
            ),
        )

        // Both descriptions are in; the agent reports the new generation on
        // both ends of the pair.
        awaitTrue("the answer was applied") { rig.transport.renewal.selectedSink != null }
        rig.transport.renewal.selectedSink!!(
            RenewTransport.SelectedPair(
                local = relayCandidate(rig.transport.renewal.localUfrag, 60001),
                remote = relayCandidate(peerUfrag, 60002),
            ),
        )
        awaitTrue("a probe went out, so observation held") {
            rig.transport.renewal.control.isNotEmpty()
        }

        // The peer acks this side's own nonce, which is the only thing that
        // commits it.
        val probe = RelayRenewProbe.decode(rig.transport.renewal.control.first())!!
        val ack = RelayRenewProbe.sign(
            rig.peerKeys, RelayRenewProbe.TYPE_ACK, "bbbbbbbb", "aaaaaaaa",
            probe.epoch, probe.round, probe.nonce,
        )!!
        rig.transport.events.onTextFrame(ack)
        return expiry
    }

    @Test
    fun `a committed migration moves the boundary to the credential it received`() {
        val rig = rig(turnTtlSeconds = 3600)
        observeRelay(rig)
        awaitTrue("bounded") { rig.controller.state.value.relayExpiresAt != null }
        val original = rig.controller.state.value.relayExpiresAt!!

        val expiry = driveCommit(rig, grantTtlSeconds = 4 * 3600)
        awaitTrue("the migration committed and the boundary moved") {
            rig.controller.state.value.renewState == RelayRenewEngine.State.RENEWED
        }
        val moved = rig.controller.state.value.relayExpiresAt!!
        assertTrue("the new boundary is later", moved > original)
        assertEquals(
            "derived from the configuration actually received, not from an extension",
            expiry * 1000 - com.relayium.protocol.RelayRenewPolicy.CLOCK_SKEW_MS,
            moved,
        )
    }

    /**
     * After a migration, a LATER classification must read the configuration the
     * connection is actually running on.
     *
     * Deriving from the room's original grant instead would read an expiry that
     * by then describes a credential nothing uses — and would end a healthy
     * migrated link on the boundary it had just replaced.
     */
    @Test
    fun `a later relay classification derives from the installed configuration`() {
        val rig = rig(turnTtlSeconds = 3600)
        observeRelay(rig)
        awaitTrue("bounded") { rig.controller.state.value.relayExpiresAt != null }
        val expiry = driveCommit(rig, grantTtlSeconds = 4 * 3600)
        awaitTrue("committed") {
            rig.controller.state.value.renewState == RelayRenewEngine.State.RENEWED
        }

        // The path goes direct, so the boundary is released…
        observeDirect(rig)
        awaitTrue("released") { rig.controller.state.value.relayExpiresAt == null }
        // …and comes back relayed, which re-derives a boundary from scratch.
        observeRelay(rig)
        awaitTrue("bounded again") { rig.controller.state.value.relayExpiresAt != null }
        assertEquals(
            "the RENEWED credential, not the room's original one",
            expiry * 1000 - com.relayium.protocol.RelayRenewPolicy.CLOCK_SKEW_MS,
            rig.controller.state.value.relayExpiresAt,
        )
    }

    @Test
    fun `the installed configuration does not outlive the link that installed it`() {
        val rig = rig(turnTtlSeconds = 3600)
        observeRelay(rig)
        awaitTrue("bounded") { rig.controller.state.value.relayExpiresAt != null }
        driveCommit(rig, grantTtlSeconds = 4 * 3600)
        awaitTrue("committed") {
            rig.controller.state.value.renewState == RelayRenewEngine.State.RENEWED
        }
        rig.controller.disconnect()
        awaitTrue("ended") {
            rig.controller.state.value.phase == TransferController.Phase.ENDED
        }
        // A configuration issued for one link is not authority for the next.
        assertNull(rig.controller.state.value.relayExpiresAt)
        assertEquals(RelayRenewEngine.State.IDLE, rig.controller.state.value.renewState)
    }

    // ── the text lane is otherwise untouched ────────────────────────────────

    @Test
    fun `an ordinary text frame still reaches the lane`() {
        val rig = rig()
        // The demux must not be a filter that eats anything else: a real
        // lifecycle byte is still the text lane's.
        rig.transport.events.onTextFrame(TextWire.REQUEST)
        awaitTrue("the conversation surfaced") {
            rig.controller.state.value.textState != TextLaneSession.State.IDLE
        }
    }
}
