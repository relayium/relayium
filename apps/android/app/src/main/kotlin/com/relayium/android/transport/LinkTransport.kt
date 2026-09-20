package com.relayium.android.transport

import android.content.Context
import com.relayium.protocol.Crypto
import com.relayium.protocol.Json
import com.relayium.protocol.LinkProtocol
import com.relayium.protocol.LinkSession
import com.relayium.protocol.RealtimeFrame
import com.relayium.protocol.RelayRenewSdp
import com.relayium.protocol.Signal
import com.relayium.protocol.legacy.WireProfile
import java.nio.ByteBuffer
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import org.webrtc.CandidatePairChangeEvent
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription

/**
 * One `link/1` connection: a real `PeerConnection`, the exact two lanes, and
 * the commit-reveal handshake driven by [LinkSession.Handshake].
 *
 * ## Ownership
 *
 * Every mutation of this object runs on the ONE injected [executor] thread —
 * the same thread the controller owns. Native WebRTC and OkHttp callbacks post
 * onto it and check [closed] before any effect, so there is no lock, no
 * half-observed state, and no callback that can race a close.
 *
 * That hop is also what makes disposal legal: `PeerConnection.dispose()` must
 * not run on the observer's own stack (its javadoc requires the observer to
 * have unwound), and here it structurally cannot — close is always a posted
 * task on the executor thread, never inline in a native callback.
 */
