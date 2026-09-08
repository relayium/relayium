package com.relayium.protocol

/**
 * What a message lane looks like to its OWNER, on either wire.
 *
 * The controller and the UI speak one vocabulary — [TextLaneSession.State] and
 * [TextLaneSession.Action] — and the two implementations differ only in which
 * bytes activate a conversation and whether one can be reopened. Modelling that
 * as an interface rather than as a second set of states is what keeps the whole
 * message surface from needing a legacy branch at every read.
 *
 * The link/1 implementation is [TextLaneSession]; the shipped single-generation
 * one is `com.relayium.protocol.legacy.LegacyTextLane`.
 */
interface TextLane {
    val state: TextLaneSession.State
    /** Whether a local request may start RIGHT NOW. Legacy answers false
     *  always: its conversation is the connection, and there is no reopen. */
    val canRequest: Boolean
    /** The composer's live limit for THIS connection. */
    val plainLimit: Int
    /**
     * Whether ending a conversation on this wire has an ordered barrier the
     * peer answers.
     *
     * `link/1` does, and its owner arms a bounded lease over it. The shipped
     * wire has no END byte at all, so there is nothing to wait for and a lease
     * there would be a timer with no event that could ever settle it.
     */
    val hasEndBarrier: Boolean
    /** Attach BEFORE answering: a frame dispatched with no listener is lost. */
    fun attachReceiver()
    fun onFrame(frame: ByteArray): List<TextLaneSession.Action>
    fun send(body: String): List<TextLaneSession.Action>
    fun request(): List<TextLaneSession.Action>
    fun accept(): List<TextLaneSession.Action>
    fun reject(): List<TextLaneSession.Action>
    fun end(): List<TextLaneSession.Action>
    /** The transport refused a frame whose nonce was already consumed. */
    fun transportSendFailed(): List<TextLaneSession.Action>
    /** The bounded wait for the peer's END barrier expired. Legacy has no
     *  barrier, so its answer is always empty. */
    fun endBarrierTimedOut(): List<TextLaneSession.Action>
}

/**
 * The text lane's state machine: activation, content, an ordered end barrier
 * with a drain, reopen, and bounds.
 *
 * Pure, for the same reason [FileLaneSession] is.
 *
 * ## END is a barrier, not a switch
 *
 * The lifecycle is modelled on the shipped `mixed-text-session.svelte.ts`,
 * because a lane that treats END as "stop listening" desynchronises against a
 * real browser peer. On an ordered channel the peer may already have sealed
 * frames before it saw this side's END, and those frames CONSUMED sequence
 * numbers. They must still be fed to the receiver — otherwise the next
 * conversation's first message arrives at a number this side no longer expects
 * and fails authentication — but they must never be shown, because the user
 * ended the conversation.
 *
 * That is what [State.ENDED] plus `draining` is. It is also why reopening never
 * constructs a new codec: the counters are per direction and per LINK, and a
 * fresh pair would reuse nonces under a key that has already sealed frames at
 * those numbers.
 */
