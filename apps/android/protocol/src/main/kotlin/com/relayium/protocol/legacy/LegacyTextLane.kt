package com.relayium.protocol.legacy

import com.relayium.protocol.Crypto
import com.relayium.protocol.LinkProtocol
import com.relayium.protocol.TextLane
import com.relayium.protocol.TextLaneSession
import com.relayium.protocol.TextSessionLimits
import com.relayium.protocol.TextWire
import com.relayium.protocol.TextWireException

/**
 * The shipped single-generation message connection, as `RealtimeConnection`
 * drives it in `.text` mode.
 *
 * ## The conversation IS the connection
 *
 * There is no `0xfa` REQUEST and no `0xfb` END on this wire — those are
 * `link/1` additions. The OFFER is the request: an initiator that sent a
 * `text:true` offer has asked, and the responder's `0xfe` is the answer. So
 * there is exactly one conversation per connection, it cannot be reopened, and
 * ending it means closing the connection. [canRequest] is therefore always
 * false: a "start a conversation" control on this wire would be a control over
 * nothing.
 *
 * ## The activation gate, in both roles
 *
 * `RealtimeConnection` will not let plaintext cross in either direction before
 * consent, and the two roles reach it differently:
 *
 *  - the RESPONDER sets `textAcceptedLocally` and only then sends `0xfe`,
 *    so its handler is installed before the byte that invites content;
 *  - the INITIATOR may send and surface only once it has SEEN that `0xfe`.
 *
 * Because the channel is ordered and the responder cannot send a message before
 * its own ACCEPT, an initiator that receives content before `0xfe` is not
 * seeing a race — it is seeing a peer that skipped consent. That is a hard
 * failure here rather than a buffer, which is the honest reading and needs no
 * pending-frame budget to bound.
 *
 * ## What it reuses
 *
 * Everything cryptographic: [TextWire.Sender]/[TextWire.Receiver], the kind-9
 * framing, the derived text key and the per-direction sequences from 0 are the
 * SAME objects `link/1` uses, because they are the same wire. Only the
 * lifecycle differs, and only the lifecycle is written here.
 */
