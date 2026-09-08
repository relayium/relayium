package com.relayium.protocol.legacy

import com.relayium.protocol.RealtimeFrame
import com.relayium.protocol.Signal

/**
 * The wire vocabulary of the two SHIPPED pre-`link/1` generations, as the Apple
 * and Web clients still speak them.
 *
 * Golden bytes: the TOP-LEVEL `kinds`, `controlHex`, `text` and `capability`
 * blocks of `apps/RelayiumKit/Tests/Fixtures/realtime-wire-vectors.json` — the
 * `link` block is the newer wire and is deliberately not this one.
 *
 * ## What a legacy connection IS
 *
 * ONE ordered `data` channel, created by the initiator and adopted by the
 * responder, carrying EITHER files or messages — never both. That is the whole
 * difference from `link/1`, and it is a difference in kind rather than in
 * degree: `RealtimeConnection.init` filters every inbound signal by
 * `signalGeneration(data) == self.generation`, so a file connection cannot even
 * SEE a text signal. Files and text are two connections, not two lanes.
 *
 * ## What it does not have
 *
 * No `linkRequest`, no authenticated leave, no resume, and a control set of
 * EXACTLY `0xfe`/`0xff`/`0xfd`. `0xf9` BUSY and `0xf8` BATCH_ABORT are `link/1`
 * additions: `RealtimeControl(rawValue:)` on the Apple side has three cases, so
 * a peer that received one would fall through to its AEAD receiver and fail the
 * whole connection. Emitting one here would be inventing a dialect.
 *
 * Ending a batch early is therefore a TEARDOWN, not a barrier. The shipped
 * sender checks `rejected` only in `waitForAccept()`, before it streams; once
 * it is streaming, a `0xff` is read and recorded and the stream continues. So a
 * mid-transfer cancel that did not close the connection would be a control the
 * user pressed that changes nothing.
 */
object LegacyProtocol {

    /** The single SCTP label. `RealtimeConnection.startLocked` creates exactly
     *  `data`, and the responder adopts whatever channel arrives. */
    const val CHANNEL = "data"

    /**
     * The exact capability a message connection requires of its peer, in BOTH
     * directions.
     *
     * A hint, never a security input — the relay sees and could forge it — but
     * a text offer without it means the peer cannot decode kind-9 frames, so
     * answering one produces a connection that can never carry a message.
     */
    const val TEXT_CAPABILITY = "text/1"

    /** Which of the two shipped generations a connection is. */
    enum class Lane { FILES, TEXT }

    /**
     * A lifecycle control, and the whole of it.
     *
     * One byte exactly, for the reason the `link/1` twin gives: a longer frame
     * that merely starts with one of these values is a protected frame, and
     * reading it as consent is how a batch gets accepted without a user
     * answering.
     */
    enum class Control { ACCEPT, REJECT, COMPLETE }

    fun control(frame: ByteArray): Control? {
        if (frame.size != 1) return null
        return when (frame[0].toInt() and 0xff) {
            RealtimeFrame.CTRL_ACCEPT -> Control.ACCEPT
            RealtimeFrame.CTRL_REJECT -> Control.REJECT
            RealtimeFrame.CTRL_COMPLETE -> Control.COMPLETE
            else -> null
        }
    }

    /**
     * What rides alongside the SDP.
     *
     * A FILE connection announces NOTHING — `Mode.file.localCapabilities` is
     * empty and `addingCaps` then adds no field at all, which is what keeps the
     * signal byte-identical to what every already-deployed peer sends. A TEXT
     * connection announces exactly `text/1`, on the offer AND on the answer,
     * because `RealtimeConnection.handleSignal` re-checks it on every SDP until
     * the peer key is delivered.
     */
    fun caps(lane: Lane): List<String>? =
        if (lane == Lane.TEXT) listOf(TEXT_CAPABILITY) else null

    /** `sdpSignal(kind:"offer", …)` — untagged for files, `text:true` for text. */
    fun offer(sdp: String, commit: String, lane: Lane) = Signal(
        sdpType = "offer", sdp = sdp, commit = commit,
        caps = caps(lane), text = lane == Lane.TEXT,
    )

    fun answer(sdp: String, commit: String, lane: Lane) = Signal(
        sdpType = "answer", sdp = sdp, commit = commit,
        caps = caps(lane), text = lane == Lane.TEXT,
    )

    /** `taggedSignal(iceSignal(…))`. Candidates carry no capabilities. */
    fun candidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int?, lane: Lane) = Signal(
        candidate = candidate, sdpMid = sdpMid, sdpMLineIndex = sdpMLineIndex,
        text = lane == Lane.TEXT,
    )

    /** `taggedSignal(revealField(…))`. */
    fun reveal(key: String, nonce: String, lane: Lane) = Signal(
        revealKey = key, revealNonce = nonce, text = lane == Lane.TEXT,
    )

    /**
     * Which legacy connection an inbound signal opens for a RESPONDER, or null
     * for none. The exact clauses of `RealtimeSignal.inboundOfferGeneration`:
     *
     * - only a real SDP **offer** starts one; an answer, a candidate or a reveal
     *   belongs to a connection that already exists;
     * - `resume` and `link` are not this wire, and answering either would strand
     *   the initiator on a protocol it is not speaking;
     * - a `text` offer must carry exact `text/1`. Anything else fails CLOSED —
     *   silence is the truthful answer to a dialect we cannot speak, and a
     *   `busy` reply would say "try later", which is not what is wrong.
     */
    fun inboundOfferLane(signal: Signal): Lane? {
        if (signal.sdpType != "offer" || signal.sdp == null) return null
        return when (signal.generation) {
            Signal.Generation.FILE -> Lane.FILES
            Signal.Generation.TEXT ->
                if (signal.caps?.contains(TEXT_CAPABILITY) == true) Lane.TEXT else null
            Signal.Generation.RESUME, Signal.Generation.LINK -> null
        }
    }
}

/**
 * **Which legacy generation a peer that cannot speak `link/1` gets — decided
 * from what the peer announced, never from a question put to the user.**
 *
 * The same pure rule as `LegacyLaneResolution.swift`, and pinned to the same
 * `capability.legacyLane` fixture rows, because a side that answers `.text`
 * where the other answers `.files` hands its peer an offer it will never build
 * and the user sees a hang rather than a decision that was wrong.
 */
object LegacyLane {

    /**
     * `hasArmedBatch` wins whatever the peer said: a staged batch is the user's
     * stated intent and is the one thing a text connection cannot carry at all.
     *
     * This client's cross-network create arms nothing before connecting, so it
     * always passes false today. The parameter stays because the rule belongs to
     * the WIRE rather than to one surface — the Apple clients reach it with a
     * staged batch — and a copy that dropped the arm would be a second, subtly
     * different rule rather than the shared one.
     */
    fun mode(peerAnnouncesText: Boolean, hasArmedBatch: Boolean): LegacyProtocol.Lane = when {
        hasArmedBatch -> LegacyProtocol.Lane.FILES
        peerAnnouncesText -> LegacyProtocol.Lane.TEXT
        // A legacy peer that announced NOTHING is a file peer by construction:
        // `Mode.text` is the only branch that ever sends a hello.
        else -> LegacyProtocol.Lane.FILES
    }
}
