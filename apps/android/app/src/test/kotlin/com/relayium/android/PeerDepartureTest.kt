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
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
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
 *
 * ## How this file observes
 *
 * Every effect here lands on the controller's ONE session executor, and the
 * state flow is published from that thread too — but not always last.
 * `endSession` publishes `Phase.ENDED` and only THEN runs `closeConnection`,
 * so a reader that waits for the phase and immediately inspects the transport
 * is reading across a window in which the close has not happened yet. That is
 * what failed hosted `android` run 35460630190, and a 100 ms delay inside the
 * fake's `close` reproduces it exactly.
 *
 * So no test here waits on a phase as a proxy for a later effect, and none
 * uses elapsed time as proof. [Rig.settle] submits a task to the session owner
 * itself and waits for it: the executor is serial, so when that task runs,
 * every effect queued before it has finished. It is finite, positively
 * observed, and exact. Fake callbacks are delivered through [Rig.onSession] for
 * the same reason the real transport delivers them there — `LinkTransport`'s
 * contract is that every event fires on the executor thread.
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

        /** Every close this transport was asked to perform, in order, recorded
         *  only once the call has actually completed. A list rather than one
         *  field because a local disconnect performs TWO — the authenticated
         *  leave and then the teardown — and "the last one wins" hid that. */
        val closeCalls = ConcurrentLinkedQueue<String>()

        /** The controller ADOPTED and published this transport, then started
         *  it. `startTransport` assigns the field and publishes the phase
         *  before this runs, so observing it is observing the publish. */
        @Volatile var started = false

        @Volatile var announcedLeave: Signal? = null

        /**
         * Fault injection: hold the close open before publishing it.
         *
         * This is NOT a retry or a tolerance. It widens a window that exists in
         * production ordering — the phase is published before the teardown — so
         * that a test which reads the transport after a phase edge fails here
         * instead of on a loaded CI runner. Root reproduced the hosted failure
         * with exactly this, at 100 ms.
         */
        @Volatile var closeDelayMs = 0L

        override fun start() { started = true }
        override fun onSignal(raw: Json) { signals.add(raw) }
        override fun sendFile(frame: ByteArray): Boolean { fileFrames.add(frame); return true }
        override fun sendText(frame: ByteArray): Boolean { textFrames.add(frame); return true }
        override fun fileBufferedAmount() = 0L
        override fun textBufferedAmount() = 0L

        override fun leaveAndClose(leave: Signal?) {
            announcedLeave = leave
            close("local-leave")
        }

        override fun close(reason: String) {
            if (closeDelayMs > 0) Thread.sleep(closeDelayMs)
            closeCalls.add(reason)
        }
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
        /** Applied to every transport the factory builds from now on, so a
         *  slow close can be armed before the transport exists. */
        val closeDelayForNew: AtomicLong,
        private val sessionOwner: AtomicReference<ScheduledExecutorService?>,
    ) {
        val state get() = controller.state.value
        val events: SignalingClient.Events get() = signaling.events ?: error("no signalling client")
        val transport: FakeTransport get() = transports.peek() ?: error("no transport")

        /** Run [block] ON the session executor and wait for it — the thread
         *  `LinkTransport.Events` promises to fire on. */
        fun <T> onSession(block: () -> T): T =
            owner().submit(Callable { block() }).get(10, TimeUnit.SECONDS)

        /**
         * Wait until the session owner has drained everything queued before
         * now.
         *
         * The executor is serial and FIFO, so a task submitted here runs after
         * every effect already posted — including an `endSession` whose phase
         * publish precedes its teardown. This is the file's only "and then
         * nothing else happened" barrier, and it is an observation rather than
         * a duration.
         */
        fun settle() {
            owner().submit(Runnable { }).get(10, TimeUnit.SECONDS)
        }

        private fun owner(): ScheduledExecutorService = sessionOwner.get()
            ?: error("the session owner is only visible once a transport has been built")
    }

    private fun rig(
        selfId: String = "aaaaaaaa",
        source: ConnectionSource = ConnectionSource.Pairing(
            PairCode("123456"), TransferController.Intent.JOINER,
        ),
    ): Rig {
        val signaling = FakeSignaling()
        val transports = ConcurrentLinkedQueue<FakeTransport>()
        val closeDelayForNew = AtomicLong(0)
        val sessionOwner = AtomicReference<ScheduledExecutorService?>(null)
        val deps = TransferController.Deps(
            fetchIce = { IceConfig.Result(emptyList(), "") },
            signals = { _, events -> signaling.also { it.events = events } },
            transports = { profile, _, executor, _, events ->
                // The executor handed in here IS the controller's session
                // owner. Capturing it is what lets this file observe the
                // session instead of guessing at it with a sleep.
                sessionOwner.set(executor)
                FakeTransport(profile, events)
                    .also { it.closeDelayMs = closeDelayForNew.get() }
                    .also(transports::add)
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
        return Rig(controller, signaling, transports, closeDelayForNew, sessionOwner)
    }

    private fun quiet() = TransferController.Timeouts(
        helloRetryMs = 60_000, settleMs = 60_000, requestRetryMs = 60_000,
        requestDeadlineMs = 60_000, consentMs = 60_000, textEndAckMs = 60_000,
        abortBarrierMs = 60_000, textIdleMs = 600_000,
        pendingAdmissionMs = 60_000, roomRetryMs = 60_000,
    )

    /** For the two edges that are genuinely produced by another thread and have
     *  no ordering to ride: the signalling client appearing, and a transport
     *  being built. Everything after that uses [Rig.settle]. */
    private fun awaitTrue(what: String, timeoutMs: Long = 5_000, predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return
            Thread.sleep(5)
        }
        throw AssertionError("timed out waiting for: $what")
    }

    private fun capsHello(): Json = Json.obj("caps" to Json.arr(listOf(Json.of("link/1"))))

    private fun mirroredKeys(): Pair<Crypto.SessionKeys, Crypto.SessionKeys> {
        val a = Crypto.generateKeyPair()
        val b = Crypto.generateKeyPair()
        return Crypto.deriveSession(Crypto.Role.INITIATOR, a, b.publicKey) to
            Crypto.deriveSession(Crypto.Role.RESPONDER, b, a.publicKey)
    }

    /**
     * A transport that EXISTS but has not reached READY.
     *
     * Waits for the controller's own `start()` call rather than for the
     * factory's return value: the factory runs INSIDE `startTransport`, so a
     * transport can be in the queue a moment before the controller has adopted
     * it and published the phase that describes it. `start()` is the last thing
     * that function does, so observing it observes the publish.
     */
    private fun establishing(rig: Rig, peer: String = "bbbbbbbb"): FakeTransport {
        rig.events.onPeers(listOf(Envelope.Peer(peer, "peer")))
        rig.events.onSignal(peer, capsHello())
        awaitTrue("a transport, adopted and started by the controller") {
            rig.transports.peek()?.started == true
        }
        assertEquals(TransferController.Phase.CONNECTING, rig.state.phase)
        return rig.transport
    }

    /** …and the same transport brought to READY with real mirrored keys.
     *  Returns the PEER side. */
    private fun connect(rig: Rig, peer: String = "bbbbbbbb"): Crypto.SessionKeys {
        val transport = establishing(rig, peer)
        val (local, remote) = mirroredKeys()
        rig.onSession {
            transport.events.onReady(local, "705955", RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        }
        assertEquals(TransferController.Phase.CONNECTED, rig.state.phase)
        return remote
    }

    // ── an established link outlives the room's view of the peer ────────────

    @Test
    fun `a READY link survives the peer leaving the rendezvous`() {
        val rig = rig()
        connect(rig)
        rig.events.onPeerLeft("bbbbbbbb")
        rig.settle()
        assertEquals(
            "the data channel is healthy; the ROOM lost sight of the peer",
            TransferController.Phase.CONNECTED, rig.state.phase,
        )
        assertEquals(
            "nothing was torn down",
            emptyList<String>(), rig.transport.closeCalls.toList(),
        )
        assertNull("and no failure is claimed", rig.state.errorKey)
    }

    @Test
    fun `a conversation keeps working after the peer left the rendezvous`() {
        val rig = rig()
        connect(rig)
        rig.onSession { rig.transport.events.onTextFrame(TextWire.REQUEST) }
        assertEquals(TextLaneSession.State.OPEN, rig.state.textState)
        rig.events.onPeerLeft("bbbbbbbb")
        rig.settle()
        val before = rig.transport.textFrames.size
        // Written on the session thread, read here: a plain ArrayList would be
        // unsafely published across that boundary even when the value is right.
        val outcomes = ConcurrentLinkedQueue<Boolean>()
        rig.controller.sendText("still reachable over the data channel") { outcomes.add(it) }
        rig.settle()
        assertEquals(
            "exactly one outcome was reported, and it was a send",
            listOf(true), outcomes.toList(),
        )
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
        val transport = establishing(rig)
        rig.events.onPeerLeft("bbbbbbbb")
        rig.settle()
        assertEquals(
            "a half-built connection has no channel to survive on",
            TransferController.Phase.ENDED, rig.state.phase,
        )
        assertEquals("error_connection_lost", rig.state.errorKey)
        assertEquals(listOf("local-close"), transport.closeCalls.toList())
    }

    /**
     * The same case with the close held open for 100 ms.
     *
     * This is the permanent form of root's reproduction of hosted run
     * 35460630190: the product publishes `ENDED` before it tears the transport
     * down, so any barrier that is really "the phase changed" fails here while
     * the session barrier passes. It stays in the file so that window can never
     * be re-introduced silently by a later edit.
     */
    @Test
    fun `the close is observed even when the transport closes slowly`() {
        val rig = rig()
        rig.closeDelayForNew.set(100)
        val transport = establishing(rig)
        assertEquals(100L, transport.closeDelayMs)
        rig.events.onPeerLeft("bbbbbbbb")
        rig.settle()
        assertEquals(TransferController.Phase.ENDED, rig.state.phase)
        assertEquals("error_connection_lost", rig.state.errorKey)
        assertEquals(listOf("local-close"), transport.closeCalls.toList())
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
        rig.settle()
        assertEquals(TransferController.Phase.CONNECTED, rig.state.phase)
        // The peer says goodbye in band, signed with the real resume-auth key.
        val tag = Crypto.signAuth(remote, LinkProtocol.linkLeavePayload("bbbbbbbb", "aaaaaaaa"))
        rig.events.onSignal("bbbbbbbb", Signal.leave(tag).toJson())
        rig.settle()
        assertEquals(
            "a signed leave is still terminal",
            TransferController.Phase.ENDED, rig.state.phase,
        )
        assertNull("an announced departure is not an error", rig.state.errorKey)
    }

    @Test
    fun `an actual transport failure still ends a link whose peer had left`() {
        val rig = rig()
        connect(rig)
        rig.events.onPeerLeft("bbbbbbbb")
        rig.settle()
        assertEquals(TransferController.Phase.CONNECTED, rig.state.phase)
        // The connection itself fails — ICE gave up, or the channel closed.
        rig.onSession { rig.transport.events.onClosed("ice-failed") }
        assertEquals(
            "the connection ending is still the connection ending",
            TransferController.Phase.ENDED, rig.state.phase,
        )
        assertEquals("error_connection_lost", rig.state.errorKey)
    }

    @Test
    fun `a departure by an unrelated peer changes nothing`() {
        val rig = rig()
        connect(rig)
        rig.events.onPeerLeft("cccccccc")
        rig.settle()
        assertEquals(TransferController.Phase.CONNECTED, rig.state.phase)
        assertEquals(emptyList<String>(), rig.transport.closeCalls.toList())
    }

    @Test
    fun `leaving the room locally still ends everything`() {
        val rig = rig()
        connect(rig)
        rig.events.onPeerLeft("bbbbbbbb")
        rig.settle()
        rig.controller.disconnect()
        rig.settle()
        assertEquals(
            "the user's own disconnect is unaffected",
            TransferController.Phase.ENDED, rig.state.phase,
        )
        assertNotNull(
            "and the peer is still told, with the authenticated leave",
            rig.transport.announcedLeave,
        )
        assertEquals(
            "the announced leave first, then the teardown — both observed",
            listOf("local-leave", "local-close"), rig.transport.closeCalls.toList(),
        )
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
        awaitTrue("a transport, adopted and started by the controller") {
            rig.transports.peek()?.started == true
        }
        val (local, _) = mirroredKeys()
        rig.onSession {
            rig.transport.events.onReady(local, "705955", RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        }
        assertEquals(TransferController.Phase.CONNECTED, rig.state.phase)

        rig.events.onPeerLeft("bbbbbbbb")
        rig.events.onPeers(listOf(Envelope.Peer("aaaaaaaa", "this")))
        rig.settle()
        assertEquals(
            "the transfer the user is watching does not end because a socket did",
            TransferController.Phase.CONNECTED, rig.state.phase,
        )
        assertEquals(
            "and the selection still names the peer of the live session",
            "bbbbbbbb", rig.state.nearby.selectedId,
        )
        assertEquals(emptyList<String>(), rig.transport.closeCalls.toList())
    }
}
