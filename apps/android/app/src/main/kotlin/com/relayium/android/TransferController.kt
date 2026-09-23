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
import com.relayium.android.transport.RelayRenewEngine
import com.relayium.android.transport.RenewTransport
import com.relayium.android.transport.SignalingClient
import com.relayium.android.transport.SignalingFactory
import com.relayium.android.transport.SignalingHandle
import com.relayium.android.transport.TransportFactory
import com.relayium.android.transport.TransportHandle
import com.relayium.protocol.CliPeerSignal
import com.relayium.protocol.Crypto
import com.relayium.protocol.Envelope
import com.relayium.protocol.FileLaneSession
import com.relayium.protocol.FileMeta
import com.relayium.protocol.Json
import com.relayium.protocol.LinkProtocol
import com.relayium.protocol.LinkSession
import com.relayium.protocol.PairCode
import com.relayium.protocol.RealtimeFrame
import com.relayium.protocol.RelayRenewPolicy
import com.relayium.protocol.RelayRenewProbe
import com.relayium.protocol.RelayRenewWire
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
import java.security.SecureRandom
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlinx.coroutines.CancellationException
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
        /**
         * The user's "compare verification codes" preference, read ONCE per
         * link at the moment it becomes ready (A31 a). Off by default, as on
         * Apple and the website. A change while a link is up neither releases
         * nor re-gates anything on that link; it applies to the next one.
         */
        val verifyPeers: () -> Boolean = { false },
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
        /** Consecutive rejoin attempts for one pairing code before giving up:
         *  2+4+10+20+30+30 s at the default retry unit, about a minute and a
         *  half — well inside a code's life. */
        val pairingReconnectLimit: Int = 6,
    )

    // ── observable state ────────────────────────────────────────────────────

    enum class Phase { IDLE, CONNECTING, WAITING_PEER, CONNECTED, ENDED }

    /**
     * The verification boundary of the CURRENT link (A31 a, parity with Apple's
     * `LinkWorkspaceModel.verification`).
     *
     *  - [NONE]: the preference was off when the link came up. Nothing is
     *    held; the code stays one tap away, exactly as before.
     *  - [PENDING]: the user asked to compare codes. No work moves in either
     *    direction until they answer: an outgoing batch is HELD (not sent, not
     *    dropped), a message cannot be sent, an incoming batch cannot be
     *    accepted and an incoming conversation is not admitted.
     *  - [CONFIRMED]: they matched. Held work was released once, in order.
     *
     * Local only. Nothing about it goes on the wire, and the handshake's
     * commit-reveal and AEAD are identical in every state — this changes what
     * waits for a person, never the encryption.
     */
    enum class Verification { NONE, PENDING, CONFIRMED }

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
        /**
         * The address relayium.com observed this device at, from the welcome.
         * Empty on the local-link path, which contacts no server, and until a
         * room is joined. It IS the room key: two devices see each other in the
         * relayium.com room exactly when this value is the same on both.
         */
        val publicIp: String = "",
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
        /** See [Verification]. */
        val verification: Verification = Verification.NONE,
        /** Files in an outgoing batch held behind [Verification.PENDING]; 0
         *  when nothing is held. Shown so the compare step can say they wait. */
        val heldFiles: Int = 0,
        /** A stable identifier the UI maps to localised copy. Never raw text. */
        val errorKey: String? = null,
        /** Why relay will not be available to this cross-network session —
         *  "quota", "unverified" or "none" — or null. A key, never copy. */
        val relayNote: String? = null,
        /** The connected link stopped answering and is being given a bounded
         *  chance to come back. Not an ending: nothing has been lost yet. */
        val linkInterrupted: Boolean = false,
        /**
         * When this RELAYED link must end, on the local clock, or null.
         *
         * Null for every link nothing bounds: a LAN or Nearby session, a
         * cross-network session whose selected path was classified direct, and
         * a session whose selected path has not been reported at all.
         *
         * This is a CLIENT-side bound on this client's own behaviour. The
         * server's grant authority expires on schedule and is not negotiable;
         * what happens to the TURN allocation itself at that moment is a
         * property of the relay engine, and is deliberately NOT claimed here.
         * An allocation that already exists may outlive the credential that
         * created it, so nothing in this file may be read as an instant cap or
         * as automatic revocation.
         *
         * The honest statement is narrower, and is the one this bound rests on:
         * past its expiry the credential can no longer be relied on, nothing
         * tells the app when it stops working, and a link that keeps running on
         * one is running on something neither end can account for.
         */
        val relayExpiresAt: Long? = null,
        /** Inside the window where a live relayed link must say it is going to
         *  end. Never true once a renewal has moved the boundary past it. */
        val relayExpiryWarning: Boolean = false,
        /**
         * What renewal is doing, for truthful copy.
         *
         * Never `RENEWED` before an actual committed migration: an applied
         * configuration, an open DataChannel and a server reply are each not a
         * migration, and the UI must not claim one happened.
         */
        val renewState: RelayRenewEngine.State = RelayRenewEngine.State.IDLE,
        /** Incoming conversations this link admitted WITHOUT a prompt (link/1
         *  only). Zero on the older wire, which still asks. */
        val textAutoAdmits: Int = 0,
        /** The pairing room's socket dropped while waiting and is being rejoined
         *  with the same code. The code on screen is still the code to use. */
        val reconnecting: Boolean = false,
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

    /**
     * Peers whose prompt the user DECLINED, keyed to that prompt's id, with the
     * prompt's own deadline timer still running for it (A23 G5, parity with the
     * Apple `LinkRoomRouter.declinedAsks`).
     *
     * The asking side re-sends its request every few seconds until its own
     * deadline, so a retry already in flight when the user said no reaches an
     * idle room. Without the mark it raised a SECOND prompt for a question the
     * user had just answered. While a mark stands that peer's asks are answered
     * `busy` and nothing is shown. It lasts exactly as long as the declined
     * prompt would have stood — the window in which retries of that same ask can
     * still arrive — and goes early when the peer leaves the roster, the room
     * changes, or the user taps Connect on that very device.
     */
    private val declinedPeers = HashMap<String, DeclineMark>()

    private class DeclineMark(val promptId: Int, val timer: ScheduledFuture<*>?)

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

    /**
     * Whether the CURRENT connection reached READY — both lanes open and the
     * peer's key verified against its commitment.
     *
     * [keys] is written by [onLinkReady] and cleared by [closeConnection], both
     * on the session thread, so this is the session's own answer rather than a
     * value the UI thread may have observed one edge ago. A transport that
     * merely EXISTS is mid-handshake and is not established.
     */
    private val isLinkEstablished: Boolean get() = transport != null && keys != null

    private var keys: Crypto.SessionKeys? = null
    private var selfId: String = ""
    private var peerId: String = ""
    private var ice: IceConfig.Result = IceConfig.Result(emptyList(), "")

    /** The ROOM generation [ice] was issued for, or -1 before any grant. See
     *  [roomIceReady]; room generations are monotonic and never reused. */
    private var iceRoom = -1

    /** The in-flight ICE fetch for the current room, so a room that ends can
     *  cancel the HTTP call it started rather than leaving it to resolve into
     *  a generation check. */
    private var iceJob: Job? = null

    /** Establishment frames that reached this room before its ICE grant did,
     *  in arrival order and bounded by [LinkProtocol.HELD_SIGNAL_MAX].
     *  Capability announcements are NOT held — they build nothing, and the
     *  roster the user is looking at must not wait on an HTTP round trip. */
    private val heldRoomSignals = ArrayList<Pair<String, Json>>()

    /** The one connection this room decided to build before its ICE grant
     *  existed, re-fenced so it drops itself if the link or the room moved on.
     *  At most one: a connection is what it holds, and there is only ever one.
     *  [peer] names it so a departure can invalidate it explicitly. Every
     *  current caller sets [peerId] before it defers, so the link fence inside
     *  `run` already covers today's departures on its own; the name is here so
     *  that stays true of a caller that does not. */
    private class HeldStart(val peer: String, val run: () -> Unit)

    private var heldStart: HeldStart? = null

    /** This pairing room welcomed us since it was (re)opened. See [onRoomClosed]. */
    private var pairingWelcomed = false

    /** Consecutive pairing-room drops without a welcome in between. */
    private var pairingDrops = 0
    private var pumpJob: Job? = null
    /** The CURRENT pump's stream lease. Session thread only; the lease object
     *  itself is what crosses threads, under its own lock. */
    private var pumpLease: PumpLease? = null
    private var receivedBytes = 0L
    private var pendingExports = 0
    private var lastTextActivity = 0L

    // ── relay renewal (`docs/protocol/relay-renew-v1.md`) ───────────────────

    /**
     * The INDEPENDENT real-user-data clock.
     *
     * Deliberately not [lastTextActivity], which is refreshed by lifecycle
     * bytes and by the UI's own timers and is therefore unsuitable as a consent
     * signal (section 7.1). This one moves on authenticated user-lane data
     * only: received file plaintext, ACK progress that proves the peer took
     * bytes, and user text that was sealed or authenticated. Renewal's own
     * probes and acks are explicitly not activity, and neither are lifecycle
     * bytes, queued work or a pending consent prompt.
     */
    private val userData = RelayRenewPolicy.Activity()

    /** The epoch machine for the live link, or null when there is none. */
    private var renewal: RelayRenewEngine? = null

    /** The boundary this relayed link is bounded by, or null when nothing
     *  bounds it. Armed only from an OBSERVED relay path. */
    private var relayBound: RelayRenewPolicy.Deadline? = null

    /**
     * The renewed ICE configuration actually applied to the live connection, or
     * null while it is still running on the one the room was issued.
     *
     * Held for the life of the LINK, outliving the renewal engine's short
     * post-commit window: it is what a later path classification derives a
     * boundary from, and the room's original `ice` may by then describe a
     * credential nothing uses. Cleared with the connection, because a
     * configuration issued for one link is not authority for the next.
     */
    private var installedIce: List<IceConfig.Server>? = null

    /** Nonces and request ids. `SecureRandom` because a probe nonce is the only
     *  thing standing between a replayed ack and a false commit. */
    private val renewRandom = SecureRandom()

    private var relayWarnTimer: ScheduledFuture<*>? = null
    private var relayExpiryTimer: ScheduledFuture<*>? = null

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
        pairingWelcomed = false
        pairingDrops = 0
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
        resetRoomIce()
        if (!source.usesBackend) {
            // No grant to wait for, and none may be asked for. The gate below
            // opens immediately so this path behaves exactly as it always has.
            ice = IceConfig.Result(emptyList(), "")
            iceRoom = room
            openSignaling(room, source)
            return
        }
        // The rendezvous socket and the ICE grant are INDEPENDENT acquisitions
        // of the same room, and serialising them cost this client a whole API
        // round trip — up to the fetch's own ten-second deadline on a bad
        // network — before the peer could even see it arrive. The Web has
        // always started both at once (`App.svelte`). So: join now, gather the
        // grant alongside, and hold back only the ONE thing that genuinely
        // needs it.
        //
        // That one thing is a `PeerConnection`. Built before the grant lands it
        // is built with no STUN and no relay, so a cross-network pair gathers
        // host candidates that cannot reach each other and the link fails on a
        // room whose credential was sitting in flight. [startTransport] holds
        // the decision instead, and [onSignalFrame] holds the establishment
        // frames that would raise one, bounded and in arrival order.
        openSignaling(room, source)
        iceJob = scope.launch(sessionDispatcher) {
            val fetched = try {
                // Bounded and cancellable; [resetRoomIce] cancels it, and the
                // room check below stops an old join's completion writing into
                // the room that replaced it.
                deps.fetchIce(source)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                // The same answer the fetch gives a failed request: an EMPTY
                // list, never an invented third-party default. A throwing
                // dependency must degrade to host candidates, not wedge the
                // room behind a gate that never opens.
                IceConfig.Result(emptyList(), "")
            }
            if (roomGen != room) return@launch
            ice = fetched
            iceRoom = room
            // Pairing rooms only. The code-less relayium.com room is STUN-only by
            // server policy, so "no relay" there is the design, not a warning.
            if (source is ConnectionSource.Pairing) {
                _state.value = _state.value.copy(relayNote = fetched.relayNote)
            }
            onRoomIceReady(room)
        }
    }

    /** Whether THIS room's ICE grant has landed. A grant belongs to the room it
     *  was issued for: an empty list left over from a previous room is not this
     *  room's answer, and the generation is what says so. */
    private fun roomIceReady(): Boolean = iceRoom == roomGen

    /**
     * Whether a frame is worth holding for the grant at all.
     *
     * The hold sits ABOVE the generation routing and the admission rules, so
     * without this every frame those layers would have dropped on arrival
     * would instead occupy one of sixty-four slots and, at the bound, end a
     * session. That turns traffic this client already ignores into a lever.
     *
     * Two things qualify, and nothing else:
     *
     *  - an ASK — an SDP or the content-free link request. It is the only kind
     *    of frame that can build a connection, which is the only thing waiting
     *    for the grant.
     *  - whatever CHASES an ask: a candidate, a reveal, a commitment from a
     *    peer this room is already holding an ask for, or has already committed
     *    to ([peerId]) or raised a prompt for ([pendingPeer]). Held so the
     *    replay keeps the peer's own order.
     *
     * A candidate from a peer with no ask in flight is dropped, not held —
     * exactly as it is dropped today when the grant is already in hand and
     * there is no transport to route it into. The resume generation is
     * excluded outright: this stage refuses it in silence on every path.
     */
    private fun heldSignalMatters(from: String, signal: Signal): Boolean {
        if (signal.generation == Signal.Generation.RESUME) return false
        if (signal.sdpType != null || signal.isLinkRequest) return true
        return from == peerId || from == pendingPeer ||
            heldRoomSignals.any { (held, _) -> held == from }
    }

    /**
     * The room lost sight of [peer]: nothing held for it may still be acted on.
     *
     * Without this, the pre-handshake half of a departure is silent. A frame
     * held for the grant has not established anything yet, so [peerId] is
     * still empty and `onPeerLeft` has nothing to end — and when the grant
     * lands, the departed peer's offer builds a `PeerConnection` to a device
     * that is no longer in the room, which then burns the whole setup deadline
     * before it can say so.
     */
    private fun forgetHeldRoomWork(peer: String) {
        if (peer.isEmpty()) return
        heldRoomSignals.removeAll { (from, _) -> from == peer }
        if (heldStart?.peer == peer) heldStart = null
    }

    /**
     * This room's ICE grant landed. Everything held for it runs now, in the
     * order it was held, and nothing else is replayed.
     *
     * The held connection decision goes first because that is the order the two
     * happened in: the roster (or the user's tap) chose a peer, and the frames
     * arrived afterwards into a connection that should already have existed.
     */
    private fun onRoomIceReady(room: Int) {
        if (roomGen != room) return
        val start = heldStart
        heldStart = null
        start?.run?.invoke()
        val held = ArrayList(heldRoomSignals)
        heldRoomSignals.clear()
        // Fenced by the LINK as well as the room, because in a Nearby room the
        // two come apart: a frame in this list can end the connection and leave
        // the room standing, and the frames behind it were captured against the
        // link that just went away. Replaying them would re-prompt, or
        // re-establish, under a generation nobody held them for.
        val link = epoch
        for ((from, data) in held) {
            if (roomGen != room || epoch != link) return
            onSignalFrame(from, data)
        }
    }

    /** Drop everything the ICE acquisition of a room that is ending owned. A
     *  held frame and a held connection decision both name a room identity that
     *  is about to stop existing, so neither may survive into the next one. */
    private fun resetRoomIce() {
        iceJob?.cancel()
        iceJob = null
        iceRoom = -1
        heldRoomSignals.clear()
        heldStart = null
    }

    private fun openSignaling(room: Int, source: ConnectionSource) {
        val client = deps.signals.create(
            source,
            object : SignalingClient.Events {
                override fun onSelfId(id: String, ip: String) = postRoom(room) { onWelcome(id, ip) }
                override fun onPeers(peers: List<Envelope.Peer>) = postRoom(room) { onRoster(peers) }
                override fun onPeerLeft(peerId: String) = postRoom(room) {
                    // The rendezvous saying a PHYSICAL connection closed. It
                    // retires whatever is bound to that id and nothing else: a
                    // Nearby room keeps listing every other device.
                    //
                    // And it is a statement about the ROOM, not about the
                    // connection. A WebRTC link is peer-to-peer: an established
                    // one keeps carrying bytes after the socket that introduced
                    // the two devices is gone, which is the same reason
                    // [failRoom] leaves a live transfer running when the whole
                    // room drops. Ending it here cost a running transfer every
                    // time the peer's signalling socket dropped — a screen
                    // lock, a Wi-Fi handover, a server restart — while the data
                    // channel was still healthy. The Web deliberately does not
                    // (`peer-workspace.svelte.ts`, `departed`).
                    //
                    // `transport != null` is NOT the test, and the difference
                    // is the whole rule: a connection still in its handshake
                    // has nothing to preserve and no channel but signalling, so
                    // a departure before READY must end it rather than strand
                    // it until its own setup deadline expires.
                    if (peerId == this@TransferController.peerId && peerId.isNotEmpty() &&
                        !isLinkEstablished
                    ) {
                        endSession("error_connection_lost")
                    }
                    // The PRE-handshake half of the same departure, and the two
                    // halves are not covered by the same thing.
                    //
                    // A QUEUED frame is the reachable one: it was held before
                    // any establishment ran, so [peerId] is still empty, the
                    // branch above does not fire, and when the grant lands the
                    // held offer builds a `PeerConnection` to a device that
                    // left — which then burns the whole setup deadline. Only
                    // removing it here prevents that.
                    //
                    // A held connection DECISION is already fenced: every
                    // caller of [startTransport] sets [peerId] before it
                    // defers, so the branch above ends the session, the epoch
                    // moves, and the decision drops itself. Invalidating it by
                    // name is belt and braces for a future caller that does
                    // not.
                    forgetHeldRoomWork(peerId)
                    if (peerId == pendingPeer) clearPendingAdmission()
                    declinedPeers.remove(peerId)?.timer?.cancel(false)
                    if (admission == PeerAdmission.EXPLICIT) publishNearby()
                }
                override fun onIceGrant(data: Json) = postRoom(room) {
                    // The grant belongs to the ROOM that asked. The engine
                    // correlates it by rid on top of that, and a room switch
                    // retires the engine with its link, so one room's
                    // credentials cannot reach the next room's.
                    renewal?.onGrant(data)
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

    private fun onWelcome(id: String, ip: String) {
        if (id.isEmpty()) {
            if (admission == PeerAdmission.EXPLICIT) failRoom("error_nearby_unavailable")
            else endSession("error_network")
            return
        }
        // The registry and every signed leave payload bind to the REAL room id.
        selfId = id
        if (admission != PeerAdmission.EXPLICIT) {
            // Joined — for the first time or again. Only a drop AFTER this is a
            // drop; the retry budget is for consecutive failures, not a lifetime.
            pairingWelcomed = true
            pairingDrops = 0
            // The roster that follows the welcome moves the phase on, as it does
            // for a first join; only the "reconnecting" note is this line's.
            if (_state.value.reconnecting) _state.value = _state.value.copy(reconnecting = false)
        }
        linkSession = LinkSession(id)
        // A join is what proves a retry worked; anything short of it and the
        // next drop must not start from zero again.
        reconnectAttempt = 0
        if (admission == PeerAdmission.EXPLICIT) {
            _state.value = _state.value.copy(
                nearby = _state.value.nearby.copy(
                    room = NearbyRoom.JOINED,
                    // What relayium.com SAW this device arrive from, and
                    // therefore the room it was put in. It used to be dropped
                    // here, so the screen could not answer the one question a
                    // user with an empty list has — "am I even in the same room
                    // as the computer?" — which the website answers on its face.
                    publicIp = ip,
                ),
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
            forgetDeclined(keep = { it in present })
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

        // The relayium CLI joined this code room. Recognised by SHAPE and
        // CONSUMED here, before anything else looks at the frame, for the same
        // reason the renewal envelope below is: `Signal.fromJson` would read the
        // CLI's `commit` field as an app's commit and start a handshake that can
        // never finish. Ended on the spot rather than waited out — the CLI exits
        // on our own capability hello about 0.2 s from now, so the 35 s this
        // used to spend produced no further evidence, only the wrong sentence.
        if (CliPeerSignal.isHandshake(data)) {
            endSession("error_cli_peer")
            return
        }

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

        // A renewal envelope, recognised by SHAPE before anything cryptographic
        // and CONSUMED here whatever its contents.
        //
        // Routing stops at this line, and that is the point rather than an
        // optimisation: a `link`-generation frame is also seen by any
        // establishment in flight for this peer, and the whole reason SDP and
        // ICE are nested inside `renew` is that a top-level one would be
        // applied by the ordinary handler as a real, unauthenticated
        // renegotiation against a live PeerConnection. An envelope from anyone
        // but the established peer, or one that arrives with no renewal
        // machinery at all, is dropped in silence.
        if (RelayRenewWire.isRenewEnvelope(data)) {
            if (from == peerId) renewal?.onSignal(data)
            return
        }

        // This room's ICE grant is still in flight, and there is no connection
        // yet — so everything from here down can end in a `PeerConnection`: an
        // offer establishes directly, a request or a prompt establishes a
        // moment later, and one built now would be built with no STUN and no
        // relay. Held in arrival order, so the offer that raised an admission
        // still precedes the candidates that chased it, and replayed through
        // this same function once the grant lands. See [openRoom].
        //
        // The `transport == null` clause scopes the hold to exactly what needs
        // the grant. No room reopens under a live connection today — both
        // [failRoom] and [onRoomClosed] defer that until the connection ends —
        // so it changes no current path; it is there because a frame routed
        // into an EXISTING transport builds nothing, and the day that ordering
        // changes, a live link's own signalling (its peer's authenticated
        // leave included) must not queue behind an HTTP round trip it has no
        // use for.
        if (transport == null && !roomIceReady()) {
            // Only what could still MATTER when it is replayed takes the hold.
            // Traffic this client discards on arrival anyway must not be able
            // to spend a room's bounded buffer — and, past the bound, end a
            // session with frames that would have been ignored.
            if (!heldSignalMatters(from, signal)) return
            if (heldRoomSignals.size >= LinkProtocol.HELD_SIGNAL_MAX) {
                // More than a whole establishment's worth of REAL asks inside
                // one ICE fetch. The buffer is dropped WITH the session rather
                // than grown: a peer that can make it unbounded owns this
                // process's memory. The FETCH is left alone — in a Nearby room
                // the room survives this, and cancelling its grant would wedge
                // the gate shut for good.
                heldRoomSignals.clear()
                heldStart = null
                endSession("error_connection_lost")
                return
            }
            heldRoomSignals.add(from to data)
            return
        }

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
        startTransport(mine, from, WireProfile.Legacy(LinkProtocol.Role.RESPONDER, lane), listOf(data))
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

        // Declined inside that prompt's window: a retry of the SAME ask is
        // refused in band, and the user is not asked a second time.
        if (declinedPeers.containsKey(from)) {
            if (asks) signaling?.sendSignal(from, Signal.busy().toJson())
            return
        }

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
        val prompt = pendingPromptId
        pendingTimer = session.schedule(
            {
                if (roomGen != room) return@schedule
                if (pendingPeer != null && pendingPromptId == prompt) {
                    pendingTimer = null
                    rejectPendingAdmission(null)
                    return@schedule
                }
                // The prompt was DECLINED and this is its deadline: the window
                // for retries of that ask is over, so the mark goes with it.
                declinedPeers.entries.removeAll { it.value.promptId == prompt }
            },
            deps.timeouts.pendingAdmissionMs, TimeUnit.MILLISECONDS,
        )
    }

    /** Drop the decline marks for peers no longer present, or all of them. */
    private fun forgetDeclined(keep: (String) -> Boolean = { false }) {
        val it = declinedPeers.entries.iterator()
        while (it.hasNext()) {
            val entry = it.next()
            if (keep(entry.key)) continue
            entry.value.timer?.cancel(false)
            it.remove()
        }
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
    private fun rejectPendingAdmission(errorKey: String?, declined: Boolean = false) {
        val peer = pendingPeer
        if (declined && peer != null) {
            // The prompt's deadline timer is handed to the mark instead of being
            // cancelled: when it fires it retires the mark.
            declinedPeers.remove(peer)?.timer?.cancel(false)
            declinedPeers[peer] = DeclineMark(pendingPromptId, pendingTimer)
            pendingTimer = null
        }
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
            verification = Verification.NONE,
            heldFiles = 0,
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
        if (pendingPeer != null) rejectPendingAdmission(null, declined = true)
        // The person chose this device now; an earlier "no" to it is superseded.
        declinedPeers.remove(peerId)?.timer?.cancel(false)
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
        // The offer that raised the prompt, then whatever chased it, carried
        // WITH the decision: the user's consent is spent here, and a grant
        // still in flight must defer the connection without losing the SDP the
        // peer has already sent and will not repeat.
        startTransport(mine, peerId, profile, buffered)
    }

    /** The user refused the prompt naming [peerId]. The room continues.
     *  [expectedPrompt] identifies the question being answered — see
     *  [admitPeer]. */
    fun rejectPeer(peerId: String, expectedPrompt: Int) = post {
        if (expectedPrompt != pendingPromptId) return@post
        if (pendingPeer != peerId) return@post
        rejectPendingAdmission(null, declined = true)
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
        if (transport != null) return
        // Two different events used to share one sentence. A room that closes
        // BEFORE it ever welcomed this device is the server refusing the code —
        // wrong, expired, full. A room that closes AFTER the welcome is a
        // dropped socket: the screen slept, Wi-Fi handed over to cellular, the
        // server restarted. Telling that user "That code is not active" was
        // untrue — the code was usually still alive — and it threw away the
        // digits they had just read out. The website makes the same split and
        // reconnects (web/src/App.svelte, `joinedRoom`).
        if (pairingWelcomed && schedulePairingReconnect()) return
        endSession(if (pairingWelcomed) "error_network" else "error_code_not_found")
    }

    private fun onRoomFailed() {
        if (admission == PeerAdmission.EXPLICIT) {
            failRoom("error_nearby_unavailable")
            return
        }
        if (transport != null) return
        // A FAILURE is the network, not the server's answer, so it also covers a
        // rejoin that could not get out at all: the network that dropped the
        // socket is usually still down for the first retry or two. Only the
        // budget ends that, never the first miss.
        if ((pairingWelcomed || pairingDrops > 0) && schedulePairingReconnect()) return
        endSession("error_network")
    }

    /**
     * Rejoin the SAME pairing room after its socket dropped while waiting.
     *
     * Bounded, unlike Nearby's: a code expires, and a client that retried for
     * ever would sit on a dead code looking alive. When the code really has gone
     * the rejoin closes before its welcome — and [pairingWelcomed] is cleared
     * here, so that close reads as what it is, a refused code.
     *
     * Its own counter, because [closeRoom] zeroes [reconnectAttempt].
     */
    private fun schedulePairingReconnect(): Boolean {
        val src = source as? ConnectionSource.Pairing ?: return false
        if (pairingDrops >= deps.timeouts.pairingReconnectLimit) return false
        val step = ROOM_BACKOFF_STEPS[minOf(pairingDrops, ROOM_BACKOFF_STEPS.size - 1)]
        pairingDrops++
        pairingWelcomed = false
        releaseRoomObjects()
        roomGen++
        val room = roomGen
        _state.value = _state.value.copy(phase = Phase.CONNECTING, reconnecting = true)
        reconnectTimer = session.schedule(
            {
                reconnectTimer = null
                if (roomGen != room) return@schedule
                openRoom(room, src)
            },
            deps.timeouts.roomRetryMs * step, TimeUnit.MILLISECONDS,
        )
        return true
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
        resetRoomIce()
        helloTimer?.cancel(false)
        helloTimer = null
        clearPendingAdmission()
        forgetDeclined()
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
        // Read BEFORE the release: [releaseRoomObjects] goes through [closeRoom],
        // which zeroes [reconnectAttempt]. Reading it afterwards made every retry
        // the FIRST retry, so the backoff documented above never grew — a device
        // on a dead network re-dialled every two seconds for as long as the
        // screen stayed on, instead of settling at thirty.
        val attempt = reconnectAttempt
        // Safe now: nothing is bound to the old room's identity.
        releaseRoomObjects()
        val step = ROOM_BACKOFF_STEPS[minOf(attempt, ROOM_BACKOFF_STEPS.size - 1)]
        val delay = if (immediate) 0L else deps.timeouts.roomRetryMs * step
        reconnectAttempt = attempt + 1
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

    /**
     * Build the connection — the ONE place a `PeerConnection` comes into
     * existence, and therefore the one place the room's ICE grant is required.
     *
     * @param replay establishment frames that already arrived for this
     *   connection, fed in arrival order once it exists. They travel WITH the
     *   decision rather than being sent afterwards, because a decision this
     *   function defers would otherwise drop them into a null transport — the
     *   offer that raised an admission prompt is exactly such a frame, and the
     *   peer does not repeat it.
     */
    private fun startTransport(
        mine: Int,
        peer: String,
        profile: WireProfile,
        replay: List<Json> = emptyList(),
    ) {
        if (!roomIceReady()) {
            // Held whole, with its frames, and re-fenced on replay: the link
            // may have been retired and the room replaced while the grant was
            // in flight, and [resetRoomIce] discards this outright when it is.
            heldStart = HeldStart(peer) {
                if (epoch == mine && transport == null) startTransport(mine, peer, profile, replay)
            }
            return
        }
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
                    if (epoch != mine) return
                    val lane = fileLane ?: return
                    // ACK progress is real user data: it is the peer stating
                    // that bytes this side sent were durably received. Read
                    // across the frame rather than from an action, because an
                    // ACK produces no action of its own.
                    val ackedBefore = lane.ackedContentBytes
                    val actions = lane.onFrame(frame)
                    if (lane.ackedContentBytes > ackedBefore) noteUserData()
                    apply(mine, actions)
                }
                override fun onTextFrame(frame: ByteArray) {
                    if (epoch != mine) return
                    // A TRUE FRONT DEMUX, not an observer: a renewal control
                    // frame is CONSUMED here and reaches nothing below.
                    //
                    // Three things must not see it, and each would be a real
                    // failure rather than an untidiness: the text session's
                    // inbound rate budget (a burst would fail the lane on
                    // BOUNDS), the ten-minute idle clock (renewal traffic is
                    // explicitly not user activity), and the AEAD receiver.
                    // Because this runs inside the transport's own event, it
                    // also covers frames replayed from pre-attachment capture.
                    if (RelayRenewProbe.isControlFrame(frame)) {
                        renewal?.onControlFrame(frame)
                        return
                    }
                    textLane?.let {
                        lastTextActivity = System.currentTimeMillis()
                        applyText(mine, it.onFrame(frame))
                    }
                }
                override fun onClosed(reason: String) {
                    if (epoch == mine) onTransportClosed(reason)
                }
                override fun onInterrupted(interrupted: Boolean) {
                    if (epoch == mine) _state.value = _state.value.copy(linkInterrupted = interrupted)
                }
            },
        )
        transport = link
        _state.value = _state.value.copy(phase = Phase.CONNECTING)
        link.start()
        // In arrival order, into a transport that exists.
        for (data in replay) {
            if (epoch != mine) return
            transport?.onSignal(data)
        }
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
            Wire.LINK -> TextLaneSession(
                sessionKeys, frameBytes,
                initiator = LinkProtocol.linkRole(selfId, peerId) == LinkProtocol.Role.INITIATOR,
            )
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
        startRenewal(epoch)
        // Read once, here. A toggle later in this link changes nothing on it.
        val verify = deps.verifyPeers()
        heldBatch = null
        busyReplay = null
        outgoingSources = null
        _state.value = _state.value.copy(
            phase = Phase.CONNECTED,
            wire = wire,
            sas = sas,
            verification = if (verify) Verification.PENDING else Verification.NONE,
            heldFiles = 0,
            errorKey = null,
            textState = text?.state ?: TextLaneSession.State.IDLE,
            textLimit = text?.plainLimit ?: com.relayium.protocol.TextWire.MAX_BYTES,
            textCanRequest = text?.canRequest ?: false,
        )
    }

    // ── relay renewal (`docs/protocol/relay-renew-v1.md`) ───────────────────

    /**
     * Start the renewal machinery for a freshly ready link.
     *
     * Only for `link/1`: the older wires carry neither the signed envelope nor
     * the control frame, and pretending otherwise would announce a capability
     * this connection cannot honour.
     *
     * Nothing here arms a boundary. The link becomes bounded only when the ICE
     * agent reports a selected pair that classifies as RELAY — see
     * [onSelectedPair]. That is deliberately evidence-first: a link whose
     * selected pair is never reported keeps exactly today's behaviour, which is
     * the safe direction on a platform where the callback's availability is a
     * runtime fact.
     */
    private fun startRenewal(mine: Int) {
        renewal?.close()
        renewal = null
        relayBound = null
        installedIce = null
        cancelRelayTimers()
        if (wireProfile !is WireProfile.Link) return
        val surface = transport?.renew() ?: return
        val engine = RelayRenewEngine(
            object : RelayRenewEngine.Deps {
                override fun now(): Long = System.currentTimeMillis()

                override fun timers(): RelayRenewEngine.Timers =
                    RelayRenewEngine.Timers { delayMs, task ->
                        val future = session.schedule(
                            { if (epoch == mine) task() },
                            delayMs, TimeUnit.MILLISECONDS,
                        )
                        RelayRenewEngine.Timer { future.cancel(false) }
                    }

                override fun selfId(): String = selfId
                override fun peerId(): String = peerId
                override fun isInitiator(): Boolean =
                    (wireProfile as? WireProfile.Link)?.role == LinkProtocol.Role.INITIATOR

                override fun keys(): Crypto.SessionKeys? = keys
                override fun transport(): RenewTransport? =
                    if (epoch == mine) transport?.renew() else null

                override fun peerSupportsRenew(): Boolean =
                    linkSession?.peerAnnounced(peerId, RelayRenewWire.CAPABILITY) == true

                override fun userActive(): Boolean = userData.active(System.currentTimeMillis())

                override fun sendRenew(data: Json) {
                    if (epoch != mine) return
                    signaling?.sendSignal(peerId, data)
                }

                override fun requestRound(round: Long, rid: Long): Boolean {
                    if (epoch != mine) return false
                    // False on a rendezvous with no server to ask. A LAN or
                    // direct session cannot make this call, because the handle
                    // it holds does not implement it.
                    return signaling?.requestIceRenew(round, rid) == true
                }

                override fun randomBytes(count: Int): ByteArray =
                    ByteArray(count).also(renewRandom::nextBytes)

                override fun randomUint32(): Long =
                    renewRandom.nextInt().toLong() and RelayRenewWire.UINT32_MAX

                override fun onConfigurationInstalled(servers: List<IceConfig.Server>) {
                    if (epoch != mine) return
                    // The live connection is running on THESE servers now.
                    // Every later boundary derivation and path classification
                    // must read them rather than the configuration the room was
                    // originally issued, which may already have lapsed.
                    installedIce = servers
                }

                override fun onRenewState(
                    state: RelayRenewEngine.State,
                    commit: RelayRenewEngine.Commit?,
                ) {
                    if (epoch != mine) return
                    onRenewalState(mine, state, commit)
                }
            },
        )
        renewal = engine
        // ALWAYS-ON, and owned here rather than by the engine: the FIRST
        // observation is what classifies the path and decides whether this link
        // is bounded at all, which is a question that exists with or without a
        // renewal in flight.
        surface.onSelectedPair { pair -> if (epoch == mine) onSelectedPair(mine, pair) }
    }

    /**
     * The ICE agent reported the pair it is actually using.
     *
     * Two separate jobs, in this order:
     *
     *  - classify. A relay on either side means this link is bounded by the
     *    ephemeral credential the server issued; host-to-host is a LAN hop and
     *    anything else is a NAT-traversed direct path, and neither of those is
     *    bounded by anything. A path that becomes direct RELEASES the boundary,
     *    exactly as the existing rule does elsewhere.
     *  - forward. Only the renewal engine can decide whether this observation
     *    belongs to the generation an epoch is trying to migrate onto.
     */
    private fun onSelectedPair(mine: Int, pair: RenewTransport.SelectedPair) {
        if (com.relayium.protocol.RelayRenewSdp.classifyPath(pair.local, pair.remote) ==
            com.relayium.protocol.RelayRenewSdp.Path.RELAY
        ) {
            if (relayBound == null) armRelayBound(mine, deriveRelayBound())
        } else if (relayBound != null) {
            armRelayBound(mine, null)
        }
        renewal?.onSelectedPair(pair)
    }

    /**
     * The boundary the configuration this connection is ACTUALLY running on
     * states, or null when nothing in it can hold a TURN allocation.
     *
     * [installedIce] wins over the room's original grant whenever a renewal has
     * applied one: after a migration the original credential may already have
     * lapsed, and deriving a boundary from it would either end a healthy link
     * early or — worse — read an expiry that no longer describes anything the
     * connection uses.
     */
    private fun deriveRelayBound(): RelayRenewPolicy.Deadline? = RelayRenewPolicy.deadline(
        (installedIce ?: ice.servers).map { RelayRenewPolicy.Credential(it.urls, it.username) },
        System.currentTimeMillis(),
    )

    /**
     * Arm, move or release the relayed link's boundary.
     *
     * The warning and the ending are the EXISTING truthful fallback whenever a
     * renewal has not committed, and they are what renewal moves rather than
     * replaces.
     *
     * Ending on the boundary is this CLIENT's policy, not a claim about the
     * relay. Whether a TURN engine tears an existing allocation down when its
     * credential expires is not established, and an allocation may outlive the
     * credential that created it — so this does not end the link because the
     * bytes have necessarily stopped. It ends it because the credential's
     * authority has lapsed, nothing on the wire announces that, and continuing
     * on a lapsed credential is the one state neither end can honestly report.
     */
    private fun armRelayBound(mine: Int, bound: RelayRenewPolicy.Deadline?) {
        cancelRelayTimers()
        relayBound = bound
        renewal?.bindDeadline(bound)
        if (bound == null) {
            _state.value = _state.value.copy(relayExpiresAt = null, relayExpiryWarning = false)
            return
        }
        val now = System.currentTimeMillis()
        _state.value = _state.value.copy(
            relayExpiresAt = bound.deadlineAt,
            relayExpiryWarning = now >= bound.warnAt,
        )
        if (now < bound.warnAt) {
            relayWarnTimer = session.schedule(
                {
                    relayWarnTimer = null
                    if (epoch != mine || relayBound !== bound) return@schedule
                    _state.value = _state.value.copy(relayExpiryWarning = true)
                },
                bound.warnAt - now, TimeUnit.MILLISECONDS,
            )
        }
        relayExpiryTimer = session.schedule(
            {
                relayExpiryTimer = null
                if (epoch != mine || relayBound !== bound) return@schedule
                // Truthful, and named: the credential this relayed link was
                // issued has run out. Left to itself the connection would sit
                // `connected` and silently stop transferring until the
                // disconnect grace gave up with a generic "connection lost".
                endSession("error_relay_expired")
            },
            maxOf(0L, bound.deadlineAt - now), TimeUnit.MILLISECONDS,
        )
    }

    /**
     * One renewal state change. The boundary moves ONLY on a commit that says
     * it moved.
     *
     * A same-round repair is a real, committed migration — the path was
     * re-established and the UI may say so — and it still changes nothing about
     * the credential, because it re-used the one already installed. Re-arming
     * the timers on it would extend a boundary on no new authority, so the
     * engine states the difference and this acts on exactly that.
     */
    private fun onRenewalState(
        mine: Int,
        state: RelayRenewEngine.State,
        commit: RelayRenewEngine.Commit?,
    ) {
        if (commit != null && commit.boundaryMoved) {
            armRelayBound(mine, commit.deadline)
        }
        _state.value = _state.value.copy(renewState = state)
    }

    private fun cancelRelayTimers() {
        relayWarnTimer?.cancel(false)
        relayWarnTimer = null
        relayExpiryTimer?.cancel(false)
        relayExpiryTimer = null
    }

    /** Real authenticated user-lane data moved. */
    private fun noteUserData() {
        userData.note(System.currentTimeMillis())
        // Re-evaluated immediately, because the margin is a window rather than
        // a moment: a conversation that resumes at minute 55 of a one-hour
        // grant must still be able to renew.
        renewal?.noteUserData()
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
                    // Only a PROTECTED frame is user data. The lane's own
                    // classifier decides, so consent bytes, ACK headers and
                    // resume control can never be mistaken for content.
                    if (LinkProtocol.fileFrameClass(action.frame) ==
                        LinkProtocol.FileFrameClass.Protected
                    ) {
                        noteUserData()
                    }
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
                is FileLaneSession.Action.Write -> {
                    // Authenticated file plaintext, decrypted and about to be
                    // written. There is no plainer statement of "this link is
                    // being used" than this.
                    noteUserData()
                    onWrite(mine, action)
                }
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
                is FileLaneSession.Action.SendComplete -> {
                    outgoingSources = null
                    _state.value = _state.value.copy(
                        sendProgress = null,
                        outgoing = emptyList(),
                        sentBatch = true,
                        sentBatchCount = _state.value.sentBatchCount + 1,
                    )
                }
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
        replayBusyBatch(mine, lane)
    }

    /**
     * Re-offer a BUSY-answered batch, once, as soon as the lane can carry it:
     * nothing outgoing on the lane and nothing incoming either. Every lane
     * transition funnels through [apply], so checking at its end sees the
     * moment the peer's own batch retires — completed, declined or aborted.
     */
    private fun replayBusyBatch(mine: Int, lane: FileLaneSession) {
        val pending = busyReplay ?: return
        if (epoch != mine || pending.link != epoch || fileLane !== lane) return
        if (_state.value.fileLaneDown || verificationPending) return
        val sendFree = lane.sendState == FileLaneSession.SendState.IDLE ||
            lane.sendState == FileLaneSession.SendState.DONE
        val receiveFree = lane.receiveState == FileLaneSession.ReceiveState.IDLE ||
            lane.receiveState == FileLaneSession.ReceiveState.DONE
        if (!sendFree || !receiveFree) return
        busyReplay = null
        startOutgoing(lane, pending.sources, replayed = true)
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
                val sources = outgoingSources
                outgoingSources = null
                if (failure.reason == FileLaneSession.Failure.Reason.PEER_BUSY &&
                    sources != null && !outgoingReplayed
                ) {
                    // Requeued, not failed: the card keeps the batch listed as
                    // waiting, and [replayBusyBatch] re-offers it once.
                    busyReplay = HeldBatch(sources, epoch)
                    _state.value = _state.value.copy(sendProgress = null)
                } else {
                    _state.value = _state.value.copy(
                        errorKey = key ?: _state.value.errorKey,
                        sendProgress = null,
                        outgoing = emptyList(),
                    )
                }
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
                busyReplay = null
                outgoingSources = null
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
        // Accepting releases a write to this user's disk: never before the codes
        // were compared. The prompt STAYS — it is answered after the compare.
        if (verificationPending) return@post
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
        if (verificationPending) {
            // HELD, not sent and not dropped: the user asked for this batch and
            // is owed it once they have compared the codes. One batch, as the
            // lane itself carries one at a time; a second is refused.
            if (heldBatch == null) {
                heldBatch = HeldBatch(sources, epoch)
                _state.value = _state.value.copy(heldFiles = sources.size)
            }
            return@post
        }
        startOutgoing(lane, sources)
    }

    private fun startOutgoing(
        lane: FileLaneSession,
        sources: List<OutgoingSource>,
        replayed: Boolean = false,
    ) {
        val mine = epoch
        retirePump()
        batchGen++
        val myBatch = batchGen
        outgoingSources = sources
        outgoingReplayed = replayed
        _state.value = _state.value.copy(
            outgoing = sources.map { it.meta },
            // A fresh user send clears the last error; an automatic BUSY replay
            // must not hide one the user has not seen yet — e.g. the incoming
            // batch it waited for having just failed verification.
            errorKey = if (replayed) _state.value.errorKey else null,
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
        if (heldBatch != null) {
            // A batch that never reached the lane: nothing to tell the peer.
            heldBatch = null
            _state.value = _state.value.copy(heldFiles = 0)
            return@post
        }
        // A batch waiting for its BUSY replay is the batch the card shows; the
        // user's cancel retires it without telling the peer anything — the
        // peer already retired it when it answered BUSY.
        busyReplay = null
        outgoingSources = null
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
        var requestedNow = false
        var openedNow = false
        for (action in actions) {
            when (action) {
                is TextLaneSession.Action.Send -> {
                    // A CONTENT frame is user data; REQUEST, ACCEPT, REJECT and
                    // END are consent and lifecycle, and section 7.1 is explicit
                    // that a pending-consent flag is not activity.
                    if (com.relayium.protocol.TextWire.isTextFrame(action.frame)) noteUserData()
                    if (!enqueueFailed && transport?.sendText(action.frame) != true) {
                        enqueueFailed = true
                    }
                }
                is TextLaneSession.Action.Received -> {
                    noteUserData()
                    _state.value = _state.value.copy(
                        messages = (_state.value.messages + Message(action.body, fromPeer = true))
                            .takeLast(TextSessionLimits.HISTORY_MAX),
                    )
                }
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
                is TextLaneSession.Action.Requested -> requestedNow = true
                is TextLaneSession.Action.Opened -> openedNow = true
                // A DRAIN is authenticated peer text this side deliberately
                // does not show, because the local user ended the
                // conversation. It is not counted as user data: the drain
                // exists to keep the receive counter continuous, and treating
                // it as consent would let a peer hold a relayed link renewable
                // against the wishes of the person who closed it.
                is TextLaneSession.Action.Drained,
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
        if (!isLegacy) {
            // On `link/1` the conversation is part of the ONE workspace, as it is
            // on the website, the Mac and the iPhone: they open the lane by
            // themselves and admit an incoming request without asking. Here it
            // needed a "Start a conversation" tap on one side and an "Accept" on
            // the other, in a card below the fold — while the browser at the far
            // end sat in "waiting for accept" with Send disabled and neither
            // screen said why. The pair was already admitted and authenticated
            // when the link came up; this is not a second consent. The older
            // wire keeps its prompt: there the conversation IS the connection.
            // Not while the codes are unanswered: the request is HELD in
            // INCOMING_REQUEST and admitted by [confirmSas].
            if (requestedNow && lane.state == TextLaneSession.State.INCOMING_REQUEST &&
                !verificationPending
            ) {
                lastTextActivity = System.currentTimeMillis()
                // Counted, because the state passes through INCOMING_REQUEST in
                // one executor turn and an observer polling the published state
                // may never see it: an acceptance that has to account for who
                // opened the conversation reads this instead of guessing.
                _state.value = _state.value.copy(textAutoAdmits = _state.value.textAutoAdmits + 1)
                applyText(mine, lane.accept())
            }
            if (openedNow || lane.state == TextLaneSession.State.OPEN) flushPendingText()
            if (lane.state == TextLaneSession.State.ENDED || lane.state == TextLaneSession.State.FAILED) {
                dropPendingText()
            }
        }
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
        if (verificationPending) return@post
        val lane = textLane ?: return@post
        lastTextActivity = System.currentTimeMillis()
        if (lane.canRequest) applyText(epoch, lane.request())
    }

    fun acceptText() = post {
        if (verificationPending) return@post
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
        // Refused, not held, while the codes are unanswered — as on Apple, where
        // the composer is closed until then. The draft stays in the field.
        if (verificationPending) {
            onOutcome?.invoke(false)
            return@post
        }
        val lane = textLane ?: run { onOutcome?.invoke(false); return@post }
        if (lane.state != TextLaneSession.State.OPEN) {
            // `link/1`: typing and pressing Send IS how a conversation starts, as
            // on iOS (`flushOrOpenConversation`). Open the lane, hold this one
            // message, and send it the moment the peer's ACCEPT lands. One held
            // message, not a queue: a second Send before the first has gone is
            // refused, so the draft stays in the field rather than piling up
            // behind a lane that may never open.
            val canOpen = !isLegacy && pendingText == null &&
                (lane.canRequest || lane.state == TextLaneSession.State.INCOMING_REQUEST ||
                    lane.state == TextLaneSession.State.REQUESTED)
            if (!canOpen) {
                onOutcome?.invoke(false)
                return@post
            }
            pendingText = PendingText(body, epoch, onOutcome)
            lastTextActivity = System.currentTimeMillis()
            when {
                lane.state == TextLaneSession.State.INCOMING_REQUEST -> applyText(epoch, lane.accept())
                lane.canRequest -> applyText(epoch, lane.request())
                // Already REQUESTED: the ACCEPT that is on its way flushes it.
            }
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

    private class PendingText(val body: String, val link: Int, val onOutcome: ((Boolean) -> Unit)?)

    /** The one message typed before the lane was open. See [sendText]. */
    private var pendingText: PendingText? = null

    private fun flushPendingText() {
        val pending = pendingText ?: return
        pendingText = null
        val lane = textLane
        if (lane == null || pending.link != epoch || lane.state != TextLaneSession.State.OPEN) {
            pending.onOutcome?.invoke(false)
            return
        }
        if ((transport?.textBufferedAmount() ?: 0) > TextSessionLimits.SEND_BUFFER_MAX) {
            _state.value = _state.value.copy(errorKey = "error_text_buffer_full")
            pending.onOutcome?.invoke(false)
            return
        }
        lastTextActivity = System.currentTimeMillis()
        val actions = lane.send(pending.body)
        val hadFrame = actions.any { it is TextLaneSession.Action.Send }
        val sent = hadFrame && applyText(epoch, actions)
        if (sent) {
            _state.value = _state.value.copy(
                messages = (_state.value.messages + Message(pending.body, fromPeer = false))
                    .takeLast(TextSessionLimits.HISTORY_MAX),
            )
        }
        pending.onOutcome?.invoke(sent)
    }

    /** The lane ended or failed before it opened: the draft was NOT sent, and the
     *  caller keeps it in the field. */
    private fun dropPendingText() {
        val pending = pendingText ?: return
        pendingText = null
        pending.onOutcome?.invoke(false)
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

    // ── the verification boundary (A31 a) ───────────────────────────────────

    private class HeldBatch(val sources: List<OutgoingSource>, val link: Int)

    /** The one outgoing batch held behind [Verification.PENDING]. */
    private var heldBatch: HeldBatch? = null

    /**
     * The sources of the outgoing batch currently on the lane, and whether it
     * is already its one BUSY replay. Kept so a peer BUSY can requeue it.
     */
    private var outgoingSources: List<OutgoingSource>? = null
    private var outgoingReplayed = false

    /**
     * An outgoing batch the peer answered with BUSY, waiting for its ONE replay
     * (A08e-D5). The Web and Go requeue a busy batch once and re-offer it when
     * their lane is free (`requeueOrFail` → `pump`, which waits while a batch is
     * arriving); a second BUSY is the user-visible failure. The peer answers
     * BUSY in glare — the initiator keeps its own offer — so the batch it is
     * busy with is usually the one this side is about to be prompted for:
     * the replay therefore waits until this side's incoming batch has retired
     * too, see [replayBusyBatch].
     */
    private var busyReplay: HeldBatch? = null

    private val verificationPending: Boolean
        get() = _state.value.verification == Verification.PENDING

    /**
     * The user compared the codes and they MATCH. The only way held work is
     * released, and released once: the held batch first, because it is what the
     * user asked for before they were asked anything, then a conversation the
     * peer requested while the codes were on screen (`link/1` only; the older
     * wire keeps its own prompt).
     *
     * [expectedLink] is the [State.linkId] the screen was showing: an answer
     * composed against one link must not confirm the next.
     */
    fun confirmSas(expectedLink: Int) = post {
        if (expectedLink != epoch) return@post
        if (!verificationPending) return@post
        _state.value = _state.value.copy(verification = Verification.CONFIRMED, heldFiles = 0)
        val held = heldBatch
        heldBatch = null
        val files = fileLane
        if (held != null && held.link == epoch && files != null && !_state.value.fileLaneDown) {
            startOutgoing(files, held.sources)
        }
        val text = textLane
        if (!isLegacy && text != null && text.state == TextLaneSession.State.INCOMING_REQUEST) {
            lastTextActivity = System.currentTimeMillis()
            _state.value = _state.value.copy(textAutoAdmits = _state.value.textAutoAdmits + 1)
            applyText(epoch, text.accept())
        }
    }

    /**
     * The codes DIFFER. Terminal and named as its own ending, so the screen can
     * say why rather than report an ordinary hangup. Nothing held was sent, and
     * nothing is: the held batch goes with the link.
     */
    fun rejectSas(expectedLink: Int) = post {
        if (expectedLink != epoch) return@post
        if (!verificationPending) return@post
        heldBatch = null
        announceLeave()
        endSession("error_verification_rejected")
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
                verification = Verification.NONE,
                heldFiles = 0,
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
                // The boundary belonged to the link that just ended, not to the
                // room: a stale expiry standing over a fresh list would count
                // down to nothing.
                relayExpiresAt = null,
                relayExpiryWarning = false,
                renewState = RelayRenewEngine.State.IDLE,
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
            verification = Verification.NONE,
            heldFiles = 0,
            receiveProgress = null,
            sendProgress = null,
            awaitingFolder = false,
            relayExpiresAt = null,
            relayExpiryWarning = false,
            renewState = RelayRenewEngine.State.IDLE,
        )
        closeOnSession()
    }

    /** Every timer a CONNECTION owns. The hello retry is not one of them: it
     *  belongs to the room. */
    private fun cancelConnectionTimers() {
        for (timer in listOf(
            settleTimer, requestRetryTimer, requestDeadlineTimer,
            textEndTimer, abortBarrierTimer, textIdleTimer, legacyOfferTimer,
            relayWarnTimer, relayExpiryTimer,
        )) {
            timer?.cancel(false)
        }
        settleTimer = null; requestRetryTimer = null; requestDeadlineTimer = null
        textEndTimer = null; abortBarrierTimer = null; textIdleTimer = null
        legacyOfferTimer = null
        relayWarnTimer = null; relayExpiryTimer = null
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
        // BEFORE the timers are cancelled and before the transport goes: every
        // renewal timer, request, subscriber and retained nonce is disposed
        // with the link that owns them, and no late callback can resurrect an
        // epoch afterwards.
        renewal?.close()
        renewal = null
        relayBound = null
        installedIce = null
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
        dropPendingText()
        heldBatch = null
        busyReplay = null
        outgoingSources = null
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
        forgetDeclined()
        runCatching { signaling?.close() }
        signaling = null
        linkSession = null
        selfId = ""
        roster = emptyList()
        source = null
        roomRetryPending = false
        reconnectAttempt = 0
        ice = IceConfig.Result(emptyList(), "")
        resetRoomIce()
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
     * whole ordered sequence: announce the leave to a linked peer (best
     * effort, as on Disconnect), tear the transport and signalling down FIRST
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
                // The screen going away ends the link as surely as Disconnect
                // does, so the peer is told the same way; without it a CLI or
                // app peer can only report the link as lost (A12).
                announceLeave()
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