class LinkTransport(
    context: Context,
    /**
     * Which wire this connection speaks: its role, its channel labels and the
     * shape of its four signals.
     *
     * The role is HANDED IN rather than computed here. `link/1` derives it from
     * the two room ids and the legacy wire derives it from the user's intent,
     * and a transport that recomputed one of those would be a second, quietly
     * different answer to a question its owner has already settled.
     */
    private val profile: WireProfile,
    private val iceServers: List<IceConfig.Server>,
    private val executor: ScheduledExecutorService,
    private val send: (Signal) -> Unit,
    private val events: Events,
) : TransportHandle {

    /** All events fire on the executor thread. */
    interface Events {
        /** Both lanes open AND the peer's key verified against its commitment. */
        fun onReady(keys: Crypto.SessionKeys, sas: String, maxFrameBytes: Int)
        fun onFileFrame(frame: ByteArray)
        fun onTextFrame(frame: ByteArray)
        /** Terminal. `reason` is a stable identifier, never user-facing copy. */
        fun onClosed(reason: String)

        /** A READY link stopped answering (`true`) or came back (`false`). Not
         *  terminal: see [DisconnectGrace]. Defaulted so a test double that has
         *  no connection state to report need not mention it. */
        fun onInterrupted(interrupted: Boolean) = Unit
    }

    val role: LinkProtocol.Role = profile.role

    private val handshake = LinkSession.Handshake(role)
    private var factory: PeerConnectionFactory? = null
    private var connection: PeerConnection? = null
    private var fileChannel: DataChannel? = null
    private var textChannel: DataChannel? = null

    private var closed = false
    private var ready = false
    private var remoteDescribed = false
    private var maxFrameBytes = RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES

    /** Remote candidates that arrived before the remote description was
     *  applied. Held in arrival order and bounded; the browser trickles a
     *  handful, and an unbounded list is a lever a hostile relay can pull. */
    private val heldCandidates = ArrayList<IceCandidate>()

    /** The LOCAL half of the same race: candidates this device gathered before
     *  the description they belong to was signalled. See [LocalCandidateGate]. */
    private val localCandidates = LocalCandidateGate<IceCandidate>()

    /** Pre-ready frames, in arrival order across both lanes, bounded combined
     *  in BYTES and in COUNT — a zero-byte frame costs no bytes but still costs
     *  an entry. Overflow fails closed: a dropped admitted frame is the one
     *  thing the receiving codecs cannot survive, because the peer counted it. */
    private val captured = ArrayList<Pair<DataChannel, ByteArray>>()
    private var capturedBytes = 0

    /** Copied-but-unprocessed inbound admission, written on native threads.
     *  Bounded in bytes AND frames; `overflowSignalled` coalesces the teardown
     *  so a flood of rejected callbacks posts exactly ONE failure task instead
     *  of becoming its own unbounded queue. */
    private val pendingBytes = AtomicLong(0)
    private val pendingFrames = java.util.concurrent.atomic.AtomicInteger(0)
    private val overflowSignalled = AtomicBoolean(false)

    private val disconnectGrace = DisconnectGrace(
        executor, DisconnectGrace.DEFAULT_GRACE_MS,
        onInterrupted = { if (!closed) events.onInterrupted(it) },
        onExpired = { if (!closed) fail("connection-lost") },
    )
    private var noProgressTimer: ScheduledFuture<*>? = null
    private var hardCapTimer: ScheduledFuture<*>? = null
    private val progressSeen = HashSet<String>()
    private var candidateProgress = 0
    private var keyWindowArmed = false

    // ── relay renewal (`relay-renew-v1.md`) ─────────────────────────────────

    /** The pin taken from the remote description applied at epoch 0. */
    private var remoteBaselinePin: RelayRenewSdp.Pin? = null

    /** The ICE generation this side's most recent applied local description
     *  named. An ICE restart that does not change it did not restart. */
    private var lastLocalUfrag: String = ""

    /** Set once this link has verified any renewal signal from its peer. From
     *  then on unsigned `link`-generation SDP and ICE are refused for the
     *  remainder of this `PeerConnection` — `relay-renew-v1.md` section 4.1. */
    private var unsignedSdpLocked = false

    /** One subscriber, owned by the renewal controller. */
    private var renewCandidates: ((RenewTransport.Candidate) -> Unit)? = null

    /**
     * The always-on selected-pair channel: the one subscriber, and the last
     * real observation held for replay to it.
     *
     * The FIRST selection is what classifies the path and decides whether this
     * link is bounded by a credential at all, and it routinely happens before
     * the owner exists to subscribe. See [RelayRenewSelectedPairCache].
     */
    private val selectedPairs = RelayRenewSelectedPairCache()

    /** Must be called on the executor thread. */
    override fun start() {
        check(!closed)
        ensureFactoryInitialized(contextRef)
        factory = PeerConnectionFactory.builder().createPeerConnectionFactory()

        connection = factory?.createPeerConnection(rtcConfiguration(iceServers), Observer())
        if (connection == null) {
            fail("no-peer-connection")
            return
        }

        hardCapTimer = executor.schedule(
            { if (!ready && !closed) fail("setup-timeout") },
            LinkProtocol.SETUP_HARD_CAP_MS, TimeUnit.MILLISECONDS,
        )
        armNoProgress(LinkProtocol.NO_PROGRESS_TIMEOUT_MS)

        if (role == LinkProtocol.Role.INITIATOR) {
            // EVERY channel this wire has, in tuple order, before the offer: a
            // link whose text lane never opened cannot honour `link/1`, and a
            // legacy connection with no `data` channel carries nothing at all.
            // Adopt FIRST (the identity checks read these fields), register
            // second; start() already runs on the executor thread.
            val opened = LinkedHashMap<String, DataChannel>()
            for (label in profile.channels) {
                val channel = connection?.createDataChannel(
                    label, DataChannel.Init().apply { ordered = true },
                ) ?: break
                opened[label] = channel
            }
            fileChannel = profile.fileChannel?.let { opened[it] }
            textChannel = profile.textChannel?.let { opened[it] }
            for (channel in opened.values) register(channel)
            if (opened.size != profile.channels.size) {
                fail("no-data-channel")
                return
            }
            connection?.createOffer(
                sdpCreate("offer-failed") { description ->
                    setLocalAndSend(description) {
                        send(profile.offer(description.description, handshake.commit))
                    }
                },
                MediaConstraints(),
            )
        }
    }

    /**
     * The connection's configuration for one set of ICE servers.
     *
     * Built in ONE place because a renewal re-applies it to the same
     * `PeerConnection`: `setConfiguration` accepts a change to the ICE fields
     * and refuses a change to the rest, so a second, quietly different literal
     * would turn every renewal into a silent failure on a line nobody read.
     *
     * No `iceTransportPolicy` is set, here or on renewal. A migration that
     * lands on a direct path is a legitimate success and is classified by the
     * existing rule; renewal does not force relay where the original policy
     * allowed direct.
     */
    private fun rtcConfiguration(servers: List<IceConfig.Server>): PeerConnection.RTCConfiguration {
        val ice = servers.map { server ->
            PeerConnection.IceServer.builder(server.urls).apply {
                server.username?.let(::setUsername)
                server.credential?.let(::setPassword)
            }.createIceServer()
        }
        return PeerConnection.RTCConfiguration(ice).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
        }
    }

    // ── inbound signalling (executor thread) ────────────────────────────────

    override fun onSignal(raw: Json) {
        if (closed) return
        val signal = Signal.fromJson(raw) ?: return
        // BEFORE the busy check and before any commitment is recorded. The
        // generations share one socket, so a frame tagged for a different
        // connection must be inert here rather than merely unrouted: a `busy`
        // would close this one and a `commit` would fail it as a replacement,
        // and both are effects a relay could otherwise choose. Mirrors
        // `RealtimeConnection`'s own `signalGeneration(data) == generation`.
        if (!profile.accepts(signal)) return

        if (signal.busy) {
            fail("peer-busy")
            return
        }

        // The commitment is recorded BEFORE the SDP or a reveal in the same
        // burst is handled; a replacement commitment is an attack, not an update.
        signal.commit?.let {
            if (!handshake.recordPeerCommit(it)) {
                fail("commit-replaced")
                return
            }
        }

        // Once this link has verified a renewal signal from its peer, unsigned
        // `link`-generation SDP is refused for the remainder of this
        // `PeerConnection` (`relay-renew-v1.md` section 4.1). The decision is
        // monotonic and authenticated; it deliberately does not rest on the
        // unsigned capability hint, and it is silent rather than fatal, because
        // a renewal in flight legitimately produces the only SDP this
        // connection should still accept — and that one arrives signed.
        if (signal.sdpType != null && signal.sdp != null && !unsignedSdpLocked) {
            onRemoteSdp(signal)
        }

        if (signal.revealKey != null && signal.revealNonce != null) {
            when (val result = handshake.acceptReveal(signal.revealKey!!, signal.revealNonce!!)) {
                is LinkSession.Handshake.RevealResult.Accepted -> {
                    result.reveal?.let { send(profile.reveal(it.key, it.nonce)) }
                    maybeReady()
                }
                is LinkSession.Handshake.RevealResult.Duplicate -> Unit
                // Mismatch, malformed, no recorded commitment, or a peer key
                // that zeroes the agreement: the channel must never carry
                // content.
                is LinkSession.Handshake.RevealResult.Mismatch -> fail("commit-mismatch")
            }
        }

        signal.candidate?.let { candidate ->
            // The same lock, for the same reason: an unsigned candidate would
            // otherwise be added to a live PeerConnection whose migration is
            // being authenticated.
            if (unsignedSdpLocked) return
            val ice = IceCandidate(signal.sdpMid.orEmpty(), signal.sdpMLineIndex ?: 0, candidate)
            if (!remoteDescribed) {
                // Held, not dropped: a candidate applied before the remote
                // description is discarded by the stack, and the peer will not
                // resend it.
                if (heldCandidates.size >= LinkProtocol.HELD_SIGNAL_MAX) {
                    fail("held-candidate-overflow")
                    return
                }
                heldCandidates.add(ice)
            } else {
                addCandidate(ice)
            }
        }
    }

    private fun onRemoteSdp(signal: Signal) {
        val type = when (signal.sdpType) {
            "offer" -> SessionDescription.Type.OFFER
            "answer" -> SessionDescription.Type.ANSWER
            else -> return
        }
        // A wire without a sorted-id tiebreak prevents glare only by the two
        // intents differing, so an initiator never answers an offer and a
        // responder never applies an answer. `link/1` accepts both, exactly as
        // it did before this guard existed.
        if (!profile.acceptsSdp(signal.sdpType!!)) return
        // Commit-before-reveal, enforced at ADMISSION as well as in the
        // handshake: every conforming offer and answer carries a commitment, so
        // one without (stripped, or a peer that never sent it) is failed here
        // rather than left to time out — and the initiator can then never reach
        // its reveal without one, because revealOnAnswer checks again.
        if (!handshake.hasPeerCommit) {
            fail("commit-missing")
            return
        }
        val description = SessionDescription(type, signal.sdp)
        connection?.setRemoteDescription(
            sdpSet(
                onSuccess = {
                    remoteDescribed = true
                    // The pin is taken from the remote description ACTUALLY
                    // applied at epoch 0, and only from the first one: it is
                    // the peer's DTLS identity and m-line shape that a renewal
                    // at epoch >= 1 must not change.
                    if (remoteBaselinePin == null) remoteBaselinePin = RelayRenewSdp.pin(signal.sdp!!)
                    noteProgress("sdp:${signal.sdpType}")
                    parseMaxMessageSize(signal.sdp!!)?.let { advertised ->
                        // RFC 8841: the binding ceiling is what the REMOTE can
                        // accept. Smaller than the floor means the connection
                        // cannot carry files at all — a named failure, not a
                        // crawl or a late piecePlainBytes throw.
                        if (advertised < RealtimeFrame.MIN_PIECE_BYTES + RealtimeFrame.OVERHEAD) {
                            fail("frame-ceiling-too-small")
                            return@sdpSet
                        }
                        maxFrameBytes = minOf(advertised, RealtimeFrame.CHUNK_SIZE + RealtimeFrame.OVERHEAD)
                    }
                    val held = ArrayList(heldCandidates)
                    heldCandidates.clear()
                    for (candidate in held) addCandidate(candidate)
                    if (type == SessionDescription.Type.OFFER) createAnswer()
                    else handshake.revealOnAnswer()?.let { send(profile.reveal(it.key, it.nonce)) }
                },
                onFailure = { fail("sdp-failed") },
            ),
            description,
        )
    }

    private fun createAnswer() {
        connection?.createAnswer(
            sdpCreate("answer-failed") { description ->
                setLocalAndSend(description) {
                    send(profile.answer(description.description, handshake.commit))
                }
            },
            MediaConstraints(),
        )
    }

    /** The local description is APPLIED before the signal goes out. Sending
     *  first invites an answer to an offer the stack has not committed to, and
     *  a setLocalDescription failure must fail the link, not be ignored.
     *
     *  JSEP starts ICE gathering as part of applying a local description, and
     *  nothing orders the candidate callback against the observer below, so the
     *  gate closes first: a candidate that overtakes the offer or the answer
     *  reaches a peer that has no remote description to attach it to, and this
     *  side never re-sends it. See [LocalCandidateGate]. */
    private fun setLocalAndSend(description: SessionDescription, sendSignal: () -> Unit) {
        beginLocalDescription()
        connection?.setLocalDescription(
            sdpSet(
                onSuccess = { onLocalDescriptionApplied(sendSignal) },
                onFailure = { fail("sdp-failed") },
            ),
            description,
        )
    }

    /** Hold local candidates until the description now being applied has been
     *  signalled. Executor thread; the native `setLocalDescription` is the only
     *  thing between this and [onLocalDescriptionApplied]. */
    internal fun beginLocalDescription() {
        localCandidates.arm()
    }

    /** The local description landed: its signal goes out FIRST, then every
     *  candidate the gate held for it, in gathering order. Executor thread. */
    internal fun onLocalDescriptionApplied(sendSignal: () -> Unit) {
        if (closed) return
        sendSignal()
        connection?.localDescription?.description?.let { lastLocalUfrag = RelayRenewSdp.iceUfrag(it) }
        for (candidate in localCandidates.release()) emitLocalCandidate(candidate)
    }

    /** One locally gathered candidate, from the native observer. Executor
     *  thread; the ONLY path by which a local candidate becomes a signal. */
    internal fun onLocalIceCandidate(candidate: IceCandidate) {
        // A gathering callback that lands after teardown is inert HERE as well
        // as in the observer: the two answer to different callers, and a gate
        // that can be reopened by a late candidate is not a gate.
        if (closed) return
        when (localCandidates.admit(candidate)) {
            LocalCandidateGate.Admission.SEND -> emitLocalCandidate(candidate)
            LocalCandidateGate.Admission.HOLD -> Unit
            // Fail closed rather than truncate: dropping either end of the
            // backlog silently changes which paths the peer gets to try, and
            // a named failure beats a connection that quietly took a worse
            // path — or none at all — for a reason nothing recorded.
            LocalCandidateGate.Admission.OVERFLOW -> fail("local-candidate-overflow")
        }
    }

    /**
     * One gathered local candidate leaves this transport.
     *
     * Three destinations, and the order is the rule:
     *
     *  - a renewal epoch owns the candidate stream while it runs. Its
     *    candidates are signed and bound to an ICE generation, and emitting
     *    them unsigned as well would hand a peer two copies of the same
     *    candidate under two different trust levels.
     *  - once unsigned SDP is locked and no epoch is running, a candidate is
     *    DROPPED rather than sent. The peer refuses it by the same rule, so
     *    sending it would be an unsigned frame on the wire that nothing acts
     *    on. Continual gathering after a completed migration is an
     *    optimisation, not the path: the path is already selected and proven.
     *  - otherwise, today's behaviour, unchanged.
     */
    private fun emitLocalCandidate(candidate: IceCandidate) {
        renewCandidates?.let { subscriber ->
            subscriber(
                RenewTransport.Candidate(
                    candidate.sdp, candidate.sdpMid, candidate.sdpMLineIndex,
                ),
            )
            return
        }
        if (unsignedSdpLocked) return
        send(profile.candidate(candidate.sdp, candidate.sdpMid, candidate.sdpMLineIndex))
    }

    private fun addCandidate(candidate: IceCandidate) {
        val added = runCatching { connection?.addIceCandidate(candidate) }.getOrNull() == true
        if (added && candidateProgress < LinkProtocol.MAX_CANDIDATE_PROGRESS) {
            noteProgress("ice:${candidateProgress++}")
        }
    }

    // ── readiness ───────────────────────────────────────────────────────────

    private fun maybeReady() {
        if (ready || closed) return
        // Every lane this wire declares must be adopted AND open. A wire with
        // no text lane must not be held back waiting for one, and a wire that
        // has one must never be called ready without it.
        if (profile.fileChannel != null &&
            fileChannel?.state() != DataChannel.State.OPEN
        ) {
            return
        }
        if (profile.textChannel != null &&
            textChannel?.state() != DataChannel.State.OPEN
        ) {
            return
        }
        val keys = handshake.keys ?: run {
            // Channels open, reveal still owed: the short key window starts
            // HERE, so an instant open is not left waiting out the whole setup
            // deadline and a slow setup does not earn a fresh one.
            if (!keyWindowArmed) {
                keyWindowArmed = true
                armNoProgress(LinkProtocol.KEY_REVEAL_TIMEOUT_MS)
            }
            return
        }
        ready = true
        cancelTimers()
        val sas = handshake.sas ?: run { fail("no-sas"); return }
        events.onReady(keys, sas, maxFrameBytes)
        // Replay in arrival order, AFTER the lane owners attached in onReady.
        val replay = ArrayList(captured)
        captured.clear()
        capturedBytes = 0
        for ((channel, bytes) in replay) {
            if (closed) return
            if (channel === fileChannel) events.onFileFrame(bytes) else events.onTextFrame(bytes)
        }
    }

    // ── data ────────────────────────────────────────────────────────────────

    private fun register(channel: DataChannel) {
        channel.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previous: Long) = Unit

            override fun onStateChange() {
                // Read on the native thread (state() is thread-safe), acted on
                // only on the executor, and only for an ADOPTED lane: a rejected
                // duplicate's CLOSED must not end a healthy connection.
                executor.execute {
                    if (closed || !isAdopted(channel)) return@execute
                    when (channel.state()) {
                        DataChannel.State.OPEN -> maybeReady()
                        DataChannel.State.CLOSED -> if (ready) fail("channel-closed")
                        else -> Unit
                    }
                }
            }

            override fun onMessage(buffer: DataChannel.Buffer) {
                // ADMISSION BEFORE ALLOCATION, on the native thread. This
                // protocol's frames are binary, at least one byte, and no larger
                // than a sealed full chunk — anything else is refused without a
                // copy, because a refused callback must cost nothing a peer can
                // multiply. Refusals coalesce into ONE posted teardown.
                val size = buffer.data.remaining()
                if (!buffer.binary || size == 0 || size > MAX_WIRE_FRAME_BYTES) {
                    signalOverflow("inbound-frame-invalid")
                    return
                }
                // Two reservations, taken and rolled back INDIVIDUALLY: a
                // refusal releases exactly what it reserved. (The old combined
                // check short-circuited on the count and still subtracted the
                // bytes it had never added, driving the byte gauge negative.)
                if (pendingFrames.incrementAndGet() > PENDING_FRAME_MAX_COUNT) {
                    pendingFrames.decrementAndGet()
                    signalOverflow("inbound-queue-overflow")
                    return
                }
                if (pendingBytes.addAndGet(size.toLong()) > PENDING_FRAME_MAX_BYTES) {
                    pendingBytes.addAndGet(-size.toLong())
                    pendingFrames.decrementAndGet()
                    signalOverflow("inbound-queue-overflow")
                    return
                }
                val bytes = ByteArray(size)
                buffer.data.get(bytes)
                executor.execute {
                    pendingFrames.decrementAndGet()
                    pendingBytes.addAndGet(-size.toLong())
                    if (closed) return@execute
                    // Identity, not registration-time labels: only a frame from
                    // one of the two ADOPTED channels may reach a codec. A
                    // duplicate lane's traffic dies here even though it was
                    // registered early enough to lose no legitimate frame.
                    when (channel) {
                        fileChannel -> deliver(channel, bytes)
                        textChannel -> deliver(channel, bytes)
                        else -> Unit
                    }
                }
            }
        })
    }

    /** One coalesced admission failure, however many callbacks are refused. */
    private fun signalOverflow(reason: String) {
        if (!overflowSignalled.compareAndSet(false, true)) return
        executor.execute { if (!closed) fail(reason) }
    }

    private fun isAdopted(channel: DataChannel): Boolean =
        channel === fileChannel || channel === textChannel

    private fun deliver(channel: DataChannel, bytes: ByteArray) {
        val isFile = channel === fileChannel
        if (!ready) {
            if (captured.size >= CAPTURE_MAX_FRAMES ||
                capturedBytes + bytes.size > LinkProtocol.CAPTURE_MAX_BYTES
            ) {
                fail("capture-overflow")
                return
            }
            capturedBytes += bytes.size
            captured.add(channel to bytes)
            return
        }
        if (isFile) events.onFileFrame(bytes) else events.onTextFrame(bytes)
    }

    override fun sendFile(frame: ByteArray): Boolean = write(fileChannel, frame)

    override fun sendText(frame: ByteArray): Boolean = write(textChannel, frame)

    /** SCTP-level backpressure, separate from the application flow window. */
    override fun fileBufferedAmount(): Long = fileChannel?.bufferedAmount() ?: 0

    /** The text lane's queued-but-unsent bytes, for the send-buffer bound. */
    override fun textBufferedAmount(): Long = textChannel?.bufferedAmount() ?: 0

    private fun write(channel: DataChannel?, frame: ByteArray): Boolean {
        if (closed) return false
        val target = channel ?: return false
        if (target.state() != DataChannel.State.OPEN) return false
        return runCatching {
            target.send(DataChannel.Buffer(ByteBuffer.wrap(frame), true))
        }.getOrDefault(false)
    }

    // ── the relay-renewal surface (executor thread) ─────────────────────────

    override fun renew(): RenewTransport = renewSurface

    /**
     * The renewal's view of this transport.
     *
     * An inner object rather than a set of public methods, so the only thing
     * outside this file that can restart ICE, re-apply a configuration or take
     * the candidate stream is something holding this seam — and so every one of
     * those calls is visible in one place.
     *
     * NOTHING here calls [fail]. A renewal that cannot proceed must leave the
     * link exactly as it found it, running out the deadline it already has; a
     * migration attempt is not allowed to be a way to lose a working
     * connection.
     */
    private val renewSurface = object : RenewTransport {

        override fun applyConfiguration(servers: List<IceConfig.Server>): Boolean {
            if (closed) return false
            return runCatching {
                connection?.setConfiguration(rtcConfiguration(servers))
            }.getOrNull() == true
        }

        override fun createRenewOffer(onResult: (RenewTransport.LocalSdp?) -> Unit) {
            if (closed) { onResult(null); return }
            val pc = connection ?: run { onResult(null); return }
            // `restartIce()` is the modern API and is what marks the NEXT offer
            // as a restart; the offer is then created and applied normally.
            runCatching { pc.restartIce() }
            pc.createOffer(
                renewSdpCreate(onResult) { description -> applyRenewLocal(description, onResult) },
                MediaConstraints(),
            )
        }

        override fun createRenewAnswer(onResult: (RenewTransport.LocalSdp?) -> Unit) {
            if (closed) { onResult(null); return }
            val pc = connection ?: run { onResult(null); return }
            pc.createAnswer(
                renewSdpCreate(onResult) { description -> applyRenewLocal(description, onResult) },
                MediaConstraints(),
            )
        }

        override fun applyRemoteSdp(sdpType: String, sdp: String, onResult: (Boolean) -> Unit) {
            if (closed) { onResult(false); return }
            val type = when (sdpType) {
                "offer" -> SessionDescription.Type.OFFER
                "answer" -> SessionDescription.Type.ANSWER
                else -> { onResult(false); return }
            }
            val pc = connection ?: run { onResult(false); return }
            pc.setRemoteDescription(
                sdpSet(onSuccess = { onResult(true) }, onFailure = { onResult(false) }),
                SessionDescription(type, sdp),
            )
        }

        override fun addCandidate(candidate: RenewTransport.Candidate): Boolean {
            if (closed) return false
            val ice = IceCandidate(
                candidate.sdpMid.orEmpty(),
                candidate.sdpMLineIndex ?: 0,
                candidate.candidate,
            )
            return runCatching { connection?.addIceCandidate(ice) }.getOrNull() == true
        }

        override fun onCandidate(cb: ((RenewTransport.Candidate) -> Unit)?) {
            renewCandidates = cb
        }

        override fun onSelectedPair(cb: ((RenewTransport.SelectedPair) -> Unit)?) {
            // Attaching REPLAYS whatever this connection already observed.
            selectedPairs.subscribe(cb)
        }

        override fun baselinePin(): RelayRenewSdp.Pin? = remoteBaselinePin

        override fun sendControlFrame(frame: ByteArray): Boolean = write(textChannel, frame)

        override fun lockUnsignedSdp() {
            unsignedSdpLocked = true
        }
    }

    /**
     * Apply a renewal's local description and hand back the generation it
     * named.
     *
     * Two things happen in a fixed order, and both matter. The candidate gate
     * closes BEFORE the description is applied, so the new generation's
     * candidates cannot overtake the SDP that explains them; the caller's
     * `onResult` is what puts that SDP on the wire, so the gate opens
     * immediately after it returns.
     *
     * A local description whose `a=ice-ufrag` is UNCHANGED is reported as a
     * failure. The stack was asked for an ICE restart; if it produced the same
     * generation then no restart happened, every later ufrag comparison would
     * be vacuous, and a migration would be "proved" by the candidate that was
     * already selected. Refusing keeps the old deadline, which is the outcome
     * every failure path here shares.
     */
    private fun applyRenewLocal(
        description: SessionDescription,
        onResult: (RenewTransport.LocalSdp?) -> Unit,
    ) {
        val previous = lastLocalUfrag
        beginLocalDescription()
        connection?.setLocalDescription(
            sdpSet(
                onSuccess = {
                    val ufrag = RelayRenewSdp.iceUfrag(description.description)
                    if (ufrag.isEmpty() || ufrag == previous) {
                        localCandidates.release()
                        onResult(null)
                        return@sdpSet
                    }
                    lastLocalUfrag = ufrag
                    onResult(RenewTransport.LocalSdp(description.description, ufrag))
                    for (candidate in localCandidates.release()) emitLocalCandidate(candidate)
                },
                onFailure = {
                    localCandidates.release()
                    onResult(null)
                },
            ),
            description,
        )
    }

    /** A CREATE observer for a renewal: failure is reported, never fatal. */
    private fun renewSdpCreate(
        onResult: (RenewTransport.LocalSdp?) -> Unit,
        onCreated: (SessionDescription) -> Unit,
    ) = object : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) {
            executor.execute { if (closed) onResult(null) else onCreated(description) }
        }
        override fun onCreateFailure(error: String?) {
            executor.execute { onResult(null) }
        }
        override fun onSetSuccess() = Unit
        override fun onSetFailure(error: String?) = Unit
    }

    // ── deadlines (executor thread) ─────────────────────────────────────────

    private fun armNoProgress(delayMs: Long) {
        noProgressTimer?.cancel(false)
        noProgressTimer = executor.schedule(
            { if (!ready && !closed) fail(if (keyWindowArmed) "key-timeout" else "setup-timeout") },
            delayMs, TimeUnit.MILLISECONDS,
        )
    }

    /** SDP and state progress deduplicate by identity; ICE progress is a
     *  bounded COUNT (the caller keys it) — `relayium-link-v1.md` section 5.2. */
    private fun noteProgress(key: String) {
        if (ready || closed || keyWindowArmed) return
        if (!progressSeen.add(key)) return
        armNoProgress(LinkProtocol.NO_PROGRESS_TIMEOUT_MS)
    }

    private fun cancelTimers() {
        noProgressTimer?.cancel(false)
        hardCapTimer?.cancel(false)
        noProgressTimer = null
        hardCapTimer = null
    }

    // ── teardown (executor thread) ──────────────────────────────────────────

    /** Announce the departure with the caller-built authenticated leave, then
     *  tear down. Best effort: the peer falls back to its drop handling. */
    override fun leaveAndClose(leave: Signal?) {
        leave?.let { runCatching { send(it) } }
        close("local-leave")
    }

    /** Retire one never-adopted or torn-down channel: observer off first, so no
     *  native wrapper call can land after dispose. Executor thread only. */
    private fun discardChannel(channel: DataChannel, registered: Boolean) {
        if (registered) runCatching { channel.unregisterObserver() }
        runCatching { channel.close() }
        runCatching { channel.dispose() }
    }

    override fun close(reason: String) {
        if (closed) return
        closed = true
        disconnectGrace.cancel()
        cancelTimers()
        heldCandidates.clear()
        // Both halves of the candidate race. A held local candidate belongs to a
        // description nobody will answer, and a later native callback finds
        // `closed` and returns before it can reopen anything.
        localCandidates.discard()
        captured.clear()
        // Closing cancels every renewal queue, timer and pending verification
        // by cutting them off at the source: no later callback can resurrect an
        // epoch through a subscriber that no longer exists.
        renewCandidates = null
        selectedPairs.clear()
        // This runs on the executor thread — never a WebRTC observer stack —
        // which is what the dispose javadoc requires.
        fileChannel?.let { discardChannel(it, registered = true) }
        textChannel?.let { discardChannel(it, registered = true) }
        fileChannel = null
        textChannel = null
        runCatching { connection?.close() }
        runCatching { connection?.dispose() }
        connection = null
        runCatching { factory?.dispose() }
        factory = null
        handshake.destroy()
        events.onClosed(reason)
    }

    private fun fail(reason: String) = close(reason)

    // ── observers: every callback hops before any effect ────────────────────

    private inner class Observer : PeerConnection.Observer {
        override fun onIceCandidate(candidate: IceCandidate) {
            executor.execute {
                if (closed) return@execute
                onLocalIceCandidate(candidate)
            }
        }

        override fun onDataChannel(channel: DataChannel) {
            // Registration COMPLETES on this native callback stack BEFORE the
            // adoption/rejection task is even queued. That gives three orderings
            // for free on the serial executor: no legitimate early message is
            // lost (the observer is attached before the callback unwinds and
            // frame callbacks arrive on this same signaling thread); the
            // adoption decision is queued ahead of any frame or state task the
            // new observer can produce; and a rejection that runs IMMEDIATELY —
            // an executor is allowed to — can no longer dispose the channel
            // while this stack still has a registerObserver ahead of it.
            val label = channel.label()
            val recognised = label in profile.channels
            if (recognised) register(channel)
            executor.execute {
                if (closed) {
                    discardChannel(channel, registered = recognised)
                    return@execute
                }
                when {
                    label == profile.fileChannel && fileChannel == null -> {
                        fileChannel = channel
                        maybeReady()
                    }
                    label == profile.textChannel && textChannel == null -> {
                        textChannel = channel
                        maybeReady()
                    }
                    else -> {
                        // Outside the tuple, or a duplicate: only IT is closed,
                        // on this executor — never on the observer stack — and
                        // its identity never enters the adopted pair, so its
                        // queued traffic and its CLOSED event are inert.
                        discardChannel(channel, registered = recognised)
                    }
                }
            }
        }

        override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
            executor.execute {
                if (closed) return@execute
                noteProgress("state:$state")
                when (state) {
                    PeerConnection.PeerConnectionState.FAILED -> fail("ice-failed")
                    // Transport resume is still deferred (relayium-link-v1.md
                    // section 8.4) — but DISCONNECTED is not a dropped
                    // connection yet. It gets a bounded chance to come back on
                    // its own, or through the peer's ICE restart, before it is
                    // called lost. See [DisconnectGrace].
                    PeerConnection.PeerConnectionState.DISCONNECTED -> if (ready) disconnectGrace.disconnected()
                    PeerConnection.PeerConnectionState.CONNECTED -> disconnectGrace.recovered()
                    PeerConnection.PeerConnectionState.CLOSED -> fail("closed")
                    else -> Unit
                }
            }
        }

        /**
         * The ICE agent changed its selected pair.
         *
         * This is the AUTHORITATIVE answer to "which path is carrying this
         * connection", handed over by the stack with both candidates attached.
         * It is deliberately the only source this port uses: scanning a stats
         * report for a `nominated` + `succeeded` pair returns the OLD pair as
         * readily as the new one after a restart, and an implementation that
         * took the first match would report a migration that had not happened.
         */
        override fun onSelectedCandidatePairChanged(event: CandidatePairChangeEvent) {
            val local = event.local?.sdp ?: return
            val remote = event.remote?.sdp ?: return
            executor.execute {
                if (closed) return@execute
                // Cached before it is forwarded, so an event that lands before
                // anything has subscribed is retained rather than lost.
                selectedPairs.record(RenewTransport.SelectedPair(local, remote))
            }
        }

        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) = Unit
        override fun onAddStream(stream: MediaStream?) = Unit
        override fun onRemoveStream(stream: MediaStream?) = Unit
        override fun onRenegotiationNeeded() = Unit
        override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) = Unit
    }

    /** An SDP CREATE observer that hops to the executor and fails on error. */
    private fun sdpCreate(failReason: String, onCreated: (SessionDescription) -> Unit) =
        object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) {
                executor.execute { if (!closed) onCreated(description) }
            }
            override fun onCreateFailure(error: String?) {
                executor.execute { if (!closed) fail(failReason) }
            }
            override fun onSetSuccess() = Unit
            override fun onSetFailure(error: String?) = Unit
        }

    /** An SDP SET observer that hops to the executor; failure is never ignored. */
    private fun sdpSet(onSuccess: () -> Unit, onFailure: () -> Unit) =
        object : SdpObserver {
            override fun onSetSuccess() {
                executor.execute { if (!closed) onSuccess() }
            }
            override fun onSetFailure(error: String?) {
                executor.execute { if (!closed) onFailure() }
            }
            override fun onCreateSuccess(description: SessionDescription) = Unit
            override fun onCreateFailure(error: String?) = Unit
        }

    private val contextRef = context.applicationContext

    companion object {
        /** Copied-but-unprocessed inbound bytes across both lanes. Twice the
         *  flow window plus the text ceiling: a conforming peer cannot reach it,
         *  and past it the peer is outrunning this device on purpose. */
        const val PENDING_FRAME_MAX_BYTES =
            2 * RealtimeFrame.FLOW_WINDOW_BYTES + 2L * RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES

        /** Copied-but-unprocessed inbound FRAMES. The byte bound alone admits
         *  unlimited zero- and one-byte frames, each of which still costs an
         *  executor task. At the minimum piece size a conforming sender needs
         *  far fewer than this to fill the byte bound. */
        const val PENDING_FRAME_MAX_COUNT = 8_192

        /** Pre-ready captured frames, by count; the byte bound is
         *  [LinkProtocol.CAPTURE_MAX_BYTES]. Pre-attachment traffic is one
         *  manifest plus lifecycle bytes — a few frames, not thousands. */
        const val CAPTURE_MAX_FRAMES = 1_024

        /** No frame on this wire exceeds a sealed full logical chunk. */
        const val MAX_WIRE_FRAME_BYTES = RealtimeFrame.CHUNK_SIZE + RealtimeFrame.OVERHEAD

        private val factoryInitialized = AtomicBoolean(false)

        private fun ensureFactoryInitialized(context: Context) {
            if (!factoryInitialized.compareAndSet(false, true)) return
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context)
                    .createInitializationOptions(),
            )
        }

        /**
         * The remote's `a=max-message-size`, or null when it advertises none
         * (RFC 8841's default of 64 KiB then applies). No EGL, no video
         * factories anywhere in this file: a data-only factory needs neither.
         */
        fun parseMaxMessageSize(sdp: String): Int? {
            for (line in sdp.lineSequence()) {
                val trimmed = line.trim()
                if (!trimmed.startsWith("a=max-message-size:")) continue
                val value = trimmed.removePrefix("a=max-message-size:").trim()
                    .toLongOrNull() ?: return null
                if (value <= 0) return null
                return minOf(value, Int.MAX_VALUE.toLong()).toInt()
            }
            return null
        }
    }
}