class TextLaneSession(
    private val keys: Crypto.SessionKeys,
    private val maxFrameBytes: Int,
    private val sender: TextWire.Sender = TextWire.Sender(),
    private val receiver: TextWire.Receiver = TextWire.Receiver(),
    private val now: () -> Long = System::currentTimeMillis,
) : TextLane {

    companion object {
        /** How long the adapter waits for the peer's END barrier before
         *  settling it locally. The Web's `MIXED_TEXT_END_ACK_TIMEOUT_MS`. */
        const val END_ACK_TIMEOUT_MS = 30_000L
    }

    sealed interface Action {
        data class Send(val frame: ByteArray) : Action {
            override fun equals(other: Any?) = other is Send && frame.contentEquals(other.frame)
            override fun hashCode() = frame.contentHashCode()
        }
        /** The peer asks to open a conversation. */
        data object Requested : Action
        /** The conversation is live in both directions. */
        data object Opened : Action
        /** A message arrived, strictly UTF-8 decoded, and should be shown. */
        data class Received(val body: String) : Action
        /**
         * A message arrived AFTER this side ended, was authenticated to keep the
         * receive sequence continuous, and was deliberately NOT surfaced.
         *
         * Emitted rather than silent so the drain is observable: "we consumed a
         * sequence number and showed nothing" is exactly the behaviour a test
         * has to be able to see.
         */
        data object Drained : Action
        /** The conversation ended. The link and the file lane are untouched. */
        data object Ended : Action
        data class Fail(val reason: Reason) : Action

        enum class Reason {
            /** Malformed, unauthenticated, out of order, or over the wire limit. */
            MALFORMED,
            /** Content arrived with no conversation to attribute it to. */
            CONTENT_BEFORE_ACTIVATION,
            /** The peer declined. */
            REFUSED,
            /** A receiver-enforced session bound was reached. */
            BOUNDS,
            /** The peer never answered this side's END inside the lease. */
            BARRIER_TIMEOUT,
            /** The transport refused a frame whose nonce was already consumed. */
            TRANSPORT,
        }
    }

    enum class State {
        IDLE,
        /** A local REQUEST is out; waiting for ACCEPT or REJECT. */
        REQUESTED,
        /** The peer asked; waiting for this side to answer. */
        INCOMING_REQUEST,
        OPEN,
        /** Retired. Reopenable, and possibly still draining the peer's tail. */
        ENDED,
        /** This lane is finished. The link and the file lane survive. */
        FAILED,
    }

    override var state: State = State.IDLE
        private set

    /** This side sent END and has not yet seen the peer's ordered barrier. */
    private var awaitingEndAck = false

    /** Inbound content must be authenticated to keep the counter continuous, and
     *  discarded rather than surfaced. */
    private var draining = false

    /**
     * A local END crossed an outbound REQUEST, so the peer may still answer with
     * an ACCEPT that belongs to the conversation this side already ended. That
     * ACCEPT is not a reopen; it opens a drain until the following END.
     */
    private var lateAccept = false

    // Per-CONVERSATION budget. Reset when a conversation begins; deliberately
    // not tied to the codecs, whose counters span the whole link.
    private var messages = 0
    private var bytes = 0L
    /** Frames admitted during a drain, bounded so the tail cannot be a flood. */
    private var drained = 0

    private var receiverAttached = false

    // Inbound flood guard: a token bucket over EVERY inbound text-lane frame,
    // lifecycle and content alike, shaped after the Web's. Refills at
    // [TextSessionLimits.PER_SECOND], holds [TextSessionLimits.BURST].
    private var bucketTokens = TextSessionLimits.BURST.toDouble()
    private var bucketRefilledAt = now()

    private fun takeToken(): Boolean {
        val at = now()
        val elapsed = (at - bucketRefilledAt).coerceAtLeast(0)
        bucketRefilledAt = at
        bucketTokens = minOf(
            TextSessionLimits.BURST.toDouble(),
            bucketTokens + elapsed * TextSessionLimits.PER_SECOND / 1000.0,
        )
        if (bucketTokens < 1.0) return false
        bucketTokens -= 1.0
        return true
    }

    /** Sequence numbers the codecs have reached. Exposed so a test can assert
     *  that end/reopen never rewinds either direction. */
    val sendSeq: Long get() = sender.nextSeq
    val recvSeq: Long get() = receiver.nextExpectedSeq

    /**
     * The composer's live limit for THIS connection.
     *
     * The product cap is 64 KiB of plaintext, but 64 KiB seals into a 65 557-byte
     * frame, which does not fit a connection that negotiated RFC 8841's 65 536.
     */
    override val plainLimit: Int get() = TextWire.plainLimit(maxFrameBytes)

    override val hasEndBarrier: Boolean get() = true

    /** Attach BEFORE answering: a frame dispatched with no listener is lost. */
    override fun attachReceiver() {
        receiverAttached = true
    }

    // ── opening ─────────────────────────────────────────────────────────────

    /**
     * Whether a local request may start RIGHT NOW.
     *
     * False while an END barrier is still outstanding — `awaitingEndAck`, an
     * open drain, or an armed `lateAccept`. Reopening then would have to clear
     * the drain to enter REQUESTED, and a legitimate peer message already in
     * flight would fail as content-before-activation instead of being
     * authenticated and discarded. The Web's `openWith` refuses through its
     * `active()` check for exactly this window; the UI reads this to show a
     * truthful "closing" state instead of a dead button.
     */
    override val canRequest: Boolean
        get() = (state == State.IDLE || state == State.ENDED) &&
            !awaitingEndAck && !draining && !lateAccept

    /**
     * Ask the peer to open a conversation.
     *
     * Allowed from IDLE and from ENDED — reopening is ordinary, and the codecs
     * continue rather than restart — but NOT while the previous conversation's
     * end barrier is still outstanding. Callers gate on [canRequest]; the check
     * here is the structural backstop.
     */
    override fun request(): List<Action> {
        check(canRequest) {
            if (state == State.IDLE || state == State.ENDED) {
                "the previous conversation's end barrier has not settled yet"
            } else {
                "a conversation is already live"
            }
        }
        beginConversation()
        state = State.REQUESTED
        return listOf(Action.Send(TextWire.REQUEST))
    }

    /**
     * The bounded wait for the peer's END barrier expired.
     *
     * Elapsed time is NOT the barrier: how many frames the peer sealed before
     * this side's END is unknowable without its ordered answer, so pretending
     * the barrier arrived would let stale content bleed into a later
     * conversation at sequence numbers this side never accounted. The Web's
     * end-acknowledgement lease poisons the lane for exactly this reason.
     *
     * So: the TEXT lane fails, non-reopenably, on the SAME codecs — no counter
     * is reset and no fresh codec is constructed under keys that already sealed
     * frames. The file lane and the link are untouched; a FRESH link is the
     * recovery path. A late END arriving after this cannot unpoison it (the
     * FAILED gate at the top of [onFrame] drops it).
     */
    override fun endBarrierTimedOut(): List<Action> {
        if (!awaitingEndAck && !draining && !lateAccept) return emptyList()
        awaitingEndAck = false
        draining = false
        lateAccept = false
        state = State.FAILED
        return listOf(Action.Fail(Action.Reason.BARRIER_TIMEOUT))
    }

    override fun accept(): List<Action> {
        check(state == State.INCOMING_REQUEST) { "no conversation is waiting for an answer" }
        check(receiverAttached) {
            "attach the receive handler BEFORE sending ACCEPT: a frame dispatched with no listener is lost"
        }
        state = State.OPEN
        draining = false
        lateAccept = false
        return listOf(Action.Send(TextWire.ACCEPT), Action.Opened)
    }

    override fun reject(): List<Action> {
        check(state == State.INCOMING_REQUEST) { "no conversation is waiting for an answer" }
        state = State.ENDED
        draining = false
        lateAccept = false
        return listOf(Action.Send(TextWire.REJECT))
    }

    // ── ending ──────────────────────────────────────────────────────────────

    /**
     * End the conversation from this side.
     *
     * From OPEN this opens a DRAIN: the peer may have sealed frames before it
     * saw this END, and those numbers are spent. From REQUESTED it arms
     * `lateAccept` instead, because the peer might still be about to ACCEPT a
     * request this side has abandoned.
     *
     * From INCOMING_REQUEST it sends REJECT rather than END, matching the Web:
     * no ACCEPT was ever sent, so the peer could not have entered its protected
     * send state, and REJECT is the complete barrier without the acknowledgement
     * round trip that could cancel an immediately reopened request.
     */
    override fun end(): List<Action> = when (state) {
        State.OPEN -> {
            draining = true
            drained = 0
            awaitingEndAck = true
            state = State.ENDED
            listOf(Action.Send(TextWire.END), Action.Ended)
        }
        State.REQUESTED -> {
            lateAccept = true
            drained = 0
            awaitingEndAck = true
            state = State.ENDED
            listOf(Action.Send(TextWire.END), Action.Ended)
        }
        State.INCOMING_REQUEST -> {
            state = State.ENDED
            draining = false
            lateAccept = false
            listOf(Action.Send(TextWire.REJECT), Action.Ended)
        }
        else -> emptyList()
    }

    // ── sending ─────────────────────────────────────────────────────────────

    /**
     * Send one message.
     *
     * A refusal burns NO sequence number — [TextWire.Sender.frame] checks before
     * it takes one — so an over-long paste leaves the conversation usable.
     *
     * "Sent" here means queued onto an ordered channel and nothing more. This
     * protocol has no delivery receipt and deliberately never will, so no caller
     * may render this as "delivered" or "read".
     */
    override fun send(body: String): List<Action> {
        check(state == State.OPEN) { "the conversation is not open" }
        val size = TextWire.byteLength(body)
        if (size > plainLimit) return listOf(Action.Fail(Action.Reason.MALFORMED))
        if (messages + 1 > TextSessionLimits.MAX_MESSAGES ||
            bytes + size > TextSessionLimits.MAX_BYTES
        ) {
            return bound()
        }
        val frame = try {
            sender.frame(body, keys)
        } catch (_: TextWireException) {
            return listOf(Action.Fail(Action.Reason.MALFORMED))
        }
        messages++
        bytes += size
        return listOf(Action.Send(frame))
    }

    // ── receiving ───────────────────────────────────────────────────────────

    /**
     * One inbound frame off the text lane.
     *
     * Demux order: one-byte lifecycle, then a content frame, then everything
     * else. A frame that begins with the message kind but is too short to hold a
     * tag fails this lane; a frame beginning with any other byte is ignored,
     * which is what the Web does. This lane carries no sequence a dropped
     * unknown frame could strand, so the file lane's total partition is not
     * required here — but nothing unrecognised ever reaches the AEAD.
     */
    override fun onFrame(frame: ByteArray): List<Action> {
        if (state == State.FAILED) return emptyList()
        // Flooding fails the lane before anything is decrypted or dispatched:
        // lifecycle bytes are free to forge, so they are rate-bounded too.
        if (!takeToken()) return failLane(Action.Reason.BOUNDS)
        TextWire.lifecycleKind(frame)?.let { return onLifecycle(it) }
        if (!TextWire.isTextFrame(frame)) {
            val looksLikeContent = frame.isNotEmpty() && (frame[0].toInt() and 0xff) == TextWire.KIND
            return if (looksLikeContent) failLane(Action.Reason.MALFORMED) else emptyList()
        }
        val size = frame.size - TextWire.FRAME_OVERHEAD

        if (state == State.ENDED && draining) {
            // Authenticated to keep the receive counter continuous, then
            // discarded. Bounded, so an ended conversation's tail cannot be an
            // unbounded flood.
            if (drained + 1 > TextSessionLimits.MAX_MESSAGES) return bound()
            drained++
            return try {
                receiver.feed(frame, keys)
                listOf(Action.Drained)
            } catch (_: TextWireException) {
                failLane(Action.Reason.MALFORMED)
            }
        }

        if (state != State.OPEN) {
            // A later conversation's acceptance cannot authorise content sent
            // before it, and dropping the frame would desynchronise this lane's
            // counter with no way back. Hard failure of the TEXT lane only.
            return failLane(Action.Reason.CONTENT_BEFORE_ACTIVATION)
        }
        if (messages + 1 > TextSessionLimits.MAX_MESSAGES ||
            bytes + size > TextSessionLimits.MAX_BYTES
        ) {
            return bound()
        }
        val body = try {
            receiver.feed(frame, keys)
        } catch (_: TextWireException) {
            return failLane(Action.Reason.MALFORMED)
        }
        messages++
        bytes += size
        return listOf(Action.Received(body))
    }

    private fun onLifecycle(kind: TextWire.Lifecycle): List<Action> = when (kind) {
        TextWire.Lifecycle.REQUEST -> when (state) {
            // One conversation at a time. The Web answers a request during an
            // open conversation with REJECT rather than silence, so the peer
            // fails fast instead of waiting out its own timeout.
            State.OPEN -> listOf(Action.Send(TextWire.REJECT))
            else -> {
                beginConversation()
                state = State.INCOMING_REQUEST
                listOf(Action.Requested)
            }
        }

        TextWire.Lifecycle.ACCEPT -> when {
            state == State.REQUESTED -> {
                state = State.OPEN
                draining = false
                lateAccept = false
                listOf(Action.Opened)
            }
            // An ACCEPT for a request this side already ended. It is an ordered
            // barrier, not a reopen: authenticate what follows only until the
            // peer's own END.
            state == State.ENDED && lateAccept -> {
                lateAccept = false
                draining = true
                drained = 0
                emptyList()
            }
            else -> emptyList()
        }

        TextWire.Lifecycle.REJECT -> when {
            // A REJECT emitted before the peer saw this side's END is still a
            // complete ordered barrier for that conversation, so it settles the
            // acknowledgement without waiting for another control frame.
            awaitingEndAck -> {
                awaitingEndAck = false
                draining = false
                lateAccept = false
                state = State.ENDED
                emptyList()
            }
            state == State.REQUESTED -> {
                state = State.ENDED
                draining = false
                lateAccept = false
                listOf(Action.Fail(Action.Reason.REFUSED))
            }
            else -> emptyList()
        }

        TextWire.Lifecycle.END -> when {
            // The peer's barrier for the END this side sent first. Everything
            // ordered before it has now been drained.
            awaitingEndAck -> {
                awaitingEndAck = false
                draining = false
                lateAccept = false
                state = State.ENDED
                emptyList()
            }
            // A late ACCEPT may have crossed the END that closed this side's
            // request; this later ordered END is the safe drain barrier.
            state == State.ENDED && (draining || lateAccept) -> {
                draining = false
                lateAccept = false
                emptyList()
            }
            state == State.OPEN || state == State.REQUESTED || state == State.INCOMING_REQUEST -> {
                val wasRequested = state == State.REQUESTED
                state = State.ENDED
                draining = false
                // An END can belong to the peer's preceding request while this
                // side's new REQUEST is already in flight. Keep a drain-only
                // budget so a crossing ACCEPT cannot leak into a later
                // conversation before the symmetric END reaches the peer.
                lateAccept = wasRequested
                // The symmetric END is the ordered drain barrier for the side
                // that ended second. `awaitingEndAck` stays false, which is what
                // prevents an acknowledgement loop.
                listOf(Action.Send(TextWire.END), Action.Ended)
            }
            else -> emptyList()
        }
    }

    /** Per-conversation counters only. The CODECS are never touched here —
     *  their sequence numbers belong to the link and must never rewind — and
     *  neither is the end barrier: [canRequest] guarantees it has settled
     *  before a new conversation can begin, so clearing it here would only
     *  ever mask a caller that skipped the gate. */
    private fun beginConversation() {
        messages = 0
        bytes = 0
        drained = 0
    }

    /**
     * The transport could not enqueue a frame whose nonce [send] already
     * consumed. The peer will now expect a number it can never receive, so the
     * lane is stranded: fail it truthfully on the same codecs. Never a fresh
     * codec, never a rewind, never a "sent" that was not.
     */
    override fun transportSendFailed(): List<Action> = failLane(Action.Reason.TRANSPORT)

    private fun bound(): List<Action> {
        state = State.ENDED
        draining = false
        lateAccept = false
        return listOf(Action.Fail(Action.Reason.BOUNDS), Action.Ended)
    }

    private fun failLane(reason: Action.Reason): List<Action> {
        state = State.FAILED
        draining = false
        lateAccept = false
        return listOf(Action.Fail(reason))
    }
}
