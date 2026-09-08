package com.relayium.android

import com.relayium.android.nearby.ConnectionSource
import com.relayium.android.nearby.NearbyDevice
import com.relayium.android.nearby.PeerAdmission
import com.relayium.android.nearby.nearbyDevices
import com.relayium.android.storage.ProviderOps
import com.relayium.android.storage.ReceiveStore
import com.relayium.android.transport.IceConfig
import com.relayium.android.transport.LinkTransport
import com.relayium.android.transport.PeerScopedSignaling
import com.relayium.android.transport.SignalingClient
import com.relayium.android.transport.SignalingFactory
import com.relayium.android.transport.SignalingHandle
import com.relayium.android.transport.TransportFactory
import com.relayium.android.transport.TransportHandle
import com.relayium.protocol.Crypto
import com.relayium.protocol.Envelope
import com.relayium.protocol.FileLaneSession
import com.relayium.protocol.FileMeta
import com.relayium.protocol.Json
import com.relayium.protocol.LinkProtocol
import com.relayium.protocol.LinkSession
import com.relayium.protocol.PairCode
import com.relayium.protocol.RealtimeFrame
import com.relayium.protocol.Signal
import com.relayium.protocol.TextLane
import com.relayium.protocol.TextLaneSession
import com.relayium.protocol.TextSessionLimits
import com.relayium.protocol.legacy.LegacyLane
import com.relayium.protocol.legacy.LegacyProtocol
import com.relayium.protocol.legacy.LegacyTextLane
import com.relayium.protocol.legacy.WireProfile
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * One joined session, from the pairing code to the last saved byte.
 *
 * ## Ownership
 *
 * SESSION state — signalling registry, transport, both lane machines, timers —
 * is owned by one serial [session] executor; STORAGE effects run on a second
 * serial [storage] executor so a slow provider can never stall signals, text or
 * a cancel. Everything crossing between them is fenced twice: by [epoch] (the
 * link) and by the relevant generation ([batchGen] for an outgoing batch,
 * [receiveGen] for an incoming one, [textBarrierGen] for an end barrier), so a
 * stale continuation — an old join's ICE fetch, a cancelled pump's read, a
 * previous batch's export, a retired barrier's timer — drops itself on arrival.
 *
 * No Android type appears in this class: transport, signalling and the document
 * provider enter through [Deps], which is what lets its ownership rules run
 * under plain JVM tests against real fakes.
 */
