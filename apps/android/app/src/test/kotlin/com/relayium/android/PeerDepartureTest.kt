package com.relayium.android

import com.relayium.android.nearby.ConnectionSource
import com.relayium.android.storage.ProviderOps
import com.relayium.android.storage.ReceiveStore
import com.relayium.android.transport.IceConfig
import com.relayium.android.transport.LinkTransport
import com.relayium.android.transport.SignalingClient
import com.relayium.android.transport.SignalingHandle
import com.relayium.android.transport.TransportHandle
import com.relayium.protocol.Crypto
import com.relayium.protocol.Envelope
import com.relayium.protocol.Json
import com.relayium.protocol.LinkProtocol
import com.relayium.protocol.PairCode
import com.relayium.protocol.RealtimeFrame
import com.relayium.protocol.Signal
import com.relayium.protocol.TextLaneSession
import com.relayium.protocol.TextWire
import com.relayium.protocol.legacy.WireProfile
import java.util.concurrent.ConcurrentLinkedQueue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * What the RENDEZVOUS saying "that peer is gone" may and may not end.
 *
 * A WebRTC link is peer-to-peer. Once it is READY it carries bytes without the
 * socket that introduced the two devices, and the controller already relies on
 * that everywhere else: [TransferController] leaves a live transfer running
 * when the whole room drops, and the Web records the departure without
 * disconnecting (`peer-workspace.svelte.ts`). `onPeerLeft` was the one place
 * that did not — it ended the session unconditionally, so a peer whose
 * signalling socket dropped (a screen lock, a Wi-Fi handover, a server
 * restart) took a healthy transfer down with it.
 *
 * The rule is READY, not "a transport exists": a connection still in its
 * handshake has no channel but signalling, so its peer leaving must end it
 * rather than strand it until its own setup deadline.
 */
class PeerDepartureTest {

    @get:Rule
    val temp = TemporaryFolder()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val controllers = ArrayList<TransferController>()

    @After
    fun tearDown() {
        controllers.forEach { it.shutdown() }
        scope.cancel()
    }

    private class FakeSignaling : SignalingHandle {
        @Volatile var events: SignalingClient.Events? = null
        val sent = ConcurrentLinkedQueue<Pair<String, Json>>()
        override fun connect() = Unit
        override fun sendSignal(to: String, data: Json) { sent.add(to to data) }
        override fun close() = Unit
    }

    private class FakeTransport(
        val profile: WireProfile,
        val events: LinkTransport.Events,
    ) : TransportHandle {
        val fileFrames = ConcurrentLinkedQueue<ByteArray>()
        val textFrames = ConcurrentLinkedQueue<ByteArray>()
        val signals = ConcurrentLinkedQueue<Json>()
        @Volatile var closedReason: String? = null
        @Volatile var announcedLeave: Signal? = null
        override fun start() = Unit
        override fun onSignal(raw: Json) { signals.add(raw) }
        override fun sendFile(frame: ByteArray): Boolean { fileFrames.add(frame); return true }
        override fun sendText(frame: ByteArray): Boolean { textFrames.add(frame); return true }
        override fun fileBufferedAmount() = 0L
        override fun textBufferedAmount() = 0L
        override fun leaveAndClose(leave: Signal?) {
            announcedLeave = leave
            closedReason = "local-leave"
        }
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
    ) {
        val state get() = controller.state.value
        val events: SignalingClient.Events get() = signaling.events!!
        val transport: FakeTransport get() = transports.peek() ?: error("no transport")
    }

