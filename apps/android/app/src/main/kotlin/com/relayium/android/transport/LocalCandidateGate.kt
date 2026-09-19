package com.relayium.android.transport

import com.relayium.protocol.LinkProtocol

/**
 * Holds locally gathered ICE candidates until the local description they belong
 * to has actually been SIGNALLED, then releases them in arrival order.
 *
 * ## Why this exists
 *
 * JSEP has the ICE agent begin gathering as part of applying a local
 * description, and the API orders nothing between `onIceCandidate` and the
 * observer callback that sends the offer or the answer. So a candidate MAY be
 * handed out before its description has been signalled. How often that happens
 * on libwebrtc is not measured here and is not claimed.
 *
 * What the peer then does with such a candidate depends on the peer, and on
 * WHEN it arrives. Relayium's own clients buffer early remote candidates —
 * `LinkTransport.heldCandidates` here, `LinkCandidateGate` on Apple, the Web's
 * `webrtc-core` — but only once the object that owns the buffer exists. The
 * Web's responder, for one, builds its core when an offer arrives, so a
 * candidate that overtakes that offer has nothing to be buffered by yet. No
 * universal "nothing is lost" claim is made here.
 *
 * A peer that has neither a buffer nor a remote description has nowhere to put
 * the candidate, and this side never re-sends it. Sending the description first
 * removes the question rather than depending on what the far end happens to
 * have constructed by then.
 *
 * This is the local twin of `LinkTransport`'s `heldCandidates`, which holds the
 * REMOTE side of the same race, and the direct counterpart of Apple's
 * `LinkCandidateGate`.
 *
 * ## Bound and overflow
 *
 * [LinkProtocol.HELD_SIGNAL_MAX] — the same 64 the remote side uses. One data
 * m-line gathers roughly one host candidate per usable address plus a
 * server-reflexive and a relay candidate per configured server, so 64 leaves
 * room above a multi-homed device and is still a fixed ceiling, which is the
 * property that matters.
 *
 * Overflow is never silent truncation. Either end is the wrong thing to drop:
 * discarding the oldest removes paths the peer would otherwise have been able
 * to try, and discarding the newest hides whatever made gathering run away. The
 * caller fails the link closed instead, which is at least a named outcome.
 *
 * ## Ownership
 *
 * A pure value holder with no clock, no thread and no WebRTC type of its own.
 * Its owner serialises every call onto one executor thread, exactly as
 * [LinkTransport] does for the rest of its state.
 */
internal class LocalCandidateGate<C>(
    private val limit: Int = LinkProtocol.HELD_SIGNAL_MAX,
) {

    /** What the gate decided about one candidate. */
    enum class Admission {
        /** The description this candidate belongs to has already been
         *  signalled. Send it now. */
        SEND,

        /** Held. It comes back out of [release], in arrival order. */
        HOLD,

        /** The bound was exceeded. Terminal: the caller must fail the link. */
        OVERFLOW,
    }

    private val pending = ArrayList<C>()
    private var released = false

    /** True once the description these candidates belong to has been signalled.
     *  From then on the gate holds nothing. */
    val isOpen: Boolean get() = released

    val pendingCount: Int get() = pending.size

    /**
     * Close the gate for a local description that is about to be applied.
     *
     * Called per description rather than once at construction, so a
     * RENEGOTIATION or an ICE restart gets the same ordering guarantee its
     * initial exchange did: the new answer goes out before the candidates the
     * new generation gathers. Anything still held from the previous
     * description stays held — it is unsent either way, and dropping it here
     * would lose a candidate the peer never saw.
     */
    fun arm() {
        released = false
    }

    /** Offer one candidate to the gate. */
    fun admit(candidate: C): Admission {
        if (released) return Admission.SEND
        if (pending.size >= limit) return Admission.OVERFLOW
        pending.add(candidate)
        return Admission.HOLD
    }

    /**
     * Open the gate and hand back everything held, in arrival order.
     *
     * FIFO because the gate's job is to DELAY delivery, not to reshape it: a
     * candidate's priority is a field the ICE agent wrote into the candidate
     * itself, so the peer's ranking is unaffected either way, and preserving
     * arrival order simply leaves the trickle looking the way it would have
     * looked had nothing been held.
     *
     * Idempotent — a second call returns nothing rather than replaying a
     * backlog.
     */
    fun release(): List<C> {
        released = true
        if (pending.isEmpty()) return emptyList()
        val held = ArrayList(pending)
        pending.clear()
        return held
    }

    /** Drop the backlog without releasing it. For teardown: candidates held for
     *  a connection that is going away belong to a link nobody will use. */
    fun discard() {
        pending.clear()
    }
}
