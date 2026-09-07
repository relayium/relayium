package com.relayium.android.transport

import android.content.Context
import com.relayium.protocol.Crypto
import com.relayium.protocol.Json
import com.relayium.protocol.LinkProtocol
import com.relayium.protocol.LinkSession
import com.relayium.protocol.RealtimeFrame
import com.relayium.protocol.Signal
import java.nio.ByteBuffer
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
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
    private val selfId: String,
    private val peerId: String,
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
    }

    val role: LinkProtocol.Role = LinkProtocol.linkRole(selfId, peerId)

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

    private var noProgressTimer: ScheduledFuture<*>? = null
    private var hardCapTimer: ScheduledFuture<*>? = null
    private val progressSeen = HashSet<String>()
    private var candidateProgress = 0
    private var keyWindowArmed = false

    /** Must be called on the executor thread. */
    override fun start() {
        check(!closed)
        ensureFactoryInitialized(contextRef)
        factory = PeerConnectionFactory.builder().createPeerConnectionFactory()

        val servers = iceServers.map { server ->
            PeerConnection.IceServer.builder(server.urls).apply {
                server.username?.let(::setUsername)
                server.credential?.let(::setPassword)
            }.createIceServer()
        }
        val config = PeerConnection.RTCConfiguration(servers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
        }
        connection = factory?.createPeerConnection(config, Observer())
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
            // BOTH channels, in tuple order, before the offer: a link whose text
            // lane never opened cannot honour `link/1`.
            // Adopt FIRST (the identity checks read these fields), register
            // second; start() already runs on the executor thread.
            fileChannel = connection?.createDataChannel(
                LinkProtocol.FILE_CHANNEL, DataChannel.Init().apply { ordered = true },
            )
            textChannel = connection?.createDataChannel(
                LinkProtocol.TEXT_CHANNEL, DataChannel.Init().apply { ordered = true },
            )
            fileChannel?.let { register(it) }
            textChannel?.let { register(it) }
            if (fileChannel == null || textChannel == null) {
                fail("no-data-channel")
                return
            }
            connection?.createOffer(
                sdpCreate("offer-failed") { description ->
                    setLocalAndSend(description) {
                        send(Signal.offer(description.description, handshake.commit, LinkProtocol.ADVERTISED_CAPS))
                    }
                },
                MediaConstraints(),
            )
        }
    }

    // ── inbound signalling (executor thread) ────────────────────────────────

    override fun onSignal(raw: Json) {
        if (closed) return
        val signal = Signal.fromJson(raw) ?: return

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

        if (signal.sdpType != null && signal.sdp != null) {
            onRemoteSdp(signal)
        }

        if (signal.revealKey != null && signal.revealNonce != null) {
            when (val result = handshake.acceptReveal(signal.revealKey!!, signal.revealNonce!!)) {
                is LinkSession.Handshake.RevealResult.Accepted -> {
                    result.reveal?.let { send(Signal.reveal(it.key, it.nonce)) }
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
                    else handshake.revealOnAnswer()?.let { send(Signal.reveal(it.key, it.nonce)) }
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
                    send(Signal.answer(description.description, handshake.commit, LinkProtocol.ADVERTISED_CAPS))
                }
            },
            MediaConstraints(),
        )
    }

    /** The local description is APPLIED before the signal goes out. Sending
     *  first invites an answer to an offer the stack has not committed to, and
     *  a setLocalDescription failure must fail the link, not be ignored. */
    private fun setLocalAndSend(description: SessionDescription, sendSignal: () -> Unit) {
        connection?.setLocalDescription(
            sdpSet(onSuccess = sendSignal, onFailure = { fail("sdp-failed") }),
            description,
        )
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
        val file = fileChannel ?: return
        val text = textChannel ?: return
        if (file.state() != DataChannel.State.OPEN || text.state() != DataChannel.State.OPEN) return
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
        cancelTimers()
        heldCandidates.clear()
        captured.clear()
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
                send(Signal.candidate(candidate.sdp, candidate.sdpMid, candidate.sdpMLineIndex))
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
            val recognised = label == LinkProtocol.FILE_CHANNEL || label == LinkProtocol.TEXT_CHANNEL
            if (recognised) register(channel)
            executor.execute {
                if (closed) {
                    discardChannel(channel, registered = recognised)
                    return@execute
                }
                when {
                    label == LinkProtocol.FILE_CHANNEL && fileChannel == null -> {
                        fileChannel = channel
                        maybeReady()
                    }
                    label == LinkProtocol.TEXT_CHANNEL && textChannel == null -> {
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
                    // Transport resume is deferred: a dropped connection ends
                    // the link truthfully — relayium-link-v1.md section 8.4.
                    PeerConnection.PeerConnectionState.DISCONNECTED -> if (ready) fail("connection-lost")
                    PeerConnection.PeerConnectionState.CLOSED -> fail("closed")
                    else -> Unit
                }
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