    private fun rig(
        selfId: String = "aaaaaaaa",
        source: ConnectionSource = ConnectionSource.Pairing(
            PairCode("123456"), TransferController.Intent.JOINER,
        ),
    ): Rig {
        val signaling = FakeSignaling()
        val transports = ConcurrentLinkedQueue<FakeTransport>()
        val deps = TransferController.Deps(
            fetchIce = { IceConfig.Result(emptyList(), "") },
            signals = { _, events -> signaling.also { it.events = events } },
            transports = { profile, _, _, _, events ->
                FakeTransport(profile, events).also(transports::add)
            },
            store = ReceiveStore(temp.newFolder("staging-${System.nanoTime()}")),
            providerOps = NoOps(),
            timeouts = quiet(),
        )
        val controller = TransferController(scope, "test-device", deps)
        controllers.add(controller)
        controller.join(source)
        awaitTrue("signalling wired") { signaling.events != null }
        signaling.events!!.onSelfId(selfId, "")
        return Rig(controller, signaling, transports)
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

    private fun quiesce() = Thread.sleep(250)

    private fun capsHello(): Json = Json.obj("caps" to Json.arr(listOf(Json.of("link/1"))))

    private fun mirroredKeys(): Pair<Crypto.SessionKeys, Crypto.SessionKeys> {
        val a = Crypto.generateKeyPair()
        val b = Crypto.generateKeyPair()
        return Crypto.deriveSession(Crypto.Role.INITIATOR, a, b.publicKey) to
            Crypto.deriveSession(Crypto.Role.RESPONDER, b, a.publicKey)
    }

    /** A transport that EXISTS but has not reached READY. */
    private fun establishing(rig: Rig, peer: String = "bbbbbbbb") {
        rig.events.onPeers(listOf(Envelope.Peer(peer, "peer")))
        rig.events.onSignal(peer, capsHello())
        awaitTrue("transport created") { rig.transports.isNotEmpty() }
    }

    /** …and the same transport brought to READY with real mirrored keys.
     *  Returns the PEER side. */
    private fun connect(rig: Rig, peer: String = "bbbbbbbb"): Crypto.SessionKeys {
        establishing(rig, peer)
        val (local, remote) = mirroredKeys()
        rig.transport.events.onReady(local, "705955", RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        awaitTrue("connected") { rig.state.phase == TransferController.Phase.CONNECTED }
        return remote
    }

    // ── an established link outlives the room's view of the peer ────────────

    @Test
    fun `a READY link survives the peer leaving the rendezvous`() {
        val rig = rig()
        connect(rig)
        rig.events.onPeerLeft("bbbbbbbb")
        quiesce()
        assertEquals(
            "the data channel is healthy; the ROOM lost sight of the peer",
            TransferController.Phase.CONNECTED, rig.state.phase,
        )
        assertNull("nothing was torn down", rig.transport.closedReason)
        assertNull("and no failure is claimed", rig.state.errorKey)
    }

    @Test
    fun `a conversation keeps working after the peer left the rendezvous`() {
        val rig = rig()
        connect(rig)
        rig.transport.events.onTextFrame(TextWire.REQUEST)
        awaitTrue("lane open") { rig.state.textState == TextLaneSession.State.OPEN }
        rig.events.onPeerLeft("bbbbbbbb")
        quiesce()
        val before = rig.transport.textFrames.size
        val outcomes = ArrayList<Boolean>()
        rig.controller.sendText("still reachable over the data channel") { outcomes.add(it) }
        awaitTrue("the message went out") { outcomes.size == 1 }
        assertTrue("and it was actually sent", outcomes[0])
        assertTrue(
            "over the surviving transport",
            rig.transport.textFrames.size > before,
        )
        assertEquals(TransferController.Phase.CONNECTED, rig.state.phase)
    }

    // ── everything that still ends it ───────────────────────────────────────

    @Test
    fun `a departure BEFORE the handshake completes ends the session`() {
        val rig = rig()
        establishing(rig)
        assertEquals(TransferController.Phase.CONNECTING, rig.state.phase)
        rig.events.onPeerLeft("bbbbbbbb")
        awaitTrue("a half-built connection has no channel to survive on") {
            rig.state.phase == TransferController.Phase.ENDED
        }
        assertEquals("error_connection_lost", rig.state.errorKey)
        assertEquals("local-close", rig.transport.closedReason)
    }

    @Test
    fun `the peer's authenticated leave still ends a READY link`() {
        val rig = rig()
        val remote = connect(rig)
        rig.events.onPeerLeft("bbbbbbbb")
        // …and the roster that follows no longer lists it, so the capability
        // registry has dropped the peer too. The leave budget belongs to the
        // authenticated LINK, not to a room membership.
        rig.events.onPeers(emptyList())
        quiesce()
        assertEquals(TransferController.Phase.CONNECTED, rig.state.phase)
        // The peer says goodbye in band, signed with the real resume-auth key.
        val tag = Crypto.signAuth(remote, LinkProtocol.linkLeavePayload("bbbbbbbb", "aaaaaaaa"))
        rig.events.onSignal("bbbbbbbb", Signal.leave(tag).toJson())
        awaitTrue("a signed leave is still terminal") {
            rig.state.phase == TransferController.Phase.ENDED
        }
        assertNull("an announced departure is not an error", rig.state.errorKey)
    }

    @Test
    fun `an actual transport failure still ends a link whose peer had left`() {
        val rig = rig()
        connect(rig)
        rig.events.onPeerLeft("bbbbbbbb")
        quiesce()
        assertEquals(TransferController.Phase.CONNECTED, rig.state.phase)
        // The connection itself fails — ICE gave up, or the channel closed.
        rig.transport.events.onClosed("ice-failed")
        awaitTrue("the connection ending is still the connection ending") {
            rig.state.phase == TransferController.Phase.ENDED
        }
        assertEquals("error_connection_lost", rig.state.errorKey)
    }

    @Test
    fun `a departure by an unrelated peer changes nothing`() {
        val rig = rig()
        connect(rig)
        rig.events.onPeerLeft("cccccccc")
        quiesce()
        assertEquals(TransferController.Phase.CONNECTED, rig.state.phase)
        assertNull(rig.transport.closedReason)
    }

    @Test
    fun `leaving the room locally still ends everything`() {
        val rig = rig()
        connect(rig)
        rig.events.onPeerLeft("bbbbbbbb")
        quiesce()
        rig.controller.disconnect()
        awaitTrue("the user's own disconnect is unaffected") {
            rig.state.phase == TransferController.Phase.ENDED
        }
        assertNotNull(
            "and the peer is still told, with the authenticated leave",
            rig.transport.announcedLeave,
        )
        assertEquals("local-close", rig.transport.closedReason)
    }

    // ── the Nearby surface ──────────────────────────────────────────────────

    @Test
    fun `a Nearby peer that leaves the room keeps its live connection and its row`() {
        val rig = rig(selfId = "aaaaaaaa", source = ConnectionSource.Hub)
        rig.events.onPeers(
            listOf(Envelope.Peer("aaaaaaaa", "this"), Envelope.Peer("bbbbbbbb", "peer")),
        )
        rig.events.onSignal("bbbbbbbb", capsHello())
        awaitTrue("listed") { rig.state.nearby.devices.size == 1 }
        rig.controller.connectToPeer("bbbbbbbb", rig.state.nearby.roomId)
        awaitTrue("transport") { rig.transports.isNotEmpty() }
        val (local, _) = mirroredKeys()
        rig.transport.events.onReady(local, "705955", RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        awaitTrue("connected") { rig.state.phase == TransferController.Phase.CONNECTED }

        rig.events.onPeerLeft("bbbbbbbb")
        rig.events.onPeers(listOf(Envelope.Peer("aaaaaaaa", "this")))
        quiesce()
        assertEquals(
            "the transfer the user is watching does not end because a socket did",
            TransferController.Phase.CONNECTED, rig.state.phase,
        )
        assertEquals(
            "and the selection still names the peer of the live session",
            "bbbbbbbb", rig.state.nearby.selectedId,
        )
        assertNull(rig.transport.closedReason)
    }
}