class LegacyTextLane(
    private val keys: Crypto.SessionKeys,
    private val maxFrameBytes: Int,
    role: LinkProtocol.Role,
    private val sender: TextWire.Sender = TextWire.Sender(),
    private val receiver: TextWire.Receiver = TextWire.Receiver(),
    private val now: () -> Long = System::currentTimeMillis,
) : TextLane {

    /**
     * The initiator has already asked by offering; the responder is being
     * asked. Neither is IDLE, and that is the point: on this wire a connected
     * message session always has a conversation in one of those two states, so
     * the UI never shows a start control that cannot do anything.
     */
    override var state: TextLaneSession.State =
        if (role == LinkProtocol.Role.INITIATOR) {
            TextLaneSession.State.REQUESTED
        } else {
            TextLaneSession.State.INCOMING_REQUEST
        }
        private set

    private var receiverAttached = false

    // Per-conversation bounds, the same numbers the other wire enforces.
    private var messages = 0
    private var bytes = 0L

    // The same inbound token bucket, over EVERY frame including lifecycle
    // bytes: those are free to forge, so they are rate-bounded too.
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

    /** Exposed for the same reason the other lane exposes them: a test must be
     *  able to assert that nothing ever rewinds a direction. */
    val sendSeq: Long get() = sender.nextSeq
    val recvSeq: Long get() = receiver.nextExpectedSeq

    override val plainLimit: Int get() = TextWire.plainLimit(maxFrameBytes)

    /** No `0xfb` on this wire, so nothing to wait for. */
    override val hasEndBarrier: Boolean get() = false

    /** Never. See the class note: there is nothing to reopen. */
    override val canRequest: Boolean get() = false

    override fun attachReceiver() {
        receiverAttached = true
    }

    /** The offer already carried the request. Calling this would mean a caller
     *  ignored [canRequest]; it is inert rather than a second ask on the wire. */
    override fun request(): List<TextLaneSession.Action> = emptyList()

    /**
     * Consent, from the responder.
     *
     * The handler is attached BEFORE `0xfe` goes out, for the reason the file
     * lane states: a frame dispatched with no listener is dropped and there is
     * no replay, so answering first loses whatever the peer sends the instant
     * it sees the answer.
     */
    override fun accept(): List<TextLaneSession.Action> {
        check(state == TextLaneSession.State.INCOMING_REQUEST) {
            "no conversation is waiting for an answer"
        }
        check(receiverAttached) {
            "attach the receive handler BEFORE sending ACCEPT: a frame dispatched with no listener is lost"
        }
        state = TextLaneSession.State.OPEN
        return listOf(TextLaneSession.Action.Send(TextWire.ACCEPT), TextLaneSession.Action.Opened)
    }

    /**
     * Refusal, from the responder.
     *
     * `RealtimeConnection.rejectText` sends `0xff` and closes; the owner does
     * the closing here, so this emits the byte and retires the conversation.
     */
    override fun reject(): List<TextLaneSession.Action> {
        check(state == TextLaneSession.State.INCOMING_REQUEST) {
            "no conversation is waiting for an answer"
        }
        state = TextLaneSession.State.ENDED
        return listOf(TextLaneSession.Action.Send(TextWire.REJECT), TextLaneSession.Action.Ended)
    }

    /**
     * End the conversation.
     *
     * No byte goes out: there is none to send, and the ordered barrier that
     * `link/1` uses to keep a counter continuous across a reopen has nothing to
     * protect when there is no reopen. The owner tears the connection down, and
     * the state says the conversation is over so the composer does not stay
     * live over a connection that is closing.
     */
    override fun end(): List<TextLaneSession.Action> = when (state) {
        TextLaneSession.State.ENDED, TextLaneSession.State.FAILED -> emptyList()
        else -> {
            state = TextLaneSession.State.ENDED
            listOf(TextLaneSession.Action.Ended)
        }
    }

    /** No barrier on this wire, so no lease over one. */
    override fun endBarrierTimedOut(): List<TextLaneSession.Action> = emptyList()

    override fun send(body: String): List<TextLaneSession.Action> {
        check(state == TextLaneSession.State.OPEN) { "the conversation is not open" }
        val size = TextWire.byteLength(body)
        if (size > plainLimit) return listOf(TextLaneSession.Action.Fail(TextLaneSession.Action.Reason.MALFORMED))
        if (messages + 1 > TextSessionLimits.MAX_MESSAGES || bytes + size > TextSessionLimits.MAX_BYTES) {
            return bound()
        }
        val frame = try {
            sender.frame(body, keys)
        } catch (_: TextWireException) {
            return listOf(TextLaneSession.Action.Fail(TextLaneSession.Action.Reason.MALFORMED))
        }
        messages++
        bytes += size
        return listOf(TextLaneSession.Action.Send(frame))
    }

    /**
     * One inbound frame.
     *
     * Demux order is the peer's: one-byte control first, then a kind-9 frame,
     * then everything else. `0xfd` COMPLETE belongs to the file generation and
     * `RealtimeConnection` reads it in `.text` mode and does nothing with it —
     * matched here rather than failed, so a peer doing exactly what the shipped
     * client does cannot kill a conversation.
     */
    override fun onFrame(frame: ByteArray): List<TextLaneSession.Action> {
        if (state == TextLaneSession.State.FAILED) return emptyList()
        if (!takeToken()) return failLane(TextLaneSession.Action.Reason.BOUNDS)
        LegacyProtocol.control(frame)?.let { return onControl(it) }
        if (!TextWire.isTextFrame(frame)) {
            val looksLikeContent = frame.isNotEmpty() && (frame[0].toInt() and 0xff) == TextWire.KIND
            return if (looksLikeContent) failLane(TextLaneSession.Action.Reason.MALFORMED) else emptyList()
        }
        if (state != TextLaneSession.State.OPEN) {
            // Content with no conversation to attribute it to. On an ordered
            // channel the peer cannot have sent this before its own consent by
            // accident, and dropping it would desynchronise the counter with no
            // way back.
            return failLane(TextLaneSession.Action.Reason.CONTENT_BEFORE_ACTIVATION)
        }
        val size = frame.size - TextWire.FRAME_OVERHEAD
        if (messages + 1 > TextSessionLimits.MAX_MESSAGES || bytes + size > TextSessionLimits.MAX_BYTES) {
            return bound()
        }
        val body = try {
            receiver.feed(frame, keys)
        } catch (_: TextWireException) {
            return failLane(TextLaneSession.Action.Reason.MALFORMED)
        }
        messages++
        bytes += size
        return listOf(TextLaneSession.Action.Received(body))
    }

    private fun onControl(control: LegacyProtocol.Control): List<TextLaneSession.Action> =
        when (control) {
            LegacyProtocol.Control.ACCEPT ->
                if (state == TextLaneSession.State.REQUESTED) {
                    state = TextLaneSession.State.OPEN
                    listOf(TextLaneSession.Action.Opened)
                } else {
                    // A duplicate, or an ACCEPT for a conversation that is over.
                    // Inert: it can neither reopen nor re-consent.
                    emptyList()
                }
            LegacyProtocol.Control.REJECT ->
                if (state == TextLaneSession.State.REQUESTED) {
                    state = TextLaneSession.State.ENDED
                    listOf(TextLaneSession.Action.Fail(TextLaneSession.Action.Reason.REFUSED))
                } else {
                    // The peer left. There is no drain to settle, so the
                    // conversation simply ends; the owner closes the connection.
                    if (state == TextLaneSession.State.OPEN) {
                        state = TextLaneSession.State.ENDED
                        listOf(TextLaneSession.Action.Ended)
                    } else {
                        emptyList()
                    }
                }
            // The file generation's byte. The shipped client ignores it here.
            LegacyProtocol.Control.COMPLETE -> emptyList()
        }

    override fun transportSendFailed(): List<TextLaneSession.Action> =
        failLane(TextLaneSession.Action.Reason.TRANSPORT)

    private fun bound(): List<TextLaneSession.Action> {
        state = TextLaneSession.State.ENDED
        return listOf(
            TextLaneSession.Action.Fail(TextLaneSession.Action.Reason.BOUNDS),
            TextLaneSession.Action.Ended,
        )
    }

    private fun failLane(reason: TextLaneSession.Action.Reason): List<TextLaneSession.Action> {
        state = TextLaneSession.State.FAILED
        return listOf(TextLaneSession.Action.Fail(reason))
    }
}