class TransferController(
    private val scope: CoroutineScope,
    private val deviceName: String,
    private val deps: Deps,
) {

    class Deps(
        /** Called ONLY for a source whose [ConnectionSource.usesBackend] is
         *  true. The direct local path has no server to ask and must not
         *  acquire one; see [openRoom]. */
        val fetchIce: suspend (ConnectionSource) -> IceConfig.Result,
        val signals: SignalingFactory,
        val transports: TransportFactory,
        val store: ReceiveStore,
        val providerOps: ProviderOps,
        val timeouts: Timeouts = Timeouts(),
    )

    /** Every deadline, injectable so a test is not a 30-second wait. Defaults
     *  are the protocol constants. */
    data class Timeouts(
        val helloRetryMs: Long = LinkProtocol.CAPS_RETRY_INTERVAL_MS,
        val settleMs: Long = LinkProtocol.CAPS_SETTLE_MS,
        val requestRetryMs: Long = LinkProtocol.LINK_REQUEST_RETRY_MS,
        val requestDeadlineMs: Long = LinkProtocol.LINK_REQUEST_TIMEOUT_MS,
        val consentMs: Long = 10 * 60_000L,
        val textEndAckMs: Long = TextLaneSession.END_ACK_TIMEOUT_MS,
        val abortBarrierMs: Long = FileLaneSession.ABORT_BARRIER_TIMEOUT_MS,
        val textIdleMs: Long = TextSessionLimits.IDLE_MS,
        /** How long an unanswered inbound admission prompt may stand. Matched
         *  to the peer's own request deadline, so the two sides give up
         *  together instead of one waiting on a prompt the other abandoned. */
        val pendingAdmissionMs: Long = LinkProtocol.LINK_REQUEST_TIMEOUT_MS,
        /** The first room-reconnect delay; later attempts scale it. */
        val roomRetryMs: Long = 2_000L,
    )

    // ── observable state ────────────────────────────────────────────────────

    enum class Phase { IDLE, CONNECTING, WAITING_PEER, CONNECTED, ENDED }

    /**
     * Why this device is in the room, and therefore who offers on a wire that
     * has no other tiebreak.
     *
     * `link/1` derives its role from the two hub ids, identically on both
     * sides. The shipped legacy wire does not: `RealtimeSessionModel.join`
     * takes the role from the verb the user pressed — creating a code offers,
     * joining one answers — so the intent has to be carried here rather than
     * re-derived. Two devices that both computed a sorted role would disagree
     * with every already-deployed peer about who offers.
     */
    enum class Intent { MINTER, JOINER }

    /** Which wire the established connection actually speaks. */
    enum class Wire {
        /** Two lanes, one connection: files and messages together. */
        LINK,
        /** The shipped file generation. Carries files only. */
        LEGACY_FILES,
        /** The shipped message generation. Carries messages only. */
        LEGACY_TEXT,
    }

    data class Progress(val name: String, val done: Long, val total: Long)

    data class Message(val body: String, val fromPeer: Boolean)

    /**
     * Whether the discovery half of a Nearby source is usable RIGHT NOW.
     *
     * Published separately from [Phase] because the two are genuinely
     * independent: a WebRTC connection is peer-to-peer and keeps working while
     * the room that introduced the peers is gone, and a room that is searching
     * again is not a transfer that is connecting. Collapsing them is how a
     * screen ends up claiming a list is live when nothing is maintaining it.
     */
    enum class NearbyRoom {
        /** Not a Nearby source, or the user stopped it. */
        OFF,
        /** Opening the rendezvous; nothing is listed, because a roster that
         *  cannot exclude this device would offer the user their own phone. */
        CONNECTING,
        /** Live. The list is meaningful, though it may legitimately be empty. */
        JOINED,
        /** The room dropped or could not run, and a bounded retry is armed.
         *  Deliberately NOT "joined with an old list": nothing is maintaining
         *  that list, so it is cleared rather than left on screen. */
        RECONNECTING,
    }

    /**
     * The discovery surface, and NOTHING that decides a transfer.
     *
     * Everything here is either what the user is looking at or what they chose.
     * No field is ever read as permission: [NearbyDevice] carries what a peer
     * ANNOUNCED, and commit-reveal plus the SAS are what authenticate.
     */
    data class Nearby(
        /** A Nearby source is running. False for a pairing code. */
        val active: Boolean = false,
        /** The local-link path: no server of any kind was contacted. Published
         *  so the screen can say which of the two rooms this is — their privacy
         *  properties genuinely differ, and describing both the same way would
         *  be untrue about one of them. */
        val direct: Boolean = false,
        val room: NearbyRoom = NearbyRoom.OFF,
        val devices: List<NearbyDevice> = emptyList(),
        /** The device the user picked, or null. Only ever set by an explicit
         *  choice — never by arrival order, never by "the most recent one". */
        val selectedId: String? = null,
        /** A peer asking to connect, awaiting the user's answer. At most one: a
         *  second asker is refused in band rather than queued behind a prompt
         *  the user has not answered. */
        val incomingId: String? = null,
        /**
         * Identity of the CURRENT prompt, and of the room the list belongs to.
         *
         * Both are monotonic, never reused, and both must be handed back with
         * the user action they authorise — [connectToPeer] takes the room,
         * [admitPeer]/[rejectPeer] take the prompt. A peer id is not enough on
         * its own: a device on the local link keeps its identity for as long as
         * it keeps advertising, so a tap that crossed a withdrawn prompt or a
         * reopened room would otherwise still name something that matches.
         */
        val incomingPromptId: Int = 0,
        val roomId: Int = 0,
    )

    data class State(
        val phase: Phase = Phase.IDLE,
        /**
         * The wire this session speaks, once it is established; null before.
         *
         * Published so the UI can be TRUTHFUL rather than generic: a legacy
         * file connection has no message lane and a legacy message connection
         * has no file lane, and offering the missing one would be a control
         * over nothing. Derived nowhere else — [canSendFiles] and
         * [canSendMessages] read this so there is one answer.
         */
        val wire: Wire? = null,
        /** The controller-owned identity of THIS link session: monotonically
         *  unique, published with the state that describes the session, never
         *  reused. A picker result captured under one value must be handed
         *  back with it, and the controller drops the effect INSIDE the
         *  session executor if the link has changed — the UI cannot enforce
         *  this by watching phases, which conflate and repeat. */
        val linkId: Int = 0,
        val sas: String? = null,
        /** A stable identifier the UI maps to localised copy. Never raw text. */
        val errorKey: String? = null,
        val incoming: List<FileMeta> = emptyList(),
        /** Identity of the current incoming prompt. A folder-picker result for
         *  an older prompt — a replaced offer — must not accept this one. */
        val promptId: Int = 0,
        val awaitingFolder: Boolean = false,
        val receiveProgress: Progress? = null,
        val sendProgress: Progress? = null,
        val outgoing: List<FileMeta> = emptyList(),
        val messages: List<Message> = emptyList(),
        val textState: TextLaneSession.State = TextLaneSession.State.IDLE,
        /** False while an end barrier is settling or after the text lane
         *  poisoned; the UI shows the truthful state, not a throwing button. */
        val textCanRequest: Boolean = false,
        val textLimit: Int = com.relayium.protocol.TextWire.MAX_BYTES,
        /** The file lane failed terminally on this link. Text may continue; a
         *  fresh session is the file path's recovery. */
        val fileLaneDown: Boolean = false,
        val savedBatch: Boolean = false,
        /** The last outgoing batch reached the peer's verified COMPLETE. This is
         *  the ONLY thing "sent" may mean in the UI: cancel and failure also
         *  empty [outgoing] and [sendProgress], so their absence proves nothing. */
        val sentBatch: Boolean = false,
        /** How many INCOMING batches completed — saved and verified — on THIS
         *  link. Monotonic per link, reset by a new join, never decremented.
         *  [savedBatch] alone cannot distinguish "batch N completed" from
         *  "batch N-1 completed and batch N was not yet admitted": an observer
         *  that captured the count before starting a batch owns an edge no
         *  stale flag can fake. Cancels and failures do not count. */
        val savedBatchCount: Int = 0,
        /** The outgoing twin of [savedBatchCount]: verified COMPLETEs only. */
        val sentBatchCount: Int = 0,
        /** A cleanup left partial documents in the user's folder that could not
         *  be removed. Session-level and sticky across links until the user
         *  acknowledges it — never silently erased by a generation fence. */
        val cleanupIncomplete: Boolean = false,
        /** The discovery surface. Empty and inert for a pairing code. */
        val nearby: Nearby = Nearby(),
    ) {
        /** Whether THIS connection can carry files at all. */
        val canSendFiles: Boolean get() = wire == Wire.LINK || wire == Wire.LEGACY_FILES

        /** Whether THIS connection can carry messages at all. */
        val canSendMessages: Boolean get() = wire == Wire.LINK || wire == Wire.LEGACY_TEXT

        /** Whether retiring one operation on this connection ends the whole
         *  connection. True on the older wire, which has no in-band way to stop
         *  a transfer or close a conversation — see [Wire]. */
        val cancelDisconnects: Boolean get() = wire == Wire.LEGACY_FILES || wire == Wire.LEGACY_TEXT
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /** A file the user picked to send. `meta.size` must be the REAL size the
     *  provider reported; a source with an unknown size is excluded by the
     *  picker layer, never guessed. */
    data class OutgoingSource(val meta: FileMeta, val open: () -> InputStream)

    /**
     * Per-pump ownership of the source stream, under one lock.
     *
     * Exactly one side ends up owning any acquired descriptor: the OPENER
     * offers its result from the IO thread, and if the lease was already
     * retired — the cancel won the race — the offer is refused and the opener
     * closes what it opened, right there on IO where blocking is fine. A
     * retire after a successful offer takes the stream and the RETIRER closes
     * it. Nothing relies on a cancelled coroutine's resumption or `finally`
     * running, and because each pump holds its OWN lease, a late open from a
     * retired pump can never overwrite — or get closed in place of — a newer
     * pump's stream.
     */
    private class PumpLease {
        private var stream: InputStream? = null
        private var retired = false

        /** IO thread, straight after `open()`. False → retired while the open
         *  ran; the caller still owns its result and must close it itself. */
        @Synchronized
        fun offer(acquired: InputStream): Boolean {
            if (retired) return false
            check(stream == null) { "a pump owns one stream at a time" }
            stream = acquired
            return true
        }

        /** The pump is done with the current stream: take it back for closing.
         *  Null when a retire already took it. */
        @Synchronized
        fun release(): InputStream? = stream.also { stream = null }

        /** Retire the lease and surrender whatever it holds. Idempotent. */
        @Synchronized
        fun retire(): InputStream? {
            retired = true
            return stream.also { stream = null }
        }
    }

    // ── the owners ──────────────────────────────────────────────────────────

    private val session = ScheduledThreadPoolExecutor(1)
    private val sessionDispatcher = session.asCoroutineDispatcher()
    private val storage = ScheduledThreadPoolExecutor(1)

    /**
     * The CONNECTION generation, and the published `linkId`.
     *
     * Unchanged in meaning: it fences the transport, both lanes, the pump,
     * every storage completion and every picker result, and it is bumped by
     * anything that retires a connection. What changed is only that it is no
     * longer also the rendezvous' generation — see [roomGen] — so a Nearby
     * session can retire a connection and build a fresh one to another device
     * without tearing down the room the user is looking at.
     */
    private var epoch = 0

    /**
     * The ROOM generation: the rendezvous socket, the capability registry, this
     * device's room identity and the roster.
     *
     * Signalling callbacks fence on this instead of on [epoch], because their
     * subject outlives an individual connection. For a pairing code the two
     * always move together — every path that bumps one bumps the other — so
     * that room's behaviour is exactly what it was.
     */
    private var roomGen = 0
    private var batchGen = 0
    private var receiveGen = 0
    private var textBarrierGen = 0
    private var promptCounter = 0

    /** A session-thread-visible mirror of [receiveGen] the STORAGE thread can
     *  read, so a queued begin/write/export effect for a retired batch is
     *  skipped at execution — not merely gated when its completion posts back. */
    @Volatile
    private var receiveToken = 0

    /** Enqueued-but-not-yet-completed plaintext bytes and tasks on the storage
     *  executor. Both are mutated only on the session thread (bumped when a task
     *  is enqueued, dropped when its completion posts back), so a peer that
     *  ignores ACKs cannot make the unbounded storage queue grow without bound. */
    private var queuedStorageBytes = 0L
    private var queuedStorageTasks = 0

    private fun post(expected: Int? = null, task: () -> Unit) {
        // A completion that posts back after the session executor was shut down
        // (shutdown races an in-flight storage task) is moot, not a crash.
        runCatching {
            session.execute {
                if (expected != null && expected != epoch) return@execute
                task()
            }
        }
    }

    /**
     * Post one ROOM effect, fenced by the room generation.
     *
     * Deliberately a separate fence from [post]'s epoch, and the separation is
     * the whole point of the split: a signalling frame is about the ROOM, and
     * dropping it because a connection inside that room was retired would make
     * the roster stop updating the moment a user finished one transfer.
     * Everything a room effect then does to a CONNECTION still reads the live
     * `epoch` on this thread, so nothing crosses the other way either.
     */
    private fun postRoom(expected: Int, task: () -> Unit) {
        runCatching {
            session.execute {
                if (expected != roomGen) return@execute
                task()
            }
        }
    }

    /** Submit one storage effect, fenced by the receive generation AT EXECUTION
     *  so a cancel drops the effect too, and inert if the executor has stopped. */
    private fun submitStorage(gen: Int, effect: () -> Unit) {
        runCatching {
            storage.execute { if (gen == receiveToken) effect() }
        }
    }

    /** Retire the current incoming batch's generation on BOTH the session-thread
     *  counter and the storage-visible mirror, and drop its queue accounting. */
    private fun bumpReceiveGen() {
        receiveGen++
        receiveToken = receiveGen
        queuedStorageBytes = 0
        queuedStorageTasks = 0
    }

    // ── session objects (session thread only) ───────────────────────────────

    private var signaling: SignalingHandle? = null

    /** Why this client is in a room. Null before the first join. */
    private var source: ConnectionSource? = null

    /** How a peer becomes THE peer. Read in the two places that would otherwise
     *  pick one implicitly, and nowhere else. */
    private val admission: PeerAdmission
        get() = source?.admission ?: PeerAdmission.AUTOMATIC

    /** The room's last roster, verbatim. Room-scoped: it means nothing outside
     *  the room that issued its ids. */
    private var roster: List<Envelope.Peer> = emptyList()

    /** The one peer asking to connect, awaiting the user's answer, and the
     *  bounded, ordered buffer of ITS establishment frames — the offer that
     *  raised the prompt and whatever chases it. Replayed into the transport on
     *  admission, discarded on every other exit. */
    private var pendingPeer: String? = null
    /** Which wire the prompt is ABOUT. A frame of another generation is not part
     *  of this ask and is never buffered into it. */
    private var pendingGeneration: Signal.Generation = Signal.Generation.LINK
    /** The legacy lane an older peer offered, or null for `link/1`. Recorded so
     *  the admitted profile is the one the user was asked about. */
    private var pendingLane: LegacyProtocol.Lane? = null
    private val pendingSignals = ArrayList<Json>()

    /**
     * Monotonic identity of the CURRENT prompt, never reused across prompts or
     * rooms.
     *
     * Published, and required back from the user action that answers it. A tap
     * is composed against one rendered question, and by the time it reaches this
     * executor that question may have been withdrawn and another one raised —
     * by a different device, in a different room. On the local link a peer's
     * identity is stable for as long as it keeps advertising, so "same peer id"
     * is NOT enough to prove the answer belongs to the ask; this is.
     */
    private var pendingPromptId = 0

    /** A room drop that arrived while a connection was live. The reconnect is
     *  deferred rather than dropped: replacing the registry under a live link
     *  would take its leave budget and its room identity with it. */
    private var roomRetryPending = false
    private var reconnectAttempt = 0

    private var transport: TransportHandle? = null
    private var linkSession: LinkSession? = null
    private var fileLane: FileLaneSession? = null
    private var textLane: TextLane? = null
    /** The wire the current transport was built for, and the role it was built
     *  with. Read when the lanes are constructed, so a lane can never be built
     *  for a different wire than the connection carrying it. */
    private var wireProfile: WireProfile? = null
    private var intent: Intent = Intent.JOINER

    /**
     * Whether the CURRENT connection is one of the shipped older generations.
     *
     * Read wherever `link/1` has an in-band way to retire one operation and the
     * older wire does not. It is deliberately a property of the live profile
     * rather than of the state snapshot: a teardown decision must not be made
     * from a value the UI thread may have observed one edge ago.
     */
    private val isLegacy: Boolean get() = wireProfile is WireProfile.Legacy
    private var keys: Crypto.SessionKeys? = null
    private var selfId: String = ""
    private var peerId: String = ""
    private var ice: IceConfig.Result = IceConfig.Result(emptyList(), "")
    private var pumpJob: Job? = null
    /** The CURRENT pump's stream lease. Session thread only; the lease object
     *  itself is what crosses threads, under its own lock. */
    private var pumpLease: PumpLease? = null
    private var receivedBytes = 0L
    private var pendingExports = 0
    private var lastTextActivity = 0L

    private var helloTimer: ScheduledFuture<*>? = null
    private var settleTimer: ScheduledFuture<*>? = null
    private var requestRetryTimer: ScheduledFuture<*>? = null
    private var requestDeadlineTimer: ScheduledFuture<*>? = null
    private var textEndTimer: ScheduledFuture<*>? = null
    private var abortBarrierTimer: ScheduledFuture<*>? = null
    private var textIdleTimer: ScheduledFuture<*>? = null
    private var pendingTimer: ScheduledFuture<*>? = null
    private var reconnectTimer: ScheduledFuture<*>? = null
    /** The bounded wait for a legacy peer's offer, for a JOINER — which never
     *  offers, on any wire. */
    private var legacyOfferTimer: ScheduledFuture<*>? = null

    // ── joining ─────────────────────────────────────────────────────────────

    /**
     * Join a pairing code as [intent].
     *
     * KEPT as the pairing room's own entry point rather than folded into the
     * general one: the intent is not a property of a code, it is a property of
     * how this device came to hold one, and spelling that out at the call site
     * is what has kept a minter from ever behaving like a joiner.
     */
    fun join(code: PairCode, intent: Intent) = join(ConnectionSource.Pairing(code, intent))

    /**
     * Join whatever rendezvous [source] names, and leave whatever this device
     * was in before.
     *
     * The source decides three things and nothing else decides them: which
     * rendezvous is opened, whether the backend may be contacted at all, and
     * whether a peer may be taken without a person choosing it. Everything
     * downstream — the capability registry, the role rule, the handshake, both
     * lanes — is identical across all three.
     */
    fun join(source: ConnectionSource) = post {
        closeOnSession()
        epoch++
        roomGen++
        this.source = source
        this.intent = (source as? ConnectionSource.Pairing)?.intent ?: Intent.JOINER
        val mine = epoch
        val room = roomGen
        val explicit = source.admission == PeerAdmission.EXPLICIT
        // A fresh link, but not a fresh disk: an unacknowledged leftover
        // warning survives the reset because the leftover itself does.
        _state.value = State(
            phase = Phase.CONNECTING,
            linkId = mine,
            cleanupIncomplete = _state.value.cleanupIncomplete,
            nearby = if (explicit) {
                Nearby(
                    active = true,
                    direct = !source.usesBackend,
                    room = NearbyRoom.CONNECTING,
                    roomId = room,
                )
            } else {
                Nearby()
            },
        )
        openRoom(room, source)
    }

    /**
     * Acquire whatever the rendezvous needs, then open it.
     *
     * The ICE fetch is SKIPPED — not merely defaulted to empty — for a source
     * that may not use the backend. That is the whole content of the direct
     * path's privacy claim at this layer: an empty list is what two devices on
     * one link need (host candidates reach each other), and asking a server for
     * relay credentials would be a request this path promises never to make.
     * The composition layer refuses such a source a second time, because one
     * fence a later edit can move is not a promise.
     */
    private fun openRoom(room: Int, source: ConnectionSource) {
        if (!source.usesBackend) {
            ice = IceConfig.Result(emptyList(), "")
            openSignaling(room, source)
            return
        }
        scope.launch(sessionDispatcher) {
            // Bounded and cancellable, with the room check that stops an old
            // join's completion opening a room the user already left.
            val fetched = deps.fetchIce(source)
            if (roomGen != room) return@launch
            ice = fetched
            openSignaling(room, source)
        }
    }

    private fun openSignaling(room: Int, source: ConnectionSource) {
        val client = deps.signals.create(
            source,
            object : SignalingClient.Events {
                override fun onSelfId(id: String, ip: String) = postRoom(room) { onWelcome(id) }
                override fun onPeers(peers: List<Envelope.Peer>) = postRoom(room) { onRoster(peers) }
                override fun onPeerLeft(peerId: String) = postRoom(room) {
                    // The rendezvous saying a PHYSICAL connection closed. It
                    // retires whatever is bound to that id and nothing else: a
                    // Nearby room keeps listing every other device.
                    if (peerId == this@TransferController.peerId && peerId.isNotEmpty()) {
                        endSession("error_connection_lost")
                    }
                    if (peerId == pendingPeer) clearPendingAdmission()
                    if (admission == PeerAdmission.EXPLICIT) publishNearby()
                }
                override fun onSignal(from: String, data: Json) = postRoom(room) {
                    onSignalFrame(from, data)
                }
                override fun onClosed(code: Int, reason: String) = postRoom(room) {
                    onRoomClosed(code)
                }
                override fun onFailure(error: Throwable) = postRoom(room) { onRoomFailed() }
            },
        )
        signaling = client
        client.connect()
    }

    private fun onWelcome(id: String) {
        if (id.isEmpty()) {
            if (admission == PeerAdmission.EXPLICIT) failRoom("error_nearby_unavailable")
            else endSession("error_network")
            return
        }
        // The registry and every signed leave payload bind to the REAL room id.
        selfId = id
        linkSession = LinkSession(id)
        // A join is what proves a retry worked; anything short of it and the
        // next drop must not start from zero again.
        reconnectAttempt = 0
        if (admission == PeerAdmission.EXPLICIT) {
            _state.value = _state.value.copy(
                nearby = _state.value.nearby.copy(room = NearbyRoom.JOINED),
            )
            publishNearby()
        }
    }

    private fun onRoster(peers: List<Envelope.Peer>) {
        val registry = linkSession ?: return
        val others = peers.map { it.id }.filter { it != selfId }
        registry.retainPeers(others)
        for (id in registry.rosterChanged(others)) {
            signaling?.sendSignal(id, registry.capsSignal())
        }
        armHelloRetry(roomGen)
        roster = peers

        if (admission == PeerAdmission.EXPLICIT) {
            // The ONE fork, and it is a subtraction: the roster is published and
            // NOTHING is established. A room that lists devices the user did not
            // ask about — the code-less room lists everything behind one public
            // address, the local link lists everything advertising on it — has no
            // "the other peer" to take.
            val present = others.toSet()
            if (pendingPeer != null && pendingPeer !in present) clearPendingAdmission()
            publishNearby()
            return
        }

        if (others.isEmpty() && transport == null) {
            _state.value = _state.value.copy(phase = Phase.WAITING_PEER)
        }
        others.firstOrNull()?.let { peer ->
            armSettle(epoch, peer)
            maybeEstablish(epoch, peer)
        }
    }

    /**
     * Recompute the list the user picks from, and the phase that describes it.
     *
     * Reads the SAME capability registry the admission rules read, so a row can
     * never claim a wire the routing predicate would then refuse. Called after
     * a roster frame AND after a capability hello, because a hello changes what
     * a listed device is shown as able to do — but never adds one: a peer no
     * roster has delivered is simply not listed until one does.
     */
    private fun publishNearby() {
        if (admission != PeerAdmission.EXPLICIT) return
        val registry = linkSession
        val devices = nearbyDevices(
            roster = roster,
            selfId = selfId,
            supportsLink = { registry?.peerSupportsLink(it) == true },
            announcesText = { registry?.peerSupportsText(it) == true },
        )
        val current = _state.value
        val listed = devices.mapTo(HashSet()) { it.id }
        _state.value = current.copy(
            // Browsing is WAITING_PEER: a room with no connection in it. A live
            // connection owns the phase, and a terminal one is not repainted.
            phase = if (transport == null && current.phase != Phase.ENDED) {
                Phase.WAITING_PEER
            } else {
                current.phase
            },
            nearby = current.nearby.copy(
                roomId = roomGen,
                devices = devices,
                // A device that left must not leave a selection pointing at
                // nothing: the next action would dial an id the room no longer
                // contains, and that id could by then belong to another device.
                // The selection is KEPT while a connection to it is live, because
                // then it is the peer of a session rather than a row in a list.
                selectedId = current.nearby.selectedId
                    ?.takeIf { it in listed || (transport != null && it == peerId) },
                incomingId = pendingPeer,
                incomingPromptId = pendingPromptId,
            ),
        )
    }


    /** Three hello attempts spaced 1.5 s, the first on roster gain. The peer
     *  does not retry on this side's behalf.
     *
     *  Fenced by the ROOM, not by the connection: greeting the devices in a
     *  room is what makes them selectable at all, and a Nearby session that
     *  finished one transfer must keep announcing to everything else in the
     *  room rather than going quiet. */
    private fun armHelloRetry(room: Int) {
        if (helloTimer != null) return
        helloTimer = session.scheduleWithFixedDelay(
            {
                if (roomGen != room) { helloTimer?.cancel(false); helloTimer = null; return@scheduleWithFixedDelay }
                val registry = linkSession ?: return@scheduleWithFixedDelay
                val due = registry.helloRetryTick()
                for (id in due) signaling?.sendSignal(id, registry.capsSignal())
                if (due.isEmpty()) { helloTimer?.cancel(false); helloTimer = null }
            },
            deps.timeouts.helloRetryMs, deps.timeouts.helloRetryMs, TimeUnit.MILLISECONDS,
        )
    }

    /**
     * The capability window closing.
     *
     * A peer past it that never announced `link/1` and never proved it with an
     * offer is not unreachable — it is a peer on the SHIPPED older wire, and
     * that is where this hands over. The fixture's `capability.promotion` is
     * the rule: `link/1` and `text/1` each resolve immediately (they are
     * positive statements), and everything else — an empty announcement,
     * `link/2`, `LINK/1`, `text/2`, or silence — resolves only HERE, because
     * until the window closes "nothing yet" and "nothing at all" are the same
     * observation.
     */
    private fun armSettle(mine: Int, peer: String) {
        if (settleTimer != null) return
        settleTimer = session.schedule(
            {
                if (epoch != mine) return@schedule
                val registry = linkSession ?: return@schedule
                if (transport == null && !registry.peerSupportsLink(peer)) {
                    establishLegacy(mine, peer)
                }
            },
            deps.timeouts.settleMs, TimeUnit.MILLISECONDS,
        )
    }

    /**
     * Hand this peer over to the shipped older wire.
     *
     * The two intents take genuinely different paths, and that asymmetry is
     * the protocol rather than a shortcut:
     *
     *  - a MINTER is the initiator, so it picks the generation from what the
     *    peer announced ([LegacyLane.mode]) and offers. There is no negotiation
     *    round for this: the offer's own tag IS the choice, and a wrong one
     *    reaches a truthful terminal state rather than a hang, because the peer
     *    filters every inbound signal by generation and simply never answers.
     *  - a JOINER is the responder and must NOT offer. It waits, and the
     *    generation of the offer that arrives is authoritative — including when
     *    that differs from what this side would have guessed.
     *
     * Nothing here arms a batch, so [LegacyLane.mode] is always asked with
     * `hasArmedBatch = false`: this client's cross-network create stages
     * nothing before connecting, and claiming otherwise would silently force
     * every connection onto the file generation.
     */
    private fun establishLegacy(mine: Int, peer: String) {
        if (transport != null || selfId.isEmpty()) return
        val registry = linkSession ?: return
        peerId = peer
        if (intent == Intent.JOINER) {
            armLegacyOffer(mine)
            return
        }
        val lane = LegacyLane.mode(
            peerAnnouncesText = registry.peerSupportsText(peer),
            hasArmedBatch = false,
        )
        startTransport(mine, peer, WireProfile.Legacy(LinkProtocol.Role.INITIATOR, lane))
    }

    /**
     * A joiner's bounded wait for the offer only the minter can send.
     *
     * There is no `linkRequest` on this wire to prod the peer with, so the
     * only honest thing to do is wait and then say so. Silence here means the
     * two devices disagree about who created the code — the one case the
     * intent cannot resolve alone — and a truthful message beats a session
     * that stays "connecting" forever.
     */
    private fun armLegacyOffer(mine: Int) {
        if (legacyOfferTimer != null) return
        _state.value = _state.value.copy(phase = Phase.CONNECTING)
        legacyOfferTimer = session.schedule(
            {
                legacyOfferTimer = null
                if (epoch != mine || transport != null) return@schedule
                endSession("error_legacy_no_offer")
            },
            deps.timeouts.requestDeadlineMs, TimeUnit.MILLISECONDS,
        )
    }

    private fun maybeEstablish(mine: Int, peer: String) {
        if (transport != null || selfId.isEmpty()) return
        val registry = linkSession ?: return
        if (!registry.peerSupportsLink(peer)) {
            // An announcement that positively names the older message wire is
            // an answer, not an absence: it resolves now rather than at the
            // settle edge. Anything else waits — see [armSettle].
            if (registry.peerSupportsText(peer)) establishLegacy(mine, peer)
            return
        }
        peerId = peer
        if (LinkProtocol.linkRole(selfId, peer) == LinkProtocol.Role.INITIATOR) {
            startTransport(mine, peer, WireProfile.Link(LinkProtocol.Role.INITIATOR))
        } else {
            signaling?.sendSignal(peer, Signal.linkRequest().toJson())
            _state.value = _state.value.copy(phase = Phase.CONNECTING)
            if (requestRetryTimer == null) {
                requestRetryTimer = session.scheduleWithFixedDelay(
                    {
                        if (epoch != mine || transport != null) {
                            requestRetryTimer?.cancel(false); requestRetryTimer = null
                            return@scheduleWithFixedDelay
                        }
                        signaling?.sendSignal(peer, Signal.linkRequest().toJson())
                    },
                    deps.timeouts.requestRetryMs, deps.timeouts.requestRetryMs, TimeUnit.MILLISECONDS,
                )
                requestDeadlineTimer = session.schedule(
                    {
                        if (epoch != mine || transport != null) return@schedule
                        endSession("error_connection_lost")
                    },
                    deps.timeouts.requestDeadlineMs, TimeUnit.MILLISECONDS,
                )
            }
        }
    }

    private fun onSignalFrame(from: String, data: Json) {
        val registry = linkSession ?: return
        val mine = epoch

        // Caps may ride ANY frame — a bare hello, but also every conforming
        // offer and answer. Record them and keep routing; return early only for
        // a capability-only hello.
        val wasHello = registry.recordPeerCaps(from, data)
        if (wasHello) {
            registry.didHearFrom(from)
            // What a listed device is shown as able to do just changed.
            if (admission == PeerAdmission.EXPLICIT) publishNearby()
        }
        val signal = Signal.fromJson(data)
        val capabilityOnly = wasHello && signal != null &&
            signal.sdpType == null && signal.candidate == null && signal.revealKey == null &&
            signal.commit == null && !signal.busy && !signal.leave && !signal.linkRequest
        if (capabilityOnly) {
            // An announcement is an announcement. Under explicit admission it
            // updates the row and stops there; it is not an ask, and treating it
            // as one would let anything on the link start a connection.
            if (admission == PeerAdmission.AUTOMATIC) maybeEstablish(mine, from)
            return
        }
        if (signal == null) return

        when (signal.generation) {
            Signal.Generation.LINK -> Unit
            // A rebuild offer for a link this stage does not rebuild: refused in
            // silence — answering would tell a relay which peer holds a link.
            Signal.Generation.RESUME -> return
            // The two shipped generations. Never mixed into the link path: they
            // are a different connection with a different channel and a
            // different control set.
            Signal.Generation.TEXT, Signal.Generation.FILE -> {
                onLegacySignal(mine, from, data, signal)
                return
            }
        }

        // The leave budget belongs to the CURRENT peer's authenticated link. An
        // unrelated sender must not be able to spend one HMAC of it, so the
        // peer check comes BEFORE the shape/budget path.
        if (signal.leave) {
            if (from != peerId) return
            keys?.let { k ->
                if (registry.acceptLeave(from, data, k)) endSession(null)
            }
            return
        }

        if (transport == null) {
            // Nothing establishes without a person — except the peer a person
            // already chose. See [isAwaitedSelection].
            if (admission == PeerAdmission.EXPLICIT && !isAwaitedSelection(from)) {
                offerAdmission(
                    from = from,
                    data = data,
                    asks = signal.isLinkOffer || signal.isLinkRequest,
                    generation = Signal.Generation.LINK,
                    lane = null,
                    // An offer composes a `link` frame, which nothing else can
                    // do, so it stands in for a hello that never arrived. A
                    // REQUEST does not: the proof exception is offer-only,
                    // exactly as it is in the automatic room.
                    provesLink = signal.isLinkOffer,
                )
                return
            }
            when {
                // An OFFER from a peer that announced nothing is itself the
                // announcement (and never overrules an incompatible snapshot).
                // A link REQUEST is NOT: the accepted proof exception is
                // offer-only, so a request from a peer that has not announced
                // `link/1` waits for its hello — or for the settle window.
                signal.isLinkOffer -> {
                    registry.recordProvenLink(from)
                    if (!registry.peerSupportsLink(from)) return
                    peerId = from
                    startTransport(mine, from, WireProfile.Link(LinkProtocol.linkRole(selfId, from)))
                }
                signal.isLinkRequest &&
                    LinkProtocol.linkRole(selfId, from) == LinkProtocol.Role.INITIATOR &&
                    registry.peerSupportsLink(from) -> {
                    peerId = from
                    startTransport(mine, from, WireProfile.Link(LinkProtocol.Role.INITIATOR))
                }
                else -> return
            }
        }
        if (from != peerId) {
            signaling?.sendSignal(from, Signal.busy().toJson())
            return
        }
        // The established connection may not be a link at all. A `link`
        // generation frame reaching a legacy handshake could close it (`busy`),
        // fail it (`commit`) or feed it a reveal for a commitment it never
        // made, so routing stops here as well as at the transport boundary —
        // the two checks answer to different callers and neither is the other's
        // backstop.
        val profile = wireProfile as? WireProfile.Link ?: return
        // A second OFFER reaching the side that already offered.
        //
        // On a pairing code this cannot happen from a conforming peer and the
        // transport's own commitment rule answers it. In a Nearby room it CAN,
        // benignly: the peer this device just finished with may still have an
        // establishment frame in flight when a fresh one to the same device
        // begins, and feeding a stale offer to a new handshake fails it as a
        // replaced commitment. The role rule is the single tiebreak everywhere
        // else in this protocol; here it says the same thing — the initiator
        // offered, so an inbound offer is not this connection's.
        if (profile.role == LinkProtocol.Role.INITIATOR && signal.isLinkOffer) return
        transport?.onSignal(data)
    }

    /**
     * One signal on a shipped legacy generation.
     *
     * Three rules, in this order, and each of them is a way this could go
     * wrong:
     *
     *  - an ESTABLISHED session takes only its own peer's signals, and only on
     *    the generation it was built for. That is exactly what
     *    `RealtimeConnection`'s own handler filter does, and without it a stray
     *    untagged `busy` could tear down a live message connection.
     *  - a peer that announced `link/1` is being established as one. A legacy
     *    offer must never silently replace a running or proven link with an
     *    older wire.
     *  - only a JOINER adopts an offer. A minter is the initiator; answering an
     *    inbound offer as well would be two offers into one connection, which
     *    is precisely what the explicit intent exists to prevent.
     */
    private fun onLegacySignal(mine: Int, from: String, data: Json, signal: Signal) {
        val registry = linkSession ?: return
        val profile = wireProfile
        if (transport != null) {
            if (from != peerId) return
            val legacy = profile as? WireProfile.Legacy ?: return
            val expected = if (legacy.lane == LegacyProtocol.Lane.TEXT) {
                Signal.Generation.TEXT
            } else {
                Signal.Generation.FILE
            }
            if (signal.generation != expected) return
            transport?.onSignal(data)
            return
        }
        // A legacy offer must never silently replace a running or proven link
        // with an older wire.
        if (registry.peerSupportsLink(from)) return
        val lane = LegacyProtocol.inboundOfferLane(signal)
        if (admission == PeerAdmission.EXPLICIT && !isAwaitedSelection(from)) {
            // The SAME gate the `link` generation goes through. Without this an
            // older peer's offer would establish with no consent and no roster
            // check at all, because a Nearby source has no minter to be — its
            // intent defaults to JOINER, which is exactly the value this path
            // used to read as permission to answer.
            offerAdmission(
                from = from,
                data = data,
                asks = lane != null,
                generation = signal.generation,
                lane = lane,
                provesLink = false,
            )
            return
        }
        if (intent != Intent.JOINER) return
        if (lane == null) return
        peerId = from
        startTransport(mine, from, WireProfile.Legacy(LinkProtocol.Role.RESPONDER, lane))
        transport?.onSignal(data)
    }

    // ── explicit admission (Nearby) ─────────────────────────────────────────

    /**
     * An inbound establishment frame in a room where nothing establishes
     * without a person. Every generation goes through here — `link/1` and both
     * shipped legacy wires — because a consent gate one wire can walk around is
     * not a consent gate.
     *
     * Only an ASK may raise a prompt, and the restriction is the point: an
     * offer, or the content-free link request, are the two ways a peer asks for
     * a connection. A candidate, a reveal, a stray commitment or a capability
     * piggyback is not an ask, and letting one raise a prompt would let anything
     * in the room — the code-less room contains every device behind one public
     * address — put a question in front of this user, or open a buffer in this
     * process, without ever asking for anything.
     *
     * The peer must also be one the ROSTER has delivered. A device the user
     * cannot see in their list must not be able to interrupt them.
     *
     * @param asks whether this frame is a request to connect at all.
     * @param generation which wire the ask is FOR. A prompt is about one wire,
     *   and later frames are buffered only when they belong to it — replaying a
     *   frame from another generation into the admitted transport is exactly
     *   what that transport's own filter exists to refuse.
     * @param lane the legacy lane an older peer offered, or null for `link/1`.
     *   Recorded with the prompt so the admitted profile is the one the user was
     *   actually asked about.
     * @param provesLink whether this frame is itself proof of `link/1`.
     */
    private fun offerAdmission(
        from: String,
        data: Json,
        asks: Boolean,
        generation: Signal.Generation,
        lane: LegacyProtocol.Lane?,
        provesLink: Boolean,
    ) {
        val registry = linkSession ?: return
        val pending = pendingPeer

        if (pending == null) {
            if (!asks) return
            if (provesLink) registry.recordProvenLink(from)
            // `link/1` needs the announcement; the legacy path has already
            // established that this peer does NOT speak it.
            if (lane == null && !registry.peerSupportsLink(from)) return
            if (roster.none { it.id == from }) return
            pendingPeer = from
            pendingGeneration = generation
            pendingLane = lane
            pendingSignals.clear()
            pendingPromptId++
            // An offer is KEPT, in order. Answering later means answering THIS
            // offer; discarding it would leave the admitted transport waiting
            // for an SDP the peer has already sent and will not repeat. A
            // content-free request carries nothing to replay.
            if (data.carriesOffer()) pendingSignals.add(data)
            armPendingAdmission(roomGen)
            publishNearby()
            return
        }

        if (from != pending) {
            // A THIRD device while a prompt is up. Refused in band with exactly
            // the `busy` an established session sends, so it reaches a truthful
            // terminal state instead of waiting out its own deadline — and the
            // prompt the user is reading is not replaced by whoever asked last.
            signaling?.sendSignal(from, Signal.busy().toJson())
            return
        }

        // Not this prompt's wire. Dropped rather than buffered: the user is
        // being asked about one connection, and a frame for another generation
        // is not part of it.
        if (generation != pendingGeneration) return

        if (pendingSignals.size >= LinkProtocol.HELD_SIGNAL_MAX) {
            // More than a whole establishment's worth of frames chasing a prompt
            // nobody has answered. The buffer is dropped WITH the admission
            // rather than grown; the peer is told, and may ask again.
            rejectPendingAdmission("error_connection_lost")
            return
        }
        pendingSignals.add(data)
    }

    /**
     * Whether [from] is the peer this device is CURRENTLY establishing to
     * because a person chose it.
     *
     * The exception exists because half of every explicit selection does not
     * look like one from the wire's side. `linkRole` gives the offer to the
     * smaller room id, and which id is smaller has nothing to do with who
     * pressed Connect: a device that picks a peer sorting below it sends a
     * content-free link REQUEST and waits to be offered. The offer that comes
     * back is the ANSWER to a question this device asked. Reading it as a fresh
     * ask put a second consent prompt in front of the user for the device they
     * had just tapped Connect on — nobody answers a question they did not
     * expect, and both sides then sat until their own deadlines. Observed on two
     * real emulators, where the chosen peer's id happened to sort above this
     * one; the run reached discovery, selection and admission and then made no
     * progress for thirty seconds.
     *
     * It is deliberately the NARROWEST statement of "already consented", and
     * every clause is load-bearing:
     *
     *  - EXPLICIT admission only; the automatic room never reaches here.
     *  - no transport yet, so it cannot adopt a frame into a live session.
     *  - [Intent.MINTER], which ONLY [connectToPeer] sets. A device that was
     *    admitted, or that is idle, is not awaiting anything.
     *  - the sender is [peerId] — the peer `maybeEstablish` committed to for
     *    this establishment — AND the selection the UI is currently publishing.
     *
     * So a third device, a device nobody selected, and the same device offering
     * again after its session ended are all still asks: `closeConnection` clears
     * `peerId` and the selection, so the consent does not outlive the connection
     * it was given for. Each of those is a test.
     */
    private fun isAwaitedSelection(from: String): Boolean =
        admission == PeerAdmission.EXPLICIT &&
            transport == null &&
            intent == Intent.MINTER &&
            from.isNotEmpty() &&
            from == peerId &&
            from == _state.value.nearby.selectedId

    /** Whether a raw signal payload carries an SDP at all — the thing worth
     *  replaying. Read off the parsed signal rather than the caller's opinion,
     *  so the buffer holds what it says it holds. */
    private fun Json.carriesOffer(): Boolean = Signal.fromJson(this)?.sdpType != null

    /** A prompt nobody answers must not stand forever: it would hide later asks
     *  (only one may be pending) and hold the peer's frames. Fenced by the room,
     *  because that is what the prompt belongs to. */
    private fun armPendingAdmission(room: Int) {
        pendingTimer?.cancel(false)
        pendingTimer = session.schedule(
            {
                pendingTimer = null
                if (roomGen != room || pendingPeer == null) return@schedule
                rejectPendingAdmission(null)
            },
            deps.timeouts.pendingAdmissionMs, TimeUnit.MILLISECONDS,
        )
    }

    /** Retire the prompt in silence. For the cases where the peer already knows:
     *  it left the roster, or this device is leaving the room. */
    private fun clearPendingAdmission() {
        pendingTimer?.cancel(false)
        pendingTimer = null
        pendingPeer = null
        pendingLane = null
        pendingGeneration = Signal.Generation.LINK
        pendingSignals.clear()
    }

    /** Retire the prompt and TELL the peer, with the same `busy` an established
     *  session sends. [errorKey] is what this side shows, and is null for an
     *  ordinary decline — refusing a device is not a fault. */
    private fun rejectPendingAdmission(errorKey: String?) {
        val peer = pendingPeer
        clearPendingAdmission()
        if (peer != null) signaling?.sendSignal(peer, Signal.busy().toJson())
        if (errorKey != null) _state.value = _state.value.copy(errorKey = errorKey)
        publishNearby()
    }

    /**
     * Open a NEW connection identity inside a room that stays.
     *
     * Every generation a connection owns is bumped here, so a late storage
     * completion, a retired pump's read, a cancelled batch's export or an old
     * transport's callback from the PREVIOUS peer drops itself on arrival —
     * exactly as it does when a whole session is replaced. The published
     * `linkId` moves with it, which is what stops a file picked while connected
     * to one device from being sent to the next.
     */
    private fun beginConnection(peer: String): Int {
        cancelConnectionTimers()
        epoch++
        batchGen++
        bumpReceiveGen()
        textBarrierGen++
        receivedBytes = 0
        pendingExports = 0
        val mine = epoch
        val current = _state.value
        _state.value = current.copy(
            phase = Phase.CONNECTING,
            linkId = mine,
            wire = null,
            sas = null,
            errorKey = null,
            incoming = emptyList(),
            outgoing = emptyList(),
            messages = emptyList(),
            promptId = promptCounter,
            awaitingFolder = false,
            receiveProgress = null,
            sendProgress = null,
            savedBatch = false,
            sentBatch = false,
            savedBatchCount = 0,
            sentBatchCount = 0,
            fileLaneDown = false,
            textState = TextLaneSession.State.IDLE,
            textCanRequest = false,
            nearby = current.nearby.copy(selectedId = peer, incomingId = null),
        )
        return mine
    }

    /**
     * The user picked a device.
     *
     * This is the ONLY thing that replaces `others.firstOrNull()` in an explicit
     * room, and it hands the chosen peer to exactly the establishment path a
     * pairing room uses — the settle window, the capability predicate, the role
     * rule, the legacy fallback. There is no second way to establish.
     *
     * It refuses while a connection is LIVE. Retiring a running transfer because
     * a row was tapped would destroy work the user never asked to lose; the
     * screen ends the current one first, which is an action they take on purpose.
     */
    fun connectToPeer(peerId: String, expectedRoom: Int) = post {
        // The ROOM the list was rendered against. Room ids are monotonic and
        // never reused, so a tap composed against a room that has since dropped
        // and reopened — where the very same local-link peer id may still be
        // advertising — cannot dial in the new one.
        if (expectedRoom != roomGen) return@post
        if (admission != PeerAdmission.EXPLICIT) return@post
        if (transport != null) return@post
        if (selfId.isEmpty() || peerId == selfId) return@post
        if (roster.none { it.id == peerId }) return@post
        // Tapping Connect on the very device that is asking is an ACCEPT: it is
        // the same decision, and answering the offer already in hand beats
        // throwing it away and asking the peer to start again.
        if (pendingPeer == peerId) {
            admitOnSession(peerId)
            return@post
        }
        // A prompt from someone ELSE is retired: leaving it standing would let a
        // later Accept connect to a device the user has moved on from.
        if (pendingPeer != null) rejectPendingAdmission(null)
        // MINTER, because this device is the one that dialled. On the shipped
        // legacy wire that is what decides who offers, and a Nearby room has no
        // pairing code to infer it from.
        intent = Intent.MINTER
        val mine = beginConnection(peerId)
        armSettle(mine, peerId)
        maybeEstablish(mine, peerId)
    }

    /**
     * The user accepted the prompt naming [peerId].
     *
     * [expectedPrompt] is the [Nearby.incomingPromptId] the screen was RENDERING
     * when the user tapped, and it is checked here, on the session executor,
     * because that is the only place a prompt withdrawn between the tap and this
     * turn can be seen. Peer id alone is not enough: a local-link peer keeps its
     * identity while it keeps advertising, so a stale tap naming the same device
     * would otherwise authorise an ask the user never read.
     */
    fun admitPeer(peerId: String, expectedPrompt: Int) = post {
        if (expectedPrompt != pendingPromptId) return@post
        admitOnSession(peerId)
    }

    private fun admitOnSession(peerId: String) {
        if (admission != PeerAdmission.EXPLICIT) return
        if (transport != null) return
        if (pendingPeer != peerId) return
        val registry = linkSession ?: return
        val lane = pendingLane
        // The wire the user was ASKED about, not one re-derived now: a peer that
        // announced `link/1` after raising a legacy prompt has not been consented
        // to for `link/1`, and the reverse would answer an older offer on a wire
        // the peer never sent one on.
        val profile = if (lane == null) {
            if (!registry.peerSupportsLink(peerId)) return
            WireProfile.Link(LinkProtocol.linkRole(selfId, peerId))
        } else {
            WireProfile.Legacy(LinkProtocol.Role.RESPONDER, lane)
        }
        val buffered = ArrayList(pendingSignals)
        clearPendingAdmission()
        // JOINER: the peer dialled, so on the older wire it is the side that
        // offers and this one must not.
        intent = Intent.JOINER
        val mine = beginConnection(peerId)
        this.peerId = peerId
        startTransport(mine, peerId, profile)
        // In arrival order, into a transport that exists: the offer that raised
        // the prompt, then whatever chased it.
        for (data in buffered) {
            if (epoch != mine) return
            transport?.onSignal(data)
        }
    }

    /** The user refused the prompt naming [peerId]. The room continues.
     *  [expectedPrompt] identifies the question being answered — see
     *  [admitPeer]. */
    fun rejectPeer(peerId: String, expectedPrompt: Int) = post {
        if (expectedPrompt != pendingPromptId) return@post
        if (pendingPeer != peerId) return@post
        rejectPendingAdmission(null)
    }

    /** Search again now, after a failure the user can see. Resets the backoff,
     *  because a person asking is new information. */
    fun retryNearby() = post {
        if (!_state.value.nearby.active) return@post
        if (transport != null) return@post
        reconnectAttempt = 0
        roomRetryPending = false
        scheduleRoomReconnect(immediate = true)
    }

    /**
     * Leave the room entirely: the lifecycle-off path.
     *
     * Distinct from [disconnect], which retires the CONNECTION and stays in the
     * room. This one stops advertising, stops browsing, closes every socket and
     * ends the session, which is what leaving the screen or backgrounding the
     * app must do — a device that keeps announcing itself while its owner
     * believes they closed the feature is the dishonest state this separation
     * exists to prevent.
     */
    fun stopNearby() = post {
        if (!_state.value.nearby.active) return@post
        // A live peer is told, with the same authenticated leave an ordinary
        // disconnect sends. Leaving the room without it would look to the peer
        // like this device dropped off the network.
        announceLeave()
        _state.value = _state.value.copy(
            phase = Phase.ENDED,
            receiveProgress = null,
            sendProgress = null,
            awaitingFolder = false,
            nearby = Nearby(),
        )
        closeOnSession()
    }

    // ── the room's own lifetime ─────────────────────────────────────────────

    private fun onRoomClosed(code: Int) {
        if (admission == PeerAdmission.EXPLICIT) {
            // A negative code is this build's own marker for a local transport
            // that could not run — it could not advertise, could not browse, or
            // neither half came up inside the arming window. An ordinary close
            // is a drop, which needs no error copy: "searching again" IS the
            // message.
            failRoom(if (code < 0) "error_nearby_unavailable" else null)
            return
        }
        if (transport == null) endSession("error_code_not_found")
    }

    private fun onRoomFailed() {
        if (admission == PeerAdmission.EXPLICIT) {
            failRoom("error_nearby_unavailable")
            return
        }
        if (transport == null) endSession("error_network")
    }

    /**
     * The room is gone; the CONNECTION may not be.
     *
     * A WebRTC link is peer-to-peer and keeps working when the thing that
     * introduced the two devices goes away, so a live transfer is left running
     * and its reconnect is DEFERRED. That is not a nicety: reopening would mint
     * a new room identity, and the registry bound to the live link holds the
     * leave budget and the id every signed leave payload is checked against.
     *
     * What does happen immediately is the honest part — the list is CLEARED.
     * Nothing is maintaining it, and a list left on screen is a claim that
     * those devices are still reachable.
     */
    private fun failRoom(errorKey: String?) {
        // Bumped first, so the close below cannot be read back as another drop.
        roomGen++
        helloTimer?.cancel(false)
        helloTimer = null
        clearPendingAdmission()
        runCatching { signaling?.close() }
        signaling = null
        roster = emptyList()
        _state.value = _state.value.copy(
            errorKey = errorKey ?: _state.value.errorKey,
            nearby = _state.value.nearby.copy(
                room = NearbyRoom.RECONNECTING,
                devices = emptyList(),
                incomingId = null,
            ),
        )
        if (transport != null) {
            roomRetryPending = true
            return
        }
        scheduleRoomReconnect(immediate = false)
    }

    /**
     * Bounded backoff, and it stops GROWING rather than stopping altogether.
     *
     * The common cause is a network this device will rejoin — sleep, a Wi-Fi
     * change, a link that has not come up yet — and a client that gives up
     * permanently is a client that is silently no longer discoverable while its
     * screen still says Nearby.
     */
    private fun scheduleRoomReconnect(immediate: Boolean) {
        val src = source ?: return
        if (!_state.value.nearby.active) return
        // Safe now: nothing is bound to the old room's identity.
        releaseRoomObjects()
        val step = ROOM_BACKOFF_STEPS[minOf(reconnectAttempt, ROOM_BACKOFF_STEPS.size - 1)]
        val delay = if (immediate) 0L else deps.timeouts.roomRetryMs * step
        reconnectAttempt++
        roomGen++
        val room = roomGen
        reconnectTimer?.cancel(false)
        reconnectTimer = session.schedule(
            {
                reconnectTimer = null
                if (roomGen != room || !_state.value.nearby.active) return@schedule
                _state.value = _state.value.copy(
                    nearby = _state.value.nearby.copy(
                        room = NearbyRoom.CONNECTING,
                        roomId = room,
                    ),
                )
                openRoom(room, src)
            },
            delay, TimeUnit.MILLISECONDS,
        )
    }

    private fun startTransport(mine: Int, peer: String, profile: WireProfile) {
        requestRetryTimer?.cancel(false); requestRetryTimer = null
        requestDeadlineTimer?.cancel(false); requestDeadlineTimer = null
        legacyOfferTimer?.cancel(false); legacyOfferTimer = null
        wireProfile = profile
        val link = deps.transports.create(
            profile, ice.servers, session,
            { signal -> signaling?.sendSignal(peer, signal.toJson()) },
            object : LinkTransport.Events {
                override fun onReady(keys: Crypto.SessionKeys, sas: String, maxFrameBytes: Int) {
                    if (epoch == mine) onLinkReady(keys, sas, maxFrameBytes)
                }
                override fun onFileFrame(frame: ByteArray) {
                    if (epoch == mine) fileLane?.let { apply(mine, it.onFrame(frame)) }
                }
                override fun onTextFrame(frame: ByteArray) {
                    if (epoch == mine) textLane?.let {
                        lastTextActivity = System.currentTimeMillis()
                        applyText(mine, it.onFrame(frame))
                    }
                }
                override fun onClosed(reason: String) {
                    if (epoch == mine) onTransportClosed(reason)
                }
            },
        )
        transport = link
        _state.value = _state.value.copy(phase = Phase.CONNECTING)
        link.start()
    }

    /**
     * Build EXACTLY the lanes this wire has.
     *
     * A legacy connection carries one generation, so the other lane is not a
     * degraded lane — it does not exist, and constructing one would give the UI
     * a state machine describing a channel no frame can ever reach. Every lane
     * that IS built attaches its receiver before anything can answer, which is
     * the ordering both lane machines refuse to send consent without.
     */
    private fun onLinkReady(sessionKeys: Crypto.SessionKeys, sas: String, frameBytes: Int) {
        keys = sessionKeys
        val profile = wireProfile
        val legacy = profile as? WireProfile.Legacy
        val wire = when {
            legacy == null -> Wire.LINK
            legacy.lane == LegacyProtocol.Lane.TEXT -> Wire.LEGACY_TEXT
            else -> Wire.LEGACY_FILES
        }
        val files = if (wire == Wire.LEGACY_TEXT) {
            null
        } else {
            // The ordered abort barrier and the BUSY byte are `link/1`
            // additions; on the older wire the control set is the three bytes
            // the fixture pins, and emitting a fourth would be a dialect.
            FileLaneSession(sessionKeys, frameBytes, barrier = wire == Wire.LINK)
        }
        val text: TextLane? = when (wire) {
            Wire.LINK -> TextLaneSession(sessionKeys, frameBytes)
            Wire.LEGACY_TEXT -> LegacyTextLane(sessionKeys, frameBytes, role = legacy!!.role)
            Wire.LEGACY_FILES -> null
        }
        files?.attachReceiver()
        text?.attachReceiver()
        fileLane = files
        textLane = text
        settleTimer?.cancel(false); settleTimer = null
        legacyOfferTimer?.cancel(false); legacyOfferTimer = null
        lastTextActivity = System.currentTimeMillis()
        armTextIdle(epoch)
        _state.value = _state.value.copy(
            phase = Phase.CONNECTED,
            wire = wire,
            sas = sas,
            errorKey = null,
            textState = text?.state ?: TextLaneSession.State.IDLE,
            textLimit = text?.plainLimit ?: com.relayium.protocol.TextWire.MAX_BYTES,
            textCanRequest = text?.canRequest ?: false,
        )
    }

    private fun onTransportClosed(reason: String) {
        val key = when (reason) {
            "local-leave", "local-close", "closed" -> null
            "peer-busy" -> "error_peer_busy"
            "commit-mismatch", "commit-replaced", "commit-missing", "no-sas" -> "error_handshake"
            "frame-ceiling-too-small" -> "error_peer_incompatible"
            else -> "error_connection_lost"
        }
        endSession(key)
    }

    // ── the file lane ───────────────────────────────────────────────────────

    private fun apply(mine: Int, actions: List<FileLaneSession.Action>) {
        val lane = fileLane ?: return
        for (action in actions) {
            // A failure in this same list may have RETIRED the session — on the
            // older wire a terminal lane closes the connection, and `epoch` is
            // bumped before any of that unwinds. Everything after it belongs to
            // a session that no longer exists, including the drain lease below.
            if (epoch != mine) return
            when (action) {
                is FileLaneSession.Action.Send -> {
                    if (transport?.sendFile(action.frame) != true) {
                        // The nonce is spent and the frame never entered the
                        // channel: the peer's sequence is stranded. The
                        // transport is dying or dead; end truthfully.
                        endSession("error_connection_lost")
                        return
                    }
                }
                is FileLaneSession.Action.Prompt -> {
                    promptCounter++
                    _state.value = _state.value.copy(
                        incoming = action.files,
                        promptId = promptCounter,
                        awaitingFolder = true,
                        savedBatch = false,
                    )
                }
                is FileLaneSession.Action.Write -> onWrite(mine, action)
                is FileLaneSession.Action.FileVerified -> onVerified(mine, action.fileIndex)
                is FileLaneSession.Action.FileCorrupt -> {
                    discardStorage()
                    _state.value = _state.value.copy(errorKey = "error_integrity", receiveProgress = null)
                }
                is FileLaneSession.Action.ReceiveComplete -> {
                    storage.execute { deps.store.finish() }
                    _state.value = _state.value.copy(
                        incoming = emptyList(),
                        receiveProgress = null,
                        savedBatch = true,
                        savedBatchCount = _state.value.savedBatchCount + 1,
                    )
                }
                is FileLaneSession.Action.SendComplete -> _state.value =
                    _state.value.copy(
                        sendProgress = null,
                        outgoing = emptyList(),
                        sentBatch = true,
                        sentBatchCount = _state.value.sentBatchCount + 1,
                    )
                is FileLaneSession.Action.DiscardIncoming -> {
                    // The lane says the incoming batch is RETIRED — whatever
                    // phase it was in, INCLUDING a prompt still waiting for the
                    // folder answer or a begin still resolving on the storage
                    // thread. Retiring the generation first makes that pending
                    // begin inert at its post-back, and the prompt flag falls
                    // with the batch it advertised: a cancel at the prompt used
                    // to leave `awaitingFolder=true` standing over an EMPTY
                    // list, and the next observer then consumed the stale
                    // prompt — old promptId, no files — before the real next
                    // offer arrived (R22, reproduced against this controller).
                    // The public rejectIncoming also clears these; this is the
                    // action every retiring path funnels through, so the
                    // clearing lives here, not per caller.
                    bumpReceiveGen()
                    discardStorage()
                    receivedBytes = 0
                    _state.value = _state.value.copy(
                        incoming = emptyList(),
                        receiveProgress = null,
                        awaitingFolder = false,
                    )
                }
                is FileLaneSession.Action.Fail -> onLaneFailure(mine, action.failure)
            }
        }
        if (epoch != mine) return
        // The drain's ABSOLUTE lease: armed once on entering DRAINING, never
        // re-armed by traffic — an eternally-trickling sender must not hold the
        // lane forever — and retired the moment the barrier lands.
        if (lane.receiveState == FileLaneSession.ReceiveState.DRAINING) {
            if (abortBarrierTimer == null) {
                abortBarrierTimer = session.schedule(
                    {
                        abortBarrierTimer = null
                        if (epoch != mine) return@schedule
                        fileLane?.let { apply(mine, it.abortBarrierTimedOut()) }
                    },
                    deps.timeouts.abortBarrierMs, TimeUnit.MILLISECONDS,
                )
            }
        } else {
            abortBarrierTimer?.cancel(false)
            abortBarrierTimer = null
        }
    }

    /** Storage effects are posted, generation-fenced at BOTH enqueue and
     *  completion, and BOUNDED — a slow provider stalls only the storage thread,
     *  and a peer outrunning the disk fails the receive lane rather than growing
     *  an unbounded plaintext queue. */
    private fun onWrite(mine: Int, action: FileLaneSession.Action.Write) {
        val lane = fileLane ?: return
        // A conforming sender cannot outrun a durability-gated ACK by more than
        // the flow window; past twice it plus a task ceiling, the peer is
        // ignoring the contract and the only safe answer is a truthful cancel.
        if (queuedStorageBytes + action.plaintext.size > STORAGE_QUEUE_MAX_BYTES ||
            queuedStorageTasks >= STORAGE_QUEUE_MAX_TASKS
        ) {
            _state.value = _state.value.copy(errorKey = "error_save_failed", receiveProgress = null)
            apply(mine, lane.cancelIncoming())
            return
        }
        val gen = receiveGen
        queuedStorageBytes += action.plaintext.size
        queuedStorageTasks++
        submitStorage(gen) {
            val outcome = deps.store.write(action.fileIndex, action.plaintext)
            post(mine) {
                // A stale completion is not decremented: bumpReceiveGen already
                // zeroed the retired batch's accounting, so subtracting here too
                // would drive the gauge negative.
                if (gen != receiveGen) return@post
                queuedStorageBytes -= action.plaintext.size
                queuedStorageTasks--
                val current = fileLane ?: return@post
                when (outcome) {
                    is ReceiveStore.Outcome.Ok -> {
                        receivedBytes += action.plaintext.size
                        apply(mine, current.onDurableBytes(receivedBytes))
                        val meta = current.incomingFiles.getOrNull(action.fileIndex)
                        if (meta != null) {
                            _state.value = _state.value.copy(
                                receiveProgress = Progress(
                                    meta.name, action.offset + action.plaintext.size, meta.size,
                                ),
                            )
                        }
                    }
                    is ReceiveStore.Outcome.Failed -> {
                        _state.value = _state.value.copy(errorKey = "error_save_failed", receiveProgress = null)
                        apply(mine, current.cancelIncoming())
                    }
                }
            }
        }
    }

    private fun onVerified(mine: Int, index: Int) {
        val gen = receiveGen
        pendingExports++
        submitStorage(gen) {
            val outcome = deps.store.export(index)
            post(mine) {
                if (gen != receiveGen) return@post
                pendingExports--
                val lane = fileLane ?: return@post
                when (outcome) {
                    is ReceiveStore.Outcome.Ok ->
                        if (pendingExports == 0 &&
                            lane.receiveState == FileLaneSession.ReceiveState.VERIFYING
                        ) {
                            // COMPLETE only after EVERY export closed cleanly.
                            apply(mine, lane.onBatchExported())
                        }
                    is ReceiveStore.Outcome.Failed -> {
                        _state.value = _state.value.copy(
                            errorKey = when (outcome.reason) {
                                ReceiveStore.Outcome.Reason.NO_SPACE -> "error_no_space"
                                ReceiveStore.Outcome.Reason.UNSAFE_PATH -> "error_unsafe_path"
                                else -> "error_save_failed"
                            },
                            receiveProgress = null,
                        )
                        apply(mine, lane.cancelIncoming())
                    }
                }
            }
        }
    }

    /**
     * Roll back the incoming batch's exported documents.
     *
     * Discard is a cleanup effect, so it is NOT token-gated — it must run even
     * as the batch it retires is being torn down. Its leftover warning is
     * surfaced through [surfaceCleanupWarning], deliberately UNFENCED.
     */
    private fun discardStorage() {
        runCatching {
            storage.execute {
                deps.store.discard()
                surfaceCleanupWarning()
            }
        }
    }

    /**
     * Storage-thread side: surface the store's latched leftover warning.
     *
     * The flag is SESSION-LEVEL and the post is fenced by NOTHING — not epoch,
     * not receive generation. A leftover partial document is real whichever
     * batch or link is current; cancellation bumps `receiveGen` before the
     * discard completes and teardown bumps `epoch` before its queued cleanup
     * runs, so ANY fence here would silently erase exactly this warning. It
     * lands in its own state field, not `errorKey`, so it cannot clobber — or
     * be clobbered by — a later batch's error, and it stays visible until the
     * user acknowledges it ([dismissCleanupWarning]).
     */
    private fun surfaceCleanupWarning() {
        if (deps.store.consumeCleanupWarning()) {
            post { _state.value = _state.value.copy(cleanupIncomplete = true) }
        }
    }

    /** The user has seen the leftover warning. Acknowledgment only: the store's
     *  ledger for those documents is gone and generic SAF has no safe way to
     *  re-derive them, so no "retry" that would fake an Ok is offered. */
    fun dismissCleanupWarning() = post {
        _state.value = _state.value.copy(cleanupIncomplete = false)
    }

    private fun onLaneFailure(mine: Int, failure: FileLaneSession.Failure) {
        val key = when (failure.reason) {
            FileLaneSession.Failure.Reason.LEGACY_PEER -> "error_peer_incompatible"
            FileLaneSession.Failure.Reason.INTEGRITY -> "error_integrity"
            FileLaneSession.Failure.Reason.PEER_BUSY -> "error_peer_busy"
            FileLaneSession.Failure.Reason.LOCAL_CANCEL,
            FileLaneSession.Failure.Reason.PEER_REJECTED,
            -> null
            else -> "error_transfer_failed"
        }
        when (failure.scope) {
            FileLaneSession.Failure.Scope.SEND -> {
                // Peer rejection, peer cancel and local send failure all land
                // here; the pump's stream is surrendered like any other stop.
                retirePump()
                batchGen++
                _state.value = _state.value.copy(
                    errorKey = key ?: _state.value.errorKey,
                    sendProgress = null,
                    outgoing = emptyList(),
                )
            }
            FileLaneSession.Failure.Scope.RECEIVE -> {
                bumpReceiveGen()
                _state.value = _state.value.copy(
                    errorKey = key ?: _state.value.errorKey,
                    receiveProgress = null,
                )
            }
            FileLaneSession.Failure.Scope.LANE -> {
                // The FILE lane is terminal on this link; its codecs cannot be
                // replaced without nonce reuse. The TEXT lane's codecs are
                // independent and still valid, so the conversation stays usable
                // and the UI shows a truthful "files unavailable — start a new
                // session" state instead of tearing the whole link down.
                retirePump()
                batchGen++
                bumpReceiveGen()
                discardStorage()
                _state.value = _state.value.copy(
                    errorKey = key,
                    fileLaneDown = true,
                    receiveProgress = null,
                    sendProgress = null,
                    outgoing = emptyList(),
                    incoming = emptyList(),
                    awaitingFolder = false,
                )
            }
        }
        // AFTER the scope's own effects and its publication, and for EVERY
        // failure rather than only the two the user presses.
        //
        // The failures that actually strand a peer mostly do not come from a
        // cancel button at all: a storage queue overflow, a failed write, a
        // failed export, a source that could not be opened or read, a file
        // that changed size under the pick, and every protocol failure each
        // retire a batch through this one path. On `link/1` that is correct and
        // complete — the ordered barrier tells the peer, and the other lane
        // survives. On the older wire there is no barrier and no other lane, so
        // the peer would go on streaming into a receiver that stopped, or go on
        // waiting for a sender that did.
        //
        // The two exceptions are the failures the PEER signalled in band and
        // completed: it declined the batch, or it said it was busy. Both sides
        // then agree the batch is over with nothing in flight, and the
        // connection is still usable — which is why an ordinary decline must
        // not read as a fault. (A decline at this side's own prompt does not
        // reach here at all: `rejectIncoming` emits the byte and no failure.)
        if (isLegacy &&
            failure.reason != FileLaneSession.Failure.Reason.PEER_REJECTED &&
            failure.reason != FileLaneSession.Failure.Reason.PEER_BUSY
        ) {
            endSession(null)
        }
    }

    // ── UI entry points (post to the session thread) ────────────────────────

    /** The folder-picker answer for prompt [promptId]. A stale answer — the
     *  prompt was replaced while the picker was open — is ignored. */
    fun acceptIncoming(promptId: Int, tree: ProviderOps.Node?) = post {
        val lane = fileLane ?: return@post
        if (promptId != promptCounter || !_state.value.awaitingFolder) return@post
        val mine = epoch
        if (tree == null) {
            bumpReceiveGen()
            _state.value = _state.value.copy(awaitingFolder = false, errorKey = "error_save_failed")
            apply(mine, lane.rejectIncoming())
            return@post
        }
        bumpReceiveGen()
        val gen = receiveGen
        receivedBytes = 0
        pendingExports = 0
        val files = lane.incomingFiles
        submitStorage(gen) {
            val outcome = deps.store.begin(files, deps.providerOps, tree)
            // begin's defensive re-discard may have latched a leftover warning
            // from a PREVIOUS batch; surface it regardless of this one's fate.
            surfaceCleanupWarning()
            post(mine) {
                if (gen != receiveGen) return@post
                val current = fileLane ?: return@post
                // The batch may have been rejected or cancelled while begin ran
                // on the storage thread; a late success must not ACCEPT one that
                // is no longer at the prompt. (The generation guard above catches
                // the reject/cancel that bumps it; this catches any other exit.)
                if (current.receiveState != FileLaneSession.ReceiveState.PROMPT) return@post
                when (outcome) {
                    is ReceiveStore.Outcome.Ok -> {
                        _state.value = _state.value.copy(awaitingFolder = false, errorKey = null)
                        apply(mine, current.acceptIncoming())
                    }
                    is ReceiveStore.Outcome.Failed -> {
                        _state.value = _state.value.copy(
                            awaitingFolder = false,
                            errorKey = when (outcome.reason) {
                                ReceiveStore.Outcome.Reason.NO_SPACE -> "error_no_space"
                                ReceiveStore.Outcome.Reason.UNSAFE_PATH -> "error_unsafe_path"
                                else -> "error_save_failed"
                            },
                        )
                        apply(mine, current.rejectIncoming())
                    }
                }
            }
        }
    }

    fun rejectIncoming() = post {
        val lane = fileLane ?: return@post
        // Retire the generation so a folder-picker begin still resolving on the
        // storage thread drops itself instead of ACCEPTing a rejected batch.
        bumpReceiveGen()
        _state.value = _state.value.copy(awaitingFolder = false)
        apply(epoch, lane.rejectIncoming())
    }

    /** Cancel the INCOMING batch. Direction-specific: the outgoing stream, the
     *  text lane and the link all survive. */
    /**
     * Cancel the INCOMING batch.
     *
     * On `link/1` this is direction-specific: the outgoing stream, the text
     * lane and the link all survive, because the sender answers the REJECT
     * with an ordered barrier.
     *
     * On the older wire it is a DISCONNECT, and truthfully so. The shipped
     * sender reads `rejected` only before it starts streaming
     * (`RealtimeConnection.waitForAccept`); once it is streaming, a REJECT
     * changes nothing it does. Leaving the connection open would leave the user
     * looking at a cancelled transfer that keeps arriving.
     */
    fun cancelReceive() = post {
        val lane = fileLane ?: return@post
        // The disconnect on the older wire is NOT performed here: the lane's
        // own LOCAL_CANCEL failure carries it, through the one retirement point
        // in [onLaneFailure], so a cancel and a failed write end the connection
        // by the same route. A decline at the prompt emits the byte without a
        // failure and stays non-terminal.
        apply(epoch, lane.cancelIncoming())
    }

    /**
     * Start an outgoing batch.
     *
     * [expectedLink] is the [State.linkId] the caller captured when it LAUNCHED
     * the picker whose result these sources are. The comparison happens HERE,
     * on the session executor, immediately before the first lane mutation — a
     * check anywhere earlier (a ViewModel thread, an IO metadata query) leaves
     * a window in which a new join connects to a DIFFERENT peer and inherits
     * the old pick. Null skips the fence for callers with no picker round-trip.
     */
    fun sendFiles(sources: List<OutgoingSource>, expectedLink: Int? = null) = post {
        if (expectedLink != null && expectedLink != epoch) return@post
        val lane = fileLane ?: return@post
        if (sources.isEmpty() || _state.value.fileLaneDown) return@post
        val mine = epoch
        retirePump()
        batchGen++
        val myBatch = batchGen
        _state.value = _state.value.copy(
            outgoing = sources.map { it.meta },
            errorKey = null,
            sentBatch = false,
        )
        apply(mine, lane.startBatch(sources.map { it.meta }))
        startPump(mine, myBatch, lane, sources)
    }

    /**
     * The user's own cancel of an outgoing batch.
     *
     * The batch is OVER when this returns to the session thread: the pump is
     * retired, the generation is bumped so no in-flight callback can revive
     * it, and the CANCEL goes to the peer. The state must say so too —
     * `outgoing` and `sendProgress` are cleared here rather than left standing.
     *
     * Two things depend on that, and neither is cosmetic. The card would
     * otherwise keep showing a file list and a Cancel button for a batch that
     * no longer exists, offering the user a control over nothing; and there
     * would be no observable "no batch is active" edge at all — `sentBatch` is
     * already false before a cancel, so waiting on it proves only that time
     * passed. A fresh retry has to be able to wait for the previous batch to
     * be genuinely retired, and this is that edge.
     */
    fun cancelSend() = post {
        val lane = fileLane ?: return@post
        retirePump()
        batchGen++
        // On the older wire this also ends the connection — nothing else could
        // tell the receiver the chunks stopped on purpose — and it does so
        // through [onLaneFailure], not from here.
        apply(epoch, lane.cancelOutgoing())
        _state.value = _state.value.copy(
            outgoing = emptyList(),
            sendProgress = null,
            sentBatch = false,
        )
    }

    /** Stop the current pump and surrender its stream. Session thread only.
     *  EVERY send-stopping path funnels here — user cancel, peer reject or
     *  cancel, SEND or LANE failure, teardown — so no stop cause can leave an
     *  acquired descriptor open, and a read blocked on the IO dispatcher (Job
     *  cancellation cannot interrupt it) is unblocked by the close. */
    private fun retirePump() {
        pumpJob?.cancel()
        pumpJob = null
        pumpLease?.retire()?.let(::closeOffOwner)
        pumpLease = null
    }

    /** Close a provider stream WITHOUT blocking the calling owner: a content
     *  provider's close() may itself stall, and both the session thread and
     *  the caller of shutdown() must stay responsive through it. */
    private fun closeOffOwner(stream: InputStream) {
        thread(name = "relayium-close", isDaemon = true) {
            runCatching { stream.close() }
        }
    }

    /**
     * Stream the picked files, one logical chunk at a time.
     *
     * Fenced THREE ways — epoch, batch generation, lane state — at every point
     * a suspension could have crossed a cancel, so a delayed provider read from
     * an old batch can never write into a new one. Reads happen on IO; every
     * lane mutation happens back on the session dispatcher.
     */
    private fun startPump(
        mine: Int,
        myBatch: Int,
        lane: FileLaneSession,
        sources: List<OutgoingSource>,
    ) {
        val lease = PumpLease()
        pumpLease = lease
        pumpJob = scope.launch(sessionDispatcher) {
            val live = { epoch == mine && batchGen == myBatch }
            var waited = 0L
            while (live() && lane.sendState == FileLaneSession.SendState.WAITING_ACCEPT) {
                delay(POLL_MS)
                waited += POLL_MS
                if (waited > deps.timeouts.consentMs) {
                    if (live()) apply(mine, lane.cancelOutgoing())
                    return@launch
                }
            }
            for (source in sources) {
                if (!live() || lane.sendState != FileLaneSession.SendState.SENDING) return@launch
                var chain = Crypto.chainStart()
                var sent = 0L
                // Open on IO and OFFER the result to the lease inside the same
                // block: if a cancel retired the lease while open() ran, the
                // refused offer makes the OPENER close its own result — on the
                // IO thread, where a blocking provider close is harmless. The
                // resumption back here may throw CancellationException without
                // this pump ever seeing the stream again; that is fine, because
                // ownership was settled inside the lock, not in a `finally`.
                val stream = try {
                    withContext(Dispatchers.IO + NonCancellable) {
                        val acquired = source.open()
                        if (lease.offer(acquired)) {
                            acquired
                        } else {
                            runCatching { acquired.close() }
                            null
                        }
                    }
                } catch (_: Exception) {
                    // open() failed — or the dispatch back was cancelled. If we
                    // still own a stream the retirer did not take, surrender it.
                    lease.release()?.let(::closeOffOwner)
                    if (live()) apply(mine, lane.cancelOutgoing())
                    return@launch
                } ?: return@launch
                // A cancel may also land AFTER the offer succeeded but before
                // this check; the retire took the stream, so just stop.
                if (!live()) { lease.release()?.let(::closeOffOwner); return@launch }
                try {
                    while (true) {
                        val chunk = try {
                            withContext(Dispatchers.IO) { readChunk(stream) }
                        } catch (_: IOException) {
                            // A failed READ is a failed source, never quiet EOF:
                            // the DONE would cover bytes the file no longer has.
                            if (live()) {
                                _state.value = _state.value.copy(errorKey = "error_transfer_failed")
                                apply(mine, lane.cancelOutgoing())
                            }
                            return@launch
                        } ?: break
                        if (!live() || lane.sendState != FileLaneSession.SendState.SENDING) return@launch
                        chain = Crypto.chainAdvance(chain, chunk)
                        while (live() &&
                            lane.sendState == FileLaneSession.SendState.SENDING &&
                            (lane.sendCredit < chunk.size ||
                                (transport?.fileBufferedAmount() ?: 0) > BUFFERED_HIGH)
                        ) {
                            delay(POLL_MS)
                        }
                        if (!live() || lane.sendState != FileLaneSession.SendState.SENDING) return@launch
                        apply(mine, lane.sendChunk(chunk))
                        sent += chunk.size
                        if (!live()) return@launch
                        _state.value = _state.value.copy(
                            sendProgress = Progress(source.meta.name, sent, source.meta.size),
                        )
                    }
                } finally {
                    // Take the stream back from the lease (a retire may already
                    // have) and close it off-owner: a provider close can block,
                    // and this finally runs on the session dispatcher.
                    lease.release()?.let(::closeOffOwner)
                }
                if (!live() || lane.sendState != FileLaneSession.SendState.SENDING) return@launch
                if (sent != source.meta.size) {
                    // The provider returned different bytes than it declared —
                    // the file changed underneath the pick. Stop honestly.
                    apply(mine, lane.cancelOutgoing())
                    return@launch
                }
                apply(mine, lane.sendDone(chain))
            }
            if (live() && lane.sendState == FileLaneSession.SendState.SENDING) {
                apply(mine, lane.finishSending())
            }
        }
    }

    /**
     * One logical chunk, or null at a clean end of stream.
     *
     * `InputStream.readNBytes` is API 33 and this app runs from 26, so the
     * short-read loop is written out; an IOException PROPAGATES — hiding a
     * mid-file read failure as end-of-file is how a truncated file gets a
     * confident DONE.
     */
    private fun readChunk(input: InputStream): ByteArray? {
        val buffer = ByteArray(RealtimeFrame.CHUNK_SIZE)
        var off = 0
        while (off < buffer.size) {
            val n = input.read(buffer, off, buffer.size - off)
            if (n < 0) break
            off += n
        }
        return if (off == 0) null else buffer.copyOf(off)
    }

    // ── the text lane ───────────────────────────────────────────────────────

    /** Executes text actions; returns false if a transport enqueue failed (the
     *  lane is then already poisoned). */
    private fun applyText(mine: Int, actions: List<TextLaneSession.Action>): Boolean {
        val lane = textLane ?: return false
        var enqueueFailed = false
        for (action in actions) {
            when (action) {
                is TextLaneSession.Action.Send -> {
                    if (!enqueueFailed && transport?.sendText(action.frame) != true) {
                        enqueueFailed = true
                    }
                }
                is TextLaneSession.Action.Received -> _state.value = _state.value.copy(
                    messages = (_state.value.messages + Message(action.body, fromPeer = true))
                        .takeLast(TextSessionLimits.HISTORY_MAX),
                )
                is TextLaneSession.Action.Fail -> {
                    // A visible failure, not a silently changed enum: the UI
                    // maps the key.
                    val key = when (action.reason) {
                        // On `link/1` a refusal leaves the lane reopenable and
                        // the UI reads it from textState. On the older wire the
                        // refusal ends the whole connection, so the ended
                        // session has to say why by itself.
                        TextLaneSession.Action.Reason.REFUSED ->
                            if (isLegacy) "error_text_refused" else null
                        else -> "error_text_failed"
                    }
                    if (key != null) _state.value = _state.value.copy(errorKey = key)
                }
                is TextLaneSession.Action.Drained,
                is TextLaneSession.Action.Requested,
                is TextLaneSession.Action.Opened,
                is TextLaneSession.Action.Ended,
                -> Unit
            }
        }
        if (enqueueFailed) {
            // A consumed nonce never entered the channel; the lane is stranded
            // and says so. No fresh codecs, no false "sent".
            lane.transportSendFailed()
            _state.value = _state.value.copy(errorKey = "error_transfer_failed")
        }
        syncTextTimers(mine, lane)
        _state.value = _state.value.copy(textState = lane.state, textCanRequest = lane.canRequest)
        // On the older wire the conversation IS the connection: once it is
        // ENDED or FAILED nothing can carry a frame on it in either direction,
        // and leaving the socket open would leave the user in front of a dead
        // composer. Every terminal path funnels through here — the peer's
        // REJECT, a receiver-enforced bound, a malformed or unauthenticated
        // frame, a refused enqueue and the local end alike — because the local
        // ones alone were only the paths a user takes deliberately.
        //
        // AFTER the publication above, never before: the final textState the
        // user is left looking at must be the real one, and a teardown that ran
        // first would leave the previous state standing over a closed session.
        // `link/1` is untouched: its lanes are independent and an ended
        // conversation there is reopenable on a live link.
        if (isLegacy &&
            (lane.state == TextLaneSession.State.ENDED || lane.state == TextLaneSession.State.FAILED)
        ) {
            endSession(null)
        }
        return !enqueueFailed
    }

    /** The end-barrier lease: armed exactly while a barrier is outstanding,
     *  RETIRED the moment it settles, and fenced by barrier generation so a
     *  stale timer cannot poison a later conversation. */
    private fun syncTextTimers(mine: Int, lane: TextLane) {
        // A wire with no END barrier has no lease over one. Without this guard
        // a legacy lane — permanently `canRequest == false` — would look like a
        // barrier that never settles and arm a timer with nothing to answer it.
        if (!lane.hasEndBarrier) return
        val outstanding = !lane.canRequest && lane.state == TextLaneSession.State.ENDED
        if (outstanding) {
            if (textEndTimer == null) {
                textBarrierGen++
                val myBarrier = textBarrierGen
                textEndTimer = session.schedule(
                    {
                        textEndTimer = null
                        if (epoch != mine || myBarrier != textBarrierGen) return@schedule
                        textLane?.let { applyText(mine, it.endBarrierTimedOut()) }
                    },
                    deps.timeouts.textEndAckMs, TimeUnit.MILLISECONDS,
                )
            }
        } else if (textEndTimer != null) {
            textEndTimer?.cancel(false)
            textEndTimer = null
            textBarrierGen++
        }
    }

    /** Ten minutes with no traffic either way ends the conversation, as the
     *  Web's session bound does. */
    private fun armTextIdle(mine: Int) {
        textIdleTimer?.cancel(false)
        val interval = maxOf(deps.timeouts.textIdleMs / 4, 1L)
        textIdleTimer = session.scheduleWithFixedDelay(
            {
                if (epoch != mine) { textIdleTimer?.cancel(false); textIdleTimer = null; return@scheduleWithFixedDelay }
                val lane = textLane ?: return@scheduleWithFixedDelay
                if (lane.state == TextLaneSession.State.OPEN &&
                    System.currentTimeMillis() - lastTextActivity >= deps.timeouts.textIdleMs
                ) {
                    // On the older wire this also closes the connection; see
                    // the terminal handling in [applyText].
                    applyText(mine, lane.end())
                }
            },
            interval, interval, TimeUnit.MILLISECONDS,
        )
    }

    fun requestText() = post {
        val lane = textLane ?: return@post
        lastTextActivity = System.currentTimeMillis()
        if (lane.canRequest) applyText(epoch, lane.request())
    }

    fun acceptText() = post {
        val lane = textLane ?: return@post
        lastTextActivity = System.currentTimeMillis()
        if (lane.state == TextLaneSession.State.INCOMING_REQUEST) applyText(epoch, lane.accept())
    }

    fun rejectText() = post {
        val lane = textLane ?: return@post
        if (lane.state != TextLaneSession.State.INCOMING_REQUEST) return@post
        // `RealtimeConnection.rejectText` sends the byte and closes; the
        // terminal handling in [applyText] is what closes it here, so every
        // path that retires a legacy conversation does the same thing.
        applyText(epoch, lane.reject())
    }

    fun endText() = post {
        val lane = textLane ?: return@post
        applyText(epoch, lane.end())
    }

    /**
     * "Sent" means queued onto an ordered channel and nothing more. The
     * message appears in the history only AFTER a successful enqueue, and
     * [onOutcome] reports that same truth (on the session thread) so the
     * caller can decide what happens to the user's DRAFT: a closed lane, a
     * full buffer, a failed enqueue or a link that is no longer the one the
     * text was written for must leave the unsent text in the field, not
     * silently discard it. A shutdown that swallows the post never invokes the
     * callback — the conservative outcome for a draft.
     */
    fun sendText(
        body: String,
        expectedLink: Int? = null,
        onOutcome: ((Boolean) -> Unit)? = null,
    ) = post {
        // The SAME exact-peer fence [sendFiles] uses, for the same reason: a
        // draft is composed against one rendered connection, and the join that
        // replaces it can land between the tap and this executor turn. Checked
        // HERE, before the lane is even read, so no text typed for one peer can
        // be sealed for another. The outcome is `false` — the conservative
        // answer for a draft, which the caller then keeps rather than clears.
        if (expectedLink != null && expectedLink != epoch) {
            onOutcome?.invoke(false)
            return@post
        }
        val lane = textLane ?: run { onOutcome?.invoke(false); return@post }
        if (lane.state != TextLaneSession.State.OPEN) {
            onOutcome?.invoke(false)
            return@post
        }
        // The send-buffer bound, checked BEFORE sealing so no nonce is burned
        // on a frame the socket cannot take.
        if ((transport?.textBufferedAmount() ?: 0) > TextSessionLimits.SEND_BUFFER_MAX) {
            _state.value = _state.value.copy(errorKey = "error_text_buffer_full")
            onOutcome?.invoke(false)
            return@post
        }
        lastTextActivity = System.currentTimeMillis()
        val actions = lane.send(body)
        val hadFrame = actions.any { it is TextLaneSession.Action.Send }
        val delivered = applyText(epoch, actions)
        val sent = hadFrame && delivered
        if (sent) {
            _state.value = _state.value.copy(
                messages = (_state.value.messages + Message(body, fromPeer = false))
                    .takeLast(TextSessionLimits.HISTORY_MAX),
            )
        }
        onOutcome?.invoke(sent)
    }

    // ── ending ──────────────────────────────────────────────────────────────

    /**
     * End the CONNECTION.
     *
     * In a pairing room that is the whole session. In a Nearby room the room
     * stays and the user returns to the device list — see [endSession] — which
     * is the distinction between finishing a transfer and leaving the feature.
     * [stopNearby] is the other one.
     */
    fun disconnect() = post {
        announceLeave()
        endSession(null)
    }

    /** Tell the peer this side is going, if there is a peer and a wire that can
     *  carry it. The authenticated leave is a `link/1` signal — it rides the
     *  `link` generation and carries an HMAC over a link payload. Sending one to
     *  a legacy peer would be a frame it filters out by generation and could not
     *  verify anyway, so that wire simply closes. Best effort throughout: a
     *  leave that never arrives degrades to the peer's ordinary drop handling. */
    private fun announceLeave() {
        val link = transport ?: return
        val registry = linkSession ?: return
        val k = keys ?: return
        if (isLegacy || peerId.isEmpty()) return
        link.leaveAndClose(registry.leaveSignal(peerId, k))
    }

    /**
     * One connection is over.
     *
     * In a PAIRING room the session is the connection, so this is terminal and
     * behaves exactly as it always has. In a Nearby room the room outlives it:
     * the transfer ends, the stream that carried it is closed, and the user is
     * returned to the list they were looking at — which is what makes "finish
     * with this device, then connect to that one" a real thing rather than a
     * re-join under a new identity.
     */
    private fun endSession(errorKey: String?) {
        if (admission == PeerAdmission.EXPLICIT && _state.value.nearby.active) {
            val retiring = peerId
            closeConnection()
            // Close the stream this establishment used, where the transport has
            // one per peer. That is what makes "a frame from the finished
            // connection cannot reach the next one" structural: the peer's
            // in-flight signals were addressed to a socket that no longer
            // exists, and a fresh establishment dials a fresh one. It is NOT a
            // departure — the device is still advertising and stays listed.
            if (retiring.isNotEmpty()) {
                (signaling as? PeerScopedSignaling)?.retirePeer(retiring)
            }
            val current = _state.value
            _state.value = current.copy(
                phase = Phase.WAITING_PEER,
                wire = null,
                sas = null,
                // Cleared, not preserved: this is a live surface the user acts
                // on next, and a stale failure standing over a fresh list reads
                // as the list being broken.
                errorKey = errorKey,
                incoming = emptyList(),
                outgoing = emptyList(),
                messages = emptyList(),
                awaitingFolder = false,
                receiveProgress = null,
                sendProgress = null,
                fileLaneDown = false,
                textState = TextLaneSession.State.IDLE,
                textCanRequest = false,
                nearby = current.nearby.copy(selectedId = null),
            )
            publishNearby()
            // A room drop that waited for this connection can happen now.
            if (roomRetryPending) {
                roomRetryPending = false
                scheduleRoomReconnect(immediate = false)
            }
            return
        }
        _state.value = _state.value.copy(
            phase = Phase.ENDED,
            errorKey = errorKey ?: _state.value.errorKey,
            receiveProgress = null,
            sendProgress = null,
            awaitingFolder = false,
        )
        closeOnSession()
    }

    /** Every timer a CONNECTION owns. The hello retry is not one of them: it
     *  belongs to the room. */
    private fun cancelConnectionTimers() {
        for (timer in listOf(
            settleTimer, requestRetryTimer, requestDeadlineTimer,
            textEndTimer, abortBarrierTimer, textIdleTimer, legacyOfferTimer,
        )) {
            timer?.cancel(false)
        }
        settleTimer = null; requestRetryTimer = null; requestDeadlineTimer = null
        textEndTimer = null; abortBarrierTimer = null; textIdleTimer = null
        legacyOfferTimer = null
    }

    /**
     * Session-thread teardown of ONE connection. Epoch and every generation bump
     * FIRST, so every callback, timer and storage completion under the old ones
     * drops itself.
     *
     * Deliberately leaves the room alone: the signalling handle, the capability
     * registry, this device's room id, the roster and the ICE the room was
     * issued are all still exactly as true as they were. In a pairing room
     * [closeRoom] runs immediately after this, so nothing observes the split.
     */
    private fun closeConnection() {
        epoch++
        batchGen++
        bumpReceiveGen()
        textBarrierGen++
        retirePump()
        cancelConnectionTimers()
        // The final disk cleanup is QUEUED, never awaited, and its outcome is
        // still surfaced: leftovers a teardown could not remove are as real as
        // any other batch's. shutdown() stops the storage executor only AFTER
        // this submission, so the cleanup drains rather than being dropped.
        discardStorage()
        transport?.close("local-close")
        transport = null
        keys?.destroy()
        keys = null
        fileLane = null
        textLane = null
        wireProfile = null
        peerId = ""
        receivedBytes = 0
        pendingExports = 0
    }

    /** Everything that belongs to the RENDEZVOUS, and only that. A peer id, a
     *  capability announcement and an ICE grant all mean nothing outside the
     *  room that issued them. */
    private fun closeRoom() {
        roomGen++
        helloTimer?.cancel(false)
        helloTimer = null
        reconnectTimer?.cancel(false)
        reconnectTimer = null
        clearPendingAdmission()
        runCatching { signaling?.close() }
        signaling = null
        linkSession = null
        selfId = ""
        roster = emptyList()
        source = null
        roomRetryPending = false
        reconnectAttempt = 0
        ice = IceConfig.Result(emptyList(), "")
    }

    /** Release the room's objects WITHOUT ending the Nearby session, so a
     *  reconnect starts from a clean registry. [source] survives: it is what the
     *  reconnect reopens. */
    private fun releaseRoomObjects() {
        val src = source
        closeRoom()
        source = src
    }

    /** Both halves. Every existing caller — a fresh join, a terminal session, a
     *  ViewModel clear — means exactly this, which is why it stayed the name. */
    private fun closeOnSession() {
        closeConnection()
        closeRoom()
    }

    fun close() = post { closeOnSession() }

    /**
     * ViewModel-clear teardown: NONBLOCKING for the caller, ordered on the
     * session owner itself.
     *
     * The caller is normally the MAIN thread (`onCleared`), and a provider
     * blocked inside a storage write can hold the storage thread for seconds —
     * awaiting that drain here was an ANR. Instead the session thread runs the
     * whole ordered sequence: tear the transport and signalling down FIRST
     * (never dependent on any storage drain), queue the final disk cleanup,
     * and only then ask both executors to stop. `shutdown()` on an executor
     * lets already-queued work finish, so the cleanup — and its truthful
     * leftover warning — still runs when the provider unblocks instead of
     * being dropped. [awaitShutdown] exists for tests and diagnostics; no
     * production caller waits.
     */
    fun shutdown() {
        val posted = runCatching {
            session.execute {
                closeOnSession()
                session.shutdown()
                storage.shutdown()
            }
        }.isSuccess
        if (!posted) {
            // The session owner was already stopped; nothing is left to order.
            session.shutdown()
            storage.shutdown()
        }
    }

    /** Test/diagnostic completion for [shutdown]: true once BOTH owners have
     *  terminated. The production teardown path never calls this. */
    internal fun awaitShutdown(timeoutMs: Long): Boolean {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        val sessionDone = runCatching {
            session.awaitTermination(timeoutMs, TimeUnit.MILLISECONDS)
        }.getOrDefault(false)
        if (!sessionDone) return false
        val left = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
        return runCatching {
            storage.awaitTermination(maxOf(left, 1L), TimeUnit.MILLISECONDS)
        }.getOrDefault(false)
    }

    private companion object {
        const val POLL_MS = 20L
        /** Room-reconnect delays, as multiples of [Timeouts.roomRetryMs]: 2, 4,
         *  10, 20, 30, 30 seconds at the default. Bounded, and it stops growing
         *  rather than stopping. */
        val ROOM_BACKOFF_STEPS = intArrayOf(1, 2, 5, 10, 15, 15)
        /** SCTP send-queue ceiling, independent of the application window. */
        const val BUFFERED_HIGH = 8L * 1024 * 1024
        /** Enqueued-but-uncompleted receive plaintext ceiling: twice the flow
         *  window the sender must respect. Past it a peer is ignoring ACKs. */
        const val STORAGE_QUEUE_MAX_BYTES = 2L * RealtimeFrame.FLOW_WINDOW_BYTES
        /** And a task ceiling, so a flood of tiny writes cannot queue without
         *  bound under the byte ceiling. */
        const val STORAGE_QUEUE_MAX_TASKS = 4_096
    }
}
